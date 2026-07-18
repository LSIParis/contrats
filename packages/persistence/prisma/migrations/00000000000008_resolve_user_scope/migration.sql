-- Résolution de scope au login. (§10.4, Phase B)
--
-- LE PROBLÈME : pour construire le scope d'un utilisateur, il faut lire
-- users / user_roles / customer_access — or ces tables sont sous RLS, qui
-- exige un scope déjà positionné. Œuf et poule.
--
-- LA SOLUTION : une fonction SECURITY DEFINER, plutôt qu'un troisième rôle
-- d'exception au cloisonnement. Elle s'exécute avec les droits de son
-- propriétaire (superutilisateur), donc contourne RLS pour SES requêtes
-- internes uniquement — et ne renvoie QUE les données de scope de
-- l'utilisateur demandé. L'élévation est bornée à cette opération précise,
-- pas accordée à un rôle de connexion.
--
-- Précautions SECURITY DEFINER :
--   - search_path ÉPINGLÉ à public (sinon un search_path malveillant
--     pourrait détourner les références de tables)
--   - entrées PARAMÉTRÉES (uuid), aucune interpolation
--   - EXECUTE révoqué à PUBLIC, accordé au seul lsi_app

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
  -- L'utilisateur doit exister, appartenir au tenant, et être ACTIF.
  -- Un compte désactivé ne résout aucun scope → pas de session.
  SELECT u.kind::text, u.customer_id
    INTO v_kind, v_customer
    FROM users u
   WHERE u.id = p_user AND u.tenant_id = p_tenant AND u.status = 'ACTIVE';

  IF NOT FOUND THEN
    RETURN;  -- aucune ligne : l'appelant en déduit « pas de scope »
  END IF;

  SELECT array_agg(r.code::text)
    INTO v_roles
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_user AND ur.tenant_id = p_tenant;
  v_roles := coalesce(v_roles, ARRAY[]::text[]);

  -- all_customers : réservé à MSP_ADMIN / LEGAL_REVIEWER, et seulement en interne.
  v_all := (v_kind = 'INTERNAL') AND (v_roles && ARRAY['MSP_ADMIN', 'LEGAL_REVIEWER']);

  IF v_kind = 'CLIENT' THEN
    -- Session client : TOUJOURS un singleton (RM-31).
    v_ids := ARRAY[v_customer];
  ELSIF v_all THEN
    v_ids := ARRAY[]::uuid[];
  ELSE
    -- Interne à portefeuille : les clients explicitement accordés.
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
