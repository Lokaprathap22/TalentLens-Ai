-- Drop the unconditional unique index on candidate_submissions
DROP INDEX IF EXISTS "candidate_submissions_requisition_id_candidate_id_key";

-- Create partial unique index allowing historical submissions while enforcing uniqueness for active ones
CREATE UNIQUE INDEX "candidate_submissions_active_scope_unique_idx" 
ON "candidate_submissions"("requisition_id", "candidate_id") 
WHERE status NOT IN ('WITHDRAWN', 'CLIENT_REJECTED');

-- Create CandidateShortlists table
CREATE TABLE "candidate_shortlists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "shortlisted_by" UUID NOT NULL,
    "shortlisted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes_internal" TEXT,

    CONSTRAINT "candidate_shortlists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_shortlists_requisition_id_candidate_id_key" ON "candidate_shortlists"("requisition_id", "candidate_id");
CREATE INDEX "candidate_shortlists_organization_id_candidate_id_idx" ON "candidate_shortlists"("organization_id", "candidate_id");

ALTER TABLE "candidate_shortlists" ADD CONSTRAINT "candidate_shortlists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_shortlists" ADD CONSTRAINT "candidate_shortlists_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_shortlists" ADD CONSTRAINT "candidate_shortlists_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_shortlists" ADD CONSTRAINT "candidate_shortlists_shortlisted_by_organization_id_fkey" FOREIGN KEY ("shortlisted_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create Interview enums and table
CREATE TYPE "InterviewFormat" AS ENUM ('VIDEO', 'PHONE', 'IN_PERSON');
CREATE TYPE "InterviewProposalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "interview_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "proposer_user_id" UUID NOT NULL,
    "proposer_role" "UserRole" NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "format" "InterviewFormat" NOT NULL DEFAULT 'VIDEO',
    "status" "InterviewProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interview_proposals_submission_id_status_idx" ON "interview_proposals"("submission_id", "status");
CREATE INDEX "interview_proposals_organization_id_requisition_id_idx" ON "interview_proposals"("organization_id", "requisition_id");

ALTER TABLE "interview_proposals" ADD CONSTRAINT "interview_proposals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interview_proposals" ADD CONSTRAINT "interview_proposals_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "candidate_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interview_proposals" ADD CONSTRAINT "interview_proposals_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interview_proposals" ADD CONSTRAINT "interview_proposals_proposer_user_id_organization_id_fkey" FOREIGN KEY ("proposer_user_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

