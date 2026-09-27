-- Lot 9 — propositions : conversion en contrat et preuves de signature. Migration ADDITIVE.

-- Date d'effet souhaitée (brief §12.7 : reprise par le contrat généré) et
-- dernière erreur de conversion (ex. contrat type introuvable, annexe C
-- règle 8) : visible dans l'interface, la conversion est retentée.
ALTER TABLE proposals
  ADD COLUMN desired_start_date date,
  ADD COLUMN conversion_error text;

-- Soumissions de proposition COMPLÉTÉES dont les preuves (PDF signé, journal)
-- ne sont pas encore rapatriées : la proposition ne passe SIGNÉE qu'après
-- l'archivage local (brief §12.6, 4). Identifiants seuls.
CREATE OR REPLACE FUNCTION app_find_proposal_signatures_needing_proof(p_limit int DEFAULT 100)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid, proposal_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.customer_id, s.proposal_id
    FROM proposal_signature_requests s
   WHERE s.status = 'COMPLETED'
     AND s.signed_pdf_object_key IS NULL
   ORDER BY s.updated_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_proposal_signatures_needing_proof(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_proposal_signatures_needing_proof(int) TO lsi_app;
