/**
 * Client Portal types for the Client Hiring Manager workspace.
 *
 * All types mirror the backend contracts in:
 *   apps/api/src/modules/workflow/workflow.dto.ts
 *   apps/api/src/modules/workflow/workflow.types.ts
 *
 * Privacy Invariants:
 *  - Contact details (full legal name, email, phone, physical address, DOB)
 *    and recruiter internal review notes are strictly omitted from client DTOs.
 *  - Candidates are identified exclusively by pseudonymous candidateRef.
 */

export type ClientDecisionType = 'SHORTLIST' | 'REJECT';

export type ClientSubmissionStatus =
  'SUBMITTED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED' | 'INTERVIEW_PROPOSED' | 'WITHDRAWN';

export interface AuthorizedClient {
  id: string;
  name: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  membershipId?: string;
  membershipRole?: string;
}

export interface ClientSubmissionSummary {
  submissionId: string;
  candidateRef: string;
  requisitionId: string;
  requisitionTitle: string;
  status: ClientSubmissionStatus;
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

export interface ClientCriterionEvaluation {
  label: string;
  category: string;
  requirementType: string;
  status: string;
  reasoning: string;
  verifiedQuotes: string[];
}

export interface ClientSubmissionDetail {
  submissionId: string;
  candidateRef: string;
  requisitionId: string;
  requisitionTitle: string;
  status: ClientSubmissionStatus;
  submittedAt: string;
  assessment: {
    score: number | null;
    coverage: number;
    status: string;
    criteria: ClientCriterionEvaluation[];
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

export interface ClientInterviewProposalInput {
  startAt: string;
  endAt?: string | undefined;
  timezone: string;
  format?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | undefined;
  reason?: string | undefined;
}

export interface ClientFeedbackInput {
  decision: ClientDecisionType;
  reason?: string | undefined;
}

export interface ClientFeedbackResponse {
  id: string;
  decision: ClientDecisionType;
  createdAt: string;
}

export type ClientPortalStatusFilter =
  'ALL' | 'SUBMITTED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED';
