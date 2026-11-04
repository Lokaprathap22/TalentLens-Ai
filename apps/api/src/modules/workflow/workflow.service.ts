import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { generateConsentNotice } from '../consent/consent.policy.js';
import type {
  AuthorizedClientDto,
  CandidateShortlistDto,
  CandidateSubmissionDto,
  CandidateTimelineDto,
  ClientSubmissionDetailDto,
  ClientSubmissionSummaryDto,
  InterviewProposalDto,
  RecruiterCandidateDetailDto,
  RecruiterCandidateSummaryDto,
} from './workflow.dto.js';
import type { WorkflowRepository } from './workflow.repository.js';
import type { InterviewFormat, ReviewDecision, SubmissionStatus } from './workflow.types.js';

export * from './workflow.errors.js';
import {
  WorkflowCandidateNotFoundError,
  WorkflowClientUnauthorizedError,
  WorkflowConsentMissingClientSharingError,
  WorkflowConsentRequiredError,
  WorkflowDuplicateSubmissionError,
  WorkflowRequisitionAccessDeniedError,
  WorkflowRequisitionStatusError,
  WorkflowResumeNotInspectedError,
  WorkflowShortlistRequiredError,
  WorkflowSubmissionNotFoundError,
} from './workflow.errors.js';

export interface WorkflowService {
  listCandidatesForRequisition(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    options: {
      limit: number;
      offset: number;
      processingStatus?: string | undefined;
      assessmentStatus?: string | undefined;
      reviewDecision?: string | undefined;
      submissionStatus?: string | undefined;
    },
  ): Promise<{ items: RecruiterCandidateSummaryDto[]; total: number }>;

  getCandidateDetail(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
  ): Promise<RecruiterCandidateDetailDto>;

  recordCandidateReview(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    decision: ReviewDecision,
    notesInternal?: string,
  ): Promise<{ id: string; decision: ReviewDecision; reviewedAt: string }>;

  recordShortlist(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    notesInternal?: string,
  ): Promise<CandidateShortlistDto>;

  submitCandidateToClient(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
  ): Promise<CandidateSubmissionDto>;

  listSubmissionsForRequisition(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
  ): Promise<
    Array<{
      id: string;
      candidateId: string;
      candidateCode: string;
      status: SubmissionStatus;
      submittedAt: string;
      score: number | null;
      clientName: string;
    }>
  >;

  getSubmissionForRequisition(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    submissionId: string,
  ): Promise<{
    id: string;
    candidateId: string;
    candidateCode: string;
    requisitionId: string;
    requisitionTitle: string;
    clientId: string;
    clientName: string;
    submittedById: string;
    status: SubmissionStatus;
    submittedAt: string;
    updatedAt: string;
    feedbackHistory: Array<{
      id: string;
      decision: string;
      reason: string | null;
      proposedAt: string | null;
      timezone: string | null;
      createdAt: string;
    }>;
  }>;

  listSubmissionsForClient(
    principal: AuthenticatedPrincipal,
    clientId: string,
  ): Promise<ClientSubmissionSummaryDto[]>;

  getSubmissionForClient(
    principal: AuthenticatedPrincipal,
    clientId: string,
    submissionId: string,
  ): Promise<ClientSubmissionDetailDto>;

  recordClientFeedback(
    principal: AuthenticatedPrincipal,
    clientId: string,
    membershipId: string,
    submissionId: string,
    decision: 'SHORTLIST' | 'REJECT',
    reason?: string,
  ): Promise<{ id: string; decision: string; createdAt: string }>;

  recordClientInterviewProposal(
    principal: AuthenticatedPrincipal,
    clientId: string,
    membershipId: string,
    submissionId: string,
    proposedAt: string,
    timezone: string,
    reason?: string,
    endAt?: string,
    format?: InterviewFormat,
  ): Promise<InterviewProposalDto>;

  respondToInterview(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    submissionId: string,
    decisionId: string,
    action: 'ACCEPT' | 'REJECT' | 'PROPOSE_ALTERNATIVE' | 'COMPLETE',
    payload?: {
      reason?: string | undefined;
      startAt?: string | undefined;
      endAt?: string | undefined;
      proposedAt?: string | undefined;
      timezone?: string | undefined;
      format?: InterviewFormat | undefined;
    },
  ): Promise<{ success: boolean; action: string; proposalId?: string | undefined }>;

  respondToInterviewAsClient(
    principal: AuthenticatedPrincipal,
    clientId: string,
    membershipId: string,
    submissionId: string,
    proposalId: string,
    action: 'ACCEPT' | 'REJECT',
    reason?: string,
  ): Promise<{
    success: boolean;
    action: string;
    proposalId: string;
    status: string;
  }>;

  listAuthorizedClients(principal: AuthenticatedPrincipal): Promise<AuthorizedClientDto[]>;

  getCandidateTimeline(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    options: { limit: number; offset: number },
  ): Promise<CandidateTimelineDto>;
}

export function createWorkflowService(repository: WorkflowRepository): WorkflowService {
  function requireRecruiter(principal: AuthenticatedPrincipal): void {
    if (principal.role !== 'RECRUITER') {
      throw new WorkflowRequisitionAccessDeniedError('Principal must be a RECRUITER');
    }
  }

  function requireClientManager(principal: AuthenticatedPrincipal): void {
    if (principal.role !== 'CLIENT_HIRING_MANAGER') {
      throw new WorkflowClientUnauthorizedError('Principal must be a CLIENT_HIRING_MANAGER');
    }
  }

  return {
    async listCandidatesForRequisition(principal, requisitionId, options) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      const { items, total } = await repository.listCandidatesForRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
        options,
      );

      return {
        items: items.map((i) => ({
          candidateId: i.candidateId,
          candidateCode: i.candidateCode,
          resumeDocumentId: i.resumeDocumentId,
          resumeFileName: i.resumeFileName,
          parseStatus: i.parseStatus,
          assessmentId: i.assessment?.id ?? null,
          assessmentStatus: i.assessment?.status ?? null,
          overallScore: i.assessment?.score ?? null,
          coverage: i.assessment?.coverage ?? null,
          isComplete: i.assessment?.status === 'COMPLETE',
          criteriaCount: i.assessment?.criteriaCount ?? 0,
          criteriaMetCount: i.assessment?.criteriaMetCount ?? 0,
          reviewStatus: i.review?.decision ?? 'NOT_REVIEWED',
          reviewedAt: i.review?.reviewedAt.toISOString() ?? null,
          isShortlisted: Boolean(i.shortlist),
          shortlistedAt: i.shortlist?.shortlistedAt.toISOString() ?? null,
          submissionId: i.submission?.id ?? null,
          submissionStatus: i.submission?.status ?? null,
          submittedAt: i.submission?.submittedAt.toISOString() ?? null,
          lastActivityAt: i.lastActivityAt.toISOString(),
        })),
        total,
      };
    },

    async getCandidateDetail(principal, requisitionId, candidateId) {
      requireRecruiter(principal);

      const detail = await repository.getCandidateDetail(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
      );

      if (!detail) {
        throw new WorkflowCandidateNotFoundError();
      }

      return {
        candidateId: detail.candidate.id,
        candidateCode: detail.candidate.candidateCode,
        requisitionId: detail.requisition.id,
        requisitionTitle: detail.requisition.title,
        client: detail.requisition.client,
        resume: detail.resume
          ? {
              id: detail.resume.id,
              fileName: detail.resume.fileName,
              fileType: detail.resume.fileType,
              sizeBytes: Number(detail.resume.sizeBytes),
              uploadedAt: detail.resume.uploadedAt.toISOString(),
            }
          : {
              id: '',
              fileName: '',
              fileType: '',
              sizeBytes: 0,
              uploadedAt: '',
            },
        hasInspectedOriginalResume: detail.hasInspectedOriginalResume,
        consent: detail.consent
          ? {
              id: detail.consent.id,
              status: detail.consent.status,
              policyVersion: detail.consent.policyVersion,
              capturedAt: detail.consent.capturedAt.toISOString(),
            }
          : null,
        assessment: detail.assessment
          ? {
              id: detail.assessment.id,
              status: detail.assessment.status,
              score: detail.assessment.score,
              coverage: detail.assessment.coverage,
              isComplete: detail.assessment.status === 'COMPLETE',
              formulaVersion: detail.assessment.formulaVersion,
              criteria: detail.assessment.criteria,
            }
          : null,
        review: detail.review
          ? {
              id: detail.review.id,
              decision: detail.review.decision,
              reviewedAt: detail.review.reviewedAt.toISOString(),
              reviewerId: detail.review.reviewerId,
              notesInternal: detail.review.notesInternal,
            }
          : null,
        shortlist: detail.shortlist
          ? {
              id: detail.shortlist.id,
              shortlistedById: detail.shortlist.shortlistedById,
              shortlistedAt: detail.shortlist.shortlistedAt.toISOString(),
              notesInternal: detail.shortlist.notesInternal,
            }
          : null,
        submission: detail.submission
          ? {
              id: detail.submission.id,
              status: detail.submission.status,
              submittedAt: detail.submission.submittedAt.toISOString(),
              submittedById: detail.submission.submittedById,
            }
          : null,
        clientFeedback: detail.clientFeedback.map((f) => ({
          id: f.id,
          decision: f.decision,
          reason: f.reason,
          proposedAt: f.proposedAt?.toISOString() ?? null,
          timezone: f.timezone ?? null,
          createdAt: f.createdAt.toISOString(),
        })),
        interviews: detail.interviews
          ? detail.interviews.map((ip) => ({
              id: ip.id,
              submissionId: ip.submissionId,
              requisitionId: ip.requisitionId,
              proposerUserId: ip.proposerUserId,
              proposerRole: ip.proposerRole,
              startAt: ip.startAt.toISOString(),
              endAt: ip.endAt.toISOString(),
              timezone: ip.timezone,
              format: ip.format,
              status: ip.status,
              reason: ip.reason,
              expiresAt: null,
              createdAt: ip.createdAt.toISOString(),
              updatedAt: ip.updatedAt.toISOString(),
            }))
          : [],
      };
    },

    async recordCandidateReview(principal, requisitionId, candidateId, decision, notesInternal) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      const detail = await repository.getCandidateDetail(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
      );
      if (!detail || !detail.resume) {
        throw new WorkflowCandidateNotFoundError();
      }

      const review = await repository.recordCandidateReview(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
        detail.resume.id,
        decision,
        notesInternal,
      );

      return {
        id: review.id,
        decision: review.decision,
        reviewedAt: review.reviewedAt.toISOString(),
      };
    },

    async recordShortlist(principal, requisitionId, candidateId, notesInternal) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      if (requisition.status === 'CLOSED' || requisition.status === 'FILLED') {
        throw new WorkflowRequisitionStatusError(requisition.status);
      }

      const detail = await repository.getCandidateDetail(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
      );
      if (!detail || !detail.resume) {
        throw new WorkflowCandidateNotFoundError();
      }

      // Verify active exact-scope consent
      const consent = await repository.findActiveConsentForRequisition(
        principal.organizationId,
        candidateId,
        requisitionId,
      );
      if (!consent) {
        throw new WorkflowConsentRequiredError();
      }

      // Verify recruiter has inspected the original resume
      const hasInspected = await repository.hasRecruiterInspectedResume(
        principal.organizationId,
        principal.userId,
        requisitionId,
        detail.resume.id,
      );
      if (!hasInspected) {
        throw new WorkflowResumeNotInspectedError();
      }

      // Verify candidate has an explicit positive REVIEWED decision
      if (!detail.review || detail.review.decision !== 'REVIEWED') {
        throw new WorkflowShortlistRequiredError(
          'Candidate must have an explicit REVIEWED decision before being shortlisted.',
        );
      }

      const shortlist = await repository.recordShortlist(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
        notesInternal,
      );

      return {
        id: shortlist.id,
        organizationId: shortlist.organizationId,
        candidateId: shortlist.candidateId,
        requisitionId: shortlist.requisitionId,
        shortlistedById: shortlist.shortlistedById,
        shortlistedAt: shortlist.shortlistedAt.toISOString(),
        notesInternal: shortlist.notesInternal,
      };
    },

    async submitCandidateToClient(principal, requisitionId, candidateId) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      if (requisition.status === 'CLOSED' || requisition.status === 'FILLED') {
        throw new WorkflowRequisitionStatusError(requisition.status);
      }

      if (!requisition.client || requisition.client.status !== 'ACTIVE') {
        throw new WorkflowRequisitionAccessDeniedError(
          'Requisition is not linked to an active client.',
        );
      }

      const detail = await repository.getCandidateDetail(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
      );
      if (!detail || !detail.resume) {
        throw new WorkflowCandidateNotFoundError();
      }

      // 1. Candidate must have an explicit positive REVIEWED decision
      if (!detail.review || detail.review.decision !== 'REVIEWED') {
        throw new WorkflowShortlistRequiredError(
          'Candidate must have an explicit REVIEWED decision before submission to a client.',
        );
      }

      // 1b. Candidate must have an explicit shortlist record
      const shortlist = await repository.findShortlist(
        principal.organizationId,
        requisitionId,
        candidateId,
      );
      if (!shortlist) {
        throw new WorkflowShortlistRequiredError(
          'Candidate must be shortlisted by a recruiter before submission to a client.',
        );
      }

      // 2. Recruiter must have opened/reviewed the original resume
      const hasInspected = await repository.hasRecruiterInspectedResume(
        principal.organizationId,
        principal.userId,
        requisitionId,
        detail.resume.id,
      );
      if (!hasInspected) {
        throw new WorkflowResumeNotInspectedError();
      }

      // 3. Active exact-scope consent
      const consent = await repository.findActiveConsentForRequisition(
        principal.organizationId,
        candidateId,
        requisitionId,
      );
      if (!consent) {
        throw new WorkflowConsentRequiredError();
      }

      // 4. Consent notice must explicitly cover client sharing
      // If the notice hash was captured, verify that it matches the notice generated with client disclosure
      if (consent.noticeTextHash) {
        const genericNotice = generateConsentNotice({
          organizationName: 'Hiring Organization',
          requisitionTitle: requisition.title,
        });

        // If the hash exactly matches a generic notice without clientName, client sharing was NOT authorized
        if (consent.noticeTextHash === genericNotice.noticeTextHash) {
          throw new WorkflowConsentMissingClientSharingError();
        }
      }

      // 5. Assessment must exist
      if (!detail.assessment) {
        throw new WorkflowCandidateNotFoundError(
          'Candidate has not been assessed against this scorecard.',
        );
      }

      // 6. Check for duplicate active submission
      if (
        detail.submission &&
        detail.submission.status !== 'WITHDRAWN' &&
        detail.submission.status !== 'CLIENT_REJECTED'
      ) {
        throw new WorkflowDuplicateSubmissionError();
      }

      const submission = await repository.createSubmission(
        principal.organizationId,
        principal.userId,
        requisitionId,
        requisition.clientId,
        candidateId,
        detail.resume.id,
        detail.assessment.id,
        detail.review.id,
      );

      return {
        id: submission.id,
        organizationId: submission.organizationId,
        candidateId: submission.candidateId,
        requisitionId: submission.requisitionId,
        clientId: submission.clientId,
        submittedById: submission.submittedById,
        assessmentId: submission.assessmentId,
        reviewId: submission.reviewId,
        resumeDocumentId: submission.resumeDocumentId,
        status: submission.status,
        submittedAt: submission.submittedAt.toISOString(),
        updatedAt: submission.updatedAt.toISOString(),
      };
    },

    async listSubmissionsForRequisition(principal, requisitionId) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      const submissions = await repository.listSubmissionsForRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );

      return submissions.map((s) => ({
        ...s,
        submittedAt: s.submittedAt.toISOString(),
      }));
    },

    async getSubmissionForRequisition(principal, requisitionId, submissionId) {
      requireRecruiter(principal);

      const submission = await repository.getSubmissionForRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
        submissionId,
      );

      if (!submission) {
        throw new WorkflowSubmissionNotFoundError();
      }

      return {
        id: submission.id,
        candidateId: submission.candidateId,
        candidateCode: submission.candidateCode,
        requisitionId: submission.requisitionId,
        requisitionTitle: submission.requisitionTitle,
        clientId: submission.clientId,
        clientName: submission.clientName,
        submittedById: submission.submittedById,
        status: submission.status,
        submittedAt: submission.submittedAt.toISOString(),
        updatedAt: submission.updatedAt.toISOString(),
        feedbackHistory: submission.feedbackHistory.map((f) => ({
          id: f.id,
          decision: f.decision,
          reason: f.reason,
          proposedAt: f.proposedAt?.toISOString() ?? null,
          timezone: f.timezone ?? null,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    },

    async listSubmissionsForClient(principal, clientId) {
      requireClientManager(principal);

      const records = await repository.listSubmissionsForClient(principal.organizationId, clientId);

      return records.map((r) => ({
        submissionId: r.submissionId,
        candidateRef: r.candidateRef,
        requisitionId: r.requisitionId,
        requisitionTitle: r.requisitionTitle,
        status: r.status,
        submittedAt: r.submittedAt.toISOString(),
        assessmentSummary: {
          score: r.score,
          coverage: r.coverage,
          status: r.assessmentStatus,
          criteriaCount: r.criteriaCount,
        },
        latestDecision: r.latestDecision
          ? {
              decision: r.latestDecision.decision,
              createdAt: r.latestDecision.createdAt.toISOString(),
            }
          : null,
      }));
    },

    async getSubmissionForClient(principal, clientId, submissionId) {
      requireClientManager(principal);

      const submission = await repository.getSubmissionForClient(
        principal.organizationId,
        clientId,
        submissionId,
      );

      if (!submission) {
        throw new WorkflowSubmissionNotFoundError();
      }

      return {
        submissionId: submission.submissionId,
        candidateRef: submission.candidateRef,
        requisitionId: submission.requisitionId,
        requisitionTitle: submission.requisitionTitle,
        status: submission.status,
        submittedAt: submission.submittedAt.toISOString(),
        assessment: submission.assessment,
        feedbackHistory: submission.feedbackHistory.map((f) => ({
          id: f.id,
          decision: f.decision,
          reason: f.reason,
          proposedAt: f.proposedAt?.toISOString() ?? null,
          timezone: f.timezone ?? null,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    },

    async recordClientFeedback(principal, clientId, membershipId, submissionId, decision, reason) {
      requireClientManager(principal);

      const result = await repository.recordClientFeedback(
        principal.organizationId,
        clientId,
        submissionId,
        principal.userId,
        membershipId,
        decision,
        reason,
      );

      return {
        id: result.id,
        decision: result.decision,
        createdAt: result.createdAt.toISOString(),
      };
    },

    async recordClientInterviewProposal(
      principal,
      clientId,
      membershipId,
      submissionId,
      proposedAt,
      timezone,
      reason,
      endAt,
      format,
    ) {
      requireClientManager(principal);

      const startDate = new Date(proposedAt);
      const endDate = endAt ? new Date(endAt) : new Date(startDate.getTime() + 60 * 60 * 1000);

      const result = await repository.recordClientInterviewProposal(
        principal.organizationId,
        clientId,
        submissionId,
        principal.userId,
        membershipId,
        startDate,
        endDate,
        timezone,
        format,
        reason,
      );

      return {
        id: result.id,
        submissionId,
        requisitionId: '',
        proposerUserId: principal.userId,
        proposerRole: principal.role,
        startAt: result.startAt.toISOString(),
        endAt: result.endAt.toISOString(),
        timezone: result.timezone,
        format: result.format,
        status: result.status,
        reason: reason ?? null,
        expiresAt: null,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.createdAt.toISOString(),
      };
    },

    async respondToInterview(principal, requisitionId, submissionId, decisionId, action, payload) {
      requireRecruiter(principal);

      const startDate = payload?.startAt
        ? new Date(payload.startAt)
        : payload?.proposedAt
          ? new Date(payload.proposedAt)
          : undefined;
      const endDate = payload?.endAt
        ? new Date(payload.endAt)
        : startDate
          ? new Date(startDate.getTime() + 60 * 60 * 1000)
          : undefined;

      return repository.respondToInterview(
        principal.organizationId,
        principal.userId,
        requisitionId,
        submissionId,
        decisionId,
        action,
        {
          reason: payload?.reason,
          startAt: startDate,
          endAt: endDate,
          proposedAt: startDate,
          timezone: payload?.timezone,
          format: payload?.format,
        },
      );
    },

    async respondToInterviewAsClient(
      principal,
      clientId,
      membershipId,
      submissionId,
      proposalId,
      action,
      reason,
    ) {
      requireClientManager(principal);

      return repository.respondToInterviewAsClient(
        principal.organizationId,
        clientId,
        submissionId,
        proposalId,
        principal.userId,
        membershipId,
        action,
        reason,
      );
    },

    async listAuthorizedClients(principal) {
      if (principal.role !== 'RECRUITER' && principal.role !== 'CLIENT_HIRING_MANAGER') {
        throw new WorkflowClientUnauthorizedError();
      }
      if (!repository.listAuthorizedClients) {
        return [];
      }
      return repository.listAuthorizedClients(
        principal.organizationId,
        principal.userId,
        principal.role,
      );
    },

    async getCandidateTimeline(principal, requisitionId, candidateId, options) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new WorkflowRequisitionAccessDeniedError();
      }

      if (!repository.getCandidateTimeline) {
        throw new WorkflowCandidateNotFoundError();
      }

      const result = await repository.getCandidateTimeline(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
        options,
      );

      if (!result) {
        throw new WorkflowCandidateNotFoundError();
      }

      return {
        candidateId: result.candidate.id,
        candidateCode: result.candidate.candidateCode,
        requisitionId,
        items: result.items.map((ev) => ({
          id: ev.id,
          fromStage: ev.fromStage,
          toStage: ev.toStage,
          actorRole: ev.actorRole,
          submissionId: ev.submissionId,
          reason: ev.reason,
          createdAt: ev.createdAt.toISOString(),
        })),
        total: result.total,
        limit: options.limit,
        offset: options.offset,
      };
    },
  };
}
