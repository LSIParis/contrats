-- Row-Level Security. (§10.3)
--
-- C'est la garantie de cloisonnement. Les six autres couches (guards, DTO,
-- services, lint, UX) existent pour détecter une défaillance AVANT d'arriver
-- ici ; celle-ci est la seule qui ne peut pas être contournée par du code.
--
-- Quatre conditions non négociables (§10.2), chacune couverte par un test :
--   1. FORCE ROW LEVEL SECURITY       → s'applique même au propriétaire
--   2. lsi_app non-propriétaire, sans BYPASSRLS
--   3. GUC transactionnels via set_config(..., true)
--   4. test CI refusant toute table métier sans RLS

-- ---------------------------------------------------------------------------
-- Prédicats de scope
-- ---------------------------------------------------------------------------

-- current_setting('app.tenant_id') est appelé SANS missing_ok.
-- Si le GUC est absent, PostgreSQL lève une exception au lieu de renvoyer NULL.
--
-- C'est délibéré et c'est tout le sujet : une requête hors scope PLANTE,
-- elle ne renvoie pas zéro ligne. Zéro ligne est un bug qui passe la revue
-- et se réveille en production ; une exception casse le test tout de suite.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.tenant_id')::uuid
$$;

CREATE OR REPLACE FUNCTION app_customer_in_scope(row_customer_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.all_customers', true) = 'on'
        OR row_customer_id = ANY (current_setting('app.customer_ids')::uuid[])
$$;

CREATE OR REPLACE FUNCTION app_actor_kind() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.actor_kind')
$$;

-- ---------------------------------------------------------------------------
-- customers — classe « tenant »
-- ---------------------------------------------------------------------------

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

-- On voit un client s'il est dans le tenant ET dans le portefeuille :
-- un account manager ne voit pas la liste des clients qu'il ne gère pas.
CREATE POLICY customers_scope ON customers
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(id));

-- ---------------------------------------------------------------------------
-- contracts — classe « customer »
-- ---------------------------------------------------------------------------

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;

-- WITH CHECK autant que USING.
-- Sans WITH CHECK, on lit son scope mais on ÉCRIT dans celui d'un autre :
-- UPDATE contracts SET customer_id = <autre> passerait. C'est l'oubli
-- classique des implémentations RLS.
CREATE POLICY contracts_scope ON contracts
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- ---------------------------------------------------------------------------
-- comments — classe « customer » + cloison de visibilité
-- ---------------------------------------------------------------------------

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;

-- Le prédicat de visibilité traite en base le risque de fuite le plus
-- probable de l'application (§6.10) : un CLIENT ne voit ni n'écrit jamais
-- un commentaire INTERNAL. Pas seulement un `if` dans un service.
CREATE POLICY comments_scope ON comments
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND (app_actor_kind() <> 'CLIENT' OR visibility = 'SHARED')
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND (app_actor_kind() <> 'CLIENT' OR visibility = 'SHARED')
  );

-- ---------------------------------------------------------------------------
-- tenants — classe « plateforme »
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_scope ON tenants
  USING      (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
