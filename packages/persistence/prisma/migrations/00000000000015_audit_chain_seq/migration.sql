-- Correctif d'intégrité de la chaîne d'audit.
--
-- BUG corrigé : app_append_audit sélectionnait le maillon précédent par
-- `ORDER BY occurred_at DESC, id DESC`, et app_verify_audit_chain reparcourait
-- par `ORDER BY occurred_at ASC, id ASC`. Or NI occurred_at (capturé côté app
-- avant le verrou) NI id (uuidv7, non monotone à la même milliseconde) n'est
-- assigné SOUS le verrou consultatif. Deux appends concurrents du même tenant
-- pouvaient donc acquérir le verrou dans l'ordre inverse de leur (occurred_at,
-- id) → chaîne forkée → verify en faux positif PERMANENT (table append-only).
--
-- Correctif : une colonne `seq` d'identité, assignée à l'INSERT DANS la
-- fonction (donc dans l'ordre d'acquisition du verrou), sert désormais de clé
-- de chaînage — pour la sélection du prev ET pour l'ordre de parcours de
-- verify. `seq` n'entre PAS dans le payload haché : la canonicalisation est
-- strictement inchangée, seule l'ordination du chaînage change.
ALTER TABLE audit_logs ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX audit_logs_tenant_seq_idx ON audit_logs (tenant_id, seq);

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
  v_occurred_at timestamp(3);
BEGIN
  -- Sérialise les appends du même tenant : la chaîne ne forke jamais.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));
  v_occurred_at := (p_occurred_at AT TIME ZONE 'UTC')::timestamp(3);
  -- Le maillon précédent = la dernière ligne INSÉRÉE sous ce verrou, identifiée
  -- par `seq` (monotone, assigné à l'INSERT), pas par occurred_at/id.
  SELECT hash INTO v_prev FROM audit_logs
    WHERE tenant_id = p_tenant_id
    ORDER BY seq DESC
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
  -- Parcours dans l'ordre de chaînage réel : `seq` (assigné sous le verrou),
  -- pas (occurred_at, id) qui pouvait diverger de l'ordre d'append.
  FOR r IN
    SELECT * FROM audit_logs WHERE tenant_id = p_tenant_id
    ORDER BY seq ASC
  LOOP
    IF coalesce(r.prev_hash, '') <> coalesce(v_prev, '') THEN
      RETURN r.id;  -- rupture de chaînage
    END IF;
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

-- CREATE OR REPLACE préserve les privilèges, mais on les ré-affirme (idempotent).
REVOKE ALL ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_append_audit(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,jsonb,text,timestamptz) TO lsi_app, lsi_webhook, lsi_scheduler;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid) TO lsi_app, lsi_webhook, lsi_scheduler;
