-- Règles métier opposables, traduites en contraintes de BASE.
--
-- Chacune de ces règles pourrait vivre dans un service. Elle vivrait alors
-- dans UN service, et le prochain chemin d'écriture (un job, un script de
-- reprise, une migration de données) l'ignorerait. En base, elle est vraie
-- pour tout le monde, pour toujours.

-- ---------------------------------------------------------------------------
-- RM-32 : aucun compte hybride INTERNAL + CLIENT
-- ---------------------------------------------------------------------------
-- La traduction en base de « un utilisateur appartient à une seule famille ».
-- Un compte hybride serait le vecteur de fuite le plus direct : un employé
-- LSI dont la session pourrait basculer côté client.
ALTER TABLE users ADD CONSTRAINT users_kind_customer_coherence CHECK (
  (kind = 'CLIENT'   AND customer_id IS NOT NULL) OR
  (kind = 'INTERNAL' AND customer_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- RM-10 : séparation des tâches sur la validation
-- ---------------------------------------------------------------------------
-- Celui qui soumet ne peut pas être celui qui valide.
-- Sans cette contrainte, la validation interne est un théâtre.
ALTER TABLE contract_approvals ADD CONSTRAINT approvals_separation_of_duties CHECK (
  decided_by_user_id IS NULL OR decided_by_user_id <> submitted_by_user_id
);

-- ---------------------------------------------------------------------------
-- RM-08 : cohérence des dates
-- ---------------------------------------------------------------------------
ALTER TABLE contracts ADD CONSTRAINT contracts_date_order CHECK (
  start_date IS NULL OR end_date IS NULL OR start_date <= end_date
);

-- Un avenant a un parent ; un contrat principal n'en a pas (RM-17).
ALTER TABLE contracts ADD CONSTRAINT contracts_amendment_has_parent CHECK (
  (type = 'AMENDMENT' AND parent_contract_id IS NOT NULL) OR
  (type = 'MAIN'      AND parent_contract_id IS NULL)
);

-- Un contrat n'est jamais son propre parent / successeur.
ALTER TABLE contracts ADD CONSTRAINT contracts_no_self_reference CHECK (
  id <> parent_contract_id AND id <> predecessor_contract_id AND id <> successor_contract_id
);

-- On ne stocke pas un montant négatif.
ALTER TABLE contracts ADD CONSTRAINT contracts_amount_non_negative CHECK (
  amount_cents IS NULL OR amount_cents >= 0
);

-- ---------------------------------------------------------------------------
-- RM-19 : un seul avenant en cours par contrat parent
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX contracts_one_open_amendment
  ON contracts (parent_contract_id)
  WHERE type = 'AMENDMENT'
    AND status NOT IN ('CANCELLED', 'DECLINED', 'TERMINATED', 'EXPIRED', 'RENEWED');

-- Une seule demande de signature active par contrat (§8.3).
CREATE UNIQUE INDEX signature_requests_one_active
  ON signature_requests (contract_id)
  WHERE status IN ('CREATING', 'SENT', 'PARTIALLY_COMPLETED');

-- Une seule demande de renouvellement en attente par contrat (§8.3).
CREATE UNIQUE INDEX renewal_requests_one_pending
  ON renewal_requests (contract_id)
  WHERE status = 'PENDING';

-- RM-20 : une dérogation au préavis exige une justification.
ALTER TABLE cancellations ADD CONSTRAINT cancellations_override_needs_reason CHECK (
  notice_respected = true OR (override_reason IS NOT NULL AND override_by_user_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Immuabilité des versions de contrat (RM-05)
-- ---------------------------------------------------------------------------
-- Un contrat signé est immuable DÉFINITIVEMENT — y compris pour MSP_ADMIN.
-- Le droit est retiré au SGBD : ce n'est pas une question de rôle applicatif,
-- c'est une question de valeur probante.
REVOKE UPDATE, DELETE ON contract_versions FROM lsi_app;

-- Idem pour les versions de modèles publiées.
REVOKE DELETE ON contract_template_versions FROM lsi_app;

-- ---------------------------------------------------------------------------
-- Journal d'audit append-only (§13.4)
-- ---------------------------------------------------------------------------
-- Un journal d'audit qu'un administrateur applicatif peut réécrire n'est pas
-- un journal d'audit. Le droit est retiré au niveau du SGBD.
REVOKE UPDATE, DELETE ON audit_logs FROM lsi_app;

-- Les événements de signature sont des preuves : on ne les réécrit pas.
REVOKE UPDATE, DELETE ON signature_events FROM lsi_app;

-- ---------------------------------------------------------------------------
-- Recherche plein texte (§9.3)
-- ---------------------------------------------------------------------------
-- Dans PostgreSQL, donc soumise à RLS comme tout le reste. Un moteur externe
-- serait un second magasin de données avec son propre modèle de sécurité —
-- et le contournement le plus facile de tout le dispositif.
ALTER TABLE contracts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('french', coalesce(reference, '')), 'A') ||
    setweight(to_tsvector('french', coalesce(title, '')), 'A')
  ) STORED;

CREATE INDEX contracts_search_idx ON contracts USING GIN (search_vector);

-- ---------------------------------------------------------------------------
-- Le rôle du scheduler (§12.3)
-- ---------------------------------------------------------------------------
-- LA SEULE exception au cloisonnement de toute l'application.
--
-- Le job de rappels doit découvrir le travail à faire à travers les tenants :
-- il ne peut pas être dans un scope, puisque son rôle est de trouver DE QUEL
-- scope relève chaque tâche.
--
-- L'exception est donc nommée, justifiée, et BORNÉE : lecture seule, sur trois
-- colonnes, d'une seule table. Ce rôle ne peut lire ni un contrat, ni un
-- contenu, ni une adresse. Il découvre des identifiants de scope, rien d'autre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lsi_scheduler') THEN
    CREATE ROLE lsi_scheduler LOGIN PASSWORD 'lsi_scheduler_test_pwd'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE lsi_scheduler NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO lsi_scheduler;
GRANT SELECT (id, tenant_id, customer_id, status, due_at) ON reminders TO lsi_scheduler;

-- RLS reste active pour lui : il faut donc une politique dédiée, qui n'ouvre
-- QUE la découverte des rappels dus.
CREATE POLICY reminders_scheduler_discovery ON reminders
  FOR SELECT TO lsi_scheduler
  USING (status = 'PENDING');
