-- AlterTable
ALTER TABLE "candidate_consents" ADD COLUMN "notice_text" TEXT;

-- AlterTable
ALTER TABLE "consent_invitations" ADD COLUMN "notice_text" TEXT;

-- CreateTable
CREATE TABLE "organization_consent_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_version" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_consent_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_consent_policies_org_id_version_key" ON "organization_consent_policies"("organization_id", "policy_version");

-- CreateIndex
CREATE INDEX "org_consent_policies_org_id_version_idx" ON "organization_consent_policies"("organization_id", "policy_version");

-- AddForeignKey
ALTER TABLE "organization_consent_policies" ADD CONSTRAINT "organization_consent_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_consent_policies" ADD CONSTRAINT "org_consent_policies_approved_by_fkey" FOREIGN KEY ("approved_by_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

