-- Découverte des contrats dont le cycle de vie doit avancer. (RM-06, RM-07, §7)
--
-- Le rôle lsi_scheduler est BORNÉ à la lecture des reminders (§12.3) et ne
-- peut PAS lire contracts — un test l'impose. La découverte des contrats à
-- activer/expirer emprunte donc le même patron que la réconciliation des
-- preuves : une fonction SECURITY DEFINER bornée, exécutée sous lsi_app, qui
-- ne renvoie que des identifiants de scope. Aucun troisième rôle hors scope.

-- À activer : signés dont la date de début est atteinte (RM-06).
CREATE OR REPLACE FUNCTION app_find_contracts_to_activate(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.status = 'SIGNED'
     AND c.start_date IS NOT NULL
     AND c.start_date <= CURRENT_DATE
   ORDER BY c.start_date
   LIMIT p_limit
$$;

-- À expirer : actifs dont le terme est dépassé (RM-07). Le domaine tranchera
-- EXPIRED vs RENEWED selon l'existence d'un successeur signé.
CREATE OR REPLACE FUNCTION app_find_contracts_to_expire(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.status = 'ACTIVE'
     AND c.end_date IS NOT NULL
     AND c.end_date < CURRENT_DATE
   ORDER BY c.end_date
   LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION app_find_contracts_to_activate(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_contracts_to_expire(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_contracts_to_activate(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_contracts_to_expire(int) TO lsi_app;
