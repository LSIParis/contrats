-- Descriptions riches (HTML assaini par l'API) des lignes de barème
-- (docs/contrats/13-types-contrats.md §3). Migration ADDITIVE : une colonne
-- NULLABLE. Retour arrière : prisma/rollback/00000000000035_descriptions_lignes.down.sql.
--
-- Les codes de la grille (price_grid_items.description) et les lignes de
-- modèle de proposition (proposal_template_pricing_lines.description) ont déjà
-- une colonne `text` ; la limite (20 000 caractères) est portée par l'API.

ALTER TABLE pricing_lines ADD COLUMN description text
  CHECK (description IS NULL OR length(description) <= 20000);
