// Accès à Supabase par son API REST (PostgREST), sans dépendance.
// Variables d'environnement Netlify : SUPABASE_URL et SUPABASE_SECRET_KEY (clé secrète, jamais côté navigateur).

function configuration() {
  const url = process.env.SUPABASE_URL;
  const cle = process.env.SUPABASE_SECRET_KEY;
  if (!url || !cle) throw new Error('SUPABASE_URL ou SUPABASE_SECRET_KEY manquante');
  // Nouvelles clés (sb_secret_...) : en-tête apikey seul. Anciennes clés (JWT service_role) : les deux en-têtes.
  const entetes = cle.startsWith('sb_') ? { apikey: cle } : { apikey: cle, Authorization: `Bearer ${cle}` };
  return { base: `${url.replace(/\/+$/, '')}/rest/v1`, entetes };
}

async function requete(chemin, options = {}) {
  const { base, entetes } = configuration();
  const reponse = await fetch(`${base}/${chemin}`, {
    ...options,
    headers: { ...entetes, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!reponse.ok) {
    throw new Error(`Supabase ${reponse.status} sur ${chemin.split('?')[0]} : ${(await reponse.text()).slice(0, 300)}`);
  }
  return reponse.json();
}

const TABLES = ['axes', 'niveaux', 'questions', 'reponses_possibles', 'dependances', 'actions', 'parametres', 'profil_options'];

// Lit tout le référentiel en parallèle. Le tri et le filtre « actif » sont faits dans netlify/lib/diagnostic.mjs.
export async function lireReferentiel() {
  const lignes = await Promise.all(TABLES.map((t) => requete(`${t}?select=*`)));
  return Object.fromEntries(TABLES.map((t, i) => [t, lignes[i]]));
}

export async function enregistrerDiagnostic(payload) {
  return requete('rpc/enregistrer_diagnostic', { method: 'POST', body: JSON.stringify({ payload }) });
}
