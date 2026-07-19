-- Création d'un client. (§6.2)
--
-- La policy customers_scope a WITH CHECK (app_customer_in_scope(id)) : un
-- account manager ne peut pas insérer un client dont l'id neuf n'est pas encore
-- dans son scope (œuf/poule). Cette fonction SECURITY DEFINER bornée insère le
-- client ET, si demandé, la ligne customer_access du créateur — atomiquement.
-- Sous lsi_app, aucun nouveau rôle bypass. Le tenant vient du scope
-- server-résolu, jamais du client.
CREATE OR REPLACE FUNCTION app_create_customer(
  p_id uuid, p_tenant_id uuid, p_name text, p_legal_name text, p_siren text,
  p_vat_number text, p_address_line1 text, p_address_line2 text,
  p_postal_code text, p_city text, p_country text, p_notes text,
  p_creator_user_id uuid, p_grant_access boolean
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO customers (id, tenant_id, name, legal_name, siren, vat_number,
    address_line1, address_line2, postal_code, city, country, status, notes,
    created_at, updated_at)
  VALUES (p_id, p_tenant_id, p_name, p_legal_name, p_siren, p_vat_number,
    p_address_line1, p_address_line2, p_postal_code, p_city,
    COALESCE(p_country, 'FR'), 'ACTIVE', p_notes, now(), now());

  IF p_grant_access THEN
    INSERT INTO customer_access (tenant_id, user_id, customer_id, granted_by_user_id, granted_at)
    VALUES (p_tenant_id, p_creator_user_id, p_id, p_creator_user_id, now());
  END IF;

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION app_create_customer(uuid,uuid,text,text,text,text,text,text,text,text,text,text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_create_customer(uuid,uuid,text,text,text,text,text,text,text,text,text,text,uuid,boolean) TO lsi_app;
