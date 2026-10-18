-- Diagnostic 4 Shifts : schéma de la base (Supabase / PostgreSQL 15+).
-- À exécuter une fois dans Supabase > SQL Editor. Ré-exécutable sans perte de données.
--
-- Deux familles de tables :
--   1. Le référentiel (axes, niveaux, questions, réponses possibles, dépendances, actions,
--      paramètres, listes du profil). Modifiable dans Supabase > Table Editor.
--   2. Les résultats (diagnostics, diagnostic_reponses). Écrits uniquement par la fonction
--      Netlify, lus pour les statistiques (vues stats_*).
--
-- Aucune table n'est lisible avec la clé publique (anon) : RLS activé, sans politique.
-- Seule la clé secrète, stockée dans les variables d'environnement Netlify, y accède.

-- ---------------------------------------------------------------------------
-- 1. Référentiel
-- ---------------------------------------------------------------------------

-- Les quatre shifts.
create table if not exists axes (
  id             text primary key,                 -- code stable, ex. 'organisation'
  ordre          int  not null default 0,
  titre_fr       text not null,
  titre_en       text,
  description_fr text,
  description_en text,
  actif          boolean not null default true
);

-- L'échelle de maturité, commune à toutes les questions.
create table if not exists niveaux (
  niveau         smallint primary key check (niveau between 1 and 5),
  libelle_fr     text not null,
  libelle_en     text,
  description_fr text,
  description_en text
);

create table if not exists questions (
  id          text primary key,                    -- code stable, ex. 'ORG-1'
  axe_id      text not null references axes(id) on update cascade,
  ordre       int  not null default 0,
  intitule_fr text not null,
  intitule_en text,
  aide_fr     text,
  aide_en     text,
  poids       numeric not null default 1 check (poids > 0),
  actif       boolean not null default true
);

-- Pour chaque question, la description de chaque niveau (ce que le répondant choisit).
create table if not exists reponses_possibles (
  question_id text     not null references questions(id) on update cascade on delete cascade,
  niveau      smallint not null references niveaux(niveau),
  libelle_fr  text     not null,
  libelle_en  text,
  primary key (question_id, niveau)
);

-- « Pour atteindre le niveau niveau_cible sur question_id, il faut d'abord
--   être au moins au niveau prerequis_niveau_min sur prerequis_question_id. »
create table if not exists dependances (
  id                    bigint generated always as identity primary key,
  question_id           text     not null references questions(id) on update cascade on delete cascade,
  niveau_cible          smallint not null references niveaux(niveau),
  prerequis_question_id text     not null references questions(id) on update cascade on delete cascade,
  prerequis_niveau_min  smallint not null references niveaux(niveau),
  commentaire           text,
  unique (question_id, niveau_cible, prerequis_question_id),
  check (question_id <> prerequis_question_id),
  check (niveau_cible >= 2)
);

-- Les actions de la feuille de route : passer de niveau_depart à niveau_depart + 1.
-- Plusieurs actions possibles par marche (triées par ordre).
create table if not exists actions (
  id             bigint generated always as identity primary key,
  question_id    text     not null references questions(id) on update cascade on delete cascade,
  niveau_depart  smallint not null check (niveau_depart between 1 and 4),
  ordre          int      not null default 0,
  titre_fr       text     not null,
  titre_en       text,
  description_fr text,
  description_en text,
  duree_semaines int check (duree_semaines > 0),     -- estimation indicative
  offre          text,                             -- offre Opale Next associée, ex. 'leanai'
  actif          boolean  not null default true
);
create index if not exists actions_question_idx on actions (question_id, niveau_depart);

-- Réglages de la feuille de route et textes courts.
create table if not exists parametres (
  cle         text primary key,
  valeur      text not null,
  description text
);

-- Listes déroulantes du profil (facultatif, anonyme).
create table if not exists profil_options (
  champ      text not null check (champ in ('fonction', 'taille', 'secteur')),
  code       text not null,
  ordre      int  not null default 0,
  libelle_fr text not null,
  libelle_en text,
  actif      boolean not null default true,
  primary key (champ, code)
);

-- ---------------------------------------------------------------------------
-- 2. Résultats
-- ---------------------------------------------------------------------------

create table if not exists diagnostics (
  id           uuid primary key default gen_random_uuid(),
  cree_le      timestamptz not null default now(),
  langue       text not null default 'fr' check (langue in ('fr', 'en')),
  fonction     text,
  taille       text,
  secteur      text,
  score_global numeric(4, 2),
  scores_axes  jsonb          -- { "organisation": 2.5, ... } au moment de la réponse
);
create index if not exists diagnostics_cree_le_idx on diagnostics (cree_le);

-- Une ligne par question répondue. on delete restrict : une question qui a reçu des
-- réponses ne peut pas être supprimée. Pour la retirer, passer actif à false.
create table if not exists diagnostic_reponses (
  diagnostic_id uuid     not null references diagnostics(id) on delete cascade,
  question_id   text     not null references questions(id) on update cascade on delete restrict,
  niveau        smallint not null references niveaux(niveau),
  primary key (diagnostic_id, question_id)
);
create index if not exists diagnostic_reponses_question_idx on diagnostic_reponses (question_id);

-- Enregistre un diagnostic et ses réponses en une seule transaction.
-- payload : { langue, fonction, taille, secteur, score_global, scores_axes, reponses: { "ORG-1": 3, ... } }
create or replace function enregistrer_diagnostic(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  nouvel_id uuid;
begin
  insert into diagnostics (langue, fonction, taille, secteur, score_global, scores_axes)
  values (
    coalesce(payload->>'langue', 'fr'),
    nullif(payload->>'fonction', ''),
    nullif(payload->>'taille', ''),
    nullif(payload->>'secteur', ''),
    (payload->>'score_global')::numeric,
    payload->'scores_axes'
  )
  returning id into nouvel_id;

  insert into diagnostic_reponses (diagnostic_id, question_id, niveau)
  select nouvel_id, r.key, r.value::smallint
  from jsonb_each_text(payload->'reponses') as r;

  return nouvel_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Statistiques (Supabase > Table Editor, ou export CSV)
-- ---------------------------------------------------------------------------

-- Par question : nombre de réponses, niveau moyen, répartition par niveau.
create or replace view stats_questions with (security_invoker = true) as
select
  q.axe_id,
  q.id                                         as question_id,
  q.intitule_fr,
  q.actif,
  count(r.niveau)                              as nb_reponses,
  round(avg(r.niveau), 2)                      as niveau_moyen,
  count(*) filter (where r.niveau = 1)         as n1,
  count(*) filter (where r.niveau = 2)         as n2,
  count(*) filter (where r.niveau = 3)         as n3,
  count(*) filter (where r.niveau = 4)         as n4,
  count(*) filter (where r.niveau = 5)         as n5
from questions q
left join diagnostic_reponses r on r.question_id = q.id
group by q.axe_id, q.id, q.intitule_fr, q.actif;

-- Par axe : score moyen calculé à partir des réponses détaillées.
create or replace view stats_axes with (security_invoker = true) as
select
  a.id                                         as axe_id,
  a.titre_fr,
  count(distinct r.diagnostic_id)              as nb_diagnostics,
  round(sum(r.niveau * q.poids) / nullif(sum(q.poids) filter (where r.niveau is not null), 0), 2) as score_moyen
from axes a
left join questions q on q.axe_id = a.id
left join diagnostic_reponses r on r.question_id = q.id
group by a.id, a.titre_fr;

-- Par mois.
create or replace view stats_mois with (security_invoker = true) as
select
  date_trunc('month', cree_le)::date           as mois,
  count(*)                                     as nb_diagnostics,
  round(avg(score_global), 2)                  as score_global_moyen
from diagnostics
group by 1
order by 1;

-- Par profil (fonction × taille).
create or replace view stats_profils with (security_invoker = true) as
select
  coalesce(fonction, '(non renseigné)')        as fonction,
  coalesce(taille, '(non renseigné)')          as taille,
  count(*)                                     as nb_diagnostics,
  round(avg(score_global), 2)                  as score_global_moyen
from diagnostics
group by 1, 2;

-- ---------------------------------------------------------------------------
-- 4. Sécurité
-- ---------------------------------------------------------------------------

alter table axes                enable row level security;
alter table niveaux             enable row level security;
alter table questions           enable row level security;
alter table reponses_possibles  enable row level security;
alter table dependances         enable row level security;
alter table actions             enable row level security;
alter table parametres          enable row level security;
alter table profil_options      enable row level security;
alter table diagnostics         enable row level security;
alter table diagnostic_reponses enable row level security;

-- Ceinture et bretelles : les rôles publics de Supabase n'ont aucun droit.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke execute on function enregistrer_diagnostic(jsonb) from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function enregistrer_diagnostic(jsonb) to service_role';
  end if;
end;
$$;
