-- Le rôle applicatif. (§10.3)
--
-- Propriétés critiques, chacune testée par tests/isolation/database-guarantees.test.ts :
--   - NON-propriétaire des tables  → RLS s'applique à lui
--   - PAS de BYPASSRLS             → il ne peut pas la contourner
--   - PAS de superuser
--
-- Le mot de passe ci-dessous est un mot de passe de TEST. En production, le rôle
-- est créé par Terraform et le secret vient de Secrets Manager (§13.5).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lsi_app') THEN
    CREATE ROLE lsi_app LOGIN PASSWORD 'lsi_app_test_pwd' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Explicitement, même si c'est le défaut : l'intention doit être lisible.
ALTER ROLE lsi_app NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO lsi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lsi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lsi_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lsi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lsi_app;

-- `contract_versions` et `audit_logs` recevront des REVOKE ciblés
-- dans une migration ultérieure (§13.4).
