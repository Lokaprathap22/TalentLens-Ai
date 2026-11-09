/**
 * Candidate domain types for the recruiter-facing Candidate Directory workspace.
 *
 * Shapes mirror the backend DTOs from workflow.dto.ts and resume.types.ts.
 * No PII fields (fullNameEncrypted, emailEncrypted, etc.) are present here;
 * candidates are referenced by pseudonymous candidateCode only.
 */

// ---------------------------------------------------------------------------
// Parse / processing statuses (mirrors ResumeParseStatus in resume.types.ts)
// ---------------------------------------------------------------------------
export type ResumeParseStatus = 'PENDING' | 'PROCESSING' | 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';

// ---------------------------------------------------------------------------
// Assessment statuses (mirrors ExtractionQualityStatus in resume.types.ts)
// ---------------------------------------------------------------------------
export type AssessmentStatus = 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED';

// ---------------------------------------------------------------------------
// Extraction quality statuses (mirrors ExtractionQualityStatus in resume.types.ts)
// ---------------------------------------------------------------------------
export type ExtractionQualityStatus = 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED';

// ---------------------------------------------------------------------------
// Review decisions (mirrors ReviewDecision in workflow.types.ts)
// ---------------------------------------------------------------------------
export type ReviewDecision = 'REVIEWED' | 'NEEDS_REVIEW' | 'CLOSED';

export type ReviewStatus = ReviewDecision | 'NOT_REVIEWED';

// ---------------------------------------------------------------------------
// Submission statuses
// ---------------------------------------------------------------------------
export type SubmissionStatus =
  'SUBMITTED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED' | 'INTERVIEW_PROPOSED' | 'WITHDRAWN';

// ---------------------------------------------------------------------------
// Candidate summary DTO — from GET /api/v1/requisitions/:id/candidates
// Mirrors RecruiterCandidateSummaryDto in workflow.dto.ts exactly.
// ---------------------------------------------------------------------------
export interface CandidateSummary {
  candidateId: string;
  candidateCode: string;
  resumeDocumentId: string;
  resumeFileName: string;
  parseStatus: string;
  assessmentId: string | null;
  assessmentStatus: string | null;
  overallScore: number | null;
  coverage: number | null;
  isComplete: boolean;
  criteriaCount: number;
  criteriaMetCount: number;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  isShortlisted: boolean;
  shortlistedAt: string | null;
  submissionId: string | null;
  submissionStatus: string | null;
  submittedAt: string | null;
  lastActivityAt: string;
}

// ---------------------------------------------------------------------------
// Paginated list response from GET /api/v1/requisitions/:id/candidates
// ---------------------------------------------------------------------------
export interface ListCandidatesResponse {
  items: CandidateSummary[];
  total: number;
}

// ---------------------------------------------------------------------------
// Query parameters for candidate listing
// ---------------------------------------------------------------------------
export interface ListCandidatesQuery {
  limit?: number | undefined;
  offset?: number | undefined;
  search?: string | undefined;
  sortBy?: ('activity' | 'score' | 'uploadedAt') | undefined;
  sortOrder?: ('asc' | 'desc') | undefined;
  processingStatus?: ResumeParseStatus | undefined;
  assessmentStatus?: AssessmentStatus | undefined;
  reviewDecision?: ReviewDecision | undefined;
  submissionStatus?: SubmissionStatus | undefined;
}

// ---------------------------------------------------------------------------
// Global candidate directory types (mirrors GlobalCandidateSummaryDto)
// ---------------------------------------------------------------------------

export type GlobalCandidateStatusCategory =
  'ASSESSED' | 'AWAITING_ASSESSMENT' | 'NEEDS_REVIEW' | 'FAILED';

export interface GlobalCandidateSummary {
  candidateId: string;
  candidateCode: string;
  createdAt: string;
  lastActivityAt: string;

  // Requisition context
  requisitionId: string | null;
  requisitionTitle: string | null;
  clientName: string | null;

  // Resume info
  resumeDocumentId: string | null;
  resumeFileName: string | null;
  parseStatus: string | null;

  // Non-PII Profile info
  currentRole: string | null;
  experienceYears: number | null;
  location: string | null;
  skills: string[];

  // Assessment info (strictly verified, never inferred or invented)
  assessmentId: string | null;
  assessmentStatus: string | null;
  overallScore: number | null;
  coverage: number | null;
  isComplete: boolean;
  criteriaCount: number;
  criteriaMetCount: number;

  // Review & Workflow status
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  isShortlisted: boolean;
  shortlistedAt: string | null;
  submissionStatus: SubmissionStatus | null;
  submittedAt: string | null;

  // Categorical indicator
  statusCategory: GlobalCandidateStatusCategory;
}

export interface ListGlobalCandidatesResponse {
  items: GlobalCandidateSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ListGlobalCandidatesQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  search?: string | undefined;
  requisitionId?: string | undefined;
  statusCategory?: ('ALL' | GlobalCandidateStatusCategory) | undefined;
  assessmentStatus?: ('ALL' | AssessmentStatus) | undefined;
  reviewStatus?: ('ALL' | ReviewStatus) | undefined;
  sortBy?: ('activity' | 'score' | 'createdAt') | undefined;
  sortOrder?: ('asc' | 'desc') | undefined;
}

// ---------------------------------------------------------------------------
// Upload result types — from POST /api/v1/requisitions/:id/resumes
// Mirrors ResumeBatchUploadResult and per-file types in resume.types.ts exactly.
// ---------------------------------------------------------------------------
export interface AcceptedUploadItem {
  clientFileId?: string | undefined;
  resumeDocumentId: string;
  candidateId: string;
  candidateCode: string;
  fileName: string;
  fileType: 'PDF' | 'DOCX';
  sizeBytes: number;
  sha256: string;
  status: 'ACCEPTED';
}

export interface DuplicateUploadItem {
  clientFileId?: string | undefined;
  fileName: string;
  sha256: string;
  resumeDocumentId: string;
  status: 'DUPLICATE';
  message: string;
}

export interface RejectedUploadItem {
  clientFileId?: string | undefined;
  fileName: string;
  reason: string;
  status: 'REJECTED';
}

export interface ResumeBatchUploadResult {
  batchId: string | null;
  totalFiles: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  accepted: AcceptedUploadItem[];
  duplicates: DuplicateUploadItem[];
  rejected: RejectedUploadItem[];
}

// ---------------------------------------------------------------------------
// Client-side upload slot state (before submission)
// ---------------------------------------------------------------------------
export type UploadSlotStatus =
  | 'pending' // selected, not yet uploaded
  | 'invalid' // client-side validation failed
  | 'uploading' // request in flight
  | 'accepted' // backend confirmed accepted
  | 'duplicate' // backend returned duplicate
  | 'rejected' // backend returned rejected
  | 'error'; // network/request error

export interface UploadSlot {
  /** Stable local ID for React keying */
  slotId: string;
  file: File;
  status: UploadSlotStatus;
  /** Set for invalid status */
  validationError?: string | undefined;
  /** Set after backend response */
  serverResult?: AcceptedUploadItem | DuplicateUploadItem | RejectedUploadItem | undefined;
  /** Set for error status */
  errorMessage?: string | undefined;
}

// ---------------------------------------------------------------------------
// Processing-status display helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a ResumeParseStatus value. */
export function getParseStatusLabel(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'Queued';
    case 'PROCESSING':
      return 'Processing';
    case 'PARSED':
      return 'Extracted';
    case 'NEEDS_REVIEW':
      return 'Needs review';
    case 'FAILED':
      return 'Extraction failed';
    default:
      return status;
  }
}

/** Badge tone for a ResumeParseStatus value. */
export function getParseStatusTone(
  status: string,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'PENDING':
      return 'neutral';
    case 'PROCESSING':
      return 'info';
    case 'PARSED':
      return 'success';
    case 'NEEDS_REVIEW':
      return 'warning';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Human-readable label for a reviewStatus value. */
export function getReviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'NOT_REVIEWED':
      return 'Not reviewed';
    case 'REVIEWED':
      return 'Reviewed';
    case 'NEEDS_REVIEW':
      return 'Flagged';
    case 'CLOSED':
      return 'Closed';
    default:
      return 'Unknown';
  }
}

/** Badge tone for a reviewStatus value. */
export function getReviewStatusTone(
  status: ReviewStatus,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'NOT_REVIEWED':
      return 'neutral';
    case 'REVIEWED':
      return 'success';
    case 'NEEDS_REVIEW':
      return 'warning';
    case 'CLOSED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Candidate detail DTO — from GET /api/v1/requisitions/:id/candidates/:candidateId
// Mirrors RecruiterCandidateDetailDto in workflow.dto.ts exactly.
// ---------------------------------------------------------------------------

export interface CandidateEvidenceDetail {
  quote: string;
  pageNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  verified: boolean;
}

export interface CandidateCriterionDetail {
  id: string;
  key: string;
  label: string;
  category: string;
  requirementType: string;
  weight: number;
  status: string;
  confidence: string;
  score: number | null;
  reasoning: string;
  evidence: CandidateEvidenceDetail[];
}

export interface CandidateAssessmentDetail {
  id: string;
  status: string;
  score: number | null;
  coverage: number;
  isComplete: boolean;
  formulaVersion: string;
  criteria: CandidateCriterionDetail[];
}

export interface CandidateConsentDetail {
  id: string;
  status: string;
  policyVersion: string;
  capturedAt: string;
}

export interface CandidateResumeDetail {
  id: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface CandidateReviewDetail {
  id: string;
  decision: ReviewDecision;
  reviewedAt: string;
  reviewerId: string;
  notesInternal: string | null;
}

export interface CandidateShortlistDetail {
  id: string;
  shortlistedById: string;
  shortlistedAt: string;
  notesInternal: string | null;
}

export interface CandidateSubmissionDetail {
  id: string;
  status: SubmissionStatus;
  submittedAt: string;
  submittedById: string;
  interviews?: CandidateInterviewDetail[];
}

export interface CandidateInterviewDetail {
  id: string;
  startAt: string;
  endAt: string;
  timezone: string;
  format: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED';
  reason?: string | null;
  createdAt: string;
}

export interface CandidateClientFeedbackDetail {
  id: string;
  decision: string;
  reason: string | null;
  proposedAt: string | null;
  timezone: string | null;
  createdAt: string;
}

export interface CandidateDetail {
  candidateId: string;
  candidateCode: string;
  requisitionId: string;
  requisitionTitle: string;
  client: {
    id: string;
    name: string;
  };
  resume: CandidateResumeDetail;
  hasInspectedOriginalResume: boolean;
  consent: CandidateConsentDetail | null;
  assessment: CandidateAssessmentDetail | null;
  review: CandidateReviewDetail | null;
  shortlist: CandidateShortlistDetail | null;
  submission: CandidateSubmissionDetail | null;
  clientFeedback: CandidateClientFeedbackDetail[];
  interviews?: CandidateInterviewDetail[];
}

// ---------------------------------------------------------------------------
// Resume extraction DTO — from GET /api/v1/requisitions/:id/resumes/:resumeId/extraction
// Mirrors DocumentExtractionDto in resume.types.ts exactly.
// ---------------------------------------------------------------------------

export interface DocumentExtraction {
  id: string;
  resumeDocumentId: string;
  version: number;
  extractedText: string;
  pageMap: Record<string, unknown>;
  parser: string;
  ocrUsed: boolean;
  qualityStatus: ExtractionQualityStatus;
  createdAt: string;
}

export interface GetDocumentExtractionResponse {
  extraction: DocumentExtraction;
}

export interface ResumeDocumentDto {
  id: string;
  candidateId: string;
  candidateCode: string;
  fileName: string;
  fileType: 'PDF' | 'DOCX';
  sizeBytes: number;
  sha256: string;
  parseStatus: ResumeParseStatus;
  uploadedAt: string;
  updatedAt: string;
}

export interface GetResumeDetailsResponse {
  resume: ResumeDocumentDto;
}

export interface AssessmentJobDto {
  jobId: string;
  batchId: string;
  requisitionId: string;
  candidateId: string;
  resumeDocumentId: string;
  jobType: string;
  status: string;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssessmentEnqueueResult {
  job: AssessmentJobDto | null;
  assessment: CandidateAssessmentDetail | null;
  isExisting: boolean;
}

export interface TriggerAssessmentApiResponse {
  status: string;
  data: AssessmentEnqueueResult;
}

// ---------------------------------------------------------------------------
// Recruiter Review & Shortlist DTOs (mirrors workflow.dto.ts & workflow.types.ts)
// ---------------------------------------------------------------------------

export interface CandidateReviewResponseDto {
  id: string;
  decision: ReviewDecision;
  reviewedAt: string;
}

export interface CandidateShortlistDto {
  id: string;
  organizationId: string;
  candidateId: string;
  requisitionId: string;
  shortlistedById: string;
  shortlistedAt: string;
  notesInternal: string | null;
}

export interface CandidateSubmissionDto {
  id: string;
  organizationId: string;
  candidateId: string;
  requisitionId: string;
  clientId: string;
  submittedById: string;
  assessmentId: string;
  reviewId: string;
  resumeDocumentId: string;
  status: SubmissionStatus;
  submittedAt: string;
  updatedAt: string;
}

export interface PipelineEventDto {
  id: string;
  fromStage: string;
  toStage: string;
  actorRole: string;
  submissionId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CandidateTimelineDto {
  candidateId: string;
  candidateCode: string;
  requisitionId: string;
  items: PipelineEventDto[];
  total: number;
  limit: number;
  offset: number;
}
