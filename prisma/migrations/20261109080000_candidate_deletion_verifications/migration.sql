-- CreateEnum
CREATE TYPE "CandidateDeletionVerificationStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "candidate_deletion_verifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "CandidateDeletionVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_deletion_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_deletion_verifications_token_hash_key" ON "candidate_deletion_verifications"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_deletion_verifications_pending_unique_idx"
ON "candidate_deletion_verifications"("organization_id", "candidate_id")
WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "cdv_org_candidate_status_idx" ON "candidate_deletion_verifications"("organization_id", "candidate_id", "status");

-- CreateIndex
CREATE INDEX "cdv_expires_status_idx" ON "candidate_deletion_verifications"("expires_at", "status");

-- AddForeignKey
ALTER TABLE "candidate_deletion_verifications" ADD CONSTRAINT "cdv_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_deletion_verifications" ADD CONSTRAINT "cdv_candidate_org_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

