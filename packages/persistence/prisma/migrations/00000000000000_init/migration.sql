-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('INTERNAL', 'CLIENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN', 'CLIENT_SIGNER', 'CLIENT_VIEWER');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ContractCategory" AS ENUM ('MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('MAIN', 'AMENDMENT');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PENDING_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'RENEWED', 'CANCELLED', 'DECLINED');

-- CreateEnum
CREATE TYPE "BillingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "SignerParty" AS ENUM ('LSI', 'CLIENT');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('PENDING', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SignatureProvider" AS ENUM ('DOCUSEAL');

-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('CREATING', 'SENT', 'PARTIALLY_COMPLETED', 'COMPLETED', 'DECLINED', 'EXPIRED', 'REVOKED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignatureEventType" AS ENUM ('FORM_VIEWED', 'FORM_STARTED', 'FORM_COMPLETED', 'FORM_DECLINED', 'SUBMISSION_COMPLETED', 'SUBMISSION_EXPIRED');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('INTERNAL', 'SHARED');

-- CreateEnum
CREATE TYPE "VirusScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('EXPIRY', 'NOTICE_DEADLINE');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED_OBSOLETE', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('INTERNAL', 'CLIENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REFUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CancellationType" AS ENUM ('CANCELLATION', 'TERMINATION');

-- CreateEnum
CREATE TYPE "InitiatedBy" AS ENUM ('LSI', 'CLIENT');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "UserKind" NOT NULL,
    "customer_id" UUID,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "external_idp_sub" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" "RoleCode" NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "customer_access" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_access_pkey" PRIMARY KEY ("user_id","customer_id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "siren" CHAR(9),
    "vat_number" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "city" TEXT,
    "country" CHAR(2) NOT NULL DEFAULT 'FR',
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "job_title" TEXT,
    "is_signatory" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ContractCategory" NOT NULL DEFAULT 'MAINTENANCE',
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_template_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "body_html" TEXT NOT NULL,
    "variables_schema" JSONB NOT NULL,
    "docuseal_template_id" INTEGER,
    "published_at" TIMESTAMP(3),
    "published_by_user_id" UUID,
    "is_immutable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ContractType" NOT NULL DEFAULT 'MAIN',
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "category" "ContractCategory" NOT NULL DEFAULT 'MAINTENANCE',
    "template_version_id" UUID,
    "current_version_id" UUID,
    "approved_version_id" UUID,
    "parent_contract_id" UUID,
    "predecessor_contract_id" UUID,
    "successor_contract_id" UUID,
    "start_date" DATE,
    "end_date" DATE,
    "notice_period_days" INTEGER,
    "amount_cents" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "billing_frequency" "BillingFrequency" NOT NULL DEFAULT 'MONTHLY',
    "auto_renew_intent" BOOLEAN NOT NULL DEFAULT false,
    "reminder_cycle" INTEGER NOT NULL DEFAULT 0,
    "signed_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "body_html" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "pdf_object_key" TEXT,
    "pdf_sha256" CHAR(64),
    "change_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_signers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "party" "SignerParty" NOT NULL,
    "contact_id" UUID,
    "user_id" UUID,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role_label" TEXT,
    "signing_order" INTEGER NOT NULL DEFAULT 0,
    "status" "SignerStatus" NOT NULL DEFAULT 'PENDING',
    "signed_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "provider_submitter_id" TEXT,
    "provider_submitter_slug" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "submitted_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "contract_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "provider" "SignatureProvider" NOT NULL DEFAULT 'DOCUSEAL',
    "provider_submission_id" TEXT,
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'CREATING',
    "idempotency_key" TEXT NOT NULL,
    "expire_at" TIMESTAMP(3),
    "signed_pdf_object_key" TEXT,
    "signed_pdf_sha256" CHAR(64),
    "audit_trail_object_key" TEXT,
    "timestamp_token" BYTEA,
    "last_synced_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "signature_request_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" "SignatureEventType" NOT NULL,
    "submitter_email" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "raw_payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "processing_error" TEXT,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "parent_comment_id" UUID,
    "author_user_id" UUID NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "body" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_id" UUID,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "uploaded_by_user_id" UUID NOT NULL,
    "virus_scan_status" "VirusScanStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "kind" "ReminderKind" NOT NULL DEFAULT 'EXPIRY',
    "offset_days" INTEGER NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3),
    "late" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "recipient_user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "related_contract_id" UUID,
    "related_reminder_id" UUID,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "sent_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "dedup_key" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "actor_user_id" UUID,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_ip" TEXT,
    "actor_user_agent" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "prev_hash" CHAR(64),
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "new_contract_id" UUID,
    "status" "RenewalStatus" NOT NULL DEFAULT 'PENDING',
    "initiated_by_user_id" UUID NOT NULL,
    "initiated_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "refusal_reason" TEXT,

    CONSTRAINT "renewal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "type" "CancellationType" NOT NULL,
    "reason" TEXT NOT NULL,
    "initiated_by" "InitiatedBy" NOT NULL,
    "effective_date" DATE NOT NULL,
    "notice_respected" BOOLEAN NOT NULL DEFAULT true,
    "override_reason" TEXT,
    "override_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "users_tenant_id_kind_idx" ON "users"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_tenant_id_key" ON "users"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "roles"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_tenant_id_key" ON "roles"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_idx" ON "user_roles"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_access_user_id_idx" ON "customer_access"("user_id");

-- CreateIndex
CREATE INDEX "customer_access_tenant_id_customer_id_idx" ON "customer_access"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_status_idx" ON "customers"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customers_id_tenant_id_key" ON "customers"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_siren_key" ON "customers"("tenant_id", "siren");

-- CreateIndex
CREATE INDEX "customer_contacts_tenant_id_customer_id_idx" ON "customer_contacts"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_contacts_customer_id_email_key" ON "customer_contacts"("customer_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "customer_contacts_id_tenant_id_customer_id_key" ON "customer_contacts"("id", "tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "contract_templates_tenant_id_status_idx" ON "contract_templates"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contract_templates_id_tenant_id_key" ON "contract_templates"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_template_versions_template_id_version_number_key" ON "contract_template_versions"("template_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "contract_template_versions_id_tenant_id_key" ON "contract_template_versions"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_customer_id_status_idx" ON "contracts"("tenant_id", "customer_id", "status");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_customer_id_end_date_idx" ON "contracts"("tenant_id", "customer_id", "end_date");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_owner_user_id_status_idx" ON "contracts"("tenant_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_customer_id_archived_at_idx" ON "contracts"("tenant_id", "customer_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_id_tenant_id_customer_id_key" ON "contracts"("id", "tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_tenant_id_reference_key" ON "contracts"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "contract_versions_tenant_id_customer_id_contract_id_idx" ON "contract_versions"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_contract_id_version_number_key" ON "contract_versions"("contract_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_id_tenant_id_customer_id_key" ON "contract_versions"("id", "tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "contract_signers_tenant_id_customer_id_contract_id_idx" ON "contract_signers"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_signers_contract_id_email_key" ON "contract_signers"("contract_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "contract_signers_provider_submitter_id_key" ON "contract_signers"("provider_submitter_id");

-- CreateIndex
CREATE INDEX "contract_approvals_tenant_id_customer_id_contract_id_idx" ON "contract_approvals"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE INDEX "contract_approvals_tenant_id_decision_idx" ON "contract_approvals"("tenant_id", "decision");

-- CreateIndex
CREATE INDEX "signature_requests_tenant_id_customer_id_contract_id_idx" ON "signature_requests"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE INDEX "signature_requests_status_last_synced_at_idx" ON "signature_requests"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_provider_provider_submission_id_key" ON "signature_requests"("provider", "provider_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_idempotency_key_key" ON "signature_requests"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_id_tenant_id_customer_id_key" ON "signature_requests"("id", "tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "signature_events_tenant_id_customer_id_signature_request_id_idx" ON "signature_events"("tenant_id", "customer_id", "signature_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_events_provider_event_id_key" ON "signature_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "comments_tenant_id_customer_id_contract_id_idx" ON "comments"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE INDEX "attachments_tenant_id_customer_id_contract_id_idx" ON "attachments"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE INDEX "reminders_status_due_at_idx" ON "reminders"("status", "due_at");

-- CreateIndex
CREATE INDEX "reminders_tenant_id_customer_id_contract_id_idx" ON "reminders"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_contract_id_kind_offset_days_cycle_key" ON "reminders"("contract_id", "kind", "offset_days", "cycle");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_user_id_status_idx" ON "notifications"("tenant_id", "recipient_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_customer_id_occurred_at_idx" ON "audit_logs"("tenant_id", "customer_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_resource_type_resource_id_occurred_at_idx" ON "audit_logs"("tenant_id", "resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "renewal_requests_tenant_id_customer_id_contract_id_idx" ON "renewal_requests"("tenant_id", "customer_id", "contract_id");

-- CreateIndex
CREATE INDEX "renewal_requests_tenant_id_status_idx" ON "renewal_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "cancellations_tenant_id_customer_id_contract_id_idx" ON "cancellations"("tenant_id", "customer_id", "contract_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_tenant_id_fkey" FOREIGN KEY ("customer_id", "tenant_id") REFERENCES "customers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_tenant_id_fkey" FOREIGN KEY ("role_id", "tenant_id") REFERENCES "roles"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_access" ADD CONSTRAINT "customer_access_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_access" ADD CONSTRAINT "customer_access_granted_by_user_id_tenant_id_fkey" FOREIGN KEY ("granted_by_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_access" ADD CONSTRAINT "customer_access_customer_id_tenant_id_fkey" FOREIGN KEY ("customer_id", "tenant_id") REFERENCES "customers"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_tenant_id_fkey" FOREIGN KEY ("customer_id", "tenant_id") REFERENCES "customers"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_template_versions" ADD CONSTRAINT "contract_template_versions_template_id_tenant_id_fkey" FOREIGN KEY ("template_id", "tenant_id") REFERENCES "contract_templates"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_tenant_id_fkey" FOREIGN KEY ("customer_id", "tenant_id") REFERENCES "customers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_template_version_id_tenant_id_fkey" FOREIGN KEY ("template_version_id", "tenant_id") REFERENCES "contract_template_versions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_parent_contract_id_fkey" FOREIGN KEY ("parent_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "customer_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_approvals" ADD CONSTRAINT "contract_approvals_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_signature_request_id_tenant_id_customer_i_fkey" FOREIGN KEY ("signature_request_id", "tenant_id", "customer_id") REFERENCES "signature_requests"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_user_id_tenant_id_fkey" FOREIGN KEY ("author_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_tenant_id_fkey" FOREIGN KEY ("recipient_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_reminder_id_fkey" FOREIGN KEY ("related_reminder_id") REFERENCES "reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_contract_id_tenant_id_customer_id_fkey" FOREIGN KEY ("contract_id", "tenant_id", "customer_id") REFERENCES "contracts"("id", "tenant_id", "customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

