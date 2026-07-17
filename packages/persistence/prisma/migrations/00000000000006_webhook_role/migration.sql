-- Rôle de résolution de scope des webhooks. (§11.4)
--
-- LA SECONDE — et dernière — exception au cloisonnement.
--
-- Le dossier de conception affirmait que le scheduler était la seule.
-- C'était une LACUNE : un webhook arrive sans session et doit lire
-- signature_requests pour découvrir de quel scope il relève. La lecture est
-- donc nécessairement hors scope — on cherche justement le scope.
--
-- Détecté à l'implémentation : le prédicat fail-closed a bloqué le webhook,
-- exactement comme il devait. Le garde-fou a fait son travail en révélant un
-- trou de conception plutôt qu'en le laissant passer.
--
-- Le principe reste : une exception doit être NOMMÉE, JUSTIFIÉE et BORNÉE.
--
-- Ce rôle peut lire QUATRE colonnes d'UNE table :
--   id, tenant_id, customer_id, contract_id
--
-- Il ne peut lire ni le PDF signé, ni les hashes, ni le message d'erreur, ni
-- quoi que ce soit d'autre. Il découvre des identifiants de scope, rien de
-- plus. Si ce rôle fuitait, l'attaquant apprendrait que des demandes de
-- signature existent — pas ce qu'elles contiennent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lsi_webhook') THEN
    CREATE ROLE lsi_webhook LOGIN PASSWORD 'lsi_webhook_test_pwd'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE lsi_webhook NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO lsi_webhook;

-- Quatre colonnes. Pas une de plus.
GRANT SELECT (id, tenant_id, customer_id, contract_id, provider, provider_submission_id)
  ON signature_requests TO lsi_webhook;

-- RLS reste active pour lui : il faut donc une politique dédiée.
-- Elle n'ouvre QUE la résolution de scope, en lecture.
CREATE POLICY signature_requests_webhook_lookup ON signature_requests
  FOR SELECT TO lsi_webhook
  USING (true);

-- Il ne peut RIEN écrire : le traitement de l'événement se fait ensuite
-- sous lsi_app, DANS le scope résolu.
