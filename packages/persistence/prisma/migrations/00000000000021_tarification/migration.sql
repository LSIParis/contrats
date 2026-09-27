-- Lot 3 : persistance de la tarification (docs/contrats/04-tarification.md
-- §17, 01-domaine.md §2). Migration ADDITIVE : aucune table existante n'est
-- modifiée.
--
--   1. price_indexes / price_index_values  (classe « tenant ») : séries
--      d'indices (Syntec…) et leurs valeurs publiées, APPEND-ONLY.
--   2. pricing_rules                       (classe « tenant ») : catalogue
--      de règles (grilles, paliers, remises volume / engagement).
--   3. pricing_schedules / pricing_lines   (classe « customer ») : barème
--      versionné de chaque contrat ; une version ACTIVE ne se modifie plus.
--   4. price_overrides                     (classe « customer ») : dérogations
--      bornées, motivées, à double validation au-delà d'un seuil.
--
-- Montants : JAMAIS de flottant. Prix unitaires numeric(20,6) en euros
-- (fractions de centime possibles), valeurs d'indice numeric(18,6).
--
-- Aucune valeur d'énumération n'est AJOUTÉE à un type existant : les types
-- sont créés ici, et PostgreSQL autorise leur usage dans la même transaction
-- (la règle 55P04 ne vise que ALTER TYPE … ADD VALUE).

-- Contrainte d'exclusion sur (contrat =, plage de dates &&) : le « = » sur
-- uuid dans un index GiST exige btree_gist. Extension « trusted » depuis
-- PostgreSQL 13 : le propriétaire de la base peut la créer sans superuser.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ===========================================================================
-- Énumérations
-- ===========================================================================

CREATE TYPE "PriceIndexValueSource" AS ENUM ('MANUAL', 'IMPORT');
CREATE TYPE "PricingRuleType" AS ENUM ('GRID', 'TIERS', 'VOLUME_DISCOUNT', 'COMMITMENT_DISCOUNT');
CREATE TYPE "PricingScheduleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
CREATE TYPE "PricingLineKind" AS ENUM (
  'FLAT_MONTHLY', 'FLAT_YEARLY', 'UNIT', 'HOURLY', 'HOUR_PACK', 'SETUP_FEE', 'TIERED', 'DISCOUNT'
);
CREATE TYPE "PricingLineMode" AS ENUM ('MANUAL', 'RULE', 'FORMULA');
CREATE TYPE "PricingRecurrence" AS ENUM ('MONTHLY', 'YEARLY', 'ONE_OFF');
CREATE TYPE "PricingQuantitySource" AS ENUM ('FIXED', 'PROVIDER');
CREATE TYPE "PriceOverrideStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'CANCELLED');

-- ===========================================================================
-- 1. Indices de révision (classe « tenant »)
-- ===========================================================================

CREATE TABLE price_indexes (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL REFERENCES tenants(id),
  -- Code stable, référencé par les lignes de barème (revision.indexCode,
  -- formula.indexVariables) : « SYNTEC », « INSEE_ICHT »…
  code               text         NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  label              text         NOT NULL CHECK (length(btrim(label)) > 0),
  description        text,
  -- Paramétrage du connecteur d'import (ex. { "type": "CSV", "delimiter": ";" }).
  -- NULL = saisie manuelle seulement. Jamais de secret ici.
  connector          jsonb,
  created_by_user_id uuid,
  created_at         timestamp(3) NOT NULL,
  updated_at         timestamp(3) NOT NULL,
  CONSTRAINT price_indexes_code_key  UNIQUE (tenant_id, code),
  CONSTRAINT price_indexes_scope_key UNIQUE (id, tenant_id)
);

-- APPEND-ONLY. Une valeur publiée ne se réécrit pas : une correction est une
-- NOUVELLE ligne qui `supersedes` la précédente, avec son motif. La valeur
-- retenue pour une période est la pointe de la chaîne (la ligne que personne
-- ne remplace). Garanties portées par la base, pas par le code :
--   - une seule ORIGINALE par (série, période) : UNIQUE (index, période,
--     révision) + CHECK « révision 0 ⇔ pas de prédécesseur » ;
--   - une correction reste dans la MÊME série et la MÊME période : FK
--     composite (supersedes_id, tenant, index, période) ;
--   - une valeur n'est remplacée qu'UNE fois : UNIQUE (supersedes_id) —
--     l'historique est une chaîne, jamais un arbre ;
--   - UPDATE / DELETE révoqués au rôle applicatif.
CREATE TABLE price_index_values (
  id                 uuid                    PRIMARY KEY,
  tenant_id          uuid                    NOT NULL,
  index_id           uuid                    NOT NULL,
  period             char(7)                 NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  value              numeric(18,6)           NOT NULL CHECK (value > 0),
  published_at       date                    NOT NULL,
  source             "PriceIndexValueSource" NOT NULL,
  revision           integer                 NOT NULL DEFAULT 0 CHECK (revision >= 0),
  supersedes_id      uuid,
  correction_reason  text,
  entered_by_user_id uuid,
  created_at         timestamp(3)            NOT NULL,

  CONSTRAINT price_index_values_index_fk FOREIGN KEY (index_id, tenant_id)
    REFERENCES price_indexes (id, tenant_id),
  CONSTRAINT price_index_values_chain_key UNIQUE (id, tenant_id, index_id, period),
  CONSTRAINT price_index_values_supersedes_fk FOREIGN KEY (supersedes_id, tenant_id, index_id, period)
    REFERENCES price_index_values (id, tenant_id, index_id, period),
  CONSTRAINT price_index_values_revision_key UNIQUE (index_id, period, revision),
  CONSTRAINT price_index_values_supersedes_key UNIQUE (supersedes_id),
  CONSTRAINT price_index_values_root_ck CHECK ((revision = 0) = (supersedes_id IS NULL)),
  CONSTRAINT price_index_values_correction_ck CHECK (
    supersedes_id IS NULL OR length(btrim(coalesce(correction_reason, ''))) > 0
  )
);

-- ===========================================================================
-- 2. Catalogue de règles (classe « tenant »)
-- ===========================================================================

-- `definition` est validé côté API contre les types du moteur (@lsi/pricing
-- PricingRule) ; la base garantit seulement que c'est un objet JSON.
-- Pas de suppression : une règle référencée par un barème actif ne peut pas
-- disparaître (RULE_NOT_FOUND au prochain calcul). On l'ARCHIVE.
CREATE TABLE pricing_rules (
  id                 uuid              PRIMARY KEY,
  tenant_id          uuid              NOT NULL REFERENCES tenants(id),
  code               text              NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  type               "PricingRuleType" NOT NULL,
  label              text              NOT NULL CHECK (length(btrim(label)) > 0),
  definition         jsonb             NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  archived_at        timestamp(3),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at         timestamp(3)      NOT NULL,
  updated_at         timestamp(3)      NOT NULL,
  CONSTRAINT pricing_rules_code_key UNIQUE (tenant_id, code)
);

-- ===========================================================================
-- 3. Barèmes versionnés (classe « customer »)
-- ===========================================================================

CREATE TABLE pricing_schedules (
  id                   uuid                    PRIMARY KEY,
  tenant_id            uuid                    NOT NULL,
  customer_id          uuid                    NOT NULL,
  contract_id          uuid                    NOT NULL,
  version_number       integer                 NOT NULL CHECK (version_number > 0),
  status               "PricingScheduleStatus" NOT NULL DEFAULT 'DRAFT',
  valid_from           date                    NOT NULL,
  -- Incluse ; NULL = sans fin.
  valid_to             date,
  currency             char(3)                 NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  -- Durée d'engagement (remises d'engagement du catalogue).
  commitment_months    integer                 CHECK (commitment_months IS NULL OR commitment_months BETWEEN 1 AND 240),
  note                 text,
  created_by_user_id   uuid                    NOT NULL,
  activated_by_user_id uuid,
  activated_at         timestamp(3),
  superseded_at        timestamp(3),
  created_at           timestamp(3)            NOT NULL,
  updated_at           timestamp(3)            NOT NULL,

  CONSTRAINT pricing_schedules_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT pricing_schedules_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT pricing_schedules_version_key UNIQUE (contract_id, version_number),
  CONSTRAINT pricing_schedules_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Activée ⇔ qui ET quand (tout ou rien, comme la validation d'import).
  CONSTRAINT pricing_schedules_activation_ck CHECK (
    (status = 'DRAFT' AND activated_at IS NULL AND activated_by_user_id IS NULL)
    OR (status <> 'DRAFT' AND activated_at IS NOT NULL AND activated_by_user_id IS NOT NULL)
  ),
  -- LE garde-fou du moteur (NO_SCHEDULE / OVERLAPPING_SCHEDULES) remonté en
  -- base : deux versions engagées d'un même contrat ne peuvent pas couvrir un
  -- même jour. Les brouillons, eux, peuvent chevaucher (on prépare la
  -- révision pendant que la version courante s'applique).
  CONSTRAINT pricing_schedules_no_overlap EXCLUDE USING gist (
    contract_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (status <> 'DRAFT')
);
CREATE INDEX pricing_schedules_contract_idx ON pricing_schedules (tenant_id, customer_id, contract_id);

CREATE TABLE pricing_lines (
  id                    uuid                    PRIMARY KEY,
  tenant_id             uuid                    NOT NULL,
  customer_id           uuid                    NOT NULL,
  schedule_id           uuid                    NOT NULL,
  -- Identifiant STABLE d'une version de barème à l'autre : c'est lui que le
  -- moteur appelle `lineId`, et lui que référencent les dérogations. Une
  -- révision (nouvelle version) recopie les clés : la dérogation survit.
  line_key              text                    NOT NULL CHECK (line_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  sort_order            integer                 NOT NULL DEFAULT 0,
  article_code          text                    NOT NULL CHECK (length(article_code) BETWEEN 1 AND 64),
  label                 text                    NOT NULL CHECK (length(btrim(label)) > 0),
  unit                  text                    NOT NULL,
  kind                  "PricingLineKind"       NOT NULL,
  mode                  "PricingLineMode"       NOT NULL,
  -- NULL = défaut du type (moteur, §4.1).
  recurrence            "PricingRecurrence",
  vat_rate_percent      numeric(5,2)            NOT NULL CHECK (vat_rate_percent BETWEEN 0 AND 100),
  quantity_source       "PricingQuantitySource" NOT NULL DEFAULT 'FIXED',
  -- Quantité saisie (FIXED) ; NULL si fournie par un QuantityProvider.
  quantity              numeric(20,6)           CHECK (quantity IS NULL OR quantity >= 0),
  provider_article_code text,
  -- Prix unitaire HT saisi (MANUAL) ; P0 d'une révision native.
  unit_price            numeric(20,6)           CHECK (unit_price IS NULL OR unit_price >= 0),
  -- Paramètres propres au type / mode, validés contre les types du moteur :
  -- { tiers, rule, formula, revision, hourPack, discount }.
  params                jsonb                   NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),

  CONSTRAINT pricing_lines_schedule_fk FOREIGN KEY (schedule_id, tenant_id, customer_id)
    REFERENCES pricing_schedules (id, tenant_id, customer_id) ON DELETE CASCADE,
  CONSTRAINT pricing_lines_key UNIQUE (schedule_id, line_key),
  CONSTRAINT pricing_lines_quantity_ck CHECK (
    kind = 'DISCOUNT'
    OR (quantity_source = 'FIXED' AND quantity IS NOT NULL)
    OR (quantity_source = 'PROVIDER' AND quantity IS NULL)
  )
);
CREATE INDEX pricing_lines_scope_idx ON pricing_lines (tenant_id, customer_id, schedule_id);

-- ===========================================================================
-- 4. Dérogations (classe « customer »)
-- ===========================================================================

CREATE TABLE price_overrides (
  id                       uuid                  PRIMARY KEY,
  tenant_id                uuid                  NOT NULL,
  customer_id              uuid                  NOT NULL,
  contract_id              uuid                  NOT NULL,
  -- Clé STABLE de la ligne (pricing_lines.line_key), toutes versions confondues.
  line_key                 text                  NOT NULL,
  unit_price               numeric(20,6)         NOT NULL CHECK (unit_price >= 0),
  valid_from               date                  NOT NULL,
  -- Une dérogation est TOUJOURS bornée.
  valid_to                 date                  NOT NULL,
  reason                   text                  NOT NULL,
  -- Instantané à la création (information) : prix calculé et écart. Le moteur
  -- RECALCULE l'écart à chaque date de calcul ; ces colonnes n'en décident pas.
  computed_unit_price      numeric(20,6),
  gap_percent              numeric(14,4),
  requires_second_approval boolean               NOT NULL,
  status                   "PriceOverrideStatus" NOT NULL,
  author_user_id           uuid                  NOT NULL,
  approved_by_user_id      uuid,
  approved_at              timestamp(3),
  rejected_by_user_id      uuid,
  rejected_at              timestamp(3),
  rejection_reason         text,
  cancelled_by_user_id     uuid,
  cancelled_at             timestamp(3),
  created_at               timestamp(3)          NOT NULL,
  updated_at               timestamp(3)          NOT NULL,

  CONSTRAINT price_overrides_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT price_overrides_period_ck CHECK (valid_to >= valid_from),
  CONSTRAINT price_overrides_reason_ck CHECK (length(btrim(reason)) > 0),
  -- LA règle des quatre yeux, en base : le second validateur n'est jamais
  -- l'auteur, quel que soit le chemin d'écriture.
  CONSTRAINT price_overrides_approver_ck CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> author_user_id),
  CONSTRAINT price_overrides_rejecter_ck CHECK (rejected_by_user_id IS NULL OR rejected_by_user_id <> author_user_id),
  CONSTRAINT price_overrides_approval_ck CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  CONSTRAINT price_overrides_rejection_ck CHECK ((rejected_by_user_id IS NULL) = (rejected_at IS NULL)),
  CONSTRAINT price_overrides_status_ck CHECK (
    (status = 'PENDING_APPROVAL' AND approved_by_user_id IS NULL AND rejected_by_user_id IS NULL AND cancelled_at IS NULL)
    OR (status = 'ACTIVE' AND rejected_by_user_id IS NULL AND cancelled_at IS NULL
        AND (NOT requires_second_approval OR approved_by_user_id IS NOT NULL))
    OR (status = 'REJECTED' AND rejected_by_user_id IS NOT NULL AND approved_by_user_id IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
  )
);
CREATE INDEX price_overrides_contract_idx ON price_overrides (tenant_id, customer_id, contract_id, line_key);

-- ===========================================================================
-- Immuabilité des barèmes engagés (triggers)
-- ===========================================================================

-- Une version ACTIVE (ou SUPERSEDED) ne se modifie plus : réviser, c'est
-- créer une version. Seule exception, la CLÔTURE à l'activation de la
-- version suivante : statut ACTIVE → SUPERSEDED et fin de validité posée ou
-- avancée. Le trigger le garantit quel que soit le chemin d'écriture.
CREATE OR REPLACE FUNCTION app_guard_pricing_schedule()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'barème % v% engagé (%) : suppression interdite', OLD.contract_id, OLD.version_number, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;  -- brouillon : librement modifiable (activation comprise)
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.customer_id, NEW.contract_id, NEW.version_number, NEW.valid_from,
      NEW.currency, NEW.commitment_months, NEW.note, NEW.created_by_user_id, NEW.created_at,
      NEW.activated_by_user_id, NEW.activated_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.customer_id, OLD.contract_id, OLD.version_number, OLD.valid_from,
      OLD.currency, OLD.commitment_months, OLD.note, OLD.created_by_user_id, OLD.created_at,
      OLD.activated_by_user_id, OLD.activated_at) THEN
    RAISE EXCEPTION 'barème % v% engagé (%) : contenu immuable, créer une nouvelle version', OLD.contract_id, OLD.version_number, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'DRAFT' OR (OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED') THEN
    RAISE EXCEPTION 'barème % v% : transition % → % interdite', OLD.contract_id, OLD.version_number, OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to
     AND NOT (NEW.valid_to IS NOT NULL AND (OLD.valid_to IS NULL OR NEW.valid_to < OLD.valid_to)) THEN
    RAISE EXCEPTION 'barème % v% engagé : la fin de validité ne peut qu''être posée ou avancée', OLD.contract_id, OLD.version_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pricing_schedules_guard
  BEFORE UPDATE OR DELETE ON pricing_schedules
  FOR EACH ROW EXECUTE FUNCTION app_guard_pricing_schedule();

-- Les lignes d'une version engagée sont figées avec elle. Exécuté avec les
-- droits de l'appelant (RLS comprise) : un barème invisible est traité comme
-- non modifiable — échec fermé. En suppression, un parent introuvable est un
-- parent en cours de suppression (cascade depuis un brouillon, que le trigger
-- ci-dessus a déjà autorisée).
CREATE OR REPLACE FUNCTION app_guard_pricing_line()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_status "PricingScheduleStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_status FROM pricing_schedules WHERE id = OLD.schedule_id;
    IF FOUND AND v_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'ligne % : le barème est engagé (%), ses lignes sont immuables', OLD.line_key, v_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.schedule_id IS DISTINCT FROM OLD.schedule_id THEN
    RAISE EXCEPTION 'ligne % : changement de barème interdit', OLD.line_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT status INTO v_status FROM pricing_schedules WHERE id = NEW.schedule_id;
  IF NOT FOUND OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'ligne % : le barème est engagé (%), ses lignes sont immuables', NEW.line_key, coalesce(v_status::text, 'inconnu')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pricing_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pricing_lines
  FOR EACH ROW EXECUTE FUNCTION app_guard_pricing_line();

-- ===========================================================================
-- RLS
-- ===========================================================================

-- Indices : lisibles par tout le tenant, portail client compris (la trace
-- d'un prix révisé cite S0 et S1) ; écrits par l'interne seulement.
ALTER TABLE price_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_indexes FORCE ROW LEVEL SECURITY;
CREATE POLICY price_indexes_scope ON price_indexes
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE price_index_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_index_values FORCE ROW LEVEL SECURITY;
CREATE POLICY price_index_values_scope ON price_index_values
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');
REVOKE UPDATE, DELETE, TRUNCATE ON price_index_values FROM lsi_app;
REVOKE DELETE, TRUNCATE ON price_indexes FROM lsi_app;

-- Catalogue de règles : interne uniquement (grilles commerciales du tenant,
-- valables pour TOUS les clients). Un calcul pour le portail passera par un
-- scope SYSTEM borné au client, pas par une session CLIENT.
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_rules_scope ON pricing_rules
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');
REVOKE DELETE, TRUNCATE ON pricing_rules FROM lsi_app;

-- Barème et lignes : le client LIT le barème de SES contrats ; l'écriture
-- est interne.
ALTER TABLE pricing_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_schedules_scope ON pricing_schedules
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE TRUNCATE ON pricing_schedules FROM lsi_app;

ALTER TABLE pricing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_lines_scope ON pricing_lines
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');
REVOKE TRUNCATE ON pricing_lines FROM lsi_app;

-- Dérogations : interne uniquement (le motif est une information interne).
ALTER TABLE price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY price_overrides_scope ON price_overrides
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id) AND app_actor_kind() <> 'CLIENT');

-- Une dérogation n'est jamais supprimée ni RÉÉCRITE : prix, période, motif
-- et auteur sont figés à la création. Seules les colonnes de décision
-- (validation, refus, annulation) évoluent — GRANT au niveau colonne, le
-- patron de la migration 5.
REVOKE UPDATE, DELETE, TRUNCATE ON price_overrides FROM lsi_app;
GRANT UPDATE (status, approved_by_user_id, approved_at, rejected_by_user_id, rejected_at, rejection_reason,
              cancelled_by_user_id, cancelled_at, updated_at) ON price_overrides TO lsi_app;
