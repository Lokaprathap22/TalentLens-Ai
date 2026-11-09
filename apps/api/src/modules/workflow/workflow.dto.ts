import type {
  ClientDecisionType,
  InterviewFormat,
  InterviewProposalStatus,
  ReviewDecision,
  SubmissionStatus,
  UserRole,
} from './workflow.types.js';

export interface RecruiterCandidateSummaryDto {
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
  reviewStatus: ReviewDecision | 'NOT_REVIEWED';
  reviewedAt: string | null;
  isShortlisted: boolean;
  shortlistedAt: string | null;
  submissionId: string | null;
  submissionStatus: SubmissionStatus | null;
  submittedAt: string | null;
  lastActivityAt: string;
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

export interface InterviewProposalDto {
  id: string;
  submissionId: string;
  requisitionId: string;
  proposerUserId: string;
  proposerRole: UserRole;
  startAt: string;
  endAt: string;
  timezone: string;
  format: InterviewFormat;
  status: InterviewProposalStatus;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecruiterCandidateDetailDto {
  candidateId: string;
  candidateCode: string;
  requisitionId: string;
  requisitionTitle: string;
  client: {
    id: string;
    name: string;
  };
  resume: {
    id: string;
    fileName: string;
    fileType: string;
    sizeBytes: number;
    uploadedAt: string;
  };
  hasInspectedOriginalResume: boolean;
  consent: {
    id: string;
    status: string;
    policyVersion: string;
    capturedAt: string;
  } | null;
  assessment: {
    id: string;
    status: string;
    score: number | null;
    coverage: number;
    isComplete: boolean;
    formulaVersion: string;
    criteria: Array<{
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
      evidence: Array<{
        quote: string;
        pageNumber: number | null;
        startOffset: number | null;
        endOffset: number | null;
        verified: boolean;
      }>;
    }>;
  } | null;
  review: {
    id: string;
    decision: ReviewDecision;
    reviewedAt: string;
    reviewerId: string;
    notesInternal: string | null;
  } | null;
  shortlist: {
    id: string;
    shortlistedById: string;
    shortlistedAt: string;
    notesInternal: string | null;
  } | null;
  submission: {
    id: string;
    status: SubmissionStatus;
    submittedAt: string;
    submittedById: string;
  } | null;
  clientFeedback: Array<{
    id: string;
    decision: ClientDecisionType;
    reason: string | null;
    proposedAt: string | null;
    timezone: string | null;
    createdAt: string;
  }>;
  interviews?: InterviewProposalDto[];
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
  interviews?: Array<{
    id: string;
    startAt: string;
    endAt: string;
    timezone: string;
    format: string;
    status: string;
    reason: string | null;
    createdAt: string;
  }>;
}

/**
 * Client-facing submission view with strict privacy masking.
 *
 * Contact details (full legal name, email, phone, physical address, DOB, internal code)
 * and recruiter-only internal notes are NEVER included.
 */
export interface ClientSubmissionSummaryDto {
  submissionId: string;
  candidateRef: string;
  requisitionId: string;
  requisitionTitle: string;
  status: SubmissionStatus;
  submittedAt: string;
  assessmentSummary: {
    score: number | null;
    coverage: number;
    status: string;
    criteriaCount: number;
  } | null;
  latestDecision: {
    decision: ClientDecisionType;
    createdAt: string;
  } | null;
}

export interface ClientSubmissionDetailDto {
  submissionId: string;
  candidateRef: string;
  requisitionId: string;
  requisitionTitle: string;
  status: SubmissionStatus;
  submittedAt: string;
  assessment: {
    score: number | null;
    coverage: number;
    status: string;
    criteria: Array<{
      label: string;
      category: string;
      requirementType: string;
      status: string;
      reasoning: string;
      verifiedQuotes: string[];
    }>;
  } | null;
  feedbackHistory: Array<{
    id: string;
    decision: ClientDecisionType;
    reason: string | null;
    proposedAt: string | null;
    timezone: string | null;
    createdAt: string;
  }>;
  interviews?: Array<{
    id: string;
    startAt: string;
    endAt: string;
    timezone: string;
    format: string;
    status: string;
    reason: string | null;
    createdAt: string;
  }>;
}

export interface InterviewCoordinationDto {
  id: string;
  submissionId: string;
  decision: ClientDecisionType;
  proposedAt: string | null;
  timezone: string | null;
  reason: string | null;
  createdAt: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'RESCHEDULED' | 'COMPLETED';
}

export interface AuthorizedClientDto {
  id: string;
  name: string;
  status: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  membershipId?: string | undefined;
  membershipRole?: string | undefined;
}

export interface CandidateTimelineItemDto {
  id: string;
  fromStage: string | null;
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
  items: CandidateTimelineItemDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClientMemberDto {
  id: string;
  membershipId: string;
  userId: string;
  clientId: string;
  organizationId: string;
  name: string | null;
  email: string;
  role: 'CLIENT_HIRING_MANAGER';
  membershipStatus: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  userStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  createdAt: string;
  updatedAt: string;
}

export type GlobalCandidateStatusCategory =
  'ASSESSED' | 'AWAITING_ASSESSMENT' | 'NEEDS_REVIEW' | 'FAILED';

export interface GlobalCandidateSummaryDto {
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
  reviewStatus: ReviewDecision | 'NOT_REVIEWED';
  reviewedAt: string | null;
  isShortlisted: boolean;
  shortlistedAt: string | null;
  submissionStatus: SubmissionStatus | null;
  submittedAt: string | null;

  // Categorical indicator for quick filtering & indicators
  statusCategory: GlobalCandidateStatusCategory;
}

export interface ListGlobalCandidatesResponseDto {
  items: GlobalCandidateSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface InterviewItemDto {
  id: string;
  submissionId: string;
  requisitionId: string;
  requisitionTitle: string;
  clientId: string;
  clientName: string;
  candidateId: string;
  candidateCode: string;
  proposerUserId: string;
  proposerRole: UserRole;
  startAt: string;
  endAt: string;
  timezone: string;
  format: InterviewFormat;
  status: InterviewProposalStatus;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  canAccept: boolean;
  canReject: boolean;
  canReschedule: boolean;
  canComplete: boolean;
}

export interface InterviewCountsDto {
  total: number;
  upcoming: number;
  pendingAction: number;
  completed: number;
  rejected: number;
}

export interface ListInterviewsResponseDto {
  items: InterviewItemDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: InterviewCountsDto;
}

// ---------------------------------------------------------------------------
// Aggregated Dashboard DTOs (Role-Aware)
// ---------------------------------------------------------------------------

export interface RecruiterDashboardMetricsDto {
  totalActiveRequisitions: number;
  requisitionsRequiringAttention: number;
  candidatesInPipeline: number;
  candidatesAwaitingAssessment: number;
  candidatesAwaitingReview: number;
  pendingClientDecisions: number;
  upcomingConfirmedInterviews: number;
}

export interface PipelineStageCountDto {
  key: string;
  label: string;
  count: number;
  hint: string;
}

export interface RecentRequisitionDto {
  id: string;
  title: string;
  clientName: string;
  status: 'OPEN' | 'PAUSED';
  candidatesCount: number;
  awaitingReviewCount: number;
  withClientCount: number;
  updatedAt: string;
}

export interface DashboardActivityItemDto {
  id: string;
  kind:
    | 'consent_withdrawn'
    | 'client_shortlisted'
    | 'interview_proposed'
    | 'review_recorded'
    | 'assessment_complete'
    | 'submitted'
    | 'general';
  summary: string;
  actor: string;
  createdAt: string;
}

export interface ReviewQueueSummaryItemDto {
  candidateId: string;
  requisitionId: string;
  candidateCode: string;
  requisitionTitle: string;
  assessmentStatus: 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED' | 'NOT_ASSESSED';
  score: number | null;
  coverage: number | null;
  consent: 'ACTIVE' | 'PENDING' | 'WITHDRAWN';
  lastActivityAt: string;
}

export interface RecruiterDashboardSummaryDto {
  role: 'RECRUITER';
  generatedAt: string;
  metrics: RecruiterDashboardMetricsDto;
  pipelineStages: PipelineStageCountDto[];
  recentRequisitions: RecentRequisitionDto[];
  reviewQueue: ReviewQueueSummaryItemDto[];
  upcomingInterviews: InterviewItemDto[];
  recentActivity: DashboardActivityItemDto[];
}

export interface ClientHiringManagerMetricsDto {
  pendingCandidateReviews: number;
  submittedAwaitingDecisions: number;
  upcomingConfirmedInterviews: number;
  recentDecisionsCount: number;
  activeRequisitionsCount: number;
}

export interface ClientCandidateReviewItemDto {
  submissionId: string;
  candidateCode: string;
  requisitionId: string;
  requisitionTitle: string;
  clientId: string;
  clientName: string;
  submittedAt: string;
  advisoryScore: number | null;
  criteriaCount: number | null;
  status: 'SUBMITTED' | 'INTERVIEW_PROPOSED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED';
}

export interface ClientRecentDecisionItemDto {
  id: string;
  decision: 'SHORTLIST' | 'REJECT' | 'PROPOSE_INTERVIEW';
  reason: string | null;
  candidateCode: string;
  requisitionTitle: string;
  createdAt: string;
}

export interface ClientRequisitionSummaryDto {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  status: 'OPEN' | 'PAUSED';
  activeSubmissionsCount: number;
  interviewsCount: number;
}

export interface ClientDashboardSummaryDto {
  role: 'CLIENT_HIRING_MANAGER';
  generatedAt: string;
  metrics: ClientHiringManagerMetricsDto;
  pendingReviews: ClientCandidateReviewItemDto[];
  upcomingInterviews: InterviewItemDto[];
  recentDecisions: ClientRecentDecisionItemDto[];
  activeRequisitions: ClientRequisitionSummaryDto[];
  recentActivity: DashboardActivityItemDto[];
}

export type DashboardSummaryResponseDto = RecruiterDashboardSummaryDto | ClientDashboardSummaryDto;
