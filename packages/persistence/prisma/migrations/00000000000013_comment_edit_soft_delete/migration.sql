-- §6.10 différée B : traçage édition + suppression douce des commentaires.
-- Aucune policy RLS à changer : comments_scope est au niveau ligne, indépendant
-- des colonnes. La suppression est DOUCE (la ligne reste, le corps est masqué
-- côté application) pour préserver une trace en l'absence de journal d'audit.
ALTER TABLE comments
  ADD COLUMN edited_at          timestamptz,
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_by_user_id uuid;
