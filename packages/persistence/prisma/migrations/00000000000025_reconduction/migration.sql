-- Lot 5 : reconduction tacite, renouvellement exprès (02-cycle-de-vie §5).
-- Migration ADDITIVE : fonctions de découverte seulement (identifiants de scope).

-- Date limite de dénonciation = terme − préavis (jours OU mois).
-- Même règle que packages/domain/src/contract/dates.ts (noticeDeadline) ; le
-- rabattement de fin de mois de PostgreSQL (`date - interval '1 month'`)
-- coïncide avec addMonthsClamped.
CREATE OR REPLACE FUNCTION app_notice_deadline(p_end date, p_days int, p_months int)
  RETURNS date
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT (p_end - make_interval(months => coalesce(p_months, 0), days => coalesce(p_days, 0)))::date
$$;

-- Reconduction TACITE due : période échue sans dénonciation (le contrat est
-- encore ACTIVE ou RENEWAL_DUE, donc aucune résiliation n'a été programmée).
CREATE OR REPLACE FUNCTION app_find_tacit_renewals_due(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.type = 'MAIN'
     AND c.status IN ('ACTIVE', 'RENEWAL_DUE')
     AND c.renewal_mode = 'TACIT'
     AND c.renewal_period_months IS NOT NULL
     AND c.end_date IS NOT NULL
     AND c.end_date < CURRENT_DATE
   ORDER BY c.end_date
   LIMIT p_limit
$$;

-- Renouvellement EXPRÈS à ouvrir : date limite de dénonciation atteinte.
CREATE OR REPLACE FUNCTION app_find_express_renewals_to_open(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.type = 'MAIN'
     AND c.status = 'ACTIVE'
     AND c.renewal_mode = 'EXPRESS'
     AND c.end_date IS NOT NULL
     AND app_notice_deadline(c.end_date, c.notice_period_days, c.notice_period_months) <= CURRENT_DATE
   ORDER BY c.end_date
   LIMIT p_limit
$$;

-- Expiration : les contrats à reconduction TACITE ne s'éteignent pas à leur
-- terme (ils sont reconduits) ; un renouvellement exprès non décidé expire.
CREATE OR REPLACE FUNCTION app_find_contracts_to_expire(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.status IN ('ACTIVE', 'RENEWAL_DUE')
     AND c.renewal_mode <> 'TACIT'
     AND c.end_date IS NOT NULL
     AND c.end_date < CURRENT_DATE
   ORDER BY c.end_date
   LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION app_find_tacit_renewals_due(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_express_renewals_to_open(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_contracts_to_expire(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_tacit_renewals_due(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_express_renewals_to_open(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_contracts_to_expire(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_notice_deadline(date, int, int) TO lsi_app;
