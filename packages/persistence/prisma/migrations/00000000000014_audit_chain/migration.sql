-- §6.9 : chaîne d'audit inviolable (détectable). Deux fonctions SECURITY
-- DEFINER : append (sérialisé par tenant via verrou consultatif) et verify.
-- La table reste append-only (REVOKE UPDATE/DELETE, migration 4) ; une entrée
-- modifiée casse la chaîne, donc DÉTECTABLE.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_append_audit(
  p_id uuid, p_tenant_id uuid, p_customer_id uuid,
  p_actor_user_id uuid, p_actor_kind text, p_actor_ip text, p_actor_user_agent text,
  p_action text, p_resource_type text, p_resource_id uuid,
  p_after jsonb, p_request_id text, p_occurred_at timestamptz
) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev text;
  v_payload text;
  v_hash text;
  -- audit_logs.occurred_at est TIMESTAMP(3) SANS fuseau (migration 0). Un
  -- cast implicite timestamptz → timestamp(3) à l'INSERT dépendrait du GUC
  -- TimeZone de la session — silencieusement différent d'un serveur à
  -- l'autre. On fige donc ICI, explicitement en UTC, la valeur EXACTE qui
  -- sera stockée, et on l'utilise pour le hash ET pour l'INSERT : aucune
  -- divergence possible entre ce qui est haché et ce qui est relu.
  v_occurred_at timestamp(3);
BEGIN
  -- Sérialise les appends du même tenant : la chaîne ne forke jamais.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));
  v_occurred_at := (p_occurred_at AT TIME ZONE 'UTC')::timestamp(3);
  SELECT hash INTO v_prev FROM audit_logs
    WHERE tenant_id = p_tenant_id
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;
  v_payload := coalesce(v_prev, '')
    || E'\n' || v_occurred_at::text
    || E'\n' || p_tenant_id::text
    || E'\n' || coalesce(p_customer_id::text, '')
    || E'\n' || coalesce(p_actor_user_id::text, '')
    || E'\n' || p_actor_kind
    || E'\n' || p_action
    || E'\n' || p_resource_type
    || E'\n' || coalesce(p_resource_id::text, '')
    || E'\n' || coalesce(p_after::text, '');
  v_hash := encode(digest(v_payload, 'sha256'), 'hex');
  INSERT INTO audit_logs (id, tenant_id, customer_id, actor_user_id, actor_kind,
    actor_ip, actor_user_agent, action, resource_type, resource_id,
    before, after, request_id, occurred_at, prev_hash, hash)
  VALUES (p_id, p_tenant_id, p_customer_id, p_actor_user_id, p_actor_kind::"ActorKind",
    p_actor_ip, p_actor_user_agent, p_action, p_resource_type, p_resource_id,
    NULL, p_after, p_request_id, v_occurred_at, v_prev, v_hash);
  RETURN v_hash;
END;
$$;

CREATE OR REPLACE FUNCTION app_verify_audit_chain(p_tenant_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  v_prev text := NULL;
  v_payload text;
  v_hash text;
BEGIN
  FOR r IN
    SELECT * FROM audit_logs WHERE tenant_id = p_tenant_id
    ORDER BY occurred_at ASC, id ASC
  LOOP
    IF coalesce(r.prev_hash, '') <> coalesce(v_prev, '') THEN
      RETURN r.id;  -- rupture de chaînage
    END IF;
    -- r.occurred_at est déjà la valeur canonique stockée (timestamp(3), UTC
    -- par convention) : pas de conversion AT TIME ZONE ici, elle inverserait
    -- le sens de la conversion faite à l'append (cf. commentaire ci-dessus).
    v_payload := coalesce(v_prev, '')
      || E'\n' || r.occurred_at::text
      || E'\n' || r.tenant_id::text
      || E'\n' || coalesce(r.customer_id::text, '')
      || E'\n' || coalesce(r.actor_user_id::text, '')
      || E'\n' || r.actor_kind::text
      || E'\n' || r.action
      || E'\n' || r.resource_type
      || E'\n' || coalesce(r.resource_id::text, '')
      || E'\n' || coalesce(r.after::text, '');
    v_hash := encode(digest(v_payload, 'sha256'), 'hex');
    IF v_hash <> r.hash THEN
      RETURN r.id;  -- hash altéré
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;  -- chaîne intègre
END;
$$;

REVOKE ALL ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) TO lsi_app, lsi_webhook, lsi_scheduler;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid) TO lsi_app, lsi_webhook, lsi_scheduler;
