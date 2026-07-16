-- Prédicats de scope. (§10.3)
--
-- ÉCHEC FERMÉ EXPLICITE.
--
-- L'approche initiale reposait sur current_setting() sans missing_ok, en
-- supposant qu'un GUC absent lèverait. C'est vrai sur connexion NEUVE
-- seulement : dès qu'un set_config(..., true) a eu lieu, le GUC devient connu
-- de la SESSION et retombe à la CHAÎNE VIDE au commit, pas à « inconnu ».
-- L'exception venait alors d'un cast raté (''::uuid[] → 22P02) — la garantie
-- tenait PAR ACCIDENT et aurait disparu silencieusement au premier changement
-- de type de colonne.
--
-- On refuse donc explicitement, avec un code stable (42501) et un message qui
-- dit quoi faire. Découvert par tests/isolation/scope-enforcement.test.ts.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
  DECLARE v text;
  BEGIN
    v := current_setting('app.tenant_id', true);
    IF v IS NULL OR v = '' THEN
      RAISE EXCEPTION 'scope absent : app.tenant_id non positionné — la requête doit passer par withScope()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN v::uuid;
  END
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
  DECLARE v text;
  BEGIN
    v := current_setting('app.user_id', true);
    IF v IS NULL OR v = '' OR v = 'system' THEN
      RETURN NULL;   -- le rôle SYSTEM n'est pas un utilisateur
    END IF;
    RETURN v::uuid;
  END
$$;

CREATE OR REPLACE FUNCTION app_actor_kind() RETURNS text
  LANGUAGE plpgsql STABLE AS $$
  DECLARE v text;
  BEGIN
    v := current_setting('app.actor_kind', true);
    IF v IS NULL OR v = '' THEN
      RAISE EXCEPTION 'scope absent : app.actor_kind non positionné — la requête doit passer par withScope()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN v;
  END
$$;

CREATE OR REPLACE FUNCTION app_customer_in_scope(row_customer_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
  DECLARE ids text; all_c text;
  BEGIN
    all_c := current_setting('app.all_customers', true);
    ids   := current_setting('app.customer_ids', true);

    -- Aucun des deux positionné = hors withScope. On refuse BRUYAMMENT plutôt
    -- que de renvoyer false — qui donnerait « zéro ligne », le bug silencieux
    -- que tout ce dispositif cherche à éviter.
    IF (all_c IS NULL OR all_c = '') AND (ids IS NULL OR ids = '') THEN
      RAISE EXCEPTION 'scope absent : app.customer_ids non positionné — la requête doit passer par withScope()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF all_c = 'on' THEN
      RETURN true;
    END IF;

    -- Scope explicitement vide : légitime (un AM sans portefeuille).
    IF ids IS NULL OR ids = '' OR ids = '{}' THEN
      RETURN false;
    END IF;

    RETURN row_customer_id = ANY (ids::uuid[]);
  END
$$;

-- Variante pour les colonnes customer_id NULLABLE (notifications, audit_logs).
-- Une ligne sans client est de portée tenant : visible dans le tenant.
CREATE OR REPLACE FUNCTION app_customer_in_scope_or_null(row_customer_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
  BEGIN
    IF row_customer_id IS NULL THEN
      -- Toujours évaluer le scope malgré tout : garantit l'échec fermé
      -- même sur une table dont toutes les lignes seraient à NULL.
      PERFORM app_customer_in_scope('00000000-0000-0000-0000-000000000000'::uuid);
      RETURN true;
    END IF;
    RETURN app_customer_in_scope(row_customer_id);
  END
$$;
