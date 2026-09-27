-- Lot 6 : usage et coût de l'assistance IA par tenant (05-ia-perplexity §13).
-- Migration ADDITIVE.
--
-- Une ligne par APPEL au fournisseur (réussi ou non). Aucune donnée métier :
-- ni prompt, ni réponse, ni texte pseudonymisé — seulement de quoi facturer,
-- plafonner (budget mensuel vérifié AVANT l'appel) et diagnostiquer.
-- Classe « tenant » : paramétrage/pilotage, jamais visible d'un client.

CREATE TYPE "AiOperation" AS ENUM ('DRAFT', 'REPHRASE', 'HARDEN', 'EXPLAIN', 'COMPARE', 'MISSING', 'IMPORT_EXTRACT');
CREATE TYPE "AiCallStatus" AS ENUM (
  'OK', 'NOT_CONFIGURED', 'AUTH', 'BAD_REQUEST', 'RATE_LIMIT', 'TIMEOUT', 'SCHEMA_VIOLATION', 'UPSTREAM', 'LEAK_BLOCKED'
);

CREATE TABLE ai_usage (
  id                  uuid           PRIMARY KEY,
  tenant_id           uuid           NOT NULL REFERENCES tenants(id),
  user_id             uuid,
  -- Contrat concerné, sans FK : un journal de coût ne bloque pas une purge.
  contract_id         uuid,
  operation           "AiOperation"  NOT NULL,
  provider            text           NOT NULL CHECK (provider IN ('perplexity', 'claude', 'unavailable')),
  model               text           CHECK (model IS NULL OR length(model) <= 120),
  schema_name         text           CHECK (schema_name IS NULL OR length(schema_name) <= 64),
  status              "AiCallStatus" NOT NULL,
  input_tokens        int            NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       int            NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- Coût renvoyé par le fournisseur (Perplexity) ; NULL si non communiqué (Claude).
  cost_usd            numeric(12, 6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  tool_invocations    jsonb,
  duration_ms         int            NOT NULL CHECK (duration_ms >= 0),
  created_at          timestamp(3)   NOT NULL
);

CREATE INDEX ai_usage_tenant_month_idx ON ai_usage (tenant_id, created_at);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_scope ON ai_usage
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- Journal append-only : ni modification ni suppression par l'application.
REVOKE UPDATE, DELETE ON ai_usage FROM lsi_app;
