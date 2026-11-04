import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import {
  AssessmentConsentRequiredError,
  AssessmentNotFoundError,
  AssessmentRequisitionAccessDeniedError,
  AssessmentScorecardInvalidWeightsError,
  createAssessmentService,
} from './assessment.service.js';
import type { AssessmentRepository } from './assessment.repository.js';

describe('assessment.service', () => {
  const recruiterPrincipal: AuthenticatedPrincipal = {
    userId: 'recruiter-1',
    organizationId: 'org-1',
    role: 'RECRUITER',
  };

  const clientHiringManagerPrincipal: AuthenticatedPrincipal = {
    userId: 'hiring-manager-1',
    organizationId: 'org-1',
    role: 'CLIENT_HIRING_MANAGER',
  };

  it('denies non-recruiter principals from enqueuing assessments', async () => {
    const mockRepo: Partial<AssessmentRepository> = {};
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    await expect(service.enqueue(clientHiringManagerPrincipal, 'req-1', 'res-1')).rejects.toThrow(
      AssessmentRequisitionAccessDeniedError,
    );
  });

  it('fails closed when authorized context is not found (missing consent, unapproved scorecard, or unassigned)', async () => {
    const mockRepo: Partial<AssessmentRepository> = {
      findAuthorizedContext: vi.fn().mockResolvedValue(null),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    await expect(service.enqueue(recruiterPrincipal, 'req-1', 'res-1')).rejects.toThrow(
      AssessmentConsentRequiredError,
    );
  });

  it('returns existing assessment idempotently if already completed', async () => {
    const existingAssessment = {
      id: 'existing-assessment-1',
      organizationId: 'org-1',
      requisitionId: 'req-1',
      candidateId: 'can-1',
      resumeDocumentId: 'res-1',
      scorecardVersionId: 'sc-1',
      score: 85,
      coverage: 100,
      status: 'COMPLETE' as const,
      formulaVersion: 'v1',
      modelMetadata: {
        provider: 'test-provider',
        model: 'test-model',
        promptVersion: '2026-11-assessment-v1',
        inputHash: 'hash-in',
        outputHash: 'hash-out',
        scoringFormula: 'v1',
        consentId: 'cid',
        consentNoticeHash: 'cnh',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      criteria: [
        {
          id: 'crit-1',
          key: 'ts',
          label: 'TypeScript',
          category: 'SKILL',
          requirementType: 'MUST_HAVE',
          weight: 100,
          status: 'MET',
          confidence: 'HIGH',
          score: 85,
          reasoning: 'Strong experience',
          evidence: [],
        },
      ],
      humanReviewRequired: false,
    };

    const mockRepo: Partial<AssessmentRepository> = {
      findAuthorizedContext: vi.fn().mockResolvedValue({
        requisitionId: 'req-1',
        candidateId: 'can-1',
        resumeDocumentId: 'res-1',
        documentExtractionId: 'ext-1',
        scorecardVersionId: 'sc-1',
        extractedText: 'sample',
        pageMapJson: {},
        criteria: [
          {
            id: 'crit-1',
            key: 'ts',
            label: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
          },
        ],
        consentId: 'consent-1',
        consentNoticeHash: 'hash-1',
      }),
      findExistingAssessment: vi.fn().mockResolvedValue(existingAssessment),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    const result = await service.enqueue(recruiterPrincipal, 'req-1', 'res-1');
    expect(result.isExisting).toBe(true);
    expect(result.assessment?.id).toBe('existing-assessment-1');
    expect(result.job).toBeNull();
  });

  it('returns existing in-flight job idempotently if already queued or processing', async () => {
    const mockRepo: Partial<AssessmentRepository> = {
      findAuthorizedContext: vi.fn().mockResolvedValue({
        requisitionId: 'req-1',
        candidateId: 'can-1',
        resumeDocumentId: 'res-1',
        documentExtractionId: 'ext-1',
        scorecardVersionId: 'sc-1',
        extractedText: 'sample',
        pageMapJson: {},
        criteria: [
          {
            id: 'crit-1',
            key: 'ts',
            label: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
          },
        ],
        consentId: 'consent-1',
        consentNoticeHash: 'hash-1',
      }),
      findExistingAssessment: vi.fn().mockResolvedValue(null),
      findActiveJob: vi.fn().mockResolvedValue({ id: 'active-job-1', status: 'PROCESSING' }),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    const result = await service.enqueue(recruiterPrincipal, 'req-1', 'res-1');
    expect(result.isExisting).toBe(true);
    expect(result.job?.jobId).toBe('active-job-1');
    expect(result.job?.status).toBe('PROCESSING');
  });

  it('enqueues a new job when no existing assessment or active job exists', async () => {
    const mockRepo: Partial<AssessmentRepository> = {
      findAuthorizedContext: vi.fn().mockResolvedValue({
        requisitionId: 'req-1',
        candidateId: 'can-1',
        resumeDocumentId: 'res-1',
        documentExtractionId: 'ext-1',
        scorecardVersionId: 'sc-1',
        extractedText: 'sample',
        pageMapJson: {},
        criteria: [
          {
            id: 'crit-1',
            key: 'ts',
            label: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
          },
        ],
        consentId: 'consent-1',
        consentNoticeHash: 'hash-1',
      }),
      findExistingAssessment: vi.fn().mockResolvedValue(null),
      findActiveJob: vi.fn().mockResolvedValue(null),
      enqueueAssessmentJob: vi.fn().mockResolvedValue({
        jobId: 'new-job-1',
        batchId: 'batch-1',
        status: 'QUEUED',
      }),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    const result = await service.enqueue(recruiterPrincipal, 'req-1', 'res-1');
    expect(result.isExisting).toBe(false);
    expect(result.job?.jobId).toBe('new-job-1');
    expect(result.job?.status).toBe('QUEUED');
  });

  it('throws AssessmentNotFoundError when requesting a non-existent assessment', async () => {
    const mockRepo: Partial<AssessmentRepository> = {
      getAssessmentById: vi.fn().mockResolvedValue(null),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    await expect(service.getById(recruiterPrincipal, 'req-1', 'non-existent')).rejects.toThrow(
      AssessmentNotFoundError,
    );
  });

  it('throws AssessmentScorecardInvalidWeightsError when approved scorecard has invalid weights', async () => {
    const mockRepo: Partial<AssessmentRepository> = {
      findAuthorizedContext: vi.fn().mockResolvedValue({
        requisitionId: 'req-1',
        candidateId: 'can-1',
        resumeDocumentId: 'res-1',
        documentExtractionId: 'ext-1',
        scorecardVersionId: 'sc-1',
        extractedText: 'sample',
        pageMapJson: {},
        criteria: [
          {
            id: 'crit-1',
            key: 'bad',
            label: 'Bad Weight Criterion',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: -5,
          },
        ],
        consentId: 'consent-1',
        consentNoticeHash: 'hash-1',
      }),
    };
    const service = createAssessmentService(mockRepo as AssessmentRepository);

    await expect(service.enqueue(recruiterPrincipal, 'req-1', 'res-1')).rejects.toThrow(
      AssessmentScorecardInvalidWeightsError,
    );
  });
});
