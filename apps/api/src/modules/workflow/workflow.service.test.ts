import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { generateConsentNotice } from '../consent/consent.policy.js';
import { redactCandidateIdentifiers } from '../assessments/assessment.redactor.js';
import { evaluateFeedbackFairness } from './feedback.fairness.js';
import type { WorkflowRepository } from './workflow.repository.js';
import {
  createWorkflowService,
  WorkflowClientUnauthorizedError,
  WorkflowConsentMissingClientSharingError,
  WorkflowConsentRequiredError,
  WorkflowDuplicateSubmissionError,
  WorkflowRequisitionAccessDeniedError,
  WorkflowResumeNotInspectedError,
  WorkflowShortlistRequiredError,
} from './workflow.service.js';

describe('workflow.service', () => {
  const recruiterPrincipal: AuthenticatedPrincipal = {
    userId: 'recruiter-uuid-1',
    organizationId: 'org-uuid-1',
    role: 'RECRUITER',
  };

  const clientPrincipal: AuthenticatedPrincipal = {
    userId: 'client-user-uuid-1',
    organizationId: 'org-uuid-1',
    role: 'CLIENT_HIRING_MANAGER',
  };

  const requisitionId = 'req-uuid-1';
  const candidateId = 'cand-uuid-1';
  const resumeId = 'resume-uuid-1';
  const clientId = 'client-uuid-1';
  const submissionId = 'sub-uuid-1';

  it('denies non-recruiter principals from listing candidates for requisition review', async () => {
    const mockRepo: Partial<WorkflowRepository> = {};
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.listCandidatesForRequisition(clientPrincipal, requisitionId, {
        limit: 20,
        offset: 0,
      }),
    ).rejects.toThrow(WorkflowRequisitionAccessDeniedError);
  });

  it('fails closed when recruiter is not assigned to requisition', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue(null),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.listCandidatesForRequisition(recruiterPrincipal, requisitionId, {
        limit: 20,
        offset: 0,
      }),
    ).rejects.toThrow(WorkflowRequisitionAccessDeniedError);
  });

  it('shortlist requires prior original resume inspection by recruiter', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: false,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: null,
        review: null,
        submission: null,
        clientFeedback: [],
      }),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash',
        capturedAt: new Date(),
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(false), // NOT inspected
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.recordShortlist(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowResumeNotInspectedError);
  });

  it('shortlist requires active exact-scope candidate consent', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: null,
        assessment: null,
        review: null,
        submission: null,
        clientFeedback: [],
      }),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue(null), // NO active consent
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.recordShortlist(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowConsentRequiredError);
  });

  it('submission requires prior recruiter shortlist decision', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: {
          id: 'asmt-1',
          status: 'COMPLETE',
          score: 90,
          coverage: 100,
          formulaVersion: 'v1',
          criteria: [],
        },
        review: null, // NOT reviewed/shortlisted
        submission: null,
        clientFeedback: [],
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.submitCandidateToClient(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowShortlistRequiredError);
  });

  it('submission fails closed if consent notice does not cover client sharing disclosure', async () => {
    // Generate notice WITHOUT clientName
    const genericNotice = generateConsentNotice({
      organizationName: 'Hiring Organization',
      requisitionTitle: 'Senior Engineer',
    });

    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: {
          id: 'asmt-1',
          status: 'COMPLETE',
          score: 90,
          coverage: 100,
          formulaVersion: 'v1',
          criteria: [],
        },
        review: {
          id: 'rev-1',
          decision: 'REVIEWED',
          reviewedAt: new Date(),
          reviewerId: recruiterPrincipal.userId,
          notesInternal: null,
        },
        submission: null,
        clientFeedback: [],
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
      findShortlist: vi.fn().mockResolvedValue({
        id: 'shortlist-1',
        candidateId,
        requisitionId,
        shortlistedById: recruiterPrincipal.userId,
        shortlistedAt: new Date(),
        notesInternal: null,
      }),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: genericNotice.noticeTextHash, // Matches generic without client!
        capturedAt: new Date(),
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.submitCandidateToClient(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowConsentMissingClientSharingError);
  });

  it('successful submission when all criteria, resume inspection, shortlist, and client disclosure are satisfied', async () => {
    const authorizedNotice = generateConsentNotice({
      organizationName: 'Hiring Organization',
      requisitionTitle: 'Senior Engineer',
      clientName: 'Acme Corp',
    });

    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: {
          id: 'asmt-1',
          status: 'COMPLETE',
          score: 90,
          coverage: 100,
          formulaVersion: 'v1',
          criteria: [],
        },
        review: {
          id: 'rev-1',
          decision: 'REVIEWED',
          reviewedAt: new Date(),
          reviewerId: recruiterPrincipal.userId,
          notesInternal: null,
        },
        submission: null,
        clientFeedback: [],
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
      findShortlist: vi.fn().mockResolvedValue({
        id: 'shortlist-1',
        candidateId,
        requisitionId,
        shortlistedById: recruiterPrincipal.userId,
        shortlistedAt: new Date(),
        notesInternal: null,
      }),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: authorizedNotice.noticeTextHash,
        capturedAt: new Date(),
      }),
      createSubmission: vi.fn().mockResolvedValue({
        id: submissionId,
        organizationId: recruiterPrincipal.organizationId,
        candidateId,
        requisitionId,
        clientId,
        submittedById: recruiterPrincipal.userId,
        assessmentId: 'asmt-1',
        reviewId: 'rev-1',
        resumeDocumentId: resumeId,
        status: 'SUBMITTED',
        submittedAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    const submission = await service.submitCandidateToClient(
      recruiterPrincipal,
      requisitionId,
      candidateId,
    );
    expect(submission.id).toBe(submissionId);
    expect(submission.status).toBe('SUBMITTED');
  });

  it('rejects duplicate active submission for the same candidate and requisition', async () => {
    const authorizedNotice = generateConsentNotice({
      organizationName: 'Hiring Organization',
      requisitionTitle: 'Senior Engineer',
      clientName: 'Acme Corp',
    });

    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: {
          id: 'asmt-1',
          status: 'COMPLETE',
          score: 90,
          coverage: 100,
          formulaVersion: 'v1',
          criteria: [],
        },
        review: {
          id: 'rev-1',
          decision: 'REVIEWED',
          reviewedAt: new Date(),
          reviewerId: recruiterPrincipal.userId,
          notesInternal: null,
        },
        submission: {
          id: 'sub-existing',
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedById: 'rec-1',
        },
        clientFeedback: [],
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
      findShortlist: vi.fn().mockResolvedValue({
        id: 'shortlist-1',
        candidateId,
        requisitionId,
        shortlistedById: recruiterPrincipal.userId,
        shortlistedAt: new Date(),
        notesInternal: null,
      }),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: authorizedNotice.noticeTextHash,
        capturedAt: new Date(),
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.submitCandidateToClient(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowDuplicateSubmissionError);
  });

  it('client submission detail returns masked candidate reference and verified criteria', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      getSubmissionForClient: vi.fn().mockResolvedValue({
        submissionId,
        candidateRef: 'CAND-SUB-12345678',
        requisitionId,
        requisitionTitle: 'Senior Engineer',
        status: 'SUBMITTED',
        submittedAt: new Date(),
        assessment: {
          score: 88.5,
          coverage: 100,
          status: 'COMPLETE',
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              status: 'MATCH',
              reasoning: 'Verified 5+ years experience',
              verifiedQuotes: ['Senior TypeScript engineer for 5 years'],
            },
          ],
        },
        feedbackHistory: [
          {
            id: 'dec-iv-1',
            decision: 'PROPOSE_INTERVIEW',
            reason: 'Initial technical screen',
            proposedAt: new Date('2026-11-10T10:00:00.000Z'),
            timezone: 'UTC',
            createdAt: new Date('2026-11-05T10:00:00.000Z'),
          },
        ],
        interviews: [
          {
            id: 'iv-1',
            startAt: '2026-11-10T10:00:00.000Z',
            endAt: '2026-11-10T10:45:00.000Z',
            timezone: 'UTC',
            format: 'VIDEO',
            status: 'COMPLETED',
            reason: 'Initial technical screen',
            createdAt: '2026-11-05T10:00:00.000Z',
          },
        ],
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    const clientView = await service.getSubmissionForClient(
      clientPrincipal,
      clientId,
      submissionId,
    );
    expect(clientView.candidateRef).toBe('CAND-SUB-12345678');
    const maskedClientView = clientView as unknown as Record<string, unknown>;
    expect(maskedClientView['candidateId']).toBeUndefined();
    expect(maskedClientView['email']).toBeUndefined();
    expect(maskedClientView['phone']).toBeUndefined();
    expect(maskedClientView['candidateCode']).toBeUndefined();
    expect(clientView.assessment?.criteria[0]?.verifiedQuotes[0]).toContain('Senior TypeScript');
    expect(clientView.interviews).toHaveLength(1);
    expect(clientView.interviews?.[0]?.status).toBe('COMPLETED');
  });

  it('records client feedback decision and updates status', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      recordClientFeedback: vi.fn().mockResolvedValue({
        id: 'decision-uuid-1',
        decision: 'SHORTLIST',
        createdAt: new Date(),
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    const result = await service.recordClientFeedback(
      clientPrincipal,
      clientId,
      'membership-1',
      submissionId,
      'SHORTLIST',
      'Strong fit for team',
    );
    expect(result.id).toBe('decision-uuid-1');
    expect(result.decision).toBe('SHORTLIST');
  });

  it('distinguishes general review from shortlist decision: reviewed candidate without shortlist fails submission', async () => {
    const authorizedNotice = generateConsentNotice({
      organizationName: 'Hiring Organization',
      requisitionTitle: 'Senior Engineer',
      clientName: 'Acme Corp',
    });

    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        assessment: {
          id: 'asmt-1',
          status: 'COMPLETE',
          score: 90,
          coverage: 100,
          formulaVersion: 'v1',
          criteria: [],
        },
        review: {
          id: 'rev-1',
          decision: 'REVIEWED',
          reviewedAt: new Date(),
          reviewerId: recruiterPrincipal.userId,
          notesInternal: 'Looks fine',
        },
        submission: null,
        clientFeedback: [],
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: authorizedNotice.noticeTextHash,
        capturedAt: new Date(),
      }),
      findShortlist: vi.fn().mockResolvedValue(null), // REVIEWED but NOT shortlisted!
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    await expect(
      service.submitCandidateToClient(recruiterPrincipal, requisitionId, candidateId),
    ).rejects.toThrow(WorkflowShortlistRequiredError);
  });

  it('recordShortlist persists dedicated CandidateShortlist record distinct from CandidateReview', async () => {
    const mockRepo: Partial<WorkflowRepository> = {
      findAuthorizedRequisition: vi.fn().mockResolvedValue({
        id: requisitionId,
        title: 'Senior Engineer',
        status: 'OPEN',
        clientId,
        client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
      }),
      getCandidateDetail: vi.fn().mockResolvedValue({
        candidate: { id: candidateId, candidateCode: 'CAND-001' },
        requisition: {
          id: requisitionId,
          title: 'Senior Engineer',
          client: { id: clientId, name: 'Acme Corp' },
        },
        resume: {
          id: resumeId,
          fileName: 'cv.pdf',
          fileType: 'PDF',
          sizeBytes: 1024n,
          uploadedAt: new Date(),
        },
        hasInspectedOriginalResume: true,
        consent: {
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          capturedAt: new Date(),
        },
        review: {
          id: 'rev-1',
          decision: 'REVIEWED',
          reviewedAt: new Date(),
          reviewerId: recruiterPrincipal.userId,
          notesInternal: 'Approved after review',
        },
      }),
      hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
      findActiveConsentForRequisition: vi.fn().mockResolvedValue({
        id: 'consent-1',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash',
        capturedAt: new Date(),
      }),
      recordShortlist: vi.fn().mockResolvedValue({
        id: 'shortlist-uuid-1',
        organizationId: recruiterPrincipal.organizationId,
        candidateId,
        requisitionId,
        shortlistedById: recruiterPrincipal.userId,
        shortlistedAt: new Date(),
        notesInternal: 'Top candidate for round 2',
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    const shortlist = await service.recordShortlist(
      recruiterPrincipal,
      requisitionId,
      candidateId,
      'Top candidate for round 2',
    );

    expect(shortlist.id).toBe('shortlist-uuid-1');
    expect(shortlist.shortlistedById).toBe(recruiterPrincipal.userId);
    expect(shortlist.notesInternal).toBe('Top candidate for round 2');
    expect(mockRepo.recordShortlist).toHaveBeenCalledWith(
      recruiterPrincipal.organizationId,
      recruiterPrincipal.userId,
      requisitionId,
      candidateId,
      'Top candidate for round 2',
    );
  });

  it('rejects recordShortlist and submitCandidateToClient when review decision is NEEDS_REVIEW or CLOSED (F-08)', async () => {
    for (const nonPositiveDecision of ['NEEDS_REVIEW', 'CLOSED'] as const) {
      const mockRepo: Partial<WorkflowRepository> = {
        findAuthorizedRequisition: vi.fn().mockResolvedValue({
          id: requisitionId,
          title: 'Senior Engineer',
          status: 'OPEN',
          clientId,
          client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
        }),
        getCandidateDetail: vi.fn().mockResolvedValue({
          candidate: { id: candidateId, candidateCode: 'CAND-001' },
          requisition: {
            id: requisitionId,
            title: 'Senior Engineer',
            client: { id: clientId, name: 'Acme Corp' },
          },
          resume: {
            id: resumeId,
            fileName: 'cv.pdf',
            fileType: 'PDF',
            sizeBytes: 1024n,
            uploadedAt: new Date(),
          },
          hasInspectedOriginalResume: true,
          consent: {
            id: 'consent-1',
            status: 'ACTIVE',
            policyVersion: '2026-11-v1',
            capturedAt: new Date(),
          },
          assessment: {
            id: 'asmt-1',
            status: 'COMPLETE',
            score: 90,
            coverage: 100,
            formulaVersion: 'v1',
            criteria: [],
          },
          review: {
            id: 'rev-1',
            decision: nonPositiveDecision,
            reviewedAt: new Date(),
            reviewerId: recruiterPrincipal.userId,
            notesInternal: 'Not ready to shortlist',
          },
          submission: null,
          clientFeedback: [],
        }),
        hasRecruiterInspectedResume: vi.fn().mockResolvedValue(true),
        findActiveConsentForRequisition: vi.fn().mockResolvedValue({
          id: 'consent-1',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          noticeTextHash: 'hash',
          capturedAt: new Date(),
        }),
        findShortlist: vi.fn().mockResolvedValue({
          id: 'shortlist-1',
          organizationId: recruiterPrincipal.organizationId,
          candidateId,
          requisitionId,
          shortlistedById: recruiterPrincipal.userId,
          shortlistedAt: new Date(),
          notesInternal: null,
        }),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      await expect(
        service.recordShortlist(
          recruiterPrincipal,
          requisitionId,
          candidateId,
          'Attempt shortlist',
        ),
      ).rejects.toThrow(WorkflowShortlistRequiredError);

      await expect(
        service.submitCandidateToClient(recruiterPrincipal, requisitionId, candidateId),
      ).rejects.toThrow(WorkflowShortlistRequiredError);
    }
  });

  it('client proposal creates complete interview availability record with format and status', async () => {
    const futureStart = new Date(Date.now() + 86400000);
    const futureEnd = new Date(futureStart.getTime() + 3600000);

    const mockRepo: Partial<WorkflowRepository> = {
      recordClientInterviewProposal: vi.fn().mockResolvedValue({
        id: 'proposal-1',
        decision: 'PROPOSE_INTERVIEW',
        proposedAt: futureStart,
        startAt: futureStart,
        endAt: futureEnd,
        timezone: 'America/New_York',
        format: 'VIDEO',
        status: 'PROPOSED',
        createdAt: new Date(),
      }),
    };
    const service = createWorkflowService(mockRepo as WorkflowRepository);

    const result = await service.recordClientInterviewProposal(
      clientPrincipal,
      clientId,
      'membership-1',
      submissionId,
      futureStart.toISOString(),
      'America/New_York',
      'Technical interview with VP',
      futureEnd.toISOString(),
      'VIDEO',
    );

    expect(result.id).toBe('proposal-1');
    expect(result.format).toBe('VIDEO');
    expect(result.status).toBe('PROPOSED');
    expect(result.startAt).toBe(futureStart.toISOString());
    expect(result.endAt).toBe(futureEnd.toISOString());
  });

  it('redacts direct candidate identifiers (name, address, email, phone, candidate code) from verified evidence quotes while preserving technical terms', () => {
    const rawQuote =
      'Alice Smith residing at 123 Main Street, Seattle, WA (CAN-XYZ999) led Kubernetes migration to AWS at Google LLC using TypeScript and PostgreSQL. Contact: alice.smith@example.com or +1 555-123-4567, portfolio: https://alicesmith.dev';
    const result = redactCandidateIdentifiers(rawQuote, {
      candidateNames: ['Alice Smith'],
      candidateAddress: '123 Main Street, Seattle, WA',
      extraIdentifiers: ['CAN-XYZ999'],
    });

    // PII must be redacted
    expect(result.redactedText).not.toContain('Alice Smith');
    expect(result.redactedText).not.toContain('123 Main Street, Seattle, WA');
    expect(result.redactedText).not.toContain('alice.smith@example.com');
    expect(result.redactedText).not.toContain('+1 555-123-4567');
    expect(result.redactedText).not.toContain('CAN-XYZ999');
    expect(result.redactedText).not.toContain('https://alicesmith.dev');

    // Technical skills, job keywords, company names must be preserved
    expect(result.redactedText).toContain('Kubernetes');
    expect(result.redactedText).toContain('AWS');
    expect(result.redactedText).toContain('Google LLC');
    expect(result.redactedText).toContain('TypeScript');
    expect(result.redactedText).toContain('PostgreSQL');

    // Length and character-offset alignment must be preserved
    expect(result.redactedText.length).toBe(rawQuote.length);
  });

  describe('feedback fairness safeguard (evaluateFeedbackFairness)', () => {
    it('allows legitimate negative and positive job-related technical feedback', () => {
      const allowedSamples = [
        'Candidate failed the system design round on distributed systems and Kafka replication.',
        'Refactored old legacy codebase and implemented master/slave database architecture.',
        'Strong in PostgreSQL and React, but needs improvement in Kubernetes debugging.',
        'Candidate has 15 years of deep software engineering experience in enterprise Java.',
        'Notice period is 90 days, which exceeds our project timeline.',
        'Candidate had difficulty writing clean algorithms during the live coding challenge.',
        'Good communication skills and solid understanding of event-driven microservices.',
      ];

      for (const sample of allowedSamples) {
        const result = evaluateFeedbackFairness(sample);
        expect(result.isProhibited).toBe(false);
      }
    });

    it('detects explicit age discrimination', () => {
      const result = evaluateFeedbackFairness(
        'Candidate is too old for our startup pace, we prefer a younger candidate.',
      );
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('AGE');
    });

    it('detects explicit pregnancy and family planning discrimination', () => {
      const result = evaluateFeedbackFairness(
        'Candidate mentioned planning a family and upcoming maternity leave soon.',
      );
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('PREGNANCY_OR_FAMILY');
    });

    it('detects explicit gender-based exclusion', () => {
      const result = evaluateFeedbackFairness(
        'We prefer a male candidate only for this leadership role.',
      );
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('GENDER_OR_SEX');
    });

    it('detects explicit race, ethnicity, or caste discrimination', () => {
      const result = evaluateFeedbackFairness('Reject based on race and national origin.');
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('RACE_OR_ETHNICITY');
    });

    it('detects explicit religion or faith discrimination', () => {
      const result = evaluateFeedbackFairness('Reject due to religion and wearing hijab.');
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('RELIGION_OR_FAITH');
    });

    it('detects explicit disability or medical condition exclusion', () => {
      const result = evaluateFeedbackFairness(
        'Do not hire because they are disabled and in a wheelchair.',
      );
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('DISABILITY_OR_HEALTH');
    });

    it('detects explicit sexual orientation discrimination', () => {
      const result = evaluateFeedbackFairness('Reject candidate because they are gay.');
      expect(result.isProhibited).toBe(true);
      expect(result.category).toBe('SEXUAL_ORIENTATION');
    });
  });

  describe('respondToInterviewAsClient', () => {
    it('authorizes client manager to respond to interview proposal', async () => {
      const mockRepo: Partial<WorkflowRepository> = {
        respondToInterviewAsClient: vi.fn().mockResolvedValue({
          success: true,
          action: 'ACCEPT',
          proposalId: 'prop-123',
          status: 'ACCEPTED',
        }),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      const result = await service.respondToInterviewAsClient(
        clientPrincipal,
        clientId,
        'membership-1',
        submissionId,
        'prop-123',
        'ACCEPT',
      );

      expect(result.status).toBe('ACCEPTED');
      expect(mockRepo.respondToInterviewAsClient).toHaveBeenCalledWith(
        clientPrincipal.organizationId,
        clientId,
        submissionId,
        'prop-123',
        clientPrincipal.userId,
        'membership-1',
        'ACCEPT',
        undefined,
      );
    });

    it('fails closed when non-client principal calls respondToInterviewAsClient', async () => {
      const mockRepo: Partial<WorkflowRepository> = {};
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      await expect(
        service.respondToInterviewAsClient(
          recruiterPrincipal,
          clientId,
          'membership-1',
          submissionId,
          'prop-123',
          'ACCEPT',
        ),
      ).rejects.toThrow(WorkflowClientUnauthorizedError);
    });
  });

  describe('Batch 4: Frontend-Ready API Contracts (F-06, Shortlist Status, Timeline)', () => {
    it('listCandidatesForRequisition includes explicit isShortlisted and shortlistedAt fields', async () => {
      const shortlistedAt = new Date('2026-11-04T15:00:00.000Z');
      const mockRepo: Partial<WorkflowRepository> = {
        findAuthorizedRequisition: vi.fn().mockResolvedValue({
          id: requisitionId,
          title: 'Senior Engineer',
          status: 'OPEN',
          clientId,
          client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
        }),
        listCandidatesForRequisition: vi.fn().mockResolvedValue({
          items: [
            {
              candidateId,
              candidateCode: 'CAND-001',
              resumeDocumentId: resumeId,
              resumeFileName: 'cv.pdf',
              parseStatus: 'EXTRACTED',
              assessment: {
                id: 'asmt-1',
                status: 'COMPLETE',
                score: 92,
                coverage: 100,
                criteriaCount: 4,
                criteriaMetCount: 4,
              },
              review: {
                decision: 'REVIEWED',
                reviewedAt: new Date('2026-11-04T14:00:00.000Z'),
              },
              shortlist: {
                shortlistedAt,
              },
              submission: null,
              lastActivityAt: shortlistedAt,
            },
            {
              candidateId: 'cand-2',
              candidateCode: 'CAND-002',
              resumeDocumentId: 'res-2',
              resumeFileName: 'cv2.pdf',
              parseStatus: 'EXTRACTED',
              assessment: null,
              review: null,
              shortlist: null,
              submission: null,
              lastActivityAt: new Date('2026-11-04T12:00:00.000Z'),
            },
          ],
          total: 2,
        }),
      };

      const service = createWorkflowService(mockRepo as WorkflowRepository);
      const res = await service.listCandidatesForRequisition(recruiterPrincipal, requisitionId, {
        limit: 20,
        offset: 0,
      });

      expect(res.items[0]?.isShortlisted).toBe(true);
      expect(res.items[0]?.shortlistedAt).toBe(shortlistedAt.toISOString());
      expect(res.items[1]?.isShortlisted).toBe(false);
      expect(res.items[1]?.shortlistedAt).toBeNull();
    });

    it('listAuthorizedClients returns active clients for recruiter and client hiring manager (F-06)', async () => {
      const mockRepo: Partial<WorkflowRepository> = {
        listAuthorizedClients: vi.fn().mockResolvedValue([
          {
            id: clientId,
            name: 'Acme Corp',
            status: 'ACTIVE',
            membershipRole: 'CLIENT_HIRING_MANAGER',
          },
        ]),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      const clientResult = await service.listAuthorizedClients(clientPrincipal);
      expect(clientResult).toHaveLength(1);
      expect(clientResult[0]?.id).toBe(clientId);
      expect(mockRepo.listAuthorizedClients).toHaveBeenCalledWith(
        clientPrincipal.organizationId,
        clientPrincipal.userId,
        'CLIENT_HIRING_MANAGER',
      );
    });

    it('getCandidateTimeline returns ordered pipeline events for authorized recruiter', async () => {
      const eventDate = new Date('2026-11-04T16:00:00.000Z');
      const mockRepo: Partial<WorkflowRepository> = {
        findAuthorizedRequisition: vi.fn().mockResolvedValue({
          id: requisitionId,
          title: 'Senior Engineer',
          status: 'OPEN',
          clientId,
          client: { id: clientId, name: 'Acme Corp', status: 'ACTIVE' },
        }),
        getCandidateTimeline: vi.fn().mockResolvedValue({
          candidate: { id: candidateId, candidateCode: 'CAND-001' },
          items: [
            {
              id: 'ev-1',
              fromStage: 'REVIEWED',
              toStage: 'RECRUITER_SHORTLISTED',
              actorRole: 'RECRUITER',
              submissionId: null,
              reason: 'Strong distributed systems fit',
              createdAt: eventDate,
            },
          ],
          total: 1,
        }),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      const timeline = await service.getCandidateTimeline(
        recruiterPrincipal,
        requisitionId,
        candidateId,
        { limit: 50, offset: 0 },
      );

      expect(timeline.candidateId).toBe(candidateId);
      expect(timeline.candidateCode).toBe('CAND-001');
      expect(timeline.items).toHaveLength(1);
      expect(timeline.items[0]?.toStage).toBe('RECRUITER_SHORTLISTED');
      expect(timeline.items[0]?.createdAt).toBe(eventDate.toISOString());
    });

    it('listAuthorizedClients forwards includeInactive=true for RECRUITER but never for CLIENT_HIRING_MANAGER', async () => {
      const now = new Date('2026-11-05T00:00:00.000Z');
      const mockRepo: Partial<WorkflowRepository> = {
        listAuthorizedClients: vi.fn().mockResolvedValue([
          {
            id: clientId,
            name: 'Acme Corp',
            status: 'INACTIVE',
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      const recruiterClients = await service.listAuthorizedClients(recruiterPrincipal, {
        includeInactive: true,
      });
      expect(recruiterClients[0]?.createdAt).toBe(now.toISOString());
      expect(recruiterClients[0]?.updatedAt).toBe(now.toISOString());
      expect(mockRepo.listAuthorizedClients).toHaveBeenCalledWith(
        recruiterPrincipal.organizationId,
        recruiterPrincipal.userId,
        'RECRUITER',
        { includeInactive: true },
      );

      vi.mocked(mockRepo.listAuthorizedClients!).mockClear();
      await service.listAuthorizedClients(clientPrincipal, { includeInactive: true });
      expect(mockRepo.listAuthorizedClients).toHaveBeenCalledWith(
        clientPrincipal.organizationId,
        clientPrincipal.userId,
        'CLIENT_HIRING_MANAGER',
      );
    });

    it('createClient and updateClient enforce recruiter role and return formatted client DTOs', async () => {
      const now = new Date('2026-11-05T00:00:00.000Z');
      const mockRepo: Partial<WorkflowRepository> = {
        createClient: vi.fn().mockResolvedValue({
          id: clientId,
          name: 'Acme Corp',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        }),
        updateClient: vi
          .fn()
          .mockResolvedValueOnce({
            id: clientId,
            name: 'Acme Updated',
            status: 'INACTIVE',
            createdAt: now,
            updatedAt: now,
          })
          .mockResolvedValueOnce(null),
      };
      const service = createWorkflowService(mockRepo as WorkflowRepository);

      await expect(service.createClient(clientPrincipal, { name: 'Forbidden' })).rejects.toThrow(
        WorkflowRequisitionAccessDeniedError,
      );

      await expect(
        service.updateClient(clientPrincipal, clientId, { status: 'INACTIVE' }),
      ).rejects.toThrow(WorkflowRequisitionAccessDeniedError);

      const created = await service.createClient(recruiterPrincipal, { name: 'Acme Corp' });
      expect(created).toEqual({
        id: clientId,
        name: 'Acme Corp',
        status: 'ACTIVE',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      const updated = await service.updateClient(recruiterPrincipal, clientId, {
        name: 'Acme Updated',
        status: 'INACTIVE',
      });
      expect(updated.status).toBe('INACTIVE');

      await expect(
        service.updateClient(recruiterPrincipal, 'missing-id', { status: 'ACTIVE' }),
      ).rejects.toThrow('Client not found');
    });

    it('getClient enforces authorization and returns formatted client DTO', async () => {
      const now = new Date('2026-11-05T00:00:00.000Z');
      const mockRepo: Partial<WorkflowRepository> = {
        getClient: vi.fn().mockResolvedValue({
          id: clientId,
          name: 'Acme Corp',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        }),
        listAuthorizedClients: vi.fn().mockResolvedValue([{ id: clientId }]),
      };

      const service = createWorkflowService(mockRepo as WorkflowRepository);

      // Recruiter succeeds
      const client = await service.getClient(recruiterPrincipal, clientId);
      expect(client.id).toBe(clientId);
      expect(client.name).toBe('Acme Corp');

      // Client hiring manager with membership succeeds
      const clientHm = await service.getClient(clientPrincipal, clientId);
      expect(clientHm.id).toBe(clientId);

      // Client hiring manager without membership fails
      const unauthClientPrincipal: AuthenticatedPrincipal = {
        userId: 'unauth-client-user',
        organizationId: 'org-uuid-1',
        role: 'CLIENT_HIRING_MANAGER',
      };
      (mockRepo.listAuthorizedClients as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      await expect(service.getClient(unauthClientPrincipal, clientId)).rejects.toThrow();
    });

    it('listClientMembers and inviteClientMember enforce recruiter role and forward options', async () => {
      const now = new Date('2026-11-05T00:00:00.000Z');
      const memberDto = {
        id: 'mem-1',
        membershipId: 'mem-1',
        userId: 'usr-1',
        clientId,
        organizationId: 'org-uuid-1',
        name: 'Jane Doe',
        email: 'jane@acme.com',
        role: 'CLIENT_HIRING_MANAGER' as const,
        membershipStatus: 'ACTIVE' as const,
        userStatus: 'INVITED' as const,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const mockRepo: Partial<WorkflowRepository> = {
        listClientMembers: vi.fn().mockResolvedValue([memberDto]),
        inviteClientMember: vi.fn().mockResolvedValue(memberDto),
      };

      const service = createWorkflowService(mockRepo as WorkflowRepository, {
        applicationOrigin: 'https://app.talentlens.ai',
      });

      // Non-recruiter denied
      await expect(service.listClientMembers(clientPrincipal, clientId)).rejects.toThrow(
        WorkflowRequisitionAccessDeniedError,
      );
      await expect(
        service.inviteClientMember(clientPrincipal, clientId, { email: 'test@example.com' }),
      ).rejects.toThrow(WorkflowRequisitionAccessDeniedError);

      // Recruiter succeeds
      const members = await service.listClientMembers(recruiterPrincipal, clientId);
      expect(members).toHaveLength(1);
      expect(members[0]!.email).toBe('jane@acme.com');

      const invited = await service.inviteClientMember(recruiterPrincipal, clientId, {
        email: 'jane@acme.com',
        name: 'Jane Doe',
      });
      expect(invited.email).toBe('jane@acme.com');
      expect(mockRepo.inviteClientMember).toHaveBeenCalledWith(
        recruiterPrincipal.organizationId,
        recruiterPrincipal.userId,
        clientId,
        { email: 'jane@acme.com', name: 'Jane Doe' },
        { applicationOrigin: 'https://app.talentlens.ai' },
      );
    });
  });
});
