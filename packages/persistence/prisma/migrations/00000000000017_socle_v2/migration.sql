-- Socle v2 (docs/contrats/00-architecture.md, lot 0). Migration ADDITIVE.
--
--   1. Rôles INTERNAL_SIGNATORY (signataire interne) et READER (lecteur).
--   2. Feature flags et paramètres par tenant.
--   3. stored_documents : référentiel unique des fichiers, écriture unique.
--   4. lifecycle_events : journal des transitions d'état, alimenté par
--      TRIGGER — aucune transition ne peut y échapper, qu'elle vienne d'une
--      requête HTTP, d'un webhook ou d'un job.

-- ===========================================================================
-- 1. Rôles
-- ===========================================================================

ALTER TYPE "RoleCode" ADD VALUE IF NOT EXISTS 'INTERNAL_SIGNATORY';
ALTER TYPE "RoleCode" ADD VALUE IF NOT EXISTS 'READER';

-- ===========================================================================
-- 2. Feature flags & paramètres (classe « tenant »)
-- ===========================================================================

-- Une ligne par (tenant, drapeau). ABSENCE de ligne = désactivé : c'est le
-- défaut exigé par le brief (contrats.ai.enabled, contrats.docuseal.enabled,
-- contrats.api.enabled désactivés par défaut). Aucun drapeau ne s'active
-- « tout seul » par un défaut de colonne oublié.
CREATE TABLE tenant_feature_flags (
  tenant_id          uuid         NOT NULL REFERENCES tenants(id),
  key                text         NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  enabled            boolean      NOT NULL,
  updated_at         timestamp(3) NOT NULL,
  updated_by_user_id uuid,
  PRIMARY KEY (tenant_id, key)
);

-- Paramètres typés côté application (schémas Zod par clé) : fournisseur IA,
-- modèle/preset, seuils d'alerte, règle d'arrondi, durées de conservation…
-- Jamais de secret ici : les clés d'API restent dans l'environnement.
CREATE TABLE tenant_settings (
  tenant_id          uuid         NOT NULL REFERENCES tenants(id),
  key                text         NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9_.]{2,63}$'),
  value              jsonb        NOT NULL,
  updated_at         timestamp(3) NOT NULL,
  updated_by_user_id uuid,
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_feature_flags_scope ON tenant_feature_flags
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant())
  -- Un CLIENT peut LIRE un drapeau (le portail masque la signature si
  -- DocuSeal est neutralisé) mais jamais l'écrire.
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_scope ON tenant_settings
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- ===========================================================================
-- 3. stored_documents (classe « customer »)
-- ===========================================================================

CREATE TYPE "StoredDocumentKind" AS ENUM (
  'LEGACY_SCAN',            -- scan d'un contrat papier importé : L'ORIGINAL, jamais modifié
  'OCR_TEXT',               -- texte extrait (copie de travail, distincte de l'original)
  'OCR_PDF',                -- PDF recherchable produit par l'OCR
  'CONTRACT_PDF',           -- rendu PDF d'une version figée (celui qui part en signature)
  'SIGNED_PDF',             -- document signé rapatrié de DocuSeal
  'SIGNATURE_AUDIT_TRAIL',  -- journal d'audit DocuSeal
  'TERMINATION_LETTER',     -- courrier de résiliation scanné
  'ATTACHMENT'              -- autre pièce justificative
);

CREATE TYPE "StoredDocumentOrigin" AS ENUM ('UPLOAD', 'GENERATED', 'DOCUSEAL', 'OCR');

CREATE TABLE stored_documents (
  id                  uuid                   PRIMARY KEY,
  tenant_id           uuid                   NOT NULL,
  customer_id         uuid                   NOT NULL,
  contract_id         uuid,
  kind                "StoredDocumentKind"   NOT NULL,
  origin              "StoredDocumentOrigin" NOT NULL,
  -- Clé d'objet scopée t/{tenant}/c/{customer}/… (assertKeyMatchesScope).
  object_key          text                   NOT NULL UNIQUE,
  filename            text                   NOT NULL,
  content_type        text                   NOT NULL,
  size_bytes          bigint                 NOT NULL CHECK (size_bytes >= 0),
  -- Empreinte du fichier TEL QUE STOCKÉ. Calculée à la réception, avant
  -- toute transformation : c'est elle qui fonde la valeur probante.
  sha256              char(64)               NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Filiation : une copie OCR pointe vers l'original dont elle dérive.
  derived_from_id     uuid,
  uploaded_by_user_id uuid,
  created_at          timestamp(3)           NOT NULL,

  CONSTRAINT stored_documents_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT stored_documents_customer_fk FOREIGN KEY (customer_id, tenant_id)
    REFERENCES customers (id, tenant_id),
  -- MATCH SIMPLE : contract_id NULL = document rattaché au seul client.
  CONSTRAINT stored_documents_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT stored_documents_derived_fk FOREIGN KEY (derived_from_id, tenant_id, customer_id)
    REFERENCES stored_documents (id, tenant_id, customer_id)
);
CREATE INDEX stored_documents_contract_idx ON stored_documents (tenant_id, customer_id, contract_id);
CREATE INDEX stored_documents_sha_idx ON stored_documents (tenant_id, sha256);

ALTER TABLE stored_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY stored_documents_scope ON stored_documents
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- ÉCRITURE UNIQUE. Aucune route de remplacement n'existe, et la base le
-- garantit indépendamment du code : un document probant ne se réécrit pas.
-- (La purge RGPD en fin de conservation passe par une fonction dédiée,
-- bornée et journalisée — voir 08-securite-rgpd.md.)
REVOKE UPDATE, DELETE, TRUNCATE ON stored_documents FROM lsi_app;

-- ===========================================================================
-- 4. lifecycle_events + trigger de transition
-- ===========================================================================

CREATE TABLE lifecycle_events (
  id            uuid             PRIMARY KEY,
  tenant_id     uuid             NOT NULL,
  customer_id   uuid             NOT NULL,
  contract_id   uuid             NOT NULL,
  -- NULL à la création du contrat.
  from_status   "ContractStatus",
  to_status     "ContractStatus" NOT NULL,
  -- Événement métier (SUBMIT_FOR_REVIEW, ACCEPT…) et motif, fournis par le
  -- service via les GUC app.transition_event / app.transition_reason.
  event         text,
  reason        text,
  actor_user_id uuid,
  actor_kind    "ActorKind"      NOT NULL,
  occurred_at   timestamp(3)     NOT NULL,
  seq           bigint           GENERATED ALWAYS AS IDENTITY,

  CONSTRAINT lifecycle_events_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id)
    REFERENCES contracts (id, tenant_id, customer_id)
);
CREATE INDEX lifecycle_events_contract_idx ON lifecycle_events (tenant_id, customer_id, contract_id, seq);

ALTER TABLE lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY lifecycle_events_scope ON lifecycle_events
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- Append-only, et écrit UNIQUEMENT par le trigger (SECURITY DEFINER) : le
-- rôle applicatif ne peut ni insérer à la main, ni réécrire l'histoire.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lifecycle_events FROM lsi_app;

-- Le trigger lit l'acteur dans les GUC posées par withScope(). Il s'exécute
-- avec les droits de son propriétaire : l'insertion ne dépend ni des GRANT du
-- rôle courant (lsi_app, lsi_webhook, lsi_scheduler), ni de sa RLS. Le scope
-- de la ligne écrite vient de la ligne `contracts` elle-même (NEW), jamais
-- d'une entrée utilisateur.
CREATE OR REPLACE FUNCTION app_record_contract_transition()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_user_txt text := nullif(current_setting('app.user_id', true), '');
  v_user     uuid;
  v_kind     text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'SYSTEM');
  v_event    text := nullif(current_setting('app.transition_event', true), '');
  v_reason   text := nullif(current_setting('app.transition_reason', true), '');
  v_request  text := nullif(current_setting('app.request_id', true), '');
  v_from     "ContractStatus";
  v_now      timestamptz := now();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_from := OLD.status;
  END IF;

  -- 'system', 'service:ticketing' ne sont pas des UUID : acteur NULL, le
  -- actor_kind porte alors l'information (SYSTEM).
  IF v_user_txt ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_user := v_user_txt::uuid;
  END IF;
  IF v_kind NOT IN ('INTERNAL', 'CLIENT', 'SYSTEM') THEN
    v_kind := 'SYSTEM';
  END IF;

  INSERT INTO lifecycle_events (id, tenant_id, customer_id, contract_id,
    from_status, to_status, event, reason, actor_user_id, actor_kind, occurred_at)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.customer_id, NEW.id,
    v_from, NEW.status, v_event, v_reason, v_user, v_kind::"ActorKind",
    (v_now AT TIME ZONE 'UTC')::timestamp(3));

  -- Et la même transition dans la piste d'audit CHAÎNÉE : c'est elle qui fait
  -- foi en cas de litige (lifecycle_events est la vue métier requêtable).
  PERFORM app_append_audit(
    gen_random_uuid(), NEW.tenant_id, NEW.customer_id,
    v_user, v_kind, NULL, NULL,
    'contract.transition', 'contract', NEW.id,
    jsonb_build_object('from', v_from, 'to', NEW.status, 'event', v_event, 'reason', v_reason),
    v_request, v_now);

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app_record_contract_transition() FROM PUBLIC;

CREATE TRIGGER contracts_status_transition
  AFTER INSERT OR UPDATE OF status ON contracts
  FOR EACH ROW EXECUTE FUNCTION app_record_contract_transition();

-- ===========================================================================
-- 5. Portée des nouveaux rôles
-- ===========================================================================

-- INTERNAL_SIGNATORY signe au nom de LSI pour TOUS les clients : même
-- portée transverse que MSP_ADMIN / LEGAL_REVIEWER. READER reste à
-- portefeuille (customer_access), comme TECHNICIAN.
CREATE OR REPLACE FUNCTION app_resolve_user_scope(p_tenant uuid, p_user uuid)
  RETURNS TABLE (
    user_kind    text,
    customer_id  uuid,
    all_customers boolean,
    role_codes   text[],
    customer_ids uuid[]
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_kind     text;
  v_customer uuid;
  v_roles    text[];
  v_all      boolean;
  v_ids      uuid[];
BEGIN
  SELECT u.kind::text, u.customer_id
    INTO v_kind, v_customer
    FROM users u
   WHERE u.id = p_user AND u.tenant_id = p_tenant AND u.status = 'ACTIVE';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT array_agg(r.code::text)
    INTO v_roles
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_user AND ur.tenant_id = p_tenant;
  v_roles := coalesce(v_roles, ARRAY[]::text[]);

  v_all := (v_kind = 'INTERNAL')
    AND (v_roles && ARRAY['MSP_ADMIN', 'LEGAL_REVIEWER', 'INTERNAL_SIGNATORY']);

  IF v_kind = 'CLIENT' THEN
    v_ids := ARRAY[v_customer];
  ELSIF v_all THEN
    v_ids := ARRAY[]::uuid[];
  ELSE
    SELECT array_agg(ca.customer_id)
      INTO v_ids
      FROM customer_access ca
     WHERE ca.user_id = p_user AND ca.tenant_id = p_tenant;
    v_ids := coalesce(v_ids, ARRAY[]::uuid[]);
  END IF;

  RETURN QUERY SELECT v_kind, v_customer, v_all, v_roles, v_ids;
END
$$;

REVOKE ALL ON FUNCTION app_resolve_user_scope(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_user_scope(uuid, uuid) TO lsi_app;
