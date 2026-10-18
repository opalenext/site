// Accès au classeur Google Sheets du diagnostic, par l'API Sheets v4, sans dépendance.
// Variables d'environnement Netlify :
//   GOOGLE_SHEET_ID                 identifiant du classeur (dans son URL)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL    adresse du compte de service, avec qui le classeur est partagé
//   GOOGLE_PRIVATE_KEY              clé privée du compte de service (champ private_key du fichier JSON)

import { createSign } from 'node:crypto';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Onglets du référentiel. Chaque onglet a ses noms de colonnes en ligne 1.
const ONGLETS = ['axes', 'niveaux', 'questions', 'reponses_possibles', 'dependances', 'actions', 'parametres', 'profil_options'];
const ONGLET_DIAGNOSTICS = 'diagnostics';
const ONGLET_REPONSES = 'reponses';

const COLONNES_NUMERIQUES = new Set(['niveau', 'ordre', 'poids', 'niveau_cible', 'prerequis_niveau_min', 'niveau_depart', 'duree_semaines']);
const FAUX = new Set(['false', 'faux', 'non', 'no', '0']);

function configuration() {
  const id = process.env.GOOGLE_SHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const cle = process.env.GOOGLE_PRIVATE_KEY;
  if (!id || !email || !cle) throw new Error('GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL ou GOOGLE_PRIVATE_KEY manquante');
  // Netlify conserve parfois les retours à la ligne de la clé sous la forme \n.
  return { id, email, cle: cle.replace(/\\n/g, '\n') };
}

let jeton = null;

// Jeton d'accès OAuth du compte de service, gardé en mémoire tant qu'il est valide.
async function jetonAcces() {
  if (jeton && jeton.expire > Date.now() + 60_000) return jeton.valeur;
  const { email, cle } = configuration();
  const maintenant = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const nonSigne = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: maintenant,
    exp: maintenant + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(nonSigne).sign(cle, 'base64url');
  const reponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${nonSigne}.${signature}` }),
  });
  if (!reponse.ok) throw new Error(`Google OAuth ${reponse.status} : ${(await reponse.text()).slice(0, 300)}`);
  const donnees = await reponse.json();
  jeton = { valeur: donnees.access_token, expire: Date.now() + donnees.expires_in * 1000 };
  return jeton.valeur;
}

async function requete(chemin, options = {}) {
  const { id } = configuration();
  const reponse = await fetch(`${API}/${id}${chemin}`, {
    ...options,
    headers: { Authorization: `Bearer ${await jetonAcces()}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!reponse.ok) throw new Error(`Google Sheets ${reponse.status} : ${(await reponse.text()).slice(0, 300)}`);
  return reponse.json();
}

const vide = (v) => v === undefined || v === null || v === '';

function convertir(colonne, valeur) {
  if (vide(valeur)) return null;
  if (COLONNES_NUMERIQUES.has(colonne)) {
    const n = Number(String(valeur).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (colonne === 'actif') return typeof valeur === 'boolean' ? valeur : !FAUX.has(String(valeur).trim().toLowerCase());
  return typeof valeur === 'string' ? valeur.trim() : String(valeur);
}

// Transforme les lignes d'un onglet en objets { colonne: valeur }.
// Les lignes dont la première colonne est vide sont ignorées : on peut laisser des lignes blanches.
export function lignesEnObjets(lignes = []) {
  const [entetes = [], ...donnees] = lignes;
  const colonnes = entetes.map((e) => String(e).trim());
  return donnees
    .filter((l) => !vide(l[0]))
    .map((l) => Object.fromEntries(colonnes.filter(Boolean).map((c) => [c, convertir(c, l[colonnes.indexOf(c)])])));
}

// Place les valeurs d'un objet sous les bons noms de colonnes. Une colonne inconnue reste vide.
export function aligner(entetes, objet) {
  return entetes.map((e) => objet[String(e).trim()] ?? '');
}

// Lit tout le référentiel en un appel, avec les en-têtes des onglets de résultats.
export async function lireReferentiel() {
  const plages = [...ONGLETS, `${ONGLET_DIAGNOSTICS}!1:1`, `${ONGLET_REPONSES}!1:1`];
  const parametres = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  for (const p of plages) parametres.append('ranges', p);
  const { valueRanges } = await requete(`/values:batchGet?${parametres}`);
  const ref = Object.fromEntries(ONGLETS.map((o, i) => [o, lignesEnObjets(valueRanges[i].values)]));
  ref.entetes = {
    diagnostics: valueRanges[ONGLETS.length].values?.[0] ?? [],
    reponses: valueRanges[ONGLETS.length + 1].values?.[0] ?? [],
  };
  return ref;
}

async function ajouterLignes(onglet, lignes) {
  if (!lignes.length) return;
  const parametres = new URLSearchParams({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  await requete(`/values/${encodeURIComponent(`${onglet}!A1`)}:append?${parametres}`, {
    method: 'POST',
    body: JSON.stringify({ values: lignes }),
  });
}

// diagnostic : une ligne pour l'onglet diagnostics ; reponses : une ligne par question pour l'onglet reponses.
export async function enregistrerDiagnostic(ref, { diagnostic, reponses }) {
  await ajouterLignes(ONGLET_DIAGNOSTICS, [aligner(ref.entetes.diagnostics, diagnostic)]);
  await ajouterLignes(ONGLET_REPONSES, reponses.map((r) => aligner(ref.entetes.reponses, r)));
}
