// API du Diagnostic 4 Shifts.
//   GET  /api/diagnostic?lang=fr  → questions et niveaux (sans les actions ni les dépendances)
//   POST /api/diagnostic          → enregistre les réponses, renvoie scores et feuille de route

import { lireReferentiel, enregistrerDiagnostic } from '../lib/supabase.mjs';
import {
  langueValide,
  questionnairePublic,
  validerSaisie,
  calculerScores,
  construireFeuilleDeRoute,
} from '../lib/diagnostic.mjs';

const TAILLE_MAX = 20_000;

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
  if (req.method === 'GET') {
    const ref = await chargerReferentiel();
    if (!ref) return json({ erreur: 'Le diagnostic est momentanément indisponible.' }, 503);
    const langue = langueValide(new URL(req.url).searchParams.get('lang'));
    // Cache CDN d'une minute : une modification dans Supabase apparaît sur le site en une minute au plus.
    return json(questionnairePublic(ref, langue), 200, {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    });
  }

  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée.' }, 405, { Allow: 'GET, POST' });

  if (!origineAutorisee(req)) return json({ erreur: 'Origine non autorisée.' }, 403);

  const brut = await req.text();
  if (brut.length > TAILLE_MAX) return json({ erreur: 'Requête trop volumineuse.' }, 413);
  let saisie;
  try {
    saisie = JSON.parse(brut);
  } catch {
    return json({ erreur: 'Requête invalide.' }, 400);
  }

  const ref = await chargerReferentiel();
  if (!ref) return json({ erreur: 'Le diagnostic est momentanément indisponible.' }, 503);

  const valide = validerSaisie(ref, saisie);
  if (valide.erreur) return json({ erreur: valide.erreur }, 400);
  const { reponses, profil, langue } = valide;

  const scores = calculerScores(ref, reponses, langue);
  const feuilleDeRoute = construireFeuilleDeRoute(ref, reponses, langue);

  // Si l'enregistrement échoue, le visiteur reçoit quand même son résultat.
  let enregistre = true;
  try {
    await enregistrerDiagnostic({
      langue,
      ...profil,
      score_global: scores.global,
      scores_axes: Object.fromEntries(scores.axes.map((a) => [a.id, a.score])),
      reponses,
    });
  } catch (e) {
    console.error(e);
    enregistre = false;
  }

  return json({ scores, feuille_de_route: feuilleDeRoute, enregistre });
};

export const config = { path: '/api/diagnostic' };
