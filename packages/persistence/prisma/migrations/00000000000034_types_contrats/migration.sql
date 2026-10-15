-- Types de contrats et grilles tarifaires par durée d'engagement
-- (docs/contrats/13-types-contrats.md). Migration ADDITIVE : seule
-- contract_template_versions gagne une colonne NULLABLE (date d'effet).
-- Retour arrière : prisma/rollback/00000000000034_types_contrats.down.sql.
--
--   1. contract_kinds        (classe « tenant ») : types de contrats, préfixe
--                            unique, prédéfinis (system_key) ou créés par
--                            l'utilisateur — AUCUN traitement propre aux
--                            types prédéfinis hors l'interdiction de suppression.
--   2. commitment_terms      (classe « tenant ») : référentiel des durées
--                            d'engagement (0, 12, 24, 36 mois au seed).
--   3. price_grid_items      (classe « tenant ») : codes de base
--                            {PREFIXE}-{NNNN}, numérotés par type.
--   4. price_grid_variants   (classe « tenant ») : versions par durée
--                            {PREFIXE}-{NNNN}-E{DD}.
--   5. price_grid_prices     (classe « tenant ») : historique des prix,
--                            APPEND-ONLY, avec date d'effet.
--
-- Garanties portées par la BASE, pas seulement par l'API :
--   - préfixe unique par tenant, format ^[A-Z0-9]{2,6}$ ;
--   - préfixe figé dès qu'un code de base l'utilise (trigger) ;
--   - type prédéfini jamais supprimé (trigger) ; type avec codes jamais
--     supprimé (FK) ;
--   - codes calculés par la base (triggers) à partir du préfixe et de la
--     durée, uniques par tenant, jamais réattribués : DELETE révoqué sur les
--     codes, compteur par type qui ne recule jamais ;
--   - code, numéro, type et durée d'un code non modifiables (droits par
--     colonne) ; un prix publié n'est jamais réécrit.
--
-- Montants : JAMAIS de flottant. Prix numeric(20,6) en euros, comme les lignes
-- de barème (migration 21).

-- ===========================================================================
-- 1. Types de contrats
-- ===========================================================================

CREATE TABLE contract_kinds (
  id                   uuid         PRIMARY KEY,
  tenant_id            uuid         NOT NULL REFERENCES tenants(id),
  -- Clé stable des types fournis par le seed (« MAINTENANCE »…) : le seed s'y
  -- retrouve même si le libellé ou le préfixe ont été modifiés. NULL pour un
  -- type créé par l'utilisateur.
  system_key           text         CHECK (system_key IS NULL OR system_key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  is_system            boolean      NOT NULL DEFAULT false,
  prefix               text         NOT NULL CHECK (prefix ~ '^[A-Z0-9]{2,6}$'),
  label                text         NOT NULL CHECK (length(btrim(label)) > 0),
  description          text,
  sort_order           integer      NOT NULL DEFAULT 0,
  -- Contenu contractuel : modèle de contrat (versions, clauses, annexes).
  contract_template_id uuid,
  -- Dernier numéro de code de base attribué. Ne recule jamais.
  last_item_number     integer      NOT NULL DEFAULT 0 CHECK (last_item_number >= 0),
  archived_at          timestamp(3),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  created_at           timestamp(3) NOT NULL,
  updated_at           timestamp(3) NOT NULL,
  CONSTRAINT contract_kinds_prefix_key     UNIQUE (tenant_id, prefix),
  CONSTRAINT contract_kinds_system_key_key UNIQUE (tenant_id, system_key),
  CONSTRAINT contract_kinds_scope_key      UNIQUE (id, tenant_id),
  CONSTRAINT contract_kinds_system_ck      CHECK (is_system = (system_key IS NOT NULL)),
  CONSTRAINT contract_kinds_template_fk    FOREIGN KEY (contract_template_id, tenant_id)
    REFERENCES contract_templates (id, tenant_id)
);

CREATE OR REPLACE FUNCTION app_guard_contract_kind() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'type de contrat prédéfini % : suppression interdite (archiver)', OLD.prefix
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.is_system IS DISTINCT FROM OLD.is_system OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'type de contrat % : caractère prédéfini non modifiable', OLD.prefix
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.last_item_number < OLD.last_item_number THEN
    RAISE EXCEPTION 'type de contrat % : la numérotation des codes ne recule pas', OLD.prefix
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.prefix IS DISTINCT FROM OLD.prefix
     AND (OLD.last_item_number > 0 OR EXISTS (SELECT 1 FROM price_grid_items i WHERE i.contract_kind_id = OLD.id)) THEN
    RAISE EXCEPTION 'type de contrat % : préfixe utilisé par des codes tarifs, non modifiable', OLD.prefix
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ===========================================================================
-- 2. Durées d'engagement
-- ===========================================================================

-- 0 = sans engagement. Deux chiffres : suffixe de code E00…E99.
CREATE TABLE commitment_terms (
  id          uuid         PRIMARY KEY,
  tenant_id   uuid         NOT NULL REFERENCES tenants(id),
  months      integer      NOT NULL CHECK (months BETWEEN 0 AND 99),
  label       text         NOT NULL CHECK (length(btrim(label)) > 0),
  archived_at timestamp(3),
  created_at  timestamp(3) NOT NULL,
  updated_at  timestamp(3) NOT NULL,
  CONSTRAINT commitment_terms_months_key UNIQUE (tenant_id, months),
  CONSTRAINT commitment_terms_scope_key  UNIQUE (id, tenant_id)
);

-- ===========================================================================
-- 3. Codes de base
-- ===========================================================================

CREATE TABLE price_grid_items (
  id                 uuid                PRIMARY KEY,
  tenant_id          uuid                NOT NULL,
  contract_kind_id   uuid                NOT NULL,
  -- Attribués par le trigger price_grid_items_number (valeurs fournies ignorées).
  number             integer             NOT NULL CHECK (number > 0),
  code               text                NOT NULL CHECK (code ~ '^[A-Z0-9]{2,6}-[0-9]{4,}$'),
  label              text                NOT NULL CHECK (length(btrim(label)) > 0),
  description        text,
  -- Code d'unité du référentiel @lsi/domain (PER_USER, FLAT…).
  unit               text                NOT NULL CHECK (unit ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  recurrence         "PricingRecurrence" NOT NULL CHECK (recurrence IN ('MONTHLY', 'YEARLY', 'ONE_OFF')),
  vat_rate_percent   numeric(5,2)        NOT NULL CHECK (vat_rate_percent BETWEEN 0 AND 100),
  sort_order         integer             NOT NULL DEFAULT 0,
  archived_at        timestamp(3),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at         timestamp(3)        NOT NULL,
  updated_at         timestamp(3)        NOT NULL,
  CONSTRAINT price_grid_items_kind_fk    FOREIGN KEY (contract_kind_id, tenant_id)
    REFERENCES contract_kinds (id, tenant_id),
  CONSTRAINT price_grid_items_code_key   UNIQUE (tenant_id, code),
  CONSTRAINT price_grid_items_number_key UNIQUE (contract_kind_id, number),
  CONSTRAINT price_grid_items_scope_key  UNIQUE (id, tenant_id)
);
CREATE INDEX price_grid_items_kind_idx ON price_grid_items (tenant_id, contract_kind_id);

-- Numéro et code calculés ICI : un appelant ne choisit ni l'un ni l'autre.
-- Le verrou de ligne pris par l'UPDATE sérialise les créations concurrentes
-- d'un même type ; le compteur ne recule jamais (app_guard_contract_kind).
CREATE OR REPLACE FUNCTION app_assign_price_grid_item_code() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
  v_number integer;
BEGIN
  UPDATE contract_kinds
     SET last_item_number = last_item_number + 1
   WHERE id = NEW.contract_kind_id AND tenant_id = NEW.tenant_id
  RETURNING prefix, last_item_number INTO v_prefix, v_number;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'type de contrat % introuvable', NEW.contract_kind_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.number := v_number;
  NEW.code := v_prefix || '-' || lpad(v_number::text, 4, '0');
  RETURN NEW;
END
$$;
CREATE TRIGGER price_grid_items_number BEFORE INSERT ON price_grid_items
  FOR EACH ROW EXECUTE FUNCTION app_assign_price_grid_item_code();

-- Créé après price_grid_items : la fonction de garde la lit.
CREATE TRIGGER contract_kinds_guard BEFORE UPDATE OR DELETE ON contract_kinds
  FOR EACH ROW EXECUTE FUNCTION app_guard_contract_kind();

-- ===========================================================================
-- 4. Versions par durée
-- ===========================================================================

-- Une durée sans version (ou version archivée) n'est pas proposée à la
-- sélection. Réactiver une durée = désarchiver la MÊME version : son code ne
-- change pas et n'est jamais réattribué.
CREATE TABLE price_grid_variants (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  item_id            uuid         NOT NULL,
  commitment_term_id uuid         NOT NULL,
  -- Calculé par le trigger price_grid_variants_code.
  code               text         NOT NULL CHECK (code ~ '^[A-Z0-9]{2,6}-[0-9]{4,}-E[0-9]{2}$'),
  archived_at        timestamp(3),
  created_by_user_id uuid,
  created_at         timestamp(3) NOT NULL,
  updated_at         timestamp(3) NOT NULL,
  CONSTRAINT price_grid_variants_item_fk  FOREIGN KEY (item_id, tenant_id)
    REFERENCES price_grid_items (id, tenant_id),
  CONSTRAINT price_grid_variants_term_fk  FOREIGN KEY (commitment_term_id, tenant_id)
    REFERENCES commitment_terms (id, tenant_id),
  CONSTRAINT price_grid_variants_code_key UNIQUE (tenant_id, code),
  CONSTRAINT price_grid_variants_term_key UNIQUE (item_id, commitment_term_id),
  CONSTRAINT price_grid_variants_scope_key UNIQUE (id, tenant_id)
);

CREATE OR REPLACE FUNCTION app_assign_price_grid_variant_code() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_item   text;
  v_months integer;
BEGIN
  SELECT code INTO v_item FROM price_grid_items WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id;
  SELECT months INTO v_months FROM commitment_terms WHERE id = NEW.commitment_term_id AND tenant_id = NEW.tenant_id;
  IF v_item IS NULL OR v_months IS NULL THEN
    RAISE EXCEPTION 'code de base ou durée d''engagement introuvable'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.code := v_item || '-E' || lpad(v_months::text, 2, '0');
  RETURN NEW;
END
$$;
CREATE TRIGGER price_grid_variants_code BEFORE INSERT ON price_grid_variants
  FOR EACH ROW EXECUTE FUNCTION app_assign_price_grid_variant_code();

-- ===========================================================================
-- 5. Historique des prix (APPEND-ONLY)
-- ===========================================================================

-- Prix en vigueur à une date D : la ligne de plus grande date d'effet ≤ D,
-- et parmi celles-ci la dernière saisie (id uuidv7 croissant) — une
-- correction le jour même est une NOUVELLE ligne, l'erreur reste visible.
CREATE TABLE price_grid_prices (
  id                 uuid          PRIMARY KEY,
  tenant_id          uuid          NOT NULL,
  variant_id         uuid          NOT NULL,
  effective_from     date          NOT NULL,
  unit_price         numeric(20,6) NOT NULL CHECK (unit_price >= 0),
  -- Prix d'achat (calcul de marge), interne.
  purchase_price     numeric(20,6) CHECK (purchase_price IS NULL OR purchase_price >= 0),
  entered_by_user_id uuid,
  created_at         timestamp(3)  NOT NULL,
  CONSTRAINT price_grid_prices_variant_fk FOREIGN KEY (variant_id, tenant_id)
    REFERENCES price_grid_variants (id, tenant_id)
);
CREATE INDEX price_grid_prices_variant_idx ON price_grid_prices (variant_id, effective_from DESC, id DESC);

-- ===========================================================================
-- 6. Contenu contractuel : date d'effet des versions de modèle
-- ===========================================================================

ALTER TABLE contract_template_versions ADD COLUMN effective_from date;

-- ===========================================================================
-- 7. RLS et droits
-- ===========================================================================

-- Classe « tenant », interne uniquement : jamais lisible par un client.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_kinds', 'commitment_terms', 'price_grid_items',
                           'price_grid_variants', 'price_grid_prices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO lsi_app
         USING (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'')
         WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'')',
      t || '_scope', t);
  END LOOP;
END
$$;

-- Types : suppression possible (type personnalisé sans code), bornée par le
-- trigger et la FK. Le compteur last_item_number n'avance que par le trigger
-- des codes (droit de colonne nécessaire : le trigger s'exécute avec les
-- droits de l'appelant), et ne recule jamais.
REVOKE TRUNCATE ON contract_kinds FROM lsi_app;

-- Durées : jamais supprimées ; le nombre de mois est figé (il est dans les codes).
REVOKE UPDATE, DELETE, TRUNCATE ON commitment_terms FROM lsi_app;
GRANT UPDATE (label, archived_at, updated_at) ON commitment_terms TO lsi_app;

-- Codes de base : jamais supprimés ; type, numéro et code figés.
REVOKE UPDATE, DELETE, TRUNCATE ON price_grid_items FROM lsi_app;
GRANT UPDATE (label, description, unit, recurrence, vat_rate_percent, sort_order, archived_at,
              updated_by_user_id, updated_at) ON price_grid_items TO lsi_app;

-- Versions : jamais supprimées ; seul l'archivage évolue.
REVOKE UPDATE, DELETE, TRUNCATE ON price_grid_variants FROM lsi_app;
GRANT UPDATE (archived_at, updated_at) ON price_grid_variants TO lsi_app;

-- Prix : écrits une fois.
REVOKE UPDATE, DELETE, TRUNCATE ON price_grid_prices FROM lsi_app;
