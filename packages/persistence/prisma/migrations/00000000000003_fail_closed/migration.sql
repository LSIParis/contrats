-- Échec fermé EXPLICITE des prédicats de scope.
--
-- Découvert par tests/isolation/scope-enforcement.test.ts :
--
-- L'hypothèse initiale — « current_setting() sans missing_ok lève si le GUC
-- n'est pas positionné » — n'est vraie que sur une connexion NEUVE. Dès qu'un
-- set_config(..., true) a eu lieu, le GUC devient connu de la SESSION ; après
-- le commit il ne redevient pas inconnu, il retombe à la CHAÎNE VIDE.
--
-- Conséquences observées sur une connexion recyclée du pool :
--   app.tenant_id    = ''  →  ''::uuid    → 22P02 invalid input syntax
--   app.customer_ids = ''  →  ''::uuid[]  → 22P02 malformed array literal
--
-- La garantie tenait (les deux chemins lèvent), mais elle tenait PAR ACCIDENT :
-- un échec de cast, pas une décision. Deux problèmes avec cela :
--   1. le message n'explique rien à qui débogue à 2 h du matin ;
--   2. elle dépend d'un détail de typage — un futur changement de type de
--      colonne, ou un GUC dont la valeur vide serait castable, la ferait
--      disparaître SILENCIEUSEMENT.
--
-- On rend donc le refus explicite. Le code 42501 (insufficient_privilege) est
-- stable, assertable, et dit ce qui s'est passé.

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

CREATE OR REPLACE FUNCTION app_customer_in_scope(row_customer_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
  DECLARE ids text; all_c text;
  BEGIN
    all_c := current_setting('app.all_customers', true);
    ids   := current_setting('app.customer_ids', true);

    -- Aucun des deux positionné = hors withScope. On refuse bruyamment
    -- plutôt que de renvoyer false (qui donnerait « zéro ligne » — le
    -- bug silencieux que tout ce dispositif cherche à éviter).
    IF (all_c IS NULL OR all_c = '') AND (ids IS NULL OR ids = '') THEN
      RAISE EXCEPTION 'scope absent : app.customer_ids non positionné — la requête doit passer par withScope()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF all_c = 'on' THEN
      RETURN true;
    END IF;

    IF ids IS NULL OR ids = '' OR ids = '{}' THEN
      RETURN false;   -- scope explicitement vide : légitime, renvoie 0 ligne
    END IF;

    RETURN row_customer_id = ANY (ids::uuid[]);
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
