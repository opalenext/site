// API du Diagnostic 4 Shifts.
//   GET  /api/diagnostic?lang=fr  → questions et niveaux (sans les actions ni les dépendances)
//   POST /api/diagnostic          → enregistre les réponses, renvoie scores et feuille de route
//                                   (recalcul: true → recalcule dans une autre langue sans enregistrer)

import { randomUUID } from 'node:crypto';
import { lireReferentiel, enregistrerDiagnostic } from '../lib/sheets.mjs';
import {
  langueValide,
  questionnairePublic,
  validerSaisie,
  calculerScores,
  construireFeuilleDeRoute,
  lignesResultat,
} from '../lib/diagnostic.mjs';

const TAILLE_MAX = 20_000;

const MESSAGES = {
  fr: {
    indisponible: 'Le diagnostic est momentanément indisponible.',
    methode: 'Méthode non autorisée.',
    origine: 'Origine non autorisée.',
    trop_volumineux: 'Requête trop volumineuse.',
    invalide: 'Requête invalide.',
    incomplet: 'Merci de répondre à toutes les questions.',
    question_inconnue: 'Le questionnaire a changé. Rechargez la page.',
  },
  en: {
    indisponible: 'The assessment is temporarily unavailable.',
    methode: 'Method not allowed.',
    origine: 'Origin not allowed.',
    trop_volumineux: 'Request too large.',
    invalide: 'Invalid request.',
    incomplet: 'Please answer every question.',
    question_inconnue: 'The questionnaire has changed. Please reload the page.',
  },
};

const erreur = (code, langue, statut, entetes) => json({ erreur: MESSAGES[langue][code] }, statut, entetes);

function json(corps, statut = 200, entetes = {}) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...entetes },
  });
}

// Refuse les envois depuis un autre site. Un navigateur envoie toujours l'en-tête Origin sur un POST.
function origineAutorisee(req) {
  const origine = req.headers.get('origin');
  if (!origine) return true;
  try {
    return new URL(origine).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

async function chargerReferentiel() {
  try {
    return await lireReferentiel();
  } catch (e) {
    console.error(e);
    return null;
  }
}

export default async (req) => {
  let langue = langueValide(new URL(req.url).searchParams.get('lang'));

  if (req.method === 'GET') {
    const ref = await chargerReferentiel();
    if (!ref) return erreur('indisponible', langue, 503);
    // Cache CDN d'une minute : une modification dans le classeur apparaît sur le site en une minute au plus.
    return json(questionnairePublic(ref, langue), 200, {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      'Netlify-Vary': 'query=lang',
    });
  }

  if (req.method !== 'POST') return erreur('methode', langue, 405, { Allow: 'GET, POST' });

  if (!origineAutorisee(req)) return erreur('origine', langue, 403);

  const brut = await req.text();
  if (brut.length > TAILLE_MAX) return erreur('trop_volumineux', langue, 413);
  let saisie;
  try {
    saisie = JSON.parse(brut);
  } catch {
    return erreur('invalide', langue, 400);
  }
  langue = langueValide(saisie?.langue ?? langue);

  const ref = await chargerReferentiel();
  if (!ref) return erreur('indisponible', langue, 503);

  const valide = validerSaisie(ref, saisie);
  if (valide.erreur) return erreur(valide.erreur, langue, 400);
  const { reponses, profil } = valide;

  const scores = calculerScores(ref, reponses, langue);
  const feuilleDeRoute = construireFeuilleDeRoute(ref, reponses, langue);

  // Changement de langue sur l'écran de résultats : même calcul, rien n'est enregistré une seconde fois.
  if (saisie.recalcul === true) return json({ scores, feuille_de_route: feuilleDeRoute, enregistre: false });

  // Si l'enregistrement échoue, le visiteur reçoit quand même son résultat.
  let enregistre = true;
  try {
    await enregistrerDiagnostic(ref, lignesResultat(ref, { id: randomUUID(), date: new Date(), reponses, profil, langue, scores }));
  } catch (e) {
    console.error(e);
    enregistre = false;
  }

  return json({ scores, feuille_de_route: feuilleDeRoute, enregistre });
};

export const config = { path: '/api/diagnostic' };
