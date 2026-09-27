-- Lot 4 : signature électronique DocuSeal Pro (06-docuseal.md). Migration ADDITIVE.

-- Voie de création : PDF figé (nominale) ou modèle DocuSeal figé (secondaire).
CREATE TYPE "SignatureMode" AS ENUM ('PDF', 'TEMPLATE');
-- Remise : lien par e-mail, ou signature intégrée dans l'application.
CREATE TYPE "SignatureDelivery" AS ENUM ('EMAIL', 'EMBEDDED');
-- Lien entre l'empreinte ENVOYÉE et l'empreinte du document SIGNÉ rapatrié.
CREATE TYPE "HashRelation" AS ENUM ('IDENTICAL', 'SIGNED_OVERLAY');

ALTER TABLE signature_requests
  ADD COLUMN mode                "SignatureMode"     NOT NULL DEFAULT 'PDF',
  ADD COLUMN delivery            "SignatureDelivery" NOT NULL DEFAULT 'EMAIL',
  -- Politique d'ordre retenue à l'envoi (CLIENT_THEN_LSI par défaut, brief §7).
  ADD COLUMN signing_order       text CHECK (signing_order IS NULL OR signing_order IN ('CLIENT_THEN_LSI', 'LSI_THEN_CLIENT', 'PARALLEL', 'AS_DEFINED')),
  -- Empreinte du PDF effectivement ENVOYÉ (= contract_versions.pdf_sha256 au
  -- moment de l'envoi), recopiée ici : la preuve de la soumission ne dépend
  -- pas d'une autre ligne.
  ADD COLUMN sent_pdf_sha256     char(64) CHECK (sent_pdf_sha256 IS NULL OR sent_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN hash_relation       "HashRelation",
  ADD COLUMN audit_trail_sha256  char(64) CHECK (audit_trail_sha256 IS NULL OR audit_trail_sha256 ~ '^[0-9a-f]{64}$');

-- Soumissions sans nouvelle depuis `p_stale_minutes` (webhook perdu) : la
-- tâche de réconciliation relit leur état chez DocuSeal. Identifiants seuls.
CREATE OR REPLACE FUNCTION app_find_signatures_needing_sync(p_stale_minutes int DEFAULT 60, p_limit int DEFAULT 200)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid, provider_submission_id text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.customer_id, s.provider_submission_id
    FROM signature_requests s
   WHERE s.status IN ('SENT', 'PARTIALLY_COMPLETED')
     AND s.provider_submission_id IS NOT NULL
     AND (s.last_synced_at IS NULL OR s.last_synced_at < now() - make_interval(mins => p_stale_minutes))
   ORDER BY s.last_synced_at NULLS FIRST
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_signatures_needing_sync(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_signatures_needing_sync(int, int) TO lsi_app;
