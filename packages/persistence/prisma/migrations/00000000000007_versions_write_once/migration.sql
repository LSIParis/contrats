-- contract_versions : immuabilité du CONTENU, écriture UNIQUE de l'empreinte.
--
-- La migration 00000000000004 révoquait UPDATE en bloc (RM-05). Trop large :
-- le PDF est rendu à l'ENVOI, pas à la création de la version, donc
-- pdf_object_key et pdf_sha256 doivent pouvoir être renseignés après coup.
--
-- Détecté par tests/isolation/send-for-signature.test.ts.
--
-- Trois options se présentaient, et le choix compte :
--
--   a) GRANT UPDATE (pdf_sha256) → le hash devient MODIFIABLE. Inacceptable :
--      on pourrait réécrire l'empreinte pour qu'elle corresponde à un autre
--      document. C'est exactement la falsification que le hash doit rendre
--      détectable.
--
--   b) Rendre le PDF à chaque création de version → coûteux (un Chromium par
--      sauvegarde de brouillon) et inutile : la plupart des versions ne sont
--      jamais envoyées.
--
--   c) ÉCRITURE UNIQUE : on peut renseigner une fois, jamais changer.
--
-- (c) est la bonne sémantique. Elle n'existe pas nativement en SQL : on
-- l'implémente par trigger. Le coût est un trigger de plus ; le bénéfice est
-- qu'aucun code applicatif, présent ou futur, ne peut réécrire une empreinte.

CREATE OR REPLACE FUNCTION contract_versions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Le CONTENU est immuable, définitivement (RM-05).
  -- Un contrat signé ne se modifie pas : la seule évolution est un avenant.
  IF OLD.body_html      IS DISTINCT FROM NEW.body_html
  OR OLD.variables      IS DISTINCT FROM NEW.variables
  OR OLD.version_number IS DISTINCT FROM NEW.version_number
  OR OLD.contract_id    IS DISTINCT FROM NEW.contract_id
  OR OLD.tenant_id      IS DISTINCT FROM NEW.tenant_id
  OR OLD.customer_id    IS DISTINCT FROM NEW.customer_id
  OR OLD.created_at     IS DISTINCT FROM NEW.created_at
  OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
    RAISE EXCEPTION 'contract_versions : le contenu d''une version est immuable (RM-05)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- L'EMPREINTE est à écriture unique.
  -- Une fois posée, elle atteste « le document envoyé est exactement
  -- celui-ci » (§11.2). La réécrire viderait cette attestation de son sens.
  IF OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 THEN
    RAISE EXCEPTION 'contract_versions.pdf_sha256 : écriture unique, déjà renseignée'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key THEN
    RAISE EXCEPTION 'contract_versions.pdf_object_key : écriture unique, déjà renseignée'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER contract_versions_guard_trg
  BEFORE UPDATE ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION contract_versions_guard();

-- Seules ces deux colonnes sont accessibles en écriture. Le trigger fait le
-- reste : il rend l'écriture UNIQUE, là où le GRANT ne sait dire que
-- « autorisé » ou « interdit ».
GRANT UPDATE (pdf_object_key, pdf_sha256) ON contract_versions TO lsi_app;

-- DELETE reste révoqué : une version ne disparaît jamais.
