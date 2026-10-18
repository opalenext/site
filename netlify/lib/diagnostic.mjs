// Logique du Diagnostic 4 Shifts : questionnaire public, validation, scores, feuille de route.
// Fonctions pures : elles reçoivent le référentiel lu dans la base et ne font aucun appel réseau.

const LANGUES = ['fr', 'en'];
const CHAMPS_PROFIL = ['fonction', 'taille', 'secteur'];

export function langueValide(langue) {
  return LANGUES.includes(langue) ? langue : 'fr';
}

// Texte dans la langue demandée, avec repli sur le français.
function texte(ligne, champ, langue) {
  return (langue === 'en' && ligne[`${champ}_en`]) || ligne[`${champ}_fr`] || '';
}

const parOrdre = (a, b) => (a.ordre ?? 0) - (b.ordre ?? 0);

// Axes et questions actifs, triés, avec leurs réponses possibles.
// Une question sans réponse possible n'est pas posée.
function questionsActives(ref) {
  const axes = ref.axes.filter((a) => a.actif !== false).sort(parOrdre);
  const reponsesParQuestion = new Map();
  for (const r of ref.reponses_possibles) {
    if (!reponsesParQuestion.has(r.question_id)) reponsesParQuestion.set(r.question_id, []);
    reponsesParQuestion.get(r.question_id).push(r);
  }
  const resultat = [];
  for (const axe of axes) {
    const questions = ref.questions
      .filter((q) => q.axe_id === axe.id && q.actif !== false && reponsesParQuestion.has(q.id))
      .sort(parOrdre);
    for (const q of questions) {
      resultat.push({
        ...q,
        axe,
        reponses: reponsesParQuestion.get(q.id).sort((a, b) => a.niveau - b.niveau),
      });
    }
  }
  return resultat;
}

export function questionnairePublic(ref, langue) {
  const questions = questionsActives(ref);
  const axes = [];
  for (const q of questions) {
    let axe = axes.find((a) => a.id === q.axe.id);
    if (!axe) {
      axe = { id: q.axe.id, titre: texte(q.axe, 'titre', langue), description: texte(q.axe, 'description', langue), questions: [] };
      axes.push(axe);
    }
    axe.questions.push({
      id: q.id,
      intitule: texte(q, 'intitule', langue),
      aide: texte(q, 'aide', langue),
      reponses: q.reponses.map((r) => ({ niveau: r.niveau, libelle: texte(r, 'libelle', langue) })),
    });
  }
  const profil = {};
  for (const champ of CHAMPS_PROFIL) {
    profil[champ] = ref.profil_options
      .filter((o) => o.champ === champ && o.actif !== false)
      .sort(parOrdre)
      .map((o) => ({ code: o.code, libelle: texte(o, 'libelle', langue) }));
  }
  const contact = ref.parametres.find((p) => p.cle === 'contact_email')?.valeur ?? '';
  return {
    contact_email: /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(contact) ? contact : null,
    niveaux: [...ref.niveaux]
      .sort((a, b) => a.niveau - b.niveau)
      .map((n) => ({ niveau: n.niveau, libelle: texte(n, 'libelle', langue), description: texte(n, 'description', langue) })),
    axes,
    profil,
  };
}

// Vérifie la saisie envoyée par le navigateur. Renvoie { erreur } (un code, traduit par la fonction)
// ou { reponses, profil, langue }.
export function validerSaisie(ref, saisie) {
  if (!saisie || typeof saisie !== 'object' || Array.isArray(saisie)) return { erreur: 'invalide' };
  if (saisie.site_web) return { erreur: 'invalide' }; // champ piège invisible pour les robots

  const brutes = saisie.reponses;
  if (!brutes || typeof brutes !== 'object' || Array.isArray(brutes)) return { erreur: 'incomplet' };

  const questions = questionsActives(ref);
  const connues = new Map(questions.map((q) => [q.id, q]));
  for (const id of Object.keys(brutes)) {
    if (!connues.has(id)) return { erreur: 'question_inconnue' };
  }

  const reponses = {};
  for (const q of questions) {
    const niveau = brutes[q.id];
    if (!Number.isInteger(niveau) || !q.reponses.some((r) => r.niveau === niveau)) {
      return { erreur: 'incomplet' };
    }
    reponses[q.id] = niveau;
  }

  const profil = {};
  const saisieProfil = saisie.profil && typeof saisie.profil === 'object' ? saisie.profil : {};
  for (const champ of CHAMPS_PROFIL) {
    const code = saisieProfil[champ];
    const ok = ref.profil_options.some((o) => o.champ === champ && o.code === code && o.actif !== false);
    profil[champ] = ok ? code : null;
  }

  return { reponses, profil, langue: langueValide(saisie.langue) };
}

const arrondi = (x) => Math.round(x * 100) / 100;

// Score par axe : moyenne des niveaux pondérée par le poids des questions. Score global : moyenne des axes.
export function calculerScores(ref, reponses, langue) {
  const axes = [];
  for (const q of questionsActives(ref)) {
    if (reponses[q.id] === undefined) continue;
    let axe = axes.find((a) => a.id === q.axe.id);
    if (!axe) {
      axe = { id: q.axe.id, titre: texte(q.axe, 'titre', langue), somme: 0, poids: 0 };
      axes.push(axe);
    }
    const poids = Number(q.poids) || 1;
    axe.somme += reponses[q.id] * poids;
    axe.poids += poids;
  }
  const resultat = axes.map((a) => ({ id: a.id, titre: a.titre, score: arrondi(a.somme / a.poids) }));
  const global = resultat.length ? arrondi(resultat.reduce((s, a) => s + a.score, 0) / resultat.length) : null;
  return { axes: resultat, global };
}

function parametreEntier(ref, cle, defaut, min, max) {
  const ligne = ref.parametres.find((p) => p.cle === cle);
  const valeur = ligne ? parseInt(ligne.valeur, 10) : NaN;
  return Number.isInteger(valeur) ? Math.min(max, Math.max(min, valeur)) : defaut;
}

// Feuille de route par vagues.
// À chaque vague, on retient les marches (niveau n → n + 1) dont les prérequis sont atteints,
// en commençant par les niveaux les plus bas, puis par celles qui débloquent le plus d'autres marches.
// Les marches retenues sont considérées comme franchies pour la vague suivante.
export function construireFeuilleDeRoute(ref, reponses, langue) {
  const questions = questionsActives(ref);
  const actives = new Set(questions.map((q) => q.id));
  const nbVagues = parametreEntier(ref, 'roadmap_vagues', 3, 1, 6);
  const parVague = parametreEntier(ref, 'roadmap_etapes_par_vague', 4, 1, 20);
  const libellesBruts = ref.parametres.find((p) => p.cle === `roadmap_libelles_${langue}`)
    ?? ref.parametres.find((p) => p.cle === 'roadmap_libelles_fr');
  const libelles = libellesBruts ? libellesBruts.valeur.split('|').map((s) => s.trim()) : [];
  const niveauMax = Math.max(...ref.niveaux.map((n) => n.niveau));
  const libelleNiveau = new Map(ref.niveaux.map((n) => [n.niveau, texte(n, 'libelle', langue)]));
  const parId = new Map(questions.map((q) => [q.id, q]));

  // Une dépendance vers une question désactivée est ignorée.
  const dependances = ref.dependances.filter((d) => actives.has(d.question_id) && actives.has(d.prerequis_question_id));
  const nbDebloquees = new Map();
  for (const d of dependances) {
    nbDebloquees.set(d.prerequis_question_id, (nbDebloquees.get(d.prerequis_question_id) ?? 0) + 1);
  }
  const actions = ref.actions.filter((a) => a.actif !== false).sort(parOrdre);

  const niveaux = { ...reponses };
  const vagues = [];
  for (let v = 0; v < nbVagues; v++) {
    const candidates = [];
    questions.forEach((q, rang) => {
      const de = niveaux[q.id];
      if (de === undefined || de >= niveauMax) return;
      const vers = de + 1;
      const prerequis = dependances.filter((d) => d.question_id === q.id && d.niveau_cible === vers);
      if (prerequis.every((d) => (niveaux[d.prerequis_question_id] ?? 0) >= d.prerequis_niveau_min)) {
        candidates.push({ q, de, vers, prerequis, rang });
      }
    });
    candidates.sort((a, b) =>
      a.de - b.de
      || (nbDebloquees.get(b.q.id) ?? 0) - (nbDebloquees.get(a.q.id) ?? 0)
      || a.rang - b.rang);
    const retenues = candidates.slice(0, parVague);
    if (!retenues.length) break;
    for (const c of retenues) niveaux[c.q.id] = c.vers;

    vagues.push({
      libelle: libelles[v] || `Horizon ${v + 1}`,
      etapes: retenues.map((c) => ({
        question_id: c.q.id,
        intitule: texte(c.q, 'intitule', langue),
        axe: texte(c.q.axe, 'titre', langue),
        de: c.de,
        vers: c.vers,
        de_libelle: libelleNiveau.get(c.de) ?? '',
        vers_libelle: libelleNiveau.get(c.vers) ?? '',
        cible: texte(c.q.reponses.find((r) => r.niveau === c.vers) ?? {}, 'libelle', langue),
        actions: actions
          .filter((a) => a.question_id === c.q.id && a.niveau_depart === c.de)
          .map((a) => ({
            titre: texte(a, 'titre', langue),
            description: texte(a, 'description', langue),
            duree_semaines: a.duree_semaines ?? null,
            offre: a.offre ?? null,
          })),
        prerequis: c.prerequis.map((d) => ({
          question_id: d.prerequis_question_id,
          intitule: texte(parId.get(d.prerequis_question_id), 'intitule', langue),
          niveau_min: d.prerequis_niveau_min,
          commentaire: d.commentaire ?? '',
        })),
      })),
    });
  }
  return vagues;
}

// Lignes à ajouter au classeur : une ligne de synthèse (onglet diagnostics) et une ligne par
// question (onglet reponses, pratique pour les tableaux croisés dynamiques).
// Le profil est enregistré avec son libellé français, plus lisible dans les analyses.
export function lignesResultat(ref, { id, date, reponses, profil, langue, scores }) {
  const horodatage = date.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
  const libelles = {};
  for (const champ of CHAMPS_PROFIL) {
    const option = ref.profil_options.find((o) => o.champ === champ && o.code === profil[champ]);
    libelles[champ] = option ? option.libelle_fr : '';
  }
  const commun = { diagnostic_id: id, date: horodatage, ...libelles };
  const diagnostic = { id, date: horodatage, langue, ...libelles, score_global: scores.global, ...reponses };
  for (const a of scores.axes) diagnostic[`score_${a.id}`] = a.score;
  const lignes = questionsActives(ref)
    .filter((q) => reponses[q.id] !== undefined)
    .map((q) => ({ ...commun, axe: q.axe.titre_fr, question_id: q.id, question: q.intitule_fr, niveau: reponses[q.id] }));
  return { diagnostic, reponses: lignes };
}
