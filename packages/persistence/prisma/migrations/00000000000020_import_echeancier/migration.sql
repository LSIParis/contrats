-- Lot 1 : reprise des contrats existants (03-import-existant.md) et échéancier
-- (02-cycle-de-vie.md §6). Migration ADDITIVE.

-- ===========================================================================
-- contract_imports : pipeline OCR → extraction → validation humaine
-- ===========================================================================

CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

CREATE TABLE contract_imports (
  id                    uuid         PRIMARY KEY,
  tenant_id             uuid         NOT NULL,
  customer_id           uuid         NOT NULL,
  contract_id           uuid         NOT NULL UNIQUE,
  -- L'ORIGINAL (stored_documents LEGACY_SCAN, écriture unique).
  original_document_id  uuid         NOT NULL,
  ocr_pdf_document_id   uuid,
  ocr_text_document_id  uuid,
  ocr_status            "OcrStatus"  NOT NULL DEFAULT 'PENDING',
  ocr_attempts          integer      NOT NULL DEFAULT 0,
  ocr_pages             integer,
  ocr_error             text,
  -- Proposition d'extraction : { champ: { value, confidence, evidence, method } }.
  extraction            jsonb,
  extraction_method     text         CHECK (extraction_method IS NULL OR extraction_method IN ('RULES', 'RULES+LLM')),
  extracted_at          timestamp(3),
  -- Ce que l'humain a RETENU (peut différer de la proposition) et qui.
  validated_fields      jsonb,
  validated_by_user_id  uuid,
  validated_at          timestamp(3),
  created_by_user_id    uuid         NOT NULL,
  created_at            timestamp(3) NOT NULL,
  updated_at            timestamp(3) NOT NULL,

  CONSTRAINT contract_imports_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT contract_imports_original_fk FOREIGN KEY (original_document_id, tenant_id, customer_id)
    REFERENCES stored_documents (id, tenant_id, customer_id),
  CONSTRAINT contract_imports_ocr_pdf_fk FOREIGN KEY (ocr_pdf_document_id, tenant_id, customer_id)
    REFERENCES stored_documents (id, tenant_id, customer_id),
  CONSTRAINT contract_imports_ocr_text_fk FOREIGN KEY (ocr_text_document_id, tenant_id, customer_id)
    REFERENCES stored_documents (id, tenant_id, customer_id),
  -- Validé ⇔ qui ET quand ET quoi.
  CONSTRAINT contract_imports_validation_ck CHECK (
    (validated_at IS NULL AND validated_by_user_id IS NULL AND validated_fields IS NULL)
    OR (validated_at IS NOT NULL AND validated_by_user_id IS NOT NULL AND validated_fields IS NOT NULL)
  )
);
CREATE INDEX contract_imports_scope_idx ON contract_imports (tenant_id, customer_id);
CREATE INDEX contract_imports_ocr_idx ON contract_imports (ocr_status);

ALTER TABLE contract_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_imports FORCE ROW LEVEL SECURITY;
-- Interne uniquement : l'extraction brute (texte OCR, propositions) n'a pas
-- à être exposée au portail client.
CREATE POLICY contract_imports_scope ON contract_imports
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE DELETE, TRUNCATE ON contract_imports FROM lsi_app;

-- ===========================================================================
-- deadlines : échéancier matérialisé
-- ===========================================================================

CREATE TYPE "DeadlineKind" AS ENUM (
  'PERIOD_END', 'NOTICE_DEADLINE', 'PRICE_REVISION', 'RENEWAL_DECISION', 'CHATEL_NOTICE', 'TERMINATION_EFFECTIVE'
);
CREATE TYPE "DeadlineStatus" AS ENUM ('OPEN', 'DONE', 'OBSOLETE');

CREATE TABLE deadlines (
  id           uuid             PRIMARY KEY,
  tenant_id    uuid             NOT NULL,
  customer_id  uuid             NOT NULL,
  contract_id  uuid             NOT NULL,
  kind         "DeadlineKind"   NOT NULL,
  due_date     date             NOT NULL,
  status       "DeadlineStatus" NOT NULL DEFAULT 'OPEN',
  details      jsonb            NOT NULL DEFAULT '{}',
  computed_at  timestamp(3)     NOT NULL,
  CONSTRAINT deadlines_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  -- Une échéance donnée n'existe qu'une fois : le recalcul est idempotent
  -- par contrainte, pas par un `if`.
  CONSTRAINT deadlines_unique_key UNIQUE (contract_id, kind, due_date)
);
CREATE INDEX deadlines_due_idx ON deadlines (tenant_id, status, due_date);
CREATE INDEX deadlines_contract_idx ON deadlines (tenant_id, customer_id, contract_id);

ALTER TABLE deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadlines FORCE ROW LEVEL SECURITY;
-- Lisible par le client (dates de SES contrats), écrite par l'interne / le système.
CREATE POLICY deadlines_scope ON deadlines
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE DELETE, TRUNCATE ON deadlines FROM lsi_app;

-- ===========================================================================
-- reminders : les alertes d'échéance passent par le mécanisme existant
-- ===========================================================================
-- Un seul mécanisme d'alerte (reminders : dédoublonnage en base, envoi,
-- escalade) plutôt que deux concurrents. Chaque rappel pointe l'échéance qui
-- l'a produit. Les nouvelles valeurs ne sont pas UTILISÉES dans cette
-- migration (règle PostgreSQL 55P04).
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'PRICE_REVISION';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'RENEWAL_DECISION';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'CHATEL_NOTICE';
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'TERMINATION_EFFECTIVE';

ALTER TABLE reminders ADD COLUMN deadline_id uuid REFERENCES deadlines (id);

-- ===========================================================================
-- Découverte : contrats engagés dont l'échéancier doit être recalculé
-- ===========================================================================
-- Patron des migrations 11 / 19 : SECURITY DEFINER bornée, identifiants seuls.
CREATE OR REPLACE FUNCTION app_find_contracts_for_deadlines(p_limit int DEFAULT 5000)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.customer_id
    FROM contracts c
   WHERE c.status IN ('SIGNED', 'ACTIVE', 'RENEWAL_DUE', 'TERMINATION_PENDING')
     AND c.type = 'MAIN'
   ORDER BY c.id
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_contracts_for_deadlines(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_contracts_for_deadlines(int) TO lsi_app;

-- Imports dont l'OCR reste à faire (filet si un job a été perdu).
CREATE OR REPLACE FUNCTION app_find_pending_ocr_imports(p_limit int DEFAULT 100)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT i.id, i.tenant_id, i.customer_id
    FROM contract_imports i
   WHERE i.ocr_status = 'PENDING' AND i.ocr_attempts < 3
   ORDER BY i.created_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_pending_ocr_imports(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_pending_ocr_imports(int) TO lsi_app;
