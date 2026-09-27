-- Lot 9 — propositions commerciales (brief §12, docs/contrats/11-propositions.md).
-- Migration ADDITIVE : aucune table existante n'est réécrite ; les contrats
-- existants, en cours ou importés, restent tels quels (brief §12 règle 6).
--
--   1. Types.
--   2. Classe « tenant » : bibliothèque de contenus, CGV versionnées, modèles
--      de proposition (sections, lignes de prix) — cible du seed de l'annexe C —
--      et compteur de numérotation PROP-AAAA-NNNN.
--   3. Classe « customer » : propositions, versions immuables une fois
--      envoyées, sections / blocs, destinataires, liens d'accès (jeton HACHÉ),
--      suivi de lecture (détail purgeable + agrégats), commentaires, relances,
--      envois, sélections du client, PricingSnapshot, acceptations, signature.
--   4. Liens avec l'existant : contracts.proposal_id (UNIQUE : une proposition
--      ne crée jamais deux contrats), customers.commercial_status,
--      stored_documents.proposal_id, notifications.related_proposal_id.
--   5. RLS : tenant → tenant_id ; customer → tenant + client ; PLUS une
--      politique de LECTURE confinée à UNE proposition pour la page publique
--      (GUC app.proposal_id, posée par withScope pour un lien résolu).
--   6. Journal des transitions (trigger), gardes d'immuabilité, fonctions de
--      découverte SECURITY DEFINER (identifiants seuls) pour les jobs.

-- ===========================================================================
-- 1. Types
-- ===========================================================================

CREATE TYPE "ProposalStatus" AS ENUM (
  'DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED',
  'PENDING_SIGNATURE', 'SIGNED', 'CONVERTED', 'EXPIRED', 'DECLINED', 'WITHDRAWN'
);
CREATE TYPE "ProposalAcceptanceMode" AS ENUM ('DOCUSEAL_SIGNATURE', 'CLICK_ACCEPT');
CREATE TYPE "ProposalSectionKind" AS ENUM ('COVER', 'LIBRARY', 'TEXT', 'CLIENT_INPUT', 'PRICING', 'TERMS', 'SIGNATURE');
CREATE TYPE "ProposalLineKind" AS ENUM ('REQUIRED', 'OPTIONAL', 'SETUP', 'INFO');
CREATE TYPE "ProposalRecurrence" AS ENUM ('ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'INFO');
CREATE TYPE "ProposalLineGroup" AS ENUM ('RECURRING', 'SETUP', 'OPTIONS', 'YEARLY', 'OUT_OF_SCOPE');
CREATE TYPE "ProposalPriceStatus" AS ENUM ('VALIDATED', 'TO_VALIDATE');
CREATE TYPE "ProposalRecipientRole" AS ENUM ('DECISION_MAKER', 'SIGNER', 'READER');
CREATE TYPE "ProposalBlockType" AS ENUM (
  'RICH_TEXT', 'IMAGE', 'VIDEO', 'PRICING_TABLE', 'TIMELINE', 'TEAM', 'REFERENCES', 'FAQ', 'TERMS', 'SIGNATURE'
);
CREATE TYPE "ProposalViewEventKind" AS ENUM ('OPENED', 'SECTION_VIEWED', 'PDF_DOWNLOADED', 'NEW_VIEWER');
CREATE TYPE "ProposalFollowUpKind" AS ENUM ('NO_OPEN', 'NO_DECISION', 'BEFORE_EXPIRY');
CREATE TYPE "ProposalFollowUpStatus" AS ENUM ('PLANNED', 'SENT', 'SKIPPED', 'CANCELLED');
CREATE TYPE "ProposalDeliveryKind" AS ENUM ('INITIAL', 'RESEND', 'NEW_VERSION', 'FOLLOW_UP', 'OTP', 'REVISION_NOTICE');
CREATE TYPE "ProposalCommentAuthor" AS ENUM ('CLIENT', 'INTERNAL');
-- Brief §12.1 : Client gagne un statut PROSPECT | CLIENT | ANCIEN_CLIENT.
CREATE TYPE "CustomerCommercialStatus" AS ENUM ('PROSPECT', 'CLIENT', 'FORMER_CLIENT');

-- GUC de confinement de la page publique : la proposition du lien résolu.
-- NULL hors de ce cas (toutes les sessions internes, portail, jobs).
CREATE OR REPLACE FUNCTION app_current_proposal() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
  DECLARE v text;
  BEGIN
    v := current_setting('app.proposal_id', true);
    IF v IS NULL OR v = '' THEN
      RETURN NULL;
    END IF;
    RETURN v::uuid;
  END
$$;

-- ===========================================================================
-- 2. Classe « tenant »
-- ===========================================================================

-- Bibliothèque de contenus réutilisables (présentation, engagements, FAQ…).
-- `version` s'incrémente à chaque modification ; le texte est FIGÉ dans chaque
-- version de proposition envoyée. `user_modified_at` : modification faite dans
-- l'interface — le seed de l'annexe C ne la réécrit jamais (sauf --force).
CREATE TABLE content_library_items (
  id                    uuid         PRIMARY KEY,
  tenant_id             uuid         NOT NULL,
  key                   text         NOT NULL CHECK (key ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'),
  title                 text         NOT NULL,
  folder                text         NOT NULL,
  body                  text         NOT NULL,
  requires_legal_review boolean      NOT NULL DEFAULT false,
  version               integer      NOT NULL DEFAULT 1 CHECK (version >= 1),
  seed_version          integer,
  seed_checksum         char(64)     CHECK (seed_checksum IS NULL OR seed_checksum ~ '^[0-9a-f]{64}$'),
  user_modified_at      timestamp(3),
  archived_at           timestamp(3),
  created_at            timestamp(3) NOT NULL,
  updated_at            timestamp(3) NOT NULL,
  CONSTRAINT content_library_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT content_library_items_key_key UNIQUE (tenant_id, key),
  CONSTRAINT content_library_items_scope_key UNIQUE (id, tenant_id)
);
CREATE INDEX content_library_items_folder_idx ON content_library_items (tenant_id, folder);

-- CGV et conditions, VERSIONNÉES et immuables : chaque version de proposition
-- référence la version des CGV qu'elle joint (brief §12.3).
CREATE TABLE proposal_terms (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  version_number     integer      NOT NULL CHECK (version_number >= 1),
  title              text         NOT NULL,
  body               text         NOT NULL,
  sha256             char(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid,
  created_at         timestamp(3) NOT NULL,
  CONSTRAINT proposal_terms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT proposal_terms_version_key UNIQUE (tenant_id, version_number),
  CONSTRAINT proposal_terms_scope_key UNIQUE (id, tenant_id)
);

-- Modèles de proposition (annexe C). Forme du fragment `proposal-templates.prisma`,
-- rattachée au tenant par FK et complétée de `signed_proposal_is_contract`
-- (brief §12.7 : désactivée par défaut, à faire valider par un juriste).
CREATE TABLE proposal_templates (
  id                          uuid                     PRIMARY KEY,
  tenant_id                   uuid                     NOT NULL,
  slug                        text                     NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'),
  name                        text                     NOT NULL,
  description                 text                     NOT NULL,
  target                      text                     NOT NULL,
  contract_template_slug      text                     NOT NULL,
  acceptance_mode             "ProposalAcceptanceMode" NOT NULL,
  provider_countersign        boolean                  NOT NULL DEFAULT true,
  validity_days               integer                  NOT NULL DEFAULT 30 CHECK (validity_days BETWEEN 1 AND 365),
  follow_ups                  jsonb                    NOT NULL,
  vat_rate_percent            numeric(5,2)             NOT NULL CHECK (vat_rate_percent BETWEEN 0 AND 100),
  currency                    char(3)                  NOT NULL DEFAULT 'EUR',
  tags                        text[]                   NOT NULL DEFAULT '{}',
  pricing_choices             jsonb                    NOT NULL,
  pricing_rules               jsonb                    NOT NULL,
  control_cases               jsonb,
  signed_proposal_is_contract boolean                  NOT NULL DEFAULT false,
  seed_version                integer,
  seed_checksum               char(64)                 CHECK (seed_checksum IS NULL OR seed_checksum ~ '^[0-9a-f]{64}$'),
  user_modified_at            timestamp(3),
  archived_at                 timestamp(3),
  created_at                  timestamp(3)             NOT NULL,
  updated_at                  timestamp(3)             NOT NULL,
  CONSTRAINT proposal_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT proposal_templates_slug_key UNIQUE (tenant_id, slug),
  CONSTRAINT proposal_templates_scope_key UNIQUE (id, tenant_id)
);

CREATE TABLE proposal_template_sections (
  id                uuid                  PRIMARY KEY,
  tenant_id         uuid                  NOT NULL,
  template_id       uuid                  NOT NULL,
  position          integer               NOT NULL CHECK (position >= 0),
  key               text                  NOT NULL,
  title             text                  NOT NULL,
  kind              "ProposalSectionKind" NOT NULL,
  body              text,
  library_item_key  text,
  guidance          text,
  ai_assist         boolean               NOT NULL DEFAULT false,
  optional          boolean               NOT NULL DEFAULT false,
  validation_status "ProposalPriceStatus" NOT NULL DEFAULT 'VALIDATED',
  CONSTRAINT proposal_template_sections_template_fk FOREIGN KEY (template_id, tenant_id)
    REFERENCES proposal_templates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT proposal_template_sections_key_key UNIQUE (template_id, key)
);
CREATE INDEX proposal_template_sections_position_idx ON proposal_template_sections (template_id, position);

CREATE TABLE proposal_template_pricing_lines (
  id                     uuid                  PRIMARY KEY,
  tenant_id              uuid                  NOT NULL,
  template_id            uuid                  NOT NULL,
  position               integer               NOT NULL CHECK (position >= 0),
  key                    text                  NOT NULL,
  label                  text                  NOT NULL,
  description            text,
  kind                   "ProposalLineKind"    NOT NULL,
  unit                   text                  NOT NULL,
  recurrence             "ProposalRecurrence"  NOT NULL,
  "group"                "ProposalLineGroup"   NOT NULL,
  quantity               jsonb,
  pricing                jsonb                 NOT NULL,
  price_from             boolean               NOT NULL DEFAULT false,
  price_status           "ProposalPriceStatus" NOT NULL,
  price_status_by_choice jsonb,
  price_source           text                  NOT NULL,
  setup_line_key         text,
  indexation             jsonb,
  CONSTRAINT proposal_template_pricing_lines_template_fk FOREIGN KEY (template_id, tenant_id)
    REFERENCES proposal_templates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT proposal_template_pricing_lines_key_key UNIQUE (template_id, key)
);
CREATE INDEX proposal_template_pricing_lines_position_idx ON proposal_template_pricing_lines (template_id, position);

-- Numérotation PROP-AAAA-NNNN : compteur par tenant et par année, incrémenté
-- ATOMIQUEMENT (INSERT … ON CONFLICT DO UPDATE … RETURNING) — jamais un max+1
-- qui se ferait doubler par deux créations concurrentes.
CREATE TABLE proposal_sequences (
  tenant_id  uuid    NOT NULL,
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_value integer NOT NULL CHECK (last_value >= 1),
  CONSTRAINT proposal_sequences_pkey PRIMARY KEY (tenant_id, year),
  CONSTRAINT proposal_sequences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
);

-- ===========================================================================
-- 3. Classe « customer »
-- ===========================================================================

ALTER TABLE customers
  ADD COLUMN commercial_status "CustomerCommercialStatus" NOT NULL DEFAULT 'CLIENT';

CREATE TABLE proposals (
  id                          uuid                     PRIMARY KEY,
  tenant_id                   uuid                     NOT NULL,
  customer_id                 uuid                     NOT NULL,
  number                      text                     NOT NULL CHECK (number ~ '^PROP-[0-9]{4}-[0-9]{4,}$'),
  title                       text                     NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  template_id                 uuid,
  owner_user_id               uuid                     NOT NULL,
  status                      "ProposalStatus"         NOT NULL DEFAULT 'DRAFT',
  acceptance_mode             "ProposalAcceptanceMode" NOT NULL DEFAULT 'DOCUSEAL_SIGNATURE',
  current_version_id          uuid,
  -- Validité : date fixe OU N jours après envoi (brief §12.2).
  validity_days               integer                  NOT NULL DEFAULT 30 CHECK (validity_days BETWEEN 1 AND 365),
  fixed_expiry_date           date,
  expires_at                  timestamp(3),
  -- Accès par code à usage unique pour les propositions sensibles (§12.5).
  sensitive                   boolean                  NOT NULL DEFAULT false,
  review_required             boolean                  NOT NULL DEFAULT false,
  review_submitted_by_user_id uuid,
  review_approved_version_id  uuid,
  review_decided_by_user_id   uuid,
  review_reason               text,
  accepted_version_id         uuid,
  accepted_snapshot_id        uuid,
  follow_ups_enabled          boolean                  NOT NULL DEFAULT true,
  follow_up_config            jsonb,
  -- Valeurs de fusion saisies (parc.*, contact.*, client.effectif…).
  merge_context               jsonb                    NOT NULL DEFAULT '{}',
  win_probability             integer                  CHECK (win_probability IS NULL OR win_probability BETWEEN 0 AND 100),
  -- Montants synthèse de la configuration courante (centimes HT).
  one_time_cents              bigint,
  monthly_cents               bigint,
  commitment_total_cents      bigint,
  commitment_months           integer,
  signed_proposal_is_contract boolean                  NOT NULL DEFAULT false,
  decline_reason_code         text,
  decline_reason              text,
  withdraw_reason             text,
  contract_id                 uuid,
  sent_at                     timestamp(3),
  first_viewed_at             timestamp(3),
  last_activity_at            timestamp(3),
  client_responded_at         timestamp(3),
  accepted_at                 timestamp(3),
  signed_at                   timestamp(3),
  converted_at                timestamp(3),
  declined_at                 timestamp(3),
  expired_at                  timestamp(3),
  withdrawn_at                timestamp(3),
  created_at                  timestamp(3)             NOT NULL,
  updated_at                  timestamp(3)             NOT NULL,
  created_by_user_id          uuid                     NOT NULL,
  updated_by_user_id          uuid                     NOT NULL,
  CONSTRAINT proposals_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposals_number_key UNIQUE (tenant_id, number),
  CONSTRAINT proposals_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES customers (id, tenant_id),
  CONSTRAINT proposals_template_fk FOREIGN KEY (template_id, tenant_id) REFERENCES proposal_templates (id, tenant_id),
  CONSTRAINT proposals_owner_fk FOREIGN KEY (owner_user_id, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT proposals_contract_fk FOREIGN KEY (contract_id, tenant_id, customer_id) REFERENCES contracts (id, tenant_id, customer_id),
  CONSTRAINT proposals_decline_ck CHECK (status <> 'DECLINED' OR decline_reason_code IS NOT NULL),
  CONSTRAINT proposals_converted_ck CHECK (status <> 'CONVERTED' OR contract_id IS NOT NULL)
);
CREATE INDEX proposals_status_idx ON proposals (tenant_id, status);
CREATE INDEX proposals_customer_idx ON proposals (tenant_id, customer_id);
CREATE INDEX proposals_owner_idx ON proposals (tenant_id, owner_user_id, status);
CREATE INDEX proposals_expiry_idx ON proposals (status, expires_at);

-- Journal des transitions, alimenté EXCLUSIVEMENT par trigger (comme lifecycle_events).
CREATE TABLE proposal_lifecycle_events (
  id            uuid             PRIMARY KEY,
  tenant_id     uuid             NOT NULL,
  customer_id   uuid             NOT NULL,
  proposal_id   uuid             NOT NULL,
  from_status   "ProposalStatus",
  to_status     "ProposalStatus" NOT NULL,
  event         text,
  reason        text,
  actor_user_id uuid,
  actor_kind    "ActorKind"      NOT NULL,
  occurred_at   timestamp(3)     NOT NULL,
  seq           bigint           GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT proposal_lifecycle_events_proposal_fk FOREIGN KEY (proposal_id, tenant_id, customer_id)
    REFERENCES proposals (id, tenant_id, customer_id)
);
CREATE INDEX proposal_lifecycle_events_proposal_idx ON proposal_lifecycle_events (tenant_id, customer_id, proposal_id, seq);

-- Version : contenu, tableau de prix proposé, CGV référencées, valeurs de
-- fusion figées. IMMUABLE dès l'envoi (`locked_at`, trigger ci-dessous) : une
-- modification crée une nouvelle version.
CREATE TABLE proposal_versions (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  customer_id        uuid         NOT NULL,
  proposal_id        uuid         NOT NULL,
  version_number     integer      NOT NULL CHECK (version_number >= 1),
  title              text         NOT NULL,
  cover              jsonb        NOT NULL DEFAULT '{}',
  pricing_definition jsonb        NOT NULL,
  pricing_settings   jsonb        NOT NULL DEFAULT '{}',
  terms_id           uuid,
  merge_values       jsonb        NOT NULL DEFAULT '{}',
  content_sha256     char(64)     CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_object_key     text,
  pdf_sha256         char(64)     CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
  change_summary     text,
  locked_at          timestamp(3),
  superseded_at      timestamp(3),
  created_at         timestamp(3) NOT NULL,
  created_by_user_id uuid         NOT NULL,
  CONSTRAINT proposal_versions_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_versions_number_key UNIQUE (proposal_id, version_number),
  CONSTRAINT proposal_versions_proposal_fk FOREIGN KEY (proposal_id, tenant_id, customer_id)
    REFERENCES proposals (id, tenant_id, customer_id),
  CONSTRAINT proposal_versions_terms_fk FOREIGN KEY (terms_id, tenant_id) REFERENCES proposal_terms (id, tenant_id),
  CONSTRAINT proposal_versions_locked_ck CHECK (locked_at IS NOT NULL OR superseded_at IS NULL)
);
CREATE INDEX proposal_versions_proposal_idx ON proposal_versions (tenant_id, customer_id, proposal_id);

CREATE TABLE proposal_sections (
  id                uuid                  PRIMARY KEY,
  tenant_id         uuid                  NOT NULL,
  customer_id       uuid                  NOT NULL,
  proposal_id       uuid                  NOT NULL,
  version_id        uuid                  NOT NULL,
  position          integer               NOT NULL CHECK (position >= 0),
  key               text                  NOT NULL,
  title             text                  NOT NULL,
  kind              "ProposalSectionKind" NOT NULL,
  library_item_key  text,
  guidance          text,
  optional          boolean               NOT NULL DEFAULT false,
  -- Section facultative retirée : ni affichée, ni bloquante (annexe C, excludedSections).
  excluded          boolean               NOT NULL DEFAULT false,
  validation_status "ProposalPriceStatus" NOT NULL DEFAULT 'VALIDATED',
  -- Contenu rédigé par IA pas encore validé par un humain (bandeau, lot 9.9).
  ai_pending_review boolean               NOT NULL DEFAULT false,
  CONSTRAINT proposal_sections_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_sections_key_key UNIQUE (version_id, key),
  CONSTRAINT proposal_sections_position_key UNIQUE (version_id, position),
  CONSTRAINT proposal_sections_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id)
);
CREATE INDEX proposal_sections_proposal_idx ON proposal_sections (tenant_id, customer_id, proposal_id);

CREATE TABLE proposal_blocks (
  id          uuid                PRIMARY KEY,
  tenant_id   uuid                NOT NULL,
  customer_id uuid                NOT NULL,
  proposal_id uuid                NOT NULL,
  section_id  uuid                NOT NULL,
  position    integer             NOT NULL CHECK (position >= 0),
  type        "ProposalBlockType" NOT NULL,
  content     jsonb               NOT NULL,
  CONSTRAINT proposal_blocks_position_key UNIQUE (section_id, position),
  CONSTRAINT proposal_blocks_section_fk FOREIGN KEY (section_id, tenant_id, customer_id)
    REFERENCES proposal_sections (id, tenant_id, customer_id) ON DELETE CASCADE
);
CREATE INDEX proposal_blocks_proposal_idx ON proposal_blocks (tenant_id, customer_id, proposal_id);

CREATE TABLE proposal_recipients (
  id            uuid                    PRIMARY KEY,
  tenant_id     uuid                    NOT NULL,
  customer_id   uuid                    NOT NULL,
  proposal_id   uuid                    NOT NULL,
  contact_id    uuid,
  full_name     text                    NOT NULL,
  email         text                    NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  job_title     text,
  role          "ProposalRecipientRole" NOT NULL,
  signing_order integer                 NOT NULL DEFAULT 0 CHECK (signing_order >= 0),
  created_at    timestamp(3)            NOT NULL,
  updated_at    timestamp(3)            NOT NULL,
  CONSTRAINT proposal_recipients_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_recipients_email_key UNIQUE (proposal_id, email),
  CONSTRAINT proposal_recipients_proposal_fk FOREIGN KEY (proposal_id, tenant_id, customer_id)
    REFERENCES proposals (id, tenant_id, customer_id),
  CONSTRAINT proposal_recipients_contact_fk FOREIGN KEY (contact_id, tenant_id, customer_id)
    REFERENCES customer_contacts (id, tenant_id, customer_id)
);

-- Lien personnel par destinataire. Le JETON n'est jamais stocké : seulement
-- son SHA-256 (≥ 128 bits d'aléa côté application). Même règle pour le code
-- à usage unique et le jeton de session qu'il délivre.
CREATE TABLE proposal_access_links (
  id                     uuid         PRIMARY KEY,
  tenant_id              uuid         NOT NULL,
  customer_id            uuid         NOT NULL,
  proposal_id            uuid         NOT NULL,
  version_id             uuid         NOT NULL,
  recipient_id           uuid         NOT NULL,
  token_hash             char(64)     NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at             timestamp(3) NOT NULL,
  revoked_at             timestamp(3),
  revoked_reason         text,
  otp_hash               char(64)     CHECK (otp_hash IS NULL OR otp_hash ~ '^[0-9a-f]{64}$'),
  otp_expires_at         timestamp(3),
  otp_attempts           integer      NOT NULL DEFAULT 0 CHECK (otp_attempts >= 0),
  otp_session_hash       char(64)     CHECK (otp_session_hash IS NULL OR otp_session_hash ~ '^[0-9a-f]{64}$'),
  otp_session_expires_at timestamp(3),
  otp_verified_at        timestamp(3),
  -- Empreintes pseudonymes des navigateurs déjà vus (lien transféré → NEW_VIEWER).
  known_viewers          text[]       NOT NULL DEFAULT '{}',
  first_used_at          timestamp(3),
  last_used_at           timestamp(3),
  created_at             timestamp(3) NOT NULL,
  CONSTRAINT proposal_access_links_token_key UNIQUE (token_hash),
  CONSTRAINT proposal_access_links_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_access_links_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT proposal_access_links_recipient_fk FOREIGN KEY (recipient_id, tenant_id, customer_id)
    REFERENCES proposal_recipients (id, tenant_id, customer_id)
);
CREATE INDEX proposal_access_links_proposal_idx ON proposal_access_links (tenant_id, customer_id, proposal_id);

-- Suivi de lecture DÉTAILLÉ : purgé après décision ou expiration (durée
-- paramétrable), les AGRÉGATS (proposal_view_stats) sont conservés.
CREATE TABLE proposal_view_events (
  id           uuid                    PRIMARY KEY,
  tenant_id    uuid                    NOT NULL,
  customer_id  uuid                    NOT NULL,
  proposal_id  uuid                    NOT NULL,
  version_id   uuid                    NOT NULL,
  recipient_id uuid,
  link_id      uuid,
  kind         "ProposalViewEventKind" NOT NULL,
  section_key  text,
  duration_ms  integer                 CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  -- IP TRONQUÉE (/24, /48) : jamais l'adresse complète pour le suivi.
  ip_truncated text,
  user_agent   text                    CHECK (user_agent IS NULL OR length(user_agent) <= 200),
  occurred_at  timestamp(3)            NOT NULL,
  CONSTRAINT proposal_view_events_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id)
);
CREATE INDEX proposal_view_events_proposal_idx ON proposal_view_events (tenant_id, proposal_id, occurred_at);

CREATE TABLE proposal_view_stats (
  tenant_id         uuid         NOT NULL,
  customer_id       uuid         NOT NULL,
  proposal_id       uuid         NOT NULL,
  -- '' = total de la proposition ; sinon la clé de section.
  section_key       text         NOT NULL DEFAULT '',
  opens             integer      NOT NULL DEFAULT 0 CHECK (opens >= 0),
  total_duration_ms bigint       NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
  pdf_downloads     integer      NOT NULL DEFAULT 0 CHECK (pdf_downloads >= 0),
  new_viewers       integer      NOT NULL DEFAULT 0 CHECK (new_viewers >= 0),
  last_viewed_at    timestamp(3),
  CONSTRAINT proposal_view_stats_pkey PRIMARY KEY (proposal_id, section_key),
  CONSTRAINT proposal_view_stats_proposal_fk FOREIGN KEY (proposal_id, tenant_id, customer_id)
    REFERENCES proposals (id, tenant_id, customer_id)
);
CREATE INDEX proposal_view_stats_scope_idx ON proposal_view_stats (tenant_id, customer_id);

CREATE TABLE proposal_comments (
  id             uuid                    PRIMARY KEY,
  tenant_id      uuid                    NOT NULL,
  customer_id    uuid                    NOT NULL,
  proposal_id    uuid                    NOT NULL,
  version_id     uuid                    NOT NULL,
  section_key    text,
  parent_id      uuid,
  author_kind    "ProposalCommentAuthor" NOT NULL,
  recipient_id   uuid,
  author_user_id uuid,
  author_name    text                    NOT NULL,
  body           text                    NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at     timestamp(3)            NOT NULL,
  CONSTRAINT proposal_comments_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_comments_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT proposal_comments_parent_fk FOREIGN KEY (parent_id, tenant_id, customer_id)
    REFERENCES proposal_comments (id, tenant_id, customer_id),
  CONSTRAINT proposal_comments_author_ck CHECK (
    (author_kind = 'CLIENT' AND recipient_id IS NOT NULL) OR (author_kind = 'INTERNAL' AND author_user_id IS NOT NULL)
  )
);
CREATE INDEX proposal_comments_proposal_idx ON proposal_comments (tenant_id, customer_id, proposal_id);

CREATE TABLE proposal_follow_ups (
  id          uuid                     PRIMARY KEY,
  tenant_id   uuid                     NOT NULL,
  customer_id uuid                     NOT NULL,
  proposal_id uuid                     NOT NULL,
  kind        "ProposalFollowUpKind"   NOT NULL,
  due_at      timestamp(3)             NOT NULL,
  status      "ProposalFollowUpStatus" NOT NULL DEFAULT 'PLANNED',
  sent_at     timestamp(3),
  skip_reason text,
  created_at  timestamp(3)             NOT NULL,
  updated_at  timestamp(3)             NOT NULL,
  CONSTRAINT proposal_follow_ups_plan_key UNIQUE (proposal_id, kind, due_at),
  CONSTRAINT proposal_follow_ups_proposal_fk FOREIGN KEY (proposal_id, tenant_id, customer_id)
    REFERENCES proposals (id, tenant_id, customer_id)
);
CREATE INDEX proposal_follow_ups_due_idx ON proposal_follow_ups (status, due_at);

-- Historique des envois (envoi, renvoi, nouvelle version, relance, code).
CREATE TABLE proposal_deliveries (
  id              uuid                   PRIMARY KEY,
  tenant_id       uuid                   NOT NULL,
  customer_id     uuid                   NOT NULL,
  proposal_id     uuid                   NOT NULL,
  version_id      uuid                   NOT NULL,
  recipient_id    uuid                   NOT NULL,
  kind            "ProposalDeliveryKind" NOT NULL,
  subject         text                   NOT NULL,
  sent_by_user_id uuid,
  error           text,
  sent_at         timestamp(3)           NOT NULL,
  CONSTRAINT proposal_deliveries_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT proposal_deliveries_recipient_fk FOREIGN KEY (recipient_id, tenant_id, customer_id)
    REFERENCES proposal_recipients (id, tenant_id, customer_id)
);
CREATE INDEX proposal_deliveries_proposal_idx ON proposal_deliveries (tenant_id, customer_id, proposal_id);

-- Chaque modification du client (ou du commercial) : recalculée par le moteur,
-- conservée (append-only). La dernière ligne d'une version est la configuration courante.
CREATE TABLE proposal_selections (
  id                     uuid         PRIMARY KEY,
  tenant_id              uuid         NOT NULL,
  customer_id            uuid         NOT NULL,
  proposal_id            uuid         NOT NULL,
  version_id             uuid         NOT NULL,
  choices                jsonb        NOT NULL,
  quantities             jsonb        NOT NULL,
  selected_options       jsonb        NOT NULL,
  one_time_cents         bigint       NOT NULL,
  monthly_cents          bigint       NOT NULL,
  quarterly_cents        bigint       NOT NULL,
  yearly_cents           bigint       NOT NULL,
  commitment_total_cents bigint       NOT NULL,
  commitment_months      integer      NOT NULL,
  errors                 jsonb        NOT NULL DEFAULT '[]',
  actor_kind             "ActorKind"  NOT NULL,
  recipient_id           uuid,
  user_id                uuid,
  created_at             timestamp(3) NOT NULL,
  CONSTRAINT proposal_selections_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_selections_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id)
);
CREATE INDEX proposal_selections_version_idx ON proposal_selections (tenant_id, version_id, created_at);

-- PricingSnapshot : la configuration FIGÉE à l'acceptation (définition,
-- sélection, barème du moteur, résultat), empreinte SHA-256 de l'ensemble.
-- Reprise telle quelle comme barème initial du contrat. Immuable.
CREATE TABLE pricing_snapshots (
  id                     uuid         PRIMARY KEY,
  tenant_id              uuid         NOT NULL,
  customer_id            uuid         NOT NULL,
  proposal_id            uuid         NOT NULL,
  version_id             uuid         NOT NULL,
  selection_id           uuid         NOT NULL,
  definition             jsonb        NOT NULL,
  selection              jsonb        NOT NULL,
  engine_schedule        jsonb        NOT NULL,
  engine_result          jsonb        NOT NULL,
  one_time_cents         bigint       NOT NULL,
  monthly_cents          bigint       NOT NULL,
  commitment_total_cents bigint       NOT NULL,
  commitment_months      integer      NOT NULL,
  sha256                 char(64)     NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at             timestamp(3) NOT NULL,
  CONSTRAINT pricing_snapshots_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT pricing_snapshots_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT pricing_snapshots_selection_fk FOREIGN KEY (selection_id, tenant_id, customer_id)
    REFERENCES proposal_selections (id, tenant_id, customer_id)
);
CREATE INDEX pricing_snapshots_proposal_idx ON pricing_snapshots (tenant_id, customer_id, proposal_id);

-- Preuve de l'acceptation (brief §12.6) : nom, fonction, e-mail vérifié par
-- code, horodatage, IP (COMPLÈTE : c'est une preuve, pas du suivi), empreinte
-- de la version acceptée. Append-only.
CREATE TABLE proposal_acceptances (
  id                   uuid                     PRIMARY KEY,
  tenant_id            uuid                     NOT NULL,
  customer_id          uuid                     NOT NULL,
  proposal_id          uuid                     NOT NULL,
  version_id           uuid                     NOT NULL,
  snapshot_id          uuid                     NOT NULL,
  recipient_id         uuid,
  mode                 "ProposalAcceptanceMode" NOT NULL,
  accepted_by_name     text                     NOT NULL,
  accepted_by_function text,
  accepted_by_email    text                     NOT NULL,
  email_verified_at    timestamp(3),
  ip                   text,
  user_agent           text,
  version_pdf_sha256   char(64)                 CHECK (version_pdf_sha256 IS NULL OR version_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at          timestamp(3)             NOT NULL,
  CONSTRAINT proposal_acceptances_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT proposal_acceptances_snapshot_fk FOREIGN KEY (snapshot_id, tenant_id, customer_id)
    REFERENCES pricing_snapshots (id, tenant_id, customer_id),
  -- Acceptation par clic : l'e-mail DOIT avoir été vérifié par code.
  CONSTRAINT proposal_acceptances_click_ck CHECK (mode <> 'CLICK_ACCEPT' OR email_verified_at IS NOT NULL)
);
CREATE INDEX proposal_acceptances_proposal_idx ON proposal_acceptances (tenant_id, customer_id, proposal_id);

-- Signature DocuSeal d'une proposition : même adaptateur et même pipeline de
-- webhooks que les contrats, tables propres (le scope se résout par
-- provider_submission_id, jamais par le payload).
CREATE TABLE proposal_signature_requests (
  id                     uuid                     PRIMARY KEY,
  tenant_id              uuid                     NOT NULL,
  customer_id            uuid                     NOT NULL,
  proposal_id            uuid                     NOT NULL,
  version_id             uuid                     NOT NULL,
  snapshot_id            uuid                     NOT NULL,
  provider               "SignatureProvider"      NOT NULL DEFAULT 'DOCUSEAL',
  provider_submission_id text,
  status                 "SignatureRequestStatus" NOT NULL DEFAULT 'CREATING',
  idempotency_key        text                     NOT NULL,
  expire_at              timestamp(3),
  delivery               "SignatureDelivery"      NOT NULL DEFAULT 'EMBEDDED',
  signing_order          text                     CHECK (signing_order IS NULL OR signing_order IN ('CLIENT_THEN_LSI', 'LSI_THEN_CLIENT', 'PARALLEL', 'AS_DEFINED')),
  sent_pdf_object_key    text,
  sent_pdf_sha256        char(64)                 CHECK (sent_pdf_sha256 IS NULL OR sent_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  signed_pdf_object_key  text,
  signed_pdf_sha256      char(64)                 CHECK (signed_pdf_sha256 IS NULL OR signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  audit_trail_object_key text,
  audit_trail_sha256     char(64)                 CHECK (audit_trail_sha256 IS NULL OR audit_trail_sha256 ~ '^[0-9a-f]{64}$'),
  hash_relation          "HashRelation",
  last_synced_at         timestamp(3),
  error_message          text,
  created_at             timestamp(3)             NOT NULL,
  updated_at             timestamp(3)             NOT NULL,
  created_by_user_id     uuid,
  CONSTRAINT proposal_signature_requests_scope_key UNIQUE (id, tenant_id, customer_id),
  CONSTRAINT proposal_signature_requests_submission_key UNIQUE (provider, provider_submission_id),
  CONSTRAINT proposal_signature_requests_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT proposal_signature_requests_version_fk FOREIGN KEY (version_id, tenant_id, customer_id)
    REFERENCES proposal_versions (id, tenant_id, customer_id),
  CONSTRAINT proposal_signature_requests_snapshot_fk FOREIGN KEY (snapshot_id, tenant_id, customer_id)
    REFERENCES pricing_snapshots (id, tenant_id, customer_id)
);
CREATE INDEX proposal_signature_requests_proposal_idx ON proposal_signature_requests (tenant_id, customer_id, proposal_id);
-- Une seule demande ACTIVE par proposition (comme signature_requests_one_active).
CREATE UNIQUE INDEX proposal_signature_requests_one_active ON proposal_signature_requests (proposal_id)
  WHERE status IN ('CREATING', 'SENT', 'PARTIALLY_COMPLETED');

CREATE TABLE proposal_signers (
  id                      uuid           PRIMARY KEY,
  tenant_id               uuid           NOT NULL,
  customer_id             uuid           NOT NULL,
  proposal_id             uuid           NOT NULL,
  signature_request_id    uuid           NOT NULL,
  party                   "SignerParty"  NOT NULL,
  recipient_id            uuid,
  user_id                 uuid,
  full_name               text           NOT NULL,
  email                   text           NOT NULL,
  signing_order           integer        NOT NULL DEFAULT 0,
  status                  "SignerStatus" NOT NULL DEFAULT 'PENDING',
  provider_submitter_id   text,
  provider_submitter_slug text,
  embed_src               text,
  signed_at               timestamp(3),
  declined_at             timestamp(3),
  decline_reason          text,
  created_at              timestamp(3)   NOT NULL,
  updated_at              timestamp(3)   NOT NULL,
  CONSTRAINT proposal_signers_submitter_key UNIQUE (provider_submitter_id),
  CONSTRAINT proposal_signers_request_fk FOREIGN KEY (signature_request_id, tenant_id, customer_id)
    REFERENCES proposal_signature_requests (id, tenant_id, customer_id)
);
CREATE INDEX proposal_signers_request_idx ON proposal_signers (tenant_id, customer_id, signature_request_id);

CREATE TABLE proposal_signature_events (
  id                   uuid                 PRIMARY KEY,
  tenant_id            uuid                 NOT NULL,
  customer_id          uuid                 NOT NULL,
  proposal_id          uuid                 NOT NULL,
  signature_request_id uuid                 NOT NULL,
  -- Idempotence des webhooks garantie en BASE (contrainte), pas par un `if`.
  provider_event_id    text                 NOT NULL,
  event_type           "SignatureEventType" NOT NULL,
  submitter_email      text,
  occurred_at          timestamp(3)         NOT NULL,
  received_at          timestamp(3)         NOT NULL,
  raw_payload          jsonb                NOT NULL,
  processed_at         timestamp(3),
  CONSTRAINT proposal_signature_events_event_key UNIQUE (provider_event_id),
  CONSTRAINT proposal_signature_events_request_fk FOREIGN KEY (signature_request_id, tenant_id, customer_id)
    REFERENCES proposal_signature_requests (id, tenant_id, customer_id)
);
CREATE INDEX proposal_signature_events_request_idx ON proposal_signature_events (tenant_id, customer_id, signature_request_id);

-- ===========================================================================
-- 4. Liens avec l'existant
-- ===========================================================================

-- Contrat issu d'une proposition : UNIQUE → la conversion est idempotente PAR
-- CONSTRUCTION (un webhook rejoué ne crée jamais deux contrats).
ALTER TABLE contracts
  ADD COLUMN proposal_id uuid,
  -- Proposition signée valant contrat (option `signedProposalIsContract`) :
  -- signatureMode dérivé = PROPOSAL_SIGNED.
  ADD COLUMN signed_via_proposal boolean NOT NULL DEFAULT false;
ALTER TABLE contracts ADD CONSTRAINT contracts_proposal_key UNIQUE (proposal_id);
ALTER TABLE contracts ADD CONSTRAINT contracts_proposal_fk
  FOREIGN KEY (proposal_id, tenant_id, customer_id) REFERENCES proposals (id, tenant_id, customer_id);
ALTER TABLE contracts ADD CONSTRAINT contracts_signed_via_proposal_ck
  CHECK (NOT signed_via_proposal OR proposal_id IS NOT NULL);

-- Slug STABLE d'un contrat type : la correspondance modèle de proposition →
-- contrat type (`proposal_templates.contract_template_slug`, annexe C).
ALTER TABLE contract_templates
  ADD COLUMN slug text CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE contract_templates ADD CONSTRAINT contract_templates_slug_key UNIQUE (tenant_id, slug);

ALTER TABLE stored_documents ADD COLUMN proposal_id uuid;
ALTER TABLE stored_documents ADD CONSTRAINT stored_documents_proposal_fk
  FOREIGN KEY (proposal_id, tenant_id, customer_id) REFERENCES proposals (id, tenant_id, customer_id);
CREATE INDEX stored_documents_proposal_idx ON stored_documents (tenant_id, customer_id, proposal_id);

ALTER TABLE notifications ADD COLUMN related_proposal_id uuid;

-- ===========================================================================
-- 5. RLS
-- ===========================================================================

-- Classe « tenant » : jamais lisible par un client (portail ou lien public).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_library_items', 'proposal_terms', 'proposal_templates',
                           'proposal_template_sections', 'proposal_template_pricing_lines', 'proposal_sequences']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO lsi_app
         USING (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'')
         WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'')',
      t || '_scope', t);
  END LOOP;
END
$$;

-- Classe « customer » : tenant + client, INTERNE ou SYSTÈME seulement. Un
-- compte client du portail ne voit pas les propositions (elles contiennent le
-- suivi de lecture et les échanges internes) : il y accède par son lien.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['proposals', 'proposal_lifecycle_events', 'proposal_versions', 'proposal_sections',
                           'proposal_blocks', 'proposal_recipients', 'proposal_access_links', 'proposal_view_events',
                           'proposal_view_stats', 'proposal_comments', 'proposal_follow_ups', 'proposal_deliveries',
                           'proposal_selections', 'pricing_snapshots', 'proposal_acceptances',
                           'proposal_signature_requests', 'proposal_signers', 'proposal_signature_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO lsi_app
         USING (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'' AND app_customer_in_scope(customer_id))
         WITH CHECK (tenant_id = app_current_tenant() AND app_actor_kind() <> ''CLIENT'' AND app_customer_in_scope(customer_id))',
      t || '_scope', t);
  END LOOP;
END
$$;

-- Page publique : LECTURE SEULE, confinée à UNE proposition (celle du lien
-- résolu par app_resolve_proposal_link, posée dans app.proposal_id). Aucune
-- politique d'écriture : toute écriture déclenchée par la page passe par le
-- service, dans le scope système du client, après validation du jeton.
CREATE POLICY proposals_link_read ON proposals FOR SELECT TO lsi_app
  USING (tenant_id = app_current_tenant() AND id = app_current_proposal());
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['proposal_versions', 'proposal_sections', 'proposal_blocks', 'proposal_recipients',
                           'proposal_comments', 'proposal_selections', 'proposal_signers']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO lsi_app
         USING (tenant_id = app_current_tenant() AND proposal_id = app_current_proposal())',
      t || '_link_read', t);
  END LOOP;
END
$$;

-- Webhook DocuSeal : le rôle lsi_webhook résout le scope d'une soumission de
-- proposition exactement comme pour un contrat — six colonnes d'identité.
GRANT SELECT (id, tenant_id, customer_id, proposal_id, provider, provider_submission_id)
  ON proposal_signature_requests TO lsi_webhook;
CREATE POLICY proposal_signature_requests_webhook_lookup ON proposal_signature_requests
  FOR SELECT TO lsi_webhook USING (true);

-- ===========================================================================
-- 6. Immuabilité, journal des transitions, découverte
-- ===========================================================================

REVOKE UPDATE, DELETE, TRUNCATE ON proposal_terms FROM lsi_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON proposal_lifecycle_events FROM lsi_app;
REVOKE DELETE, TRUNCATE ON proposal_versions FROM lsi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proposal_selections FROM lsi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON pricing_snapshots FROM lsi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proposal_acceptances FROM lsi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proposal_deliveries FROM lsi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON proposal_view_events FROM lsi_app;
REVOKE DELETE, TRUNCATE ON proposal_signature_events FROM lsi_app;
REVOKE DELETE, TRUNCATE ON proposal_comments FROM lsi_app;

-- Une version ENVOYÉE (locked_at) est figée : seuls le PDF (posé une fois) et
-- la date de remplacement (posée une fois) peuvent encore être renseignés.
CREATE OR REPLACE FUNCTION app_guard_proposal_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.cover IS DISTINCT FROM OLD.cover
     OR NEW.pricing_definition IS DISTINCT FROM OLD.pricing_definition
     OR NEW.pricing_settings IS DISTINCT FROM OLD.pricing_settings
     OR NEW.terms_id IS DISTINCT FROM OLD.terms_id
     OR NEW.merge_values IS DISTINCT FROM OLD.merge_values
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR (OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256)
     OR (OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'version de proposition % envoyée : immuable (créer une nouvelle version)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER proposal_versions_guard BEFORE UPDATE ON proposal_versions
  FOR EACH ROW EXECUTE FUNCTION app_guard_proposal_version();

-- Sections et blocs d'une version envoyée : figés avec elle.
CREATE OR REPLACE FUNCTION app_guard_proposal_structure() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_version uuid;
  v_locked  timestamp(3);
BEGIN
  IF TG_TABLE_NAME = 'proposal_sections' THEN
    v_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  ELSE
    SELECT s.version_id INTO v_version FROM proposal_sections s
     WHERE s.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.section_id ELSE NEW.section_id END;
  END IF;
  SELECT locked_at INTO v_locked FROM proposal_versions WHERE id = v_version;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'version de proposition % envoyée : sa structure est figée', v_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER proposal_sections_guard BEFORE INSERT OR UPDATE OR DELETE ON proposal_sections
  FOR EACH ROW EXECUTE FUNCTION app_guard_proposal_structure();
CREATE TRIGGER proposal_blocks_guard BEFORE INSERT OR UPDATE OR DELETE ON proposal_blocks
  FOR EACH ROW EXECUTE FUNCTION app_guard_proposal_structure();

-- Journal des transitions : TOUTE transition de statut, d'où qu'elle vienne
-- (requête, page publique, webhook, job), est enregistrée ET chaînée dans la
-- piste d'audit — même patron que contracts_status_transition (migration 17).
CREATE OR REPLACE FUNCTION app_record_proposal_transition()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_user_txt text := nullif(current_setting('app.user_id', true), '');
  v_user     uuid;
  v_kind     text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'SYSTEM');
  v_event    text := nullif(current_setting('app.transition_event', true), '');
  v_reason   text := nullif(current_setting('app.transition_reason', true), '');
  v_request  text := nullif(current_setting('app.request_id', true), '');
  v_from     "ProposalStatus";
  v_now      timestamptz := now();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_from := OLD.status;
  END IF;
  IF v_user_txt ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_user := v_user_txt::uuid;
  END IF;
  IF v_kind NOT IN ('INTERNAL', 'CLIENT', 'SYSTEM') THEN
    v_kind := 'SYSTEM';
  END IF;

  INSERT INTO proposal_lifecycle_events (id, tenant_id, customer_id, proposal_id,
    from_status, to_status, event, reason, actor_user_id, actor_kind, occurred_at)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.customer_id, NEW.id,
    v_from, NEW.status, v_event, v_reason, v_user, v_kind::"ActorKind",
    (v_now AT TIME ZONE 'UTC')::timestamp(3));

  PERFORM app_append_audit(
    gen_random_uuid(), NEW.tenant_id, NEW.customer_id,
    v_user, v_kind, NULL, NULL,
    'proposal.transition', 'proposal', NEW.id,
    jsonb_build_object('from', v_from, 'to', NEW.status, 'event', v_event, 'reason', v_reason, 'number', NEW.number),
    v_request, v_now);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app_record_proposal_transition() FROM PUBLIC;

CREATE TRIGGER proposals_status_transition
  AFTER INSERT OR UPDATE OF status ON proposals
  FOR EACH ROW EXECUTE FUNCTION app_record_proposal_transition();

-- Résolution d'un lien public : SHA-256 du jeton → identifiants de scope.
-- SECURITY DEFINER BORNÉE : un seul lien, identifiants et dates seulement,
-- jamais de contenu. La lecture se fait ENSUITE sous RLS, confinée à la
-- proposition (politiques *_link_read).
CREATE OR REPLACE FUNCTION app_resolve_proposal_link(p_token_hash text)
  RETURNS TABLE (link_id uuid, tenant_id uuid, customer_id uuid, proposal_id uuid, version_id uuid,
                 recipient_id uuid, expires_at timestamp(3), revoked_at timestamp(3))
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT l.id, l.tenant_id, l.customer_id, l.proposal_id, l.version_id, l.recipient_id, l.expires_at, l.revoked_at
    FROM proposal_access_links l
   WHERE l.token_hash = p_token_hash
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_resolve_proposal_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_proposal_link(text) TO lsi_app;

-- Découverte pour les jobs (identifiants seuls, traitement ensuite DANS le scope).
CREATE OR REPLACE FUNCTION app_find_proposals_to_expire(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.tenant_id, p.customer_id
    FROM proposals p
   WHERE p.status IN ('SENT', 'VIEWED', 'IN_DISCUSSION')
     AND p.expires_at IS NOT NULL
     AND p.expires_at <= (now() AT TIME ZONE 'UTC')
   ORDER BY p.expires_at
   LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION app_find_proposal_follow_ups_due(p_limit int DEFAULT 500)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT f.id, f.tenant_id, f.customer_id
    FROM proposal_follow_ups f
   WHERE f.status = 'PLANNED'
     AND f.due_at <= (now() AT TIME ZONE 'UTC')
   ORDER BY f.due_at
   LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION app_find_proposals_to_convert(p_limit int DEFAULT 100)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.tenant_id, p.customer_id
    FROM proposals p
   WHERE p.status = 'SIGNED' AND p.contract_id IS NULL
   ORDER BY p.signed_at NULLS FIRST
   LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION app_find_proposal_signatures_needing_sync(p_stale_minutes int DEFAULT 60, p_limit int DEFAULT 200)
  RETURNS TABLE (id uuid, tenant_id uuid, customer_id uuid, provider_submission_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.tenant_id, s.customer_id, s.provider_submission_id
    FROM proposal_signature_requests s
   WHERE s.status IN ('SENT', 'PARTIALLY_COMPLETED')
     AND s.provider_submission_id IS NOT NULL
     AND (s.last_synced_at IS NULL OR s.last_synced_at < (now() AT TIME ZONE 'UTC') - make_interval(mins => p_stale_minutes))
   ORDER BY s.last_synced_at NULLS FIRST
   LIMIT p_limit
$$;

-- Tenants ayant du suivi détaillé : la purge lit ensuite la durée de
-- conservation de CHAQUE tenant dans son propre scope.
CREATE OR REPLACE FUNCTION app_find_proposal_tracking_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT DISTINCT e.tenant_id FROM proposal_view_events e
$$;

-- Purge RGPD du suivi DÉTAILLÉ (brief §12.5) : événements des propositions
-- DÉCIDÉES ou EXPIRÉES depuis plus de p_days jours. Les agrégats restent.
-- Bornée au tenant de la transaction courante (jamais un autre).
CREATE OR REPLACE FUNCTION app_purge_proposal_view_events(p_tenant uuid, p_days int)
  RETURNS int
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE n int;
BEGIN
  IF p_tenant IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'purge hors tenant courant refusée' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_days IS NULL OR p_days < 0 THEN
    RAISE EXCEPTION 'durée de conservation invalide' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM proposal_view_events e
   USING proposals p
   WHERE e.proposal_id = p.id
     AND e.tenant_id = p_tenant
     AND p.status IN ('SIGNED', 'CONVERTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED')
     AND coalesce(p.converted_at, p.signed_at, p.declined_at, p.withdrawn_at, p.expired_at, p.updated_at)
         < (now() AT TIME ZONE 'UTC') - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION app_find_proposals_to_expire(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_proposal_follow_ups_due(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_proposals_to_convert(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_proposal_signatures_needing_sync(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_proposal_tracking_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_purge_proposal_view_events(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_proposals_to_expire(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_proposal_follow_ups_due(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_proposals_to_convert(int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_proposal_signatures_needing_sync(int, int) TO lsi_app;
GRANT EXECUTE ON FUNCTION app_find_proposal_tracking_tenants() TO lsi_app;
GRANT EXECUTE ON FUNCTION app_purge_proposal_view_events(uuid, int) TO lsi_app;
