-- Retour arrière de la migration 00000000000034_types_contrats.
--
-- Prisma n'a pas de migration descendante : ce script se joue À LA MAIN
-- (propriétaire de la base), PUIS on retire la ligne de _prisma_migrations
-- pour que `migrate deploy` puisse rejouer la montée :
--
--   psql "$DATABASE_URL" -f prisma/rollback/00000000000034_types_contrats.down.sql
--
-- DESTRUCTIF : types de contrats, codes et historique des prix sont perdus
-- (sauvegarde préalable, docs/contrats/09-exploitation.md §11). Couvert par
-- tests/isolation/types-contrats-rollback.test.ts (montée → descente → montée).

BEGIN;

DROP TABLE IF EXISTS price_grid_prices;
DROP TABLE IF EXISTS price_grid_variants;
DROP TABLE IF EXISTS price_grid_items;
DROP TABLE IF EXISTS commitment_terms;
DROP TABLE IF EXISTS contract_kinds;

DROP FUNCTION IF EXISTS app_assign_price_grid_variant_code();
DROP FUNCTION IF EXISTS app_assign_price_grid_item_code();
DROP FUNCTION IF EXISTS app_guard_contract_kind();

ALTER TABLE contract_template_versions DROP COLUMN IF EXISTS effective_from;
ALTER TABLE proposal_template_pricing_lines DROP COLUMN IF EXISTS grid;

DELETE FROM _prisma_migrations WHERE migration_name = '00000000000034_types_contrats';

COMMIT;
