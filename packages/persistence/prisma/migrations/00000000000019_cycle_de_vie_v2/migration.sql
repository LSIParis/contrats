-- Cycle de vie v2 (docs/contrats/02-cycle-de-vie.md). Migration ADDITIVE.

-- ===========================================================================
-- Statuts, origine, mode de reconduction
-- ===========================================================================

-- (Nouvelles valeurs d'énumération : migration 18, qui doit être COMMITÉE
-- avant que cette migration ne les utilise — règle PostgreSQL 55P04.)

-- NONE = comportement historique (le contrat expire à son terme). Les
-- contrats existants restent NONE, y compris ceux dont auto_renew_intent est
-- vrai : basculer d'office en TACIT ferait reconduire automatiquement des
-- contrats dont personne n'a relu les clauses. Ils sont listés pour revue
-- (RESTITUTION.md) — décision humaine, pas migration silencieuse.
CREATE TYPE "RenewalMode" AS ENUM ('NONE', 'TACIT', 'EXPRESS');
CREATE TYPE "AcceptanceMethod" AS ENUM ('PORTAL', 'RECORDED_BY_STAFF');
CREATE TYPE "ContractPeriodKind" AS ENUM ('INITIAL', 'TACIT_RENEWAL', 'EXPRESS_RENEWAL');

-- ===========================================================================
-- contracts : acceptation, reconduction, préavis en mois, résiliation
-- ===========================================================================

ALTER TABLE contracts
  ADD COLUMN accepted_version_id       uuid,
  ADD COLUMN renewal_mode              "RenewalMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN renewal_period_months     integer CHECK (renewal_period_months IS NULL OR renewal_period_months BETWEEN 1 AND 120),
  ADD COLUMN notice_period_months      integer CHECK (notice_period_months IS NULL OR notice_period_months BETWEEN 0 AND 60),
  -- NULL = déduit du client (Customer.is_consumer) ; TRUE/FALSE = forcé.
  ADD COLUMN chatel_notice             boolean,
  ADD COLUMN termination_effective_date date,
  -- Contrats rédigés par IA : clauses non encore validées par un humain.
  ADD COLUMN unreviewed_ai_clauses     integer NOT NULL DEFAULT 0 CHECK (unreviewed_ai_clauses >= 0);

-- Préavis en jours OU en mois : jamais les deux (ambiguïté contractuelle).
ALTER TABLE contracts ADD CONSTRAINT contracts_notice_unit_ck
  CHECK (notice_period_days IS NULL OR notice_period_months IS NULL);
-- Reconduction ⇒ durée de reconduction connue.
ALTER TABLE contracts ADD CONSTRAINT contracts_renewal_period_ck
  CHECK (renewal_mode = 'NONE' OR renewal_period_months IS NOT NULL);

-- ===========================================================================
-- customers / contacts
-- ===========================================================================

ALTER TABLE customers
  -- Consommateur ou non-professionnel : déclenche l'obligation d'information
  -- de la loi Chatel (L215-1 C. conso.).
  ADD COLUMN is_consumer  boolean NOT NULL DEFAULT false,
  -- Référence du client dans Client Help (synchronisation) ou saisie locale.
  ADD COLUMN external_ref text;
CREATE UNIQUE INDEX customers_tenant_external_ref_key ON customers (tenant_id, external_ref);

-- « Qualité à signer » : fonction habilitant à engager la société
-- (gérant, président, directeur général, mandataire…).
ALTER TABLE customer_contacts ADD COLUMN signing_capacity text;

-- ===========================================================================
-- contract_acceptances : trace de l'acceptation (distincte de la signature)
-- ===========================================================================

CREATE TABLE contract_acceptances (
  id                   uuid               PRIMARY KEY,
  tenant_id            uuid               NOT NULL,
  customer_id          uuid               NOT NULL,
  contract_id          uuid               NOT NULL,
  version_id           uuid               NOT NULL,
  method               "AcceptanceMethod" NOT NULL,
  accepted_by_user_id  uuid,
  accepted_by_name     text               NOT NULL,
  accepted_by_email    text               NOT NULL,
  -- Empreinte du rendu PDF de la version acceptée, si elle existe déjà :
  -- ce que le client a eu sous les yeux, pas seulement un identifiant.
  version_pdf_sha256   char(64)           CHECK (version_pdf_sha256 IS NULL OR version_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  ip                   text,
  user_agent           text,
  accepted_at          timestamp(3)       NOT NULL,
  -- Pour une acceptation saisie par LSI (e-mail, courrier) : la pièce qui la prouve.
  evidence_note        text,
  CONSTRAINT contract_acceptances_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT contract_acceptances_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES contract_versions (id, tenant_id, customer_id),
  CONSTRAINT contract_acceptances_staff_evidence_ck
    CHECK (method = 'PORTAL' OR evidence_note IS NOT NULL)
);
CREATE INDEX contract_acceptances_contract_idx ON contract_acceptances (tenant_id, customer_id, contract_id);

ALTER TABLE contract_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_acceptances FORCE ROW LEVEL SECURITY;
-- Le CLIENT peut créer et lire l'acceptation de SES contrats (portail).
CREATE POLICY contract_acceptances_scope ON contract_acceptances
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));
REVOKE UPDATE, DELETE, TRUNCATE ON contract_acceptances FROM lsi_app;

-- ===========================================================================
-- contract_periods : historique des périodes (initiale, reconductions)
-- ===========================================================================

CREATE TABLE contract_periods (
  id                 uuid                 PRIMARY KEY,
  tenant_id          uuid                 NOT NULL,
  customer_id        uuid                 NOT NULL,
  contract_id        uuid                 NOT NULL,
  period_number      integer              NOT NULL CHECK (period_number >= 1),
  kind               "ContractPeriodKind" NOT NULL,
  start_date         date                 NOT NULL,
  end_date           date                 NOT NULL CHECK (end_date >= start_date),
  created_by_user_id uuid,
  created_at         timestamp(3)         NOT NULL,
  CONSTRAINT contract_periods_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT contract_periods_number_key UNIQUE (contract_id, period_number)
);
CREATE INDEX contract_periods_contract_idx ON contract_periods (tenant_id, customer_id, contract_id);

ALTER TABLE contract_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_periods_scope ON contract_periods
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON contract_periods FROM lsi_app;

-- Backfill : une période INITIALE pour chaque contrat daté existant, afin que
-- l'historique des périodes soit complet dès la mise en service.
-- Fonction plutôt que INSERT nu : elle est rejouable (idempotente) et TESTÉE
-- (packages/persistence/tests/isolation/cycle-de-vie-v2.test.ts).
CREATE OR REPLACE FUNCTION app_backfill_initial_periods() RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO contract_periods (id, tenant_id, customer_id, contract_id, period_number, kind,
                                start_date, end_date, created_by_user_id, created_at)
  SELECT gen_random_uuid(), c.tenant_id, c.customer_id, c.id, 1, 'INITIAL',
         c.start_date, c.end_date, NULL, now()
    FROM contracts c
   WHERE c.start_date IS NOT NULL AND c.end_date IS NOT NULL AND c.end_date >= c.start_date
     AND NOT EXISTS (SELECT 1 FROM contract_periods p WHERE p.contract_id = c.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION app_backfill_initial_periods() FROM PUBLIC;

SELECT app_backfill_initial_periods();

-- ===========================================================================
-- Découverte : résiliations dont la date d'effet est atteinte
-- ===========================================================================
-- Même patron que app_find_contracts_to_activate (migration 11) : fonction
-- SECURITY DEFINER bornée qui ne renvoie que des identifiants de scope ; la
-- transition s'applique ensuite DANS le scope, sous RLS, via le domaine.
CREATE OR REPLACE FUNCTION app_find_terminations_due(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.status = 'TERMINATION_PENDING'
     AND c.termination_effective_date IS NOT NULL
     AND c.termination_effective_date <= CURRENT_DATE
   ORDER BY c.termination_effective_date
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_terminations_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_terminations_due(int) TO lsi_app;
