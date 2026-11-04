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
