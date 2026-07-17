-- Row-Level Security sur toutes les tables métier. (§10.3)
--
-- La dernière ligne de défense — la seule que le code applicatif ne peut pas
-- contourner. Les six autres couches (guards, DTO, services, lint, stockage,
-- UX) existent pour détecter une défaillance AVANT d'arriver ici.
--
-- Chaque politique est écrite EXPLICITEMENT, table par table. Une boucle
-- DO $$ serait plus courte, mais appliquerait silencieusement une politique
-- générique à une table qui en exige une spéciale (comments, audit_logs).
-- Le test structurel attrape l'oubli d'une table ; rien n'attraperait la
-- mauvaise politique appliquée sans bruit.
--
-- USING      → ce qu'on peut LIRE
-- WITH CHECK → ce qu'on peut ÉCRIRE
--
-- Les deux, toujours. Sans WITH CHECK on lit son scope mais on écrit dans
-- celui d'un autre : UPDATE ... SET customer_id = <autre> passerait. C'est
-- l'oubli classique des implémentations RLS.

-- ===========================================================================
-- Classe « plateforme »
-- ===========================================================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_scope ON tenants
  FOR ALL TO lsi_app
  USING      (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ===========================================================================
-- Classe « tenant »
-- ===========================================================================

-- users : un CLIENT ne voit que lui-même. Sans ce prédicat, le portail
-- exposerait l'annuaire du personnel LSI et des autres contacts.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_scope ON users
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND (app_actor_kind() <> 'CLIENT' OR id = app_current_user())
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_actor_kind() <> 'CLIENT'
  );

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_scope ON roles
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_scope ON user_roles
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

-- customer_access : la table la plus sensible de l'application (§8.3).
-- Un account manager ne doit pas découvrir le portefeuille de ses collègues.
ALTER TABLE customer_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_access FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_access_scope ON customer_access
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_actor_kind() <> 'CLIENT'
    AND app_customer_in_scope(customer_id)
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_actor_kind() <> 'CLIENT'
    AND app_customer_in_scope(customer_id)
  );

-- customers : le scope porte sur l'id lui-même.
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_scope ON customers
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(id));

-- Les modèles sont mutualisés entre clients (H10) : portée tenant.
-- Un CLIENT n'a aucune raison de lire la bibliothèque de modèles.
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_templates_scope ON contract_templates
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE contract_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_template_versions_scope ON contract_template_versions
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT')
  WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> 'CLIENT');

ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_contacts_scope ON customer_contacts
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- ===========================================================================
-- Classe « customer »
-- ===========================================================================

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY contracts_scope ON contracts
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

ALTER TABLE contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_versions_scope ON contract_versions
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

ALTER TABLE contract_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signers FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_signers_scope ON contract_signers
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- Un CLIENT n'a pas à lire le détail de la validation interne :
-- qui a validé, qui a demandé des modifications, avec quel motif.
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_approvals_scope ON contract_approvals
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND app_actor_kind() <> 'CLIENT'
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND app_actor_kind() <> 'CLIENT'
  );

ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_requests_scope ON signature_requests
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- raw_payload contient les données brutes du provider (IP, UA du signataire).
-- Réservé à l'interne.
ALTER TABLE signature_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_events FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_events_scope ON signature_events
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND app_actor_kind() <> 'CLIENT'
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
  );

-- comments : LE risque de fuite le plus probable de l'application (§6.10).
-- Traité en BASE, pas seulement par un `if` dans un service.
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
CREATE POLICY comments_scope ON comments
  FOR ALL TO lsi_app
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

-- Même cloison de visibilité que les commentaires : une pièce jointe
-- interne (grille tarifaire, note de marge) ne doit jamais fuiter.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_scope ON attachments
  FOR ALL TO lsi_app
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

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY reminders_scope ON reminders
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
    AND app_actor_kind() <> 'CLIENT'
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope(customer_id)
  );

ALTER TABLE renewal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY renewal_requests_scope ON renewal_requests
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY cancellations_scope ON cancellations
  FOR ALL TO lsi_app
  USING      (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id))
  WITH CHECK (tenant_id = app_current_tenant() AND app_customer_in_scope(customer_id));

-- ===========================================================================
-- customer_id NULLABLE
-- ===========================================================================

-- Un utilisateur ne lit QUE ses propres notifications, quel que soit son rôle.
-- Un MSP_ADMIN n'a pas à lire la boîte de réception de ses collègues :
-- les notifications ne sont pas un journal d'audit (c'est audit_logs, §13.4).
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_scope ON notifications
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope_or_null(customer_id)
    AND (app_actor_kind() = 'SYSTEM' OR recipient_user_id = app_current_user())
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope_or_null(customer_id)
  );

-- audit_logs : cloisonné ET interdit aux CLIENT.
-- Les REVOKE UPDATE/DELETE sont dans la migration 00000000000004.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_scope ON audit_logs
  FOR ALL TO lsi_app
  USING (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope_or_null(customer_id)
    AND app_actor_kind() <> 'CLIENT'
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_customer_in_scope_or_null(customer_id)
  );
