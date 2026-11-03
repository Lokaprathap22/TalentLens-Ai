-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('RECRUITER', 'CLIENT_HIRING_MANAGER', 'DELIVERY_HEAD');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('CLIENT_HIRING_MANAGER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'FILLED');

-- CreateEnum
CREATE TYPE "ScorecardStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CriterionCategory" AS ENUM ('SKILL', 'EXPERIENCE', 'NOTICE', 'COMPENSATION', 'OTHER_JOB_RELATED');

-- CreateEnum
CREATE TYPE "RequirementType" AS ENUM ('MUST_HAVE', 'PREFERRED');

-- CreateEnum
CREATE TYPE "CandidateRecordStatus" AS ENUM ('ACTIVE', 'DELETION_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('ACTIVE', 'REDACTED', 'DELETED');

-- CreateEnum
CREATE TYPE "ResumeParseStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARSED', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('PDF', 'DOCX');

-- CreateEnum
CREATE TYPE "ExtractionQualityStatus" AS ENUM ('COMPLETE', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "ProcessingBatchStatus" AS ENUM ('CREATED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "ProcessingJobType" AS ENUM ('VALIDATE_FILE', 'EXTRACT_TEXT', 'OCR', 'EXTRACT_PROFILE', 'DETECT_DUPLICATE', 'ASSESS_CANDIDATE');

-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('COMPLETE', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "CriterionAssessmentStatus" AS ENUM ('MATCH', 'PARTIAL', 'NOT_FOUND', 'UNCERTAIN', 'UNVERIFIED', 'NOT_ASSESSED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('EXACT_QUOTE', 'OFFSET_MATCH', 'PAGE_MATCH', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('REVIEWED', 'NEEDS_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('SUBMITTED', 'CLIENT_SHORTLISTED', 'CLIENT_REJECTED', 'INTERVIEW_PROPOSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ClientDecisionType" AS ENUM ('SHORTLIST', 'REJECT', 'PROPOSE_INTERVIEW');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('SOURCED', 'PARSING', 'PARSED', 'ASSESSED', 'RECRUITER_REVIEW', 'SUBMITTED_TO_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_PROPOSED', 'INTERVIEW_SCHEDULED', 'OFFERED', 'JOINED', 'CLIENT_REJECTED', 'RECRUITER_CLOSED', 'CANDIDATE_WITHDREW', 'ON_HOLD', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('HIRING_USE');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "ConsentCaptureMethod" AS ENUM ('RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "DeletionRequestStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_BLOCKED', 'REJECTED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_memberships" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "jd_text" TEXT NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "assigned_recruiter_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ScorecardStatus" NOT NULL DEFAULT 'DRAFT',
    "weights_json" JSONB NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_criteria" (
    "id" UUID NOT NULL,
    "scorecard_version_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "CriterionCategory" NOT NULL,
    "requirementType" "RequirementType" NOT NULL,
    "weight" DECIMAL(7,4) NOT NULL,
    "rule_json" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecard_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_code" TEXT NOT NULL,
    "record_status" "CandidateRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_identity" (
    "candidate_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "full_name_encrypted" TEXT,
    "email_encrypted" TEXT,
    "phone_encrypted" TEXT,
    "contact_fingerprint" TEXT,
    "identity_status" "IdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_identity_pkey" PRIMARY KEY ("candidate_id")
);

-- CreateTable
CREATE TABLE "candidate_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "current_role" TEXT,
    "experience_years" DECIMAL(6,2),
    "location" TEXT,
    "current_ctc" DECIMAL(14,2),
    "expected_ctc" DECIMAL(14,2),
    "notice_days" INTEGER,
    "summary" TEXT,
    "profile_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_skills" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_profile_id" UUID NOT NULL,
    "skill_name_normalized" TEXT NOT NULL,
    "evidence_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_type" "FileType" NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "parse_status" "ResumeParseStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_extractions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "extracted_text" TEXT NOT NULL,
    "page_map_json" JSONB NOT NULL,
    "parser" TEXT NOT NULL,
    "ocr_used" BOOLEAN NOT NULL DEFAULT false,
    "quality_status" "ExtractionQualityStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_texts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_extraction_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "redacted_text" TEXT NOT NULL,
    "page_map_json" JSONB NOT NULL,
    "redaction_map_json" JSONB NOT NULL,
    "redactor_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "total_files" INTEGER NOT NULL,
    "status" "ProcessingBatchStatus" NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "resume_document_id" UUID,
    "job_type" "ProcessingJobType" NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_assessments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "document_extraction_id" UUID NOT NULL,
    "scorecard_version_id" UUID NOT NULL,
    "assessment_text_id" UUID NOT NULL,
    "score" DECIMAL(6,2),
    "coverage" DECIMAL(6,2),
    "status" "AssessmentStatus" NOT NULL,
    "formula_version" TEXT NOT NULL,
    "model_metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "criterion_assessments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "criterion_id" UUID NOT NULL,
    "scorecard_version_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "assessment_text_id" UUID NOT NULL,
    "document_extraction_id" UUID NOT NULL,
    "status" "CriterionAssessmentStatus" NOT NULL,
    "normalized_value" DECIMAL(5,4),
    "explanation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "criterion_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_snippets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "criterion_assessment_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "scorecard_version_id" UUID NOT NULL,
    "quote" TEXT NOT NULL,
    "page_number" INTEGER,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verification_method" "VerificationMethod",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessment_text_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "document_extraction_id" UUID NOT NULL,

    CONSTRAINT "evidence_snippets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_reviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "ReviewDecision" NOT NULL,
    "notes_internal" TEXT,

    CONSTRAINT "candidate_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "resume_document_id" UUID NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "decision" "ClientDecisionType" NOT NULL,
    "reason" TEXT,
    "proposed_at" TIMESTAMP(3),
    "timezone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "submission_id" UUID,
    "from_stage" "PipelineStage",
    "to_stage" "PipelineStage" NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_consents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "policy_version" TEXT NOT NULL,
    "capture_method" "ConsentCaptureMethod" NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "captured_by" UUID,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "processed_at" TIMESTAMP(3),
    "result_summary" TEXT,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "requisition_id" UUID,
    "client_id" UUID,
    "candidate_id" UUID,
    "metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_normalized_name_key" ON "organizations"("normalized_name");

-- CreateIndex
CREATE INDEX "users_organization_id_status_idx" ON "users"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_organization_id_normalized_email_key" ON "users"("organization_id", "normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_organization_id_key" ON "users"("id", "organization_id");

-- CreateIndex
CREATE INDEX "clients_organization_id_status_idx" ON "clients"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organization_id_normalized_name_key" ON "clients"("organization_id", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_id_organization_id_key" ON "clients"("id", "organization_id");

-- CreateIndex
CREATE INDEX "client_memberships_user_id_status_idx" ON "client_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "client_memberships_client_id_status_idx" ON "client_memberships"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "client_memberships_client_user_org_key" ON "client_memberships"("client_id", "user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_memberships_client_user_key" ON "client_memberships"("client_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_memberships_decision_key" ON "client_memberships"("id", "client_id", "user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "requisitions_client_id_status_idx" ON "requisitions"("client_id", "status");

-- CreateIndex
CREATE INDEX "requisitions_organization_id_status_idx" ON "requisitions"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_id_organization_id_key" ON "requisitions"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_id_client_org_key" ON "requisitions"("id", "client_id", "organization_id");

-- CreateIndex
CREATE INDEX "scorecard_versions_requisition_id_status_idx" ON "scorecard_versions"("requisition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_versions_requisition_id_version_key" ON "scorecard_versions"("requisition_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_versions_source_key" ON "scorecard_versions"("id", "requisition_id", "organization_id");

-- CreateIndex
CREATE INDEX "scorecard_criteria_scorecard_version_id_active_display_orde_idx" ON "scorecard_criteria"("scorecard_version_id", "active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_criteria_scorecard_version_id_key_key" ON "scorecard_criteria"("scorecard_version_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_criteria_id_version_key" ON "scorecard_criteria"("id", "scorecard_version_id");

-- CreateIndex
CREATE INDEX "candidates_organization_id_record_status_idx" ON "candidates"("organization_id", "record_status");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_organization_id_candidate_code_key" ON "candidates"("organization_id", "candidate_code");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_id_organization_id_key" ON "candidates"("id", "organization_id");

-- CreateIndex
CREATE INDEX "candidate_identity_contact_fingerprint_idx" ON "candidate_identity"("contact_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_identity_candidate_org_key" ON "candidate_identity"("candidate_id", "organization_id");

-- CreateIndex
CREATE INDEX "candidate_profiles_current_role_idx" ON "candidate_profiles"("current_role");

-- CreateIndex
CREATE INDEX "candidate_profiles_location_idx" ON "candidate_profiles"("location");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_candidate_id_profile_version_key" ON "candidate_profiles"("candidate_id", "profile_version");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_id_organization_key" ON "candidate_profiles"("id", "organization_id");

-- CreateIndex
CREATE INDEX "candidate_skills_skill_name_normalized_idx" ON "candidate_skills"("skill_name_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_skills_candidate_profile_id_skill_name_normalized_key" ON "candidate_skills"("candidate_profile_id", "skill_name_normalized");

-- CreateIndex
CREATE INDEX "resume_documents_candidate_id_parse_status_idx" ON "resume_documents"("candidate_id", "parse_status");

-- CreateIndex
CREATE UNIQUE INDEX "resume_documents_organization_id_sha256_key" ON "resume_documents"("organization_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "resume_documents_candidate_id_version_key" ON "resume_documents"("candidate_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "resume_documents_id_organization_id_key" ON "resume_documents"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "resume_documents_id_candidate_org_key" ON "resume_documents"("id", "candidate_id", "organization_id");

-- CreateIndex
CREATE INDEX "document_extractions_quality_status_idx" ON "document_extractions"("quality_status");

-- CreateIndex
CREATE UNIQUE INDEX "document_extractions_resume_version_key" ON "document_extractions"("resume_document_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_extractions_source_key" ON "document_extractions"("id", "resume_document_id", "organization_id");

-- CreateIndex
CREATE INDEX "assessment_texts_resume_document_id_created_at_idx" ON "assessment_texts"("resume_document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_texts_resume_version_key" ON "assessment_texts"("resume_document_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_texts_source_key" ON "assessment_texts"("id", "resume_document_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_texts_exact_source_key" ON "assessment_texts"("id", "resume_document_id", "organization_id", "document_extraction_id");

-- CreateIndex
CREATE INDEX "processing_batches_requisition_id_status_idx" ON "processing_batches"("requisition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "processing_batches_id_organization_id_key" ON "processing_batches"("id", "organization_id");

-- CreateIndex
CREATE INDEX "processing_jobs_status_created_at_idx" ON "processing_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "processing_jobs_batch_id_status_idx" ON "processing_jobs"("batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_idempotency_key" ON "processing_jobs"("batch_id", "resume_document_id", "job_type");

-- CreateIndex
CREATE INDEX "candidate_assessments_requisition_id_score_idx" ON "candidate_assessments"("requisition_id", "score" DESC);

-- CreateIndex
CREATE INDEX "candidate_assessments_candidate_id_created_at_idx" ON "candidate_assessments"("candidate_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_assessments_requisition_id_candidate_id_resume_do_key" ON "candidate_assessments"("requisition_id", "candidate_id", "resume_document_id", "scorecard_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_submission_trace_key" ON "candidate_assessments"("id", "candidate_id", "requisition_id", "resume_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_source_key" ON "candidate_assessments"("id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id");

-- CreateIndex
CREATE INDEX "criterion_assessments_criterion_id_status_idx" ON "criterion_assessments"("criterion_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "criterion_assessments_assessment_id_criterion_id_key" ON "criterion_assessments"("assessment_id", "criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "criterion_assessments_source_key" ON "criterion_assessments"("id", "assessment_id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id");

-- CreateIndex
CREATE INDEX "evidence_snippets_criterion_assessment_id_verified_idx" ON "evidence_snippets"("criterion_assessment_id", "verified");

-- CreateIndex
CREATE INDEX "candidate_reviews_candidate_id_requisition_id_resume_docume_idx" ON "candidate_reviews"("candidate_id", "requisition_id", "resume_document_id", "reviewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_reviews_submission_trace_key" ON "candidate_reviews"("id", "candidate_id", "requisition_id", "resume_document_id");

-- CreateIndex
CREATE INDEX "candidate_submissions_client_id_requisition_id_status_idx" ON "candidate_submissions"("client_id", "requisition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_submissions_requisition_id_candidate_id_key" ON "candidate_submissions"("requisition_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_submissions_id_client_key" ON "candidate_submissions"("id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_submissions_pipeline_key" ON "candidate_submissions"("id", "candidate_id", "requisition_id", "organization_id");

-- CreateIndex
CREATE INDEX "client_decisions_submission_id_created_at_idx" ON "client_decisions"("submission_id", "created_at");

-- CreateIndex
CREATE INDEX "pipeline_events_requisition_id_candidate_id_created_at_idx" ON "pipeline_events"("requisition_id", "candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "pipeline_events_to_stage_created_at_idx" ON "pipeline_events"("to_stage", "created_at");

-- CreateIndex
CREATE INDEX "candidate_consents_candidate_id_purpose_status_idx" ON "candidate_consents"("candidate_id", "purpose", "status");

-- CreateIndex
CREATE INDEX "deletion_requests_candidate_id_status_idx" ON "deletion_requests"("candidate_id", "status");

-- CreateIndex
CREATE INDEX "deletion_requests_status_requested_at_idx" ON "deletion_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_client_id_created_at_idx" ON "audit_logs"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memberships" ADD CONSTRAINT "client_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memberships" ADD CONSTRAINT "client_memberships_client_id_organization_id_fkey" FOREIGN KEY ("client_id", "organization_id") REFERENCES "clients"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memberships" ADD CONSTRAINT "client_memberships_user_id_organization_id_fkey" FOREIGN KEY ("user_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_client_id_organization_id_fkey" FOREIGN KEY ("client_id", "organization_id") REFERENCES "clients"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_created_by_organization_id_fkey" FOREIGN KEY ("created_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_assigned_recruiter_id_organization_id_fkey" FOREIGN KEY ("assigned_recruiter_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_versions" ADD CONSTRAINT "scorecard_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_versions" ADD CONSTRAINT "scorecard_versions_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_versions" ADD CONSTRAINT "scorecard_versions_approved_by_organization_id_fkey" FOREIGN KEY ("approved_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_criteria" ADD CONSTRAINT "scorecard_criteria_scorecard_version_id_fkey" FOREIGN KEY ("scorecard_version_id") REFERENCES "scorecard_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_identity" ADD CONSTRAINT "candidate_identity_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_skills" ADD CONSTRAINT "candidate_skills_candidate_profile_id_organization_id_fkey" FOREIGN KEY ("candidate_profile_id", "organization_id") REFERENCES "candidate_profiles"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_uploaded_by_organization_id_fkey" FOREIGN KEY ("uploaded_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_resume_document_id_organization_id_fkey" FOREIGN KEY ("resume_document_id", "organization_id") REFERENCES "resume_documents"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_texts" ADD CONSTRAINT "assessment_texts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_texts" ADD CONSTRAINT "assessment_texts_document_extraction_id_resume_document_id_fkey" FOREIGN KEY ("document_extraction_id", "resume_document_id", "organization_id") REFERENCES "document_extractions"("id", "resume_document_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_texts" ADD CONSTRAINT "assessment_texts_resume_document_id_organization_id_fkey" FOREIGN KEY ("resume_document_id", "organization_id") REFERENCES "resume_documents"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_batches" ADD CONSTRAINT "processing_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_batches" ADD CONSTRAINT "processing_batches_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_batches" ADD CONSTRAINT "processing_batches_created_by_organization_id_fkey" FOREIGN KEY ("created_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_batch_id_organization_id_fkey" FOREIGN KEY ("batch_id", "organization_id") REFERENCES "processing_batches"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_resume_document_id_organization_id_fkey" FOREIGN KEY ("resume_document_id", "organization_id") REFERENCES "resume_documents"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_resume_document_id_candidate_id_orga_fkey" FOREIGN KEY ("resume_document_id", "candidate_id", "organization_id") REFERENCES "resume_documents"("id", "candidate_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_document_extraction_id_resume_docume_fkey" FOREIGN KEY ("document_extraction_id", "resume_document_id", "organization_id") REFERENCES "document_extractions"("id", "resume_document_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_scorecard_version_id_requisition_id__fkey" FOREIGN KEY ("scorecard_version_id", "requisition_id", "organization_id") REFERENCES "scorecard_versions"("id", "requisition_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_assessment_text_id_resume_document_i_fkey" FOREIGN KEY ("assessment_text_id", "resume_document_id", "organization_id", "document_extraction_id") REFERENCES "assessment_texts"("id", "resume_document_id", "organization_id", "document_extraction_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_assessments" ADD CONSTRAINT "criterion_assessments_assessment_id_scorecard_version_id_r_fkey" FOREIGN KEY ("assessment_id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id") REFERENCES "candidate_assessments"("id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_assessments" ADD CONSTRAINT "criterion_assessments_criterion_id_scorecard_version_id_fkey" FOREIGN KEY ("criterion_id", "scorecard_version_id") REFERENCES "scorecard_criteria"("id", "scorecard_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_snippets" ADD CONSTRAINT "evidence_snippets_criterion_assessment_id_assessment_id_sc_fkey" FOREIGN KEY ("criterion_assessment_id", "assessment_id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id") REFERENCES "criterion_assessments"("id", "assessment_id", "scorecard_version_id", "resume_document_id", "assessment_text_id", "document_extraction_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_snippets" ADD CONSTRAINT "evidence_snippets_assessment_text_id_resume_document_id_or_fkey" FOREIGN KEY ("assessment_text_id", "resume_document_id", "organization_id", "document_extraction_id") REFERENCES "assessment_texts"("id", "resume_document_id", "organization_id", "document_extraction_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_snippets" ADD CONSTRAINT "evidence_snippets_document_extraction_id_resume_document_i_fkey" FOREIGN KEY ("document_extraction_id", "resume_document_id", "organization_id") REFERENCES "document_extractions"("id", "resume_document_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_reviews" ADD CONSTRAINT "candidate_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_reviews" ADD CONSTRAINT "candidate_reviews_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_reviews" ADD CONSTRAINT "candidate_reviews_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_reviews" ADD CONSTRAINT "candidate_reviews_resume_document_id_candidate_id_organiza_fkey" FOREIGN KEY ("resume_document_id", "candidate_id", "organization_id") REFERENCES "resume_documents"("id", "candidate_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_reviews" ADD CONSTRAINT "candidate_reviews_reviewer_id_organization_id_fkey" FOREIGN KEY ("reviewer_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_requisition_id_client_id_organizatio_fkey" FOREIGN KEY ("requisition_id", "client_id", "organization_id") REFERENCES "requisitions"("id", "client_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_client_id_organization_id_fkey" FOREIGN KEY ("client_id", "organization_id") REFERENCES "clients"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_submitted_by_organization_id_fkey" FOREIGN KEY ("submitted_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_assessment_id_candidate_id_requisiti_fkey" FOREIGN KEY ("assessment_id", "candidate_id", "requisition_id", "resume_document_id") REFERENCES "candidate_assessments"("id", "candidate_id", "requisition_id", "resume_document_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_review_id_candidate_id_requisition_i_fkey" FOREIGN KEY ("review_id", "candidate_id", "requisition_id", "resume_document_id") REFERENCES "candidate_reviews"("id", "candidate_id", "requisition_id", "resume_document_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_resume_document_id_candidate_id_orga_fkey" FOREIGN KEY ("resume_document_id", "candidate_id", "organization_id") REFERENCES "resume_documents"("id", "candidate_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_decisions" ADD CONSTRAINT "client_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_decisions" ADD CONSTRAINT "client_decisions_client_id_organization_id_fkey" FOREIGN KEY ("client_id", "organization_id") REFERENCES "clients"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_decisions" ADD CONSTRAINT "client_decisions_submission_id_client_id_fkey" FOREIGN KEY ("submission_id", "client_id") REFERENCES "candidate_submissions"("id", "client_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_decisions" ADD CONSTRAINT "client_decisions_client_user_id_organization_id_fkey" FOREIGN KEY ("client_user_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_decisions" ADD CONSTRAINT "client_decisions_membership_id_client_id_client_user_id_or_fkey" FOREIGN KEY ("membership_id", "client_id", "client_user_id", "organization_id") REFERENCES "client_memberships"("id", "client_id", "user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_submission_id_candidate_id_requisition_id__fkey" FOREIGN KEY ("submission_id", "candidate_id", "requisition_id", "organization_id") REFERENCES "candidate_submissions"("id", "candidate_id", "requisition_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_actor_id_organization_id_fkey" FOREIGN KEY ("actor_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_consents" ADD CONSTRAINT "candidate_consents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_consents" ADD CONSTRAINT "candidate_consents_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_consents" ADD CONSTRAINT "candidate_consents_captured_by_organization_id_fkey" FOREIGN KEY ("captured_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_requested_by_organization_id_fkey" FOREIGN KEY ("requested_by", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_organization_id_fkey" FOREIGN KEY ("actor_id", "organization_id") REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_requisition_id_organization_id_fkey" FOREIGN KEY ("requisition_id", "organization_id") REFERENCES "requisitions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_client_id_organization_id_fkey" FOREIGN KEY ("client_id", "organization_id") REFERENCES "clients"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_candidate_id_organization_id_fkey" FOREIGN KEY ("candidate_id", "organization_id") REFERENCES "candidates"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
