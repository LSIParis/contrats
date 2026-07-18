-- Découverte des preuves à (re)capturer. (EC-06, §11.6)
--
-- Filet de sécurité : si le job de capture a échoué (coupure réseau au
-- téléchargement du PDF signé), la signature_request reste COMPLETED SANS
-- signed_pdf_object_key. La réconciliation les retrouve et réenfile la
-- capture.
--
-- Traverse les tenants (comme la découverte des rappels) : SECURITY DEFINER
-- borné, ne renvoie que des identifiants de scope, aucun contenu.

CREATE OR REPLACE FUNCTION app_find_signatures_needing_proof(p_limit int DEFAULT 200)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT sr.id, sr.tenant_id, sr.customer_id
    FROM signature_requests sr
   WHERE sr.status = 'COMPLETED'
     AND sr.signed_pdf_object_key IS NULL
     AND sr.provider_submission_id IS NOT NULL
   ORDER BY sr.updated_at
   LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION app_find_signatures_needing_proof(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_signatures_needing_proof(int) TO lsi_app;
