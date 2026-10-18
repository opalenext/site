# opalenext.fr

Site vitrine d'Opale Next (Vincent Dupuis). Site statique, déployé par Netlify à chaque push sur `main`.

## Diagnostic 4 Shifts
- Page : `diagnostic.html`. Elle ne contient aucune question : tout vient de `/api/diagnostic`.
- API : `netlify/functions/diagnostic.mjs`, logique dans `netlify/lib/`.
- Base : Supabase, schéma dans `db/schema.sql`. Variables Netlify : `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
- Tests : `node --test`.

## À compléter avant mise en ligne
- [x] Photo portrait (section À propos)
- [x] Numéro SIREN (pied de page)
- [x] Page mentions légales
- [ ] Liens LinkedIn et articles (section Réflexions)
