-- Webhooks sortants (brief §8, lot 5 ; docs/contrats/07-api.md §Webhooks
-- sortants). Migration ADDITIVE.
--
--   1. webhook_subscriptions : abonnements d'un tenant (URL https, types
--      d'événements, secret HMAC CHIFFRÉ AES-256-GCM par l'application).
--   2. webhook_events        : OUTBOX transactionnelle. Un événement existe si
--      et seulement si la modification métier qui l'a produit a été validée :
--      il est écrit dans LA MÊME transaction (patron « transactional outbox »).
--   3. webhook_deliveries    : une livraison par (événement, abonnement), avec
--      son état de reprise (backoff exponentiel, puis DEAD).
--   4. app_publish_webhook_event : écriture de l'outbox depuis N'IMPORTE quel
--      scope (y compris une transition déclenchée par un client via le
--      portail), sans ouvrir au client la LECTURE de ces tables.
--   5. app_find_due_webhook_deliveries : découverte des livraisons dues
--      (identifiants seuls) pour le worker.
--
-- Trois tables de classe « tenant » : un abonnement est un paramétrage du
-- tenant (MSP_ADMIN), pas une donnée d'un client. `webhook_events.customer_id`
-- est NULLABLE (un `ping` n'a pas de client) et sert au filtrage.

-- ===========================================================================
-- 1. Abonnements
-- ===========================================================================

CREATE TYPE "WebhookDeliveryStatus" AS ENUM (
  'PENDING',    -- à tenter (première tentative ou reprise programmée)
  'DELIVERED',  -- réponse 2xx reçue
  'FAILED',     -- dernière tentative en échec, une reprise est programmée
  'DEAD'        -- échéancier de reprise épuisé : plus aucune tentative auto
);

CREATE TABLE webhook_subscriptions (
  id                   uuid         PRIMARY KEY,
  tenant_id            uuid         NOT NULL REFERENCES tenants(id),
  -- Validée côté application (https obligatoire, hôtes privés refusés en
  -- production) ; le CHECK n'est qu'un filet grossier contre une URL absurde.
  url                  text         NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2048),
  description          text         CHECK (description IS NULL OR length(description) <= 500),
  -- Types abonnés (`contract.signed`, …). Tableau non vide ; le registre des
  -- types valides vit côté application (extensible sans migration).
  event_types          text[]       NOT NULL CHECK (cardinality(event_types) > 0),
  -- Secret HMAC CHIFFRÉ (AES-256-GCM, clé WEBHOOK_SECRET_KEY) : il doit être
  -- relu pour signer, donc un hachage ne convient pas. Format applicatif
  -- « base64(iv).base64(tag).base64(ciphertext) ». Jamais renvoyé par l'API
  -- après la création (ni après une rotation).
  secret_ciphertext    text         NOT NULL,
  -- Version de la clé de chiffrement : permet une rotation de
  -- WEBHOOK_SECRET_KEY sans déchiffrer toute la table d'un coup.
  secret_key_version   int          NOT NULL DEFAULT 1 CHECK (secret_key_version >= 1),
  -- 4 derniers caractères du secret, pour que l'admin reconnaisse LEQUEL est
  -- en place sans jamais le relire en entier.
  secret_hint          text         NOT NULL CHECK (length(secret_hint) <= 8),
  active               boolean      NOT NULL DEFAULT true,
  -- Livraisons DEAD consécutives ; remis à 0 à la première livraison réussie.
  -- Au-delà du seuil (WEBHOOKS_DISABLE_AFTER_DEAD, 20 par défaut) :
  -- désactivation automatique, tracée dans le journal d'audit.
  consecutive_failures int          NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_at          timestamp(3),
  disabled_reason      text,
  created_by_user_id   uuid,
  created_at           timestamp(3) NOT NULL,
  updated_at           timestamp(3) NOT NULL,
  -- Un abonnement inactif porte sa date de désactivation, et réciproquement.
  CONSTRAINT webhook_subscriptions_disabled_ck CHECK (active = (disabled_at IS NULL)),
  CONSTRAINT webhook_subscriptions_scope_key UNIQUE (id, tenant_id)
);

CREATE INDEX webhook_subscriptions_tenant_idx ON webhook_subscriptions (tenant_id, active);

-- ===========================================================================
-- 2. Outbox
-- ===========================================================================

CREATE TABLE webhook_events (
  id           uuid         PRIMARY KEY,
  tenant_id    uuid         NOT NULL REFERENCES tenants(id),
  -- Client concerné (NULL pour un `ping`). Pas de FK composite vers
  -- customers : l'outbox est un journal technique, elle ne doit pas bloquer
  -- une purge RGPD future d'un client (qui purgera aussi ses événements).
  customer_id  uuid,
  type         text         NOT NULL CHECK (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$|^ping$'),
  resource_id  uuid,
  -- MINIMISATION (docs/contrats/08-securite-rgpd.md) : identifiants,
  -- références, dates et statuts seulement. Jamais de nom, d'e-mail, de
  -- montant nominatif ni de contenu contractuel.
  payload      jsonb        NOT NULL,
  occurred_at  timestamp(3) NOT NULL,
  created_at   timestamp(3) NOT NULL,
  CONSTRAINT webhook_events_scope_key UNIQUE (id, tenant_id)
);

CREATE INDEX webhook_events_tenant_idx ON webhook_events (tenant_id, occurred_at);

-- ===========================================================================
-- 3. Livraisons
-- ===========================================================================

CREATE TABLE webhook_deliveries (
  id               uuid                    PRIMARY KEY,
  tenant_id        uuid                    NOT NULL,
  event_id         uuid                    NOT NULL,
  subscription_id  uuid                    NOT NULL,
  status           "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  -- Nombre de tentatives DÉJÀ effectuées.
  attempt          int                     NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at  timestamp(3),
  response_status  int,
  response_ms      int,
  -- Tronqué à 500 caractères côté application : jamais de corps de réponse
  -- complet (il pourrait contenir n'importe quoi).
  last_error       text                    CHECK (last_error IS NULL OR length(last_error) <= 500),
  delivered_at     timestamp(3),
  created_at       timestamp(3)            NOT NULL,
  updated_at       timestamp(3)            NOT NULL,
  -- Une seule livraison par (événement, abonnement) : la publication peut
  -- être rejouée sans doublon (INSERT … ON CONFLICT DO NOTHING).
  CONSTRAINT webhook_deliveries_event_subscription_key UNIQUE (event_id, subscription_id),
  -- FK composites : une livraison ne relie pas l'événement d'un tenant à
  -- l'abonnement d'un autre.
  CONSTRAINT webhook_deliveries_event_fk FOREIGN KEY (event_id, tenant_id)
    REFERENCES webhook_events (id, tenant_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT webhook_deliveries_subscription_fk FOREIGN KEY (subscription_id, tenant_id)
    REFERENCES webhook_subscriptions (id, tenant_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- Une livraison à reprendre a une échéance ; une livraison close n'en a pas.
  CONSTRAINT webhook_deliveries_schedule_ck CHECK (
    (status IN ('PENDING', 'FAILED')) = (next_attempt_at IS NOT NULL)
  ),
  CONSTRAINT webhook_deliveries_delivered_ck CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);

-- Index non partiel : Prisma ne sait pas décrire un index partiel, et
-- db:check-drift doit rester propre.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_subscription_idx ON webhook_deliveries (tenant_id, subscription_id, created_at);

-- ===========================================================================
-- RLS : tenant courant, jamais un CLIENT (ni en lecture ni en écriture).
-- ===========================================================================

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_subscriptions_scope ON webhook_subscriptions
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- Un interne à portefeuille restreint ne lit que les événements de SES
-- clients (ou sans client) ; le worker (SYSTEM) lit tout le tenant pour livrer.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_scope ON webhook_events
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT'
              AND (app_actor_kind() = 'SYSTEM' OR app_customer_in_scope_or_null(customer_id)))
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT'
              AND (app_actor_kind() = 'SYSTEM' OR app_customer_in_scope_or_null(customer_id)));

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_scope ON webhook_deliveries
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- L'outbox est un journal : un événement publié ne se réécrit ni ne s'efface
-- par l'application (la purge éventuelle sera une fonction bornée dédiée).
REVOKE UPDATE, DELETE ON webhook_events FROM lsi_app;
-- Les abonnements se désactivent, ils ne se suppriment pas : l'historique des
-- livraisons doit rester lisible (FK NO ACTION).
REVOKE DELETE ON webhook_subscriptions FROM lsi_app;
REVOKE DELETE ON webhook_deliveries FROM lsi_app;

-- ===========================================================================
-- 4. Publication (outbox) depuis n'importe quel scope
-- ===========================================================================
-- SECURITY DEFINER : insère l'événement ET une livraison PENDING par
-- abonnement actif du tenant qui écoute ce type — en contournant la RLS pour
-- que la publication fonctionne aussi dans une transaction ouverte au nom
-- d'un CLIENT (acceptation portail…), sans lui donner la moindre lecture.
--
-- Bornes : le tenant DOIT être celui de la transaction en cours et le client,
-- s'il est fourni, DOIT être dans le scope courant — la fonction ne permet
-- donc pas d'écrire dans l'outbox d'un autre tenant ni pour un client hors
-- portefeuille. Elle s'exécute dans la transaction de l'appelant : un
-- ROLLBACK de la modification métier emporte l'événement (outbox).
-- `ON CONFLICT DO NOTHING` sur les livraisons : rejouable sans erreur, et
-- surtout sans violation d'unicité qui avorterait la transaction (25P02).
CREATE OR REPLACE FUNCTION app_publish_webhook_event(
  p_event_id    uuid,
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_type        text,
  p_resource_id uuid,
  p_payload     jsonb,
  p_occurred_at timestamp(3),
  -- Cible UNIQUE (événement `ping` du bouton « tester ») : court-circuite le
  -- filtre sur les types abonnés. NULL = diffusion normale.
  p_only_subscription uuid DEFAULT NULL
) RETURNS int
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  n int;
  -- Colonnes timestamp(3) SANS fuseau, en UTC (convention Prisma) : on ne
  -- dépend pas du TimeZone de la session.
  v_now timestamp(3);
BEGIN
  v_now := clock_timestamp() AT TIME ZONE 'UTC';
  IF p_tenant_id IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'publication hors tenant courant refusée' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT app_customer_in_scope(p_customer_id) THEN
    RAISE EXCEPTION 'publication pour un client hors scope refusée' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Aucun abonné actif pour ce type : on n'écrit RIEN (minimisation — une
  -- donnée qui ne sera livrée à personne n'a pas à être conservée). Un
  -- abonnement créé plus tard ne reçoit pas l'historique (pas de rattrapage).
  IF NOT EXISTS (
    SELECT 1 FROM webhook_subscriptions s
     WHERE s.tenant_id = p_tenant_id AND s.active
       AND (CASE WHEN p_only_subscription IS NULL THEN p_type = ANY (s.event_types)
                 ELSE s.id = p_only_subscription END)
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO webhook_events (id, tenant_id, customer_id, type, resource_id, payload, occurred_at, created_at)
  VALUES (p_event_id, p_tenant_id, p_customer_id, p_type, p_resource_id, p_payload, p_occurred_at, v_now);

  -- L'identifiant de livraison est un UUID v4 (gen_random_uuid, natif en
  -- PG 13+) : ordre non significatif, on trie sur created_at / next_attempt_at.
  INSERT INTO webhook_deliveries (id, tenant_id, event_id, subscription_id, status, attempt,
                                  next_attempt_at, created_at, updated_at)
  SELECT gen_random_uuid(), s.tenant_id, p_event_id, s.id, 'PENDING', 0,
         v_now, v_now, v_now
    FROM webhook_subscriptions s
   WHERE s.tenant_id = p_tenant_id
     AND s.active
     AND (CASE WHEN p_only_subscription IS NULL THEN p_type = ANY (s.event_types)
               ELSE s.id = p_only_subscription END)
  ON CONFLICT (event_id, subscription_id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app_publish_webhook_event(uuid, uuid, uuid, text, uuid, jsonb, timestamp, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_publish_webhook_event(uuid, uuid, uuid, text, uuid, jsonb, timestamp, uuid) TO lsi_app;

-- ===========================================================================
-- 5. Découverte des livraisons dues (worker)
-- ===========================================================================
-- Patron des migrations 11 / 19 / 20 : SECURITY DEFINER bornée, identifiants
-- seuls. Le traitement (lecture du secret, de l'événement, mise à jour) se
-- fait ensuite dans le scope système du tenant résolu, sous RLS.
CREATE OR REPLACE FUNCTION app_find_due_webhook_deliveries(p_limit int DEFAULT 100)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT d.id, d.tenant_id
    FROM webhook_deliveries d
    JOIN webhook_subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
   WHERE d.status IN ('PENDING', 'FAILED')
     AND d.next_attempt_at <= (clock_timestamp() AT TIME ZONE 'UTC')
     AND s.active
   ORDER BY d.next_attempt_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app_find_due_webhook_deliveries(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_due_webhook_deliveries(int) TO lsi_app;
