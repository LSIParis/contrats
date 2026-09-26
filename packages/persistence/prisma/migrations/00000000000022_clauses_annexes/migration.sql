-- Lot 2 : bibliothèque de clauses, contrats types structurés, clauses et
-- annexes des versions de contrat. Migration ADDITIVE.
-- Spécification : docs/contrats/01-domaine.md §6.

CREATE TYPE "ClauseCategory" AS ENUM (
  'OBJET', 'DUREE', 'PRIX', 'SLA', 'RESPONSABILITE', 'RGPD', 'CONFIDENTIALITE',
  'PROPRIETE_INTELLECTUELLE', 'ASSURANCE', 'RESILIATION', 'DIVERS'
);
CREATE TYPE "ClauseOrigin" AS ENUM ('TEMPLATE', 'LIBRARY', 'CUSTOM', 'AI');
CREATE TYPE "ClauseRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AnnexKind" AS ENUM ('SLA', 'ASSETS', 'PRICING_GRID', 'DPA_ART28', 'OTHER');
CREATE TYPE "ClauseReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- ===========================================================================
-- Bibliothèque de clauses (classe « tenant »)
-- ===========================================================================

CREATE TABLE clause_library_items (
  id                 uuid             PRIMARY KEY,
  tenant_id          uuid             NOT NULL REFERENCES tenants (id),
  code               text             NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  category           "ClauseCategory" NOT NULL,
  title              text             NOT NULL,
  archived_at        timestamp(3),
  current_version_id uuid,
  -- Élément fourni comme exemple : affiché « DÉMONSTRATION » (brief §4).
  is_demo            boolean          NOT NULL DEFAULT false,
  created_at         timestamp(3)     NOT NULL,
  updated_at         timestamp(3)     NOT NULL,
  CONSTRAINT clause_library_items_code_key UNIQUE (tenant_id, code),
  CONSTRAINT clause_library_items_scope_key UNIQUE (id, tenant_id)
);

-- Versions IMMUABLES : une clause publiée ne se réécrit pas, on en crée une
-- nouvelle version. Les contrats et modèles pointent une version précise.
CREATE TABLE clause_library_item_versions (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  item_id            uuid         NOT NULL,
  version_number     integer      NOT NULL CHECK (version_number >= 1),
  body_html          text         NOT NULL,
  -- Noms des variables utilisées ({{client.raisonSociale}}…), extraits du corps.
  variables          text[]       NOT NULL DEFAULT '{}',
  change_note        text,
  created_by_user_id uuid,
  created_at         timestamp(3) NOT NULL,
  CONSTRAINT clause_versions_item_fk FOREIGN KEY (item_id, tenant_id) REFERENCES clause_library_items (id, tenant_id),
  CONSTRAINT clause_versions_number_key UNIQUE (item_id, version_number),
  CONSTRAINT clause_versions_scope_key UNIQUE (id, tenant_id)
);

-- ===========================================================================
-- Composition des versions de modèles (classe « tenant »)
-- ===========================================================================

ALTER TABLE contract_templates ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

-- Variables du contrat type encore sans valeur dans la version courante :
-- bloque la soumission en revue interne (garde V2-VAR du domaine).
ALTER TABLE contracts ADD COLUMN missing_variables integer NOT NULL DEFAULT 0 CHECK (missing_variables >= 0);
ALTER TABLE contract_template_versions
  -- Annexes par défaut : [{ kind, title, bodyHtml }] (copiées dans chaque contrat).
  ADD COLUMN default_annexes jsonb NOT NULL DEFAULT '[]',
  -- Barème par défaut : lignes au format @lsi/pricing (repris par le lot 3).
  ADD COLUMN default_pricing jsonb NOT NULL DEFAULT '[]';

CREATE TABLE template_clauses (
  tenant_id           uuid         NOT NULL,
  template_version_id uuid         NOT NULL,
  position            integer      NOT NULL CHECK (position >= 1),
  clause_version_id   uuid         NOT NULL,
  -- Une clause « obligatoire » ne peut être retirée d'un contrat qu'avec une
  -- dérogation explicite, signalée en revue interne.
  required            boolean      NOT NULL DEFAULT false,
  PRIMARY KEY (template_version_id, position),
  CONSTRAINT template_clauses_version_fk FOREIGN KEY (template_version_id, tenant_id)
    REFERENCES contract_template_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT template_clauses_clause_fk FOREIGN KEY (clause_version_id, tenant_id)
    REFERENCES clause_library_item_versions (id, tenant_id)
);

-- ===========================================================================
-- Clauses et annexes d'une VERSION de contrat (classe « client »)
-- ===========================================================================

CREATE TABLE contract_clauses (
  id                uuid             PRIMARY KEY,
  tenant_id         uuid             NOT NULL,
  customer_id       uuid             NOT NULL,
  contract_id       uuid             NOT NULL,
  version_id        uuid             NOT NULL,
  position          integer          NOT NULL CHECK (position >= 1),
  -- Identifiant STABLE de la clause d'une version à l'autre (diff, revue IA).
  clause_key        text             NOT NULL,
  category          "ClauseCategory" NOT NULL,
  title             text             NOT NULL,
  body_html         text             NOT NULL,
  origin            "ClauseOrigin"   NOT NULL,
  -- Source dans la bibliothèque / le modèle (NULL pour une clause spécifique).
  source_clause_version_id uuid,
  -- Rédaction IA (brief §6) : niveau de risque, justification, sources citées.
  ai_risk           "ClauseRisk",
  ai_justification  text,
  ai_sources        jsonb,
  CONSTRAINT contract_clauses_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES contract_versions (id, tenant_id, customer_id),
  CONSTRAINT contract_clauses_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT contract_clauses_position_key UNIQUE (version_id, position),
  CONSTRAINT contract_clauses_key_key UNIQUE (version_id, clause_key),
  CONSTRAINT contract_clauses_scope_key UNIQUE (id, tenant_id, customer_id)
);
CREATE INDEX contract_clauses_contract_idx ON contract_clauses (tenant_id, customer_id, contract_id);

-- Revue humaine d'une clause (obligatoire pour les clauses IA). Append-only :
-- une décision ne se réécrit pas, une nouvelle décision la remplace.
CREATE TABLE contract_clause_reviews (
  id                 uuid                   PRIMARY KEY,
  tenant_id          uuid                   NOT NULL,
  customer_id        uuid                   NOT NULL,
  contract_id        uuid                   NOT NULL,
  clause_id          uuid                   NOT NULL,
  decision           "ClauseReviewDecision" NOT NULL,
  comment            text,
  reviewed_by_user_id uuid                  NOT NULL,
  reviewed_at        timestamp(3)           NOT NULL,
  CONSTRAINT clause_reviews_clause_fk FOREIGN KEY (clause_id, tenant_id, customer_id)
    REFERENCES contract_clauses (id, tenant_id, customer_id),
  CONSTRAINT clause_reviews_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id)
);
CREATE INDEX clause_reviews_clause_idx ON contract_clause_reviews (tenant_id, customer_id, clause_id);

CREATE TABLE annexes (
  id           uuid         PRIMARY KEY,
  tenant_id    uuid         NOT NULL,
  customer_id  uuid         NOT NULL,
  contract_id  uuid         NOT NULL,
  version_id   uuid         NOT NULL,
  position     integer      NOT NULL CHECK (position >= 1),
  kind         "AnnexKind"  NOT NULL,
  title        text         NOT NULL,
  -- Corps rédigé (SLA, DPA…). NULL pour une annexe GÉNÉRÉE au rendu
  -- (grille tarifaire tirée du barème, liste d'actifs tirée de `data`).
  body_html    text,
  data         jsonb,
  CONSTRAINT annexes_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES contract_versions (id, tenant_id, customer_id),
  CONSTRAINT annexes_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT annexes_position_key UNIQUE (version_id, position)
);
CREATE INDEX annexes_contract_idx ON annexes (tenant_id, customer_id, contract_id);

-- ===========================================================================
-- RLS
-- ===========================================================================

ALTER TABLE clause_library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE clause_library_items FORCE ROW LEVEL SECURITY;
CREATE POLICY clause_library_items_scope ON clause_library_items
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE clause_library_item_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clause_library_item_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY clause_library_item_versions_scope ON clause_library_item_versions
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON clause_library_item_versions FROM lsi_app;

ALTER TABLE template_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_clauses FORCE ROW LEVEL SECURITY;
CREATE POLICY template_clauses_scope ON template_clauses
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- Les clauses d'une version sont figées avec elle : écriture unique.
ALTER TABLE contract_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clauses FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_clauses_scope ON contract_clauses
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON contract_clauses FROM lsi_app;

ALTER TABLE contract_clause_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clause_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_clause_reviews_scope ON contract_clause_reviews
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON contract_clause_reviews FROM lsi_app;

ALTER TABLE annexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE annexes FORCE ROW LEVEL SECURITY;
CREATE POLICY annexes_scope ON annexes
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON annexes FROM lsi_app;
