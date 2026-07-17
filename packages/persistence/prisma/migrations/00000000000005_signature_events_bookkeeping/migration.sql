-- Affinage de l'append-only sur signature_events.
--
-- La migration 00000000000004 révoquait UPDATE en bloc. Trop large : elle
-- empêchait aussi le service webhook d'écrire sa PROPRE comptabilité de
-- traitement (processed_at, processing_error).
--
-- Détecté par tests/isolation/docuseal-webhook.test.ts.
--
-- La distinction est réelle et vaut d'être tenue :
--
--   PREUVE (immuable)   : raw_payload, event_type, occurred_at, ip,
--                         user_agent, submitter_email, provider_event_id
--                         → ce que le provider a dit. On ne le réécrit pas.
--
--   TRAITEMENT (mutable): processed_at, processing_error
--                         → ce que NOUS avons fait de cette preuve.
--                         Le modifier ne falsifie rien.
--
-- Un GRANT au niveau COLONNE plutôt qu'un GRANT UPDATE global : la preuve
-- reste inaltérable, la comptabilité reste écrivable. Lever la protection
-- entière aurait été plus simple — et aurait rendu le payload réécrivable.

GRANT UPDATE (processed_at, processing_error) ON signature_events TO lsi_app;

-- DELETE reste révoqué : on ne supprime jamais une preuve de signature.
