-- CreateEnum
CREATE TYPE "ConsentInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "InvitationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');

-- AlterTable
ALTER TABLE "candidate_consents" ADD COLUMN "requisition_id" UUID,
ADD COLUMN "notice_text_hash" TEXT,
ADD COLUMN "confirmation_name" TEXT;

-- CreateTable
CREATE TABLE "consent_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL DEFAULT 'HIRING_USE',
    "status" "ConsentInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "policy_version" TEXT NOT NULL,
    "notice_text_hash" TEXT NOT NULL,
    "delivery_status" "InvitationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "delivery_error" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_withdrawal_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "consent_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consent_invitations_token_hash_key" ON "consent_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "consent_invitations_token_hash_idx" ON "consent_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "consent_invitations_organization_id_candidate_id_requisition_id_status_idx" ON "consent_invitations"("organization_id", "candidate_id", "requisition_id", "status");

-- CreateIndex
CREATE INDEX "consent_invitations_expires_at_status_idx" ON "consent_invitations"("expires_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consent_withdrawal_requests_token_hash_key" ON "consent_withdrawal_requests"("token_hash");

-- CreateIndex
CREATE INDEX "consent_withdrawal_requests_token_hash_idx" ON "consent_withdrawal_requests"("token_hash");

-- CreateIndex
CREATE INDEX "consent_withdrawal_requests_organization_id_candidate_id_status_idx" ON "consent_withdrawal_requests"("organization_id", "candidate_id", "status");

-- CreateIndex
CREATE INDEX "consent_withdrawal_requests_expires_at_status_idx" ON "consent_withdrawal_requests"("expires_at", "status");

-- CreateIndex
CREATE INDEX "candidate_consents_candidate_id_requisition_id_status_idx" ON "candidate_consents"("candidate_id", "requisition_id", "status");

-- AddForeignKey
ALTER TABLE "candidate_consents" ADD CONSTRAINT "candidate_consents_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_created_by_organization_id_fkey" FOREIGN KEY ("created_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_withdrawal_requests" ADD CONSTRAINT "consent_withdrawal_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_withdrawal_requests" ADD CONSTRAINT "consent_withdrawal_requests_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_withdrawal_requests" ADD CONSTRAINT "consent_withdrawal_requests_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "candidate_consents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
