import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { SessionService } from '../auth/session.service.js';
import {
  AssessmentNotFoundError,
  AssessmentScorecardInvalidWeightsError,
  type AssessmentService,
} from './assessment.service.js';

const rawToken = 'A'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const resumeId = '223e4567-e89b-42d3-a456-426614174000';
const assessmentId = '323e4567-e89b-42d3-a456-426614174000';

const recruiterPrincipal = {
  userId: 'recruiter-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'RECRUITER' as const,
};

const hiringManagerPrincipal = {
  userId: 'hm-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'CLIENT_HIRING_MANAGER' as const,
};

function createMockSessionService(
  principal: typeof recruiterPrincipal | null,
): Pick<SessionService, 'validateSession'> {
  return {
    validateSession: vi.fn().mockImplementation(async (token: string) => {
      if (!principal || token !== rawToken) {
        return null;
      }
      return principal;
    }),
  };
}

describe('assessment.routes', () => {
  const applicationOrigin = 'https://app.talentlens.ai';

  it('rejects unauthenticated enqueue requests with 401', async () => {
    const sessionService = createMockSessionService(null);
    const mockService = {} as AssessmentService;

    const app = createApp({
      assessments: {
        service: mockService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/assessments`)
      .set('Origin', applicationOrigin);

    expect(response.status).toBe(401);
  });

  it('rejects client hiring managers with 403', async () => {
    const sessionService = createMockSessionService(
      hiringManagerPrincipal as unknown as typeof recruiterPrincipal,
    );
    const mockService = {} as AssessmentService;

    const app = createApp({
      assessments: {
        service: mockService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/assessments`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken));

    expect(response.status).toBe(403);
  });

  it('rejects malformed UUIDs with 400', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService = {} as AssessmentService;

    const app = createApp({
      assessments: {
        service: mockService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/not-a-uuid/resumes/${resumeId}/assessments`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken));

    expect(response.status).toBe(400);
  });

  it('successfully enqueues an assessment returning 202 Accepted', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<AssessmentService> = {
      enqueue: vi.fn().mockResolvedValue({
        job: {
          jobId: 'job-1',
          batchId: 'batch-1',
          requisitionId,
          candidateId: 'can-1',
          resumeDocumentId: resumeId,
          jobType: 'ASSESS_CANDIDATE',
          status: 'QUEUED',
          attempts: 0,
          lastErrorCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        assessment: null,
        isExisting: false,
      }),
    };

    const app = createApp({
      assessments: {
        service: mockService as AssessmentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/assessments`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken));

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('success');
    expect(response.body.data.job.jobId).toBe('job-1');
  });

  it('retrieves an existing assessment with 200 OK', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<AssessmentService> = {
      getById: vi.fn().mockResolvedValue({
        id: assessmentId,
        organizationId: recruiterPrincipal.organizationId,
        requisitionId,
        candidateId: 'can-1',
        resumeDocumentId: resumeId,
        scorecardVersionId: 'sc-1',
        score: 95.5,
        coverage: 100,
        status: 'COMPLETE',
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
        criteria: [],
        humanReviewRequired: false,
      }),
    };

    const app = createApp({
      assessments: {
        service: mockService as AssessmentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/assessments/${assessmentId}`)
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.score).toBe(95.5);
  });

  it('returns 404 when assessment is not found', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<AssessmentService> = {
      getById: vi.fn().mockRejectedValue(new AssessmentNotFoundError()),
    };

    const app = createApp({
      assessments: {
        service: mockService as AssessmentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/assessments/${assessmentId}`)
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(404);
  });

  it('returns 400 when scorecard has invalid weights', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<AssessmentService> = {
      enqueue: vi
        .fn()
        .mockRejectedValue(
          new AssessmentScorecardInvalidWeightsError(
            'Total active scorecard weight must be finite and strictly positive.',
          ),
        ),
    };

    const app = createApp({
      assessments: {
        service: mockService as AssessmentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/assessments`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain('Total active scorecard weight must be finite');
  });
});
