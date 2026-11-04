-- AlterEnum
ALTER TYPE "ProcessingJobStatus" ADD VALUE 'HELD_FOR_AUTHORIZATION';

COMMIT;

-- AlterTable
ALTER TABLE "processing_jobs" ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "locked_by" TEXT,
ADD COLUMN "lease_token" UUID;

-- CreateIndex
CREATE INDEX "processing_jobs_status_lease_expires_at_idx" ON "processing_jobs"("status", "lease_expires_at");

-- Backfill: Transition existing QUEUED, RETRYABLE_FAILURE, or PROCESSING jobs lacking active HIRING_USE consent to HELD_FOR_AUTHORIZATION
UPDATE "processing_jobs" pj
SET "status" = 'HELD_FOR_AUTHORIZATION'
WHERE pj."status" IN ('QUEUED', 'RETRYABLE_FAILURE', 'PROCESSING')
  AND (
    pj."resume_document_id" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "resume_documents" rd
      JOIN "candidate_consents" cc
        ON cc."candidate_id" = rd."candidate_id"
       AND cc."organization_id" = rd."organization_id"
      WHERE rd."id" = pj."resume_document_id"
        AND cc."purpose" = 'HIRING_USE'
        AND cc."status" = 'ACTIVE'
        AND cc."withdrawn_at" IS NULL
    )
  );

-- Backfill: Safe recovery state for any remaining authorized PROCESSING jobs
UPDATE "processing_jobs"
SET "status" = 'QUEUED',
    "started_at" = NULL
WHERE "status" = 'PROCESSING';
