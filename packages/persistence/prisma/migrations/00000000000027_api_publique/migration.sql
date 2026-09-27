-- Lot 7 : API publique /api/v1 (brief §8, 07-api.md §2). Migration ADDITIVE.
--
--   1. api_clients   : une application consommatrice de la suite, sa clé
--                      d'API HACHÉE (jamais stockée en clair), ses scopes et
--                      son débit autorisé.
--   2. api_call_log  : une ligne par appel (journalisation exigée par le
--                      brief) — méthode, route, statut, durée ; aucun corps.
--   3. app_resolve_api_key : résolution d'une clé AVANT tout scope (la
--      requête n'a pas encore de tenant) — renvoie le strict nécessaire à la
--      vérification, par préfixe public.
--
-- Classe « tenant » : paramétrage/pilotage, jamais visible d'un client.

CREATE TABLE api_clients (
  id                    uuid          PRIMARY KEY,
  tenant_id             uuid          NOT NULL REFERENCES tenants(id),
  name                  text          NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description           text          CHECK (description IS NULL OR length(description) <= 500),
  -- Partie publique de la clé `ctr_<prefix>_<secret>` : sert à retrouver la
  -- ligne sans balayer la table ; unique sur toute l'instance.
  key_prefix            text          NOT NULL UNIQUE CHECK (key_prefix ~ '^[a-z0-9]{12}$'),
  -- SHA-256 hexadécimal du secret (256 bits aléatoires : un hachage lent
  -- n'apporte rien contre une clé qui n'est pas un mot de passe).
  key_hash              char(64)      NOT NULL,
  scopes                text[]        NOT NULL CHECK (cardinality(scopes) > 0),
  rate_limit_per_minute int           NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  active                boolean       NOT NULL DEFAULT true,
  revoked_at            timestamp(3),
  last_used_at          timestamp(3),
  created_by_user_id    uuid,
  created_at            timestamp(3)  NOT NULL,
  updated_at            timestamp(3)  NOT NULL,
  CONSTRAINT api_clients_revoked_ck CHECK (active = (revoked_at IS NULL)),
  CONSTRAINT api_clients_scope_key UNIQUE (id, tenant_id)
);
CREATE INDEX api_clients_tenant_idx ON api_clients (tenant_id, active);

CREATE TABLE api_call_log (
  id           uuid          PRIMARY KEY,
  tenant_id    uuid          NOT NULL REFERENCES tenants(id),
  client_id    uuid          NOT NULL,
  method       text          NOT NULL CHECK (length(method) <= 10),
  -- Motif de route (`/api/v1/contracts/:id`), jamais l'URL avec paramètres.
  route        text          NOT NULL CHECK (length(route) <= 200),
  status       int           NOT NULL CHECK (status BETWEEN 100 AND 599),
  duration_ms  int           NOT NULL CHECK (duration_ms >= 0),
  request_id   text          CHECK (request_id IS NULL OR length(request_id) <= 100),
  created_at   timestamp(3)  NOT NULL,
  CONSTRAINT api_call_log_client_fk FOREIGN KEY (client_id, tenant_id) REFERENCES api_clients (id, tenant_id)
);
CREATE INDEX api_call_log_client_idx ON api_call_log (tenant_id, client_id, created_at);

ALTER TABLE api_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY api_clients_scope ON api_clients
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE api_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_call_log FORCE ROW LEVEL SECURITY;
CREATE POLICY api_call_log_scope ON api_call_log
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');
-- Journal append-only.
REVOKE UPDATE, DELETE ON api_call_log FROM lsi_app;

-- Résolution d'une clé : la requête n'a pas encore de tenant, la RLS
-- masquerait tout. Renvoie la ligne d'UN préfixe exact, clés actives seules ;
-- le hachage est comparé côté application à temps constant.
CREATE OR REPLACE FUNCTION app_resolve_api_key(p_prefix text)
  RETURNS TABLE (id uuid, tenant_id uuid, key_hash char(64), scopes text[], rate_limit_per_minute int)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT k.id, k.tenant_id, k.key_hash, k.scopes, k.rate_limit_per_minute
    FROM api_clients k
    JOIN tenants t ON t.id = k.tenant_id
   WHERE k.key_prefix = p_prefix
     AND k.active
     AND t.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION app_resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_api_key(text) TO lsi_app;
