-- Recherche d'un utilisateur pour le login. (Phase B)
--
-- Le magic link (et plus tard le login mot de passe) doit trouver un
-- utilisateur par email AVANT qu'un scope existe — même œuf-et-poule que
-- app_resolve_user_scope, même solution : SECURITY DEFINER borné.
--
-- Ne renvoie que l'id et le kind, pour un compte ACTIF. Rien d'autre : pas
-- de nom, pas de rôle. Le strict nécessaire pour amorcer un login.

-- Email comparé en insensible à la casse via lower() : l'extension citext
-- n'est pas installée, et un email est insensible à la casse par nature.
CREATE OR REPLACE FUNCTION app_find_login_user(p_tenant uuid, p_email text)
  RETURNS TABLE (user_id uuid, kind text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.kind::text
      FROM users u
     WHERE u.tenant_id = p_tenant
       AND lower(u.email) = lower(p_email)
       AND u.status = 'ACTIVE';
END
$$;

REVOKE ALL ON FUNCTION app_find_login_user(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_login_user(uuid, text) TO lsi_app;

-- Résolution du tenant par slug, avant login (déploiement mono-tenant : le
-- portail sert les clients de LSI, dont on connaît le slug par config).
CREATE OR REPLACE FUNCTION app_find_tenant_by_slug(p_slug text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT id FROM tenants WHERE slug = p_slug AND status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION app_find_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_tenant_by_slug(text) TO lsi_app;
