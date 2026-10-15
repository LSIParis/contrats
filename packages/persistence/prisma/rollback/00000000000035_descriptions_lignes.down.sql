-- Retour arrière de la migration 00000000000035_descriptions_lignes (à jouer
-- en propriétaire, avant celui de la migration 34 si les deux sont annulés).
-- DESTRUCTIF : les descriptions des lignes de barème sont perdues.

BEGIN;

ALTER TABLE pricing_lines DROP COLUMN IF EXISTS description;

DELETE FROM _prisma_migrations WHERE migration_name = '00000000000035_descriptions_lignes';

COMMIT;
