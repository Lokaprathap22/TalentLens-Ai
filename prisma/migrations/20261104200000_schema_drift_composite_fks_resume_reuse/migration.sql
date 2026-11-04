-- 1. Align column defaults with Prisma schema (@default(uuid()))
ALTER TABLE "candidate_shortlists" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "consent_invitations" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "consent_withdrawal_requests" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "interview_proposals" ALTER COLUMN "id" DROP DEFAULT;

-- 2. Align index names with Prisma convention
ALTER INDEX IF EXISTS "consent_invitations_organization_id_candidate_id_requisition_id" RENAME TO "consent_invitations_organization_id_candidate_id_requisitio_idx";
ALTER INDEX IF EXISTS "consent_withdrawal_requests_organization_id_candidate_id_status" RENAME TO "consent_withdrawal_requests_organization_id_candidate_id_st_idx";

-- 3. Create missing composite index on candidate_consents (F-12)
CREATE INDEX IF NOT EXISTS "candidate_consents_organization_id_candidate_id_requisition_idx"
ON "candidate_consents"("organization_id", "candidate_id", "requisition_id", "purpose", "status");

-- 4. Scope ResumeDocument SHA-256 uniqueness to (organization_id, candidate_id, sha256) and index (organization_id, sha256) (F-10)
DROP INDEX IF EXISTS "resume_documents_organization_id_sha256_key";
CREATE UNIQUE INDEX "resume_documents_organization_id_candidate_id_sha256_key"
ON "resume_documents"("organization_id", "candidate_id", "sha256");
CREATE INDEX "resume_documents_organization_id_sha256_idx"
ON "resume_documents"("organization_id", "sha256");

-- 5. Composite tenant-scoped foreign key for ConsentWithdrawalRequest -> CandidateConsent (F-12)
CREATE UNIQUE INDEX "candidate_consents_id_candidate_org_key"
ON "candidate_consents"("id", "candidate_id", "organization_id");

ALTER TABLE "consent_withdrawal_requests"
DROP CONSTRAINT IF EXISTS "consent_withdrawal_requests_consent_id_fkey";

ALTER TABLE "consent_withdrawal_requests"
ADD CONSTRAINT "consent_withdrawal_requests_consent_id_candidate_id_organi_fkey"
FOREIGN KEY ("consent_id", "candidate_id", "organization_id")
REFERENCES "candidate_consents"("id", "candidate_id", "organization_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Composite tenant-scoped foreign key for InterviewProposal -> CandidateSubmission (F-12)
CREATE UNIQUE INDEX "candidate_submissions_id_req_org_key"
ON "candidate_submissions"("id", "requisition_id", "organization_id");

ALTER TABLE "interview_proposals"
DROP CONSTRAINT IF EXISTS "interview_proposals_submission_id_fkey";

ALTER TABLE "interview_proposals"
ADD CONSTRAINT "interview_proposals_submission_id_requisition_id_organizat_fkey"
FOREIGN KEY ("submission_id", "requisition_id", "organization_id")
REFERENCES "candidate_submissions"("id", "requisition_id", "organization_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

