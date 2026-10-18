// Lancer depuis la racine du dépôt : node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  questionnairePublic,
  validerSaisie,
  calculerScores,
  construireFeuilleDeRoute,
} from '../netlify/lib/diagnostic.mjs';

const niveaux = [1, 2, 3, 4, 5].map((n) => ({ niveau: n, libelle_fr: `N${n}`, libelle_en: `L${n}` }));
const reponsesPour = (id) => [1, 2, 3, 4, 5].map((n) => ({ question_id: id, niveau: n, libelle_fr: `${id} niveau ${n}` }));

function referentiel() {
  return {
    niveaux,
    axes: [
      { id: 'b', ordre: 2, titre_fr: 'Axe B', actif: true },
      { id: 'a', ordre: 1, titre_fr: 'Axe A', titre_en: 'Axis A', actif: true },
      { id: 'off', ordre: 3, titre_fr: 'Axe inactif', actif: false },
    ],
    questions: [
      { id: 'A1', axe_id: 'a', ordre: 1, intitule_fr: 'Question A1', poids: 1, actif: true },
      { id: 'A2', axe_id: 'a', ordre: 2, intitule_fr: 'Question A2', poids: 3, actif: true },
      { id: 'B1', axe_id: 'b', ordre: 1, intitule_fr: 'Question B1', poids: 1, actif: true },
      { id: 'X1', axe_id: 'a', ordre: 3, intitule_fr: 'Question inactive', poids: 1, actif: false },
      { id: 'O1', axe_id: 'off', ordre: 1, intitule_fr: 'Question d’un axe inactif', poids: 1, actif: true },
    ],
    reponses_possibles: [...reponsesPour('A1'), ...reponsesPour('A2'), ...reponsesPour('B1'), ...reponsesPour('X1'), ...reponsesPour('O1')],
    // B1 ne peut pas passer au niveau 3 tant que A1 n'est pas au niveau 3.
    dependances: [{ question_id: 'B1', niveau_cible: 3, prerequis_question_id: 'A1', prerequis_niveau_min: 3, commentaire: 'A1 d’abord' }],
    actions: [
      { question_id: 'A1', niveau_depart: 1, ordre: 2, titre_fr: 'A1 action 2', actif: true },
      { question_id: 'A1', niveau_depart: 1, ordre: 1, titre_fr: 'A1 action 1', actif: true },
      { question_id: 'A1', niveau_depart: 1, ordre: 3, titre_fr: 'A1 action désactivée', actif: false },
      { question_id: 'B1', niveau_depart: 2, ordre: 1, titre_fr: 'B1 vers 3', actif: true },
    ],
    parametres: [
      { cle: 'roadmap_vagues', valeur: '3' },
      { cle: 'roadmap_etapes_par_vague', valeur: '2' },
      { cle: 'roadmap_libelles_fr', valeur: 'Maintenant|Ensuite|Puis' },
    ],
    profil_options: [
      { champ: 'fonction', code: 'rh', ordre: 1, libelle_fr: 'RH', actif: true },
      { champ: 'taille', code: 'eti', ordre: 1, libelle_fr: 'ETI', actif: true },
    ],
  };
}

test('le questionnaire public ne contient que les éléments actifs, triés, sans actions ni dépendances', () => {
  const q = questionnairePublic(referentiel(), 'fr');
  assert.deepEqual(q.axes.map((a) => a.id), ['a', 'b']);
  assert.deepEqual(q.axes[0].questions.map((x) => x.id), ['A1', 'A2']);
  assert.equal(q.axes[0].questions[0].reponses.length, 5);
  assert.equal(q.niveaux.length, 5);
  assert.deepEqual(q.profil.fonction, [{ code: 'rh', libelle: 'RH' }]);
  const texte = JSON.stringify(q);
  assert.ok(!texte.includes('action'));
  assert.ok(!texte.includes('A1 d’abord'));
});

test('anglais avec repli sur le français', () => {
  const q = questionnairePublic(referentiel(), 'en');
  assert.equal(q.axes[0].titre, 'Axis A');
  assert.equal(q.axes[1].titre, 'Axe B');
  assert.equal(q.niveaux[0].libelle, 'L1');
});

test('validation : toutes les questions actives, niveaux existants, profil filtré', () => {
  const ref = referentiel();
  assert.ok(validerSaisie(ref, { reponses: { A1: 1, A2: 2 } }).erreur);
  assert.ok(validerSaisie(ref, { reponses: { A1: 1, A2: 2, B1: 6 } }).erreur);
  assert.ok(validerSaisie(ref, { reponses: { A1: 1, A2: 2, B1: '3' } }).erreur);
  assert.ok(validerSaisie(ref, { reponses: { A1: 1, A2: 2, B1: 3, X1: 2 } }).erreur);
  assert.ok(validerSaisie(ref, { reponses: { A1: 1, A2: 2, B1: 3 }, site_web: 'spam' }).erreur);
  assert.ok(validerSaisie(ref, null).erreur);
  const ok = validerSaisie(ref, { reponses: { A1: 1, A2: 2, B1: 3 }, profil: { fonction: 'rh', taille: 'inconnue' }, langue: 'de' });
  assert.equal(ok.erreur, undefined);
  assert.deepEqual(ok.profil, { fonction: 'rh', taille: null, secteur: null });
  assert.equal(ok.langue, 'fr');
});

test('scores pondérés par axe et score global', () => {
  const s = calculerScores(referentiel(), { A1: 1, A2: 5, B1: 2 }, 'fr');
  assert.deepEqual(s.axes, [
    { id: 'a', titre: 'Axe A', score: 4 }, // (1×1 + 5×3) / 4
    { id: 'b', titre: 'Axe B', score: 2 },
  ]);
  assert.equal(s.global, 3);
});

test('feuille de route : niveaux bas d’abord, limite par vague, dépendances respectées', () => {
  const vagues = construireFeuilleDeRoute(referentiel(), { A1: 1, A2: 4, B1: 2 }, 'fr');
  assert.equal(vagues.length, 3);
  assert.deepEqual(vagues.map((v) => v.libelle), ['Maintenant', 'Ensuite', 'Puis']);

  // Vague 1 : A1 (niveau 1) en premier. B1 2→3 bloquée (A1 < 3), donc A2 4→5.
  assert.deepEqual(vagues[0].etapes.map((e) => `${e.question_id}:${e.de}>${e.vers}`), ['A1:1>2', 'A2:4>5']);
  assert.deepEqual(vagues[0].etapes[0].actions.map((a) => a.titre), ['A1 action 1', 'A1 action 2']);
  assert.equal(vagues[0].etapes[0].cible, 'A1 niveau 2');

  // Vague 2 : A1 2→3. B1 toujours bloquée.
  assert.deepEqual(vagues[1].etapes.map((e) => `${e.question_id}:${e.de}>${e.vers}`), ['A1:2>3']);

  // Vague 3 : B1 débloquée, avec son prérequis affiché.
  const b1 = vagues[2].etapes.find((e) => e.question_id === 'B1');
  assert.ok(b1);
  assert.equal(b1.de, 2);
  assert.deepEqual(b1.prerequis.map((p) => [p.question_id, p.niveau_min]), [['A1', 3]]);
  assert.deepEqual(b1.actions.map((a) => a.titre), ['B1 vers 3']);
});

test('feuille de route vide quand tout est au niveau maximum', () => {
  assert.deepEqual(construireFeuilleDeRoute(referentiel(), { A1: 5, A2: 5, B1: 5 }, 'fr'), []);
});

test('une dépendance vers une question désactivée est ignorée', () => {
  const ref = referentiel();
  ref.dependances = [{ question_id: 'B1', niveau_cible: 3, prerequis_question_id: 'X1', prerequis_niveau_min: 5 }];
  const vagues = construireFeuilleDeRoute(ref, { A1: 5, A2: 5, B1: 2 }, 'fr');
  assert.equal(vagues[0].etapes[0].question_id, 'B1');
});
