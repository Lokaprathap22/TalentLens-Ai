import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import {
  WorkflowClientConflictError,
  WorkflowClientNotFoundError,
  WorkflowConsentRequiredError,
  WorkflowProhibitedFeedbackError,
  WorkflowResumeNotInspectedError,
  WorkflowSubmissionNotFoundError,
  WorkflowSubmissionStateError,
  type WorkflowService,
} from './workflow.service.js';

const rawToken = 'B'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const candidateId = '223e4567-e89b-42d3-a456-426614174000';
const clientId = '323e4567-e89b-42d3-a456-426614174000';
const submissionId = '423e4567-e89b-42d3-a456-426614174000';

const recruiterPrincipal: AuthenticatedPrincipal = {
  userId: 'recruiter-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'RECRUITER',
};

const hiringManagerPrincipal: AuthenticatedPrincipal = {
  userId: 'hm-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'CLIENT_HIRING_MANAGER',
};

function createMockSessionService(
  principal: AuthenticatedPrincipal | null,
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

function createMockAuthService(): Pick<AuthorizationService, 'authorizeClientMembership'> {
  return {
    authorizeClientMembership: vi.fn().mockResolvedValue({
      principal: hiringManagerPrincipal,
      clientId,
      membershipId: 'membership-uuid-1',
      membershipRole: 'CLIENT_HIRING_MANAGER',
    }),
  };
}

describe('workflow.routes', () => {
  const applicationOrigin = 'https://app.talentlens.ai';

  it('rejects unauthenticated candidate review requests with 401', async () => {
    const sessionService = createMockSessionService(null);
    const mockService = {} as WorkflowService;

    const app = createApp({
      workflow: {
        service: mockService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/candidates`)
      .set('Origin', applicationOrigin);

    expect(response.status).toBe(401);
  });

  it('rejects client hiring managers from recruiter endpoints with 403', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService = {} as WorkflowService;

    const app = createApp({
      workflow: {
        service: mockService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/candidates`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin);

    expect(response.status).toBe(403);
  });

  it('recruiter lists candidates for review returning 200 OK', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<WorkflowService> = {
      listCandidatesForRequisition: vi.fn().mockResolvedValue({
        items: [
          {
            candidateId,
            candidateCode: 'CAND-001',
            resumeDocumentId: 'res-1',
            resumeFileName: 'resume.pdf',
            parseStatus: 'PARSED',
            assessmentId: 'asmt-1',
            assessmentStatus: 'COMPLETE',
            overallScore: 92.5,
            coverage: 100,
            isComplete: true,
            criteriaCount: 5,
            criteriaMetCount: 5,
            reviewStatus: 'NOT_REVIEWED',
            reviewedAt: null,
            submissionId: null,
            submissionStatus: null,
            submittedAt: null,
            lastActivityAt: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/candidates`)
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].overallScore).toBe(92.5);
  });

  it('shortlist returns 400 when original resume has not been inspected', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<WorkflowService> = {
      recordShortlist: vi.fn().mockRejectedValue(new WorkflowResumeNotInspectedError()),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/shortlist`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ notesInternal: 'Promising profile' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain('inspect the original resume');
  });

  it('submits candidate to client returning 201 Created', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<WorkflowService> = {
      submitCandidateToClient: vi.fn().mockResolvedValue({
        id: submissionId,
        organizationId: recruiterPrincipal.organizationId,
        candidateId,
        requisitionId,
        clientId,
        submittedById: recruiterPrincipal.userId,
        assessmentId: 'asmt-1',
        reviewId: 'rev-1',
        resumeDocumentId: 'res-1',
        status: 'SUBMITTED',
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/submissions`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(submissionId);
    expect(response.body.status).toBe('SUBMITTED');
  });

  it('client gets masked submission details without PII returning 200 OK', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService: Partial<WorkflowService> = {
      getSubmissionForClient: vi.fn().mockResolvedValue({
        submissionId,
        candidateRef: 'CAND-SUB-12345678',
        requisitionId,
        requisitionTitle: 'Senior Backend Engineer',
        status: 'SUBMITTED',
        submittedAt: new Date().toISOString(),
        assessment: {
          score: 91,
          coverage: 100,
          status: 'COMPLETE',
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              status: 'MATCH',
              reasoning: 'Demonstrated extensive TypeScript experience',
              verifiedQuotes: ['5 years professional TypeScript development'],
            },
          ],
        },
        feedbackHistory: [],
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(`/api/v1/clients/${clientId}/submissions/${submissionId}`)
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.candidateRef).toBe('CAND-SUB-12345678');
    expect(response.body.candidateId).toBeUndefined();
    expect(response.body.email).toBeUndefined();
    expect(response.body.phone).toBeUndefined();
    expect(response.body.candidateCode).toBeUndefined();
    expect(response.body.assessment.criteria[0].label).toBe('TypeScript');
  });

  it('client feedback rejects decline without reason with 400', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService = {} as WorkflowService;

    const app = createApp({
      workflow: {
        service: mockService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/feedback`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ decision: 'REJECT' }); // Missing reason!

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('client feedback accepts decline with reason with 200 OK', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService: Partial<WorkflowService> = {
      recordClientFeedback: vi.fn().mockResolvedValue({
        id: 'decision-1',
        decision: 'REJECT',
        createdAt: new Date().toISOString(),
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/feedback`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ decision: 'REJECT', reason: 'Insufficient PostgreSQL experience' });

    expect(response.status).toBe(200);
    expect(response.body.decision).toBe('REJECT');
  });

  it('client interview proposal rejects past datetime with 400', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService = {} as WorkflowService;

    const app = createApp({
      workflow: {
        service: mockService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/interviews`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({
        proposedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        timezone: 'UTC',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('client interview proposal rejects invalid timezone with 400', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService = {} as WorkflowService;

    const app = createApp({
      workflow: {
        service: mockService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/interviews`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({
        proposedAt: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'Not/A/Timezone',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('client interview proposal accepts valid future datetime and IANA timezone with 201 Created', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService: Partial<WorkflowService> = {
      recordClientInterviewProposal: vi.fn().mockResolvedValue({
        id: 'decision-prop-1',
        decision: 'PROPOSE_INTERVIEW',
        proposedAt: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'Asia/Kolkata',
        createdAt: new Date().toISOString(),
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/interviews`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({
        proposedAt: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'Asia/Kolkata',
        reason: 'Technical deep-dive interview',
      });

    expect(response.status).toBe(201);
    expect(response.body.decision).toBe('PROPOSE_INTERVIEW');
    expect(response.body.timezone).toBe('Asia/Kolkata');
  });

  it('client accepts recruiter interview proposal with 200 OK', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const proposalId = '523e4567-e89b-42d3-a456-426614174000';
    const mockService: Partial<WorkflowService> = {
      respondToInterviewAsClient: vi.fn().mockResolvedValue({
        success: true,
        action: 'ACCEPT',
        proposalId,
        status: 'ACCEPTED',
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(
        `/api/v1/clients/${clientId}/submissions/${submissionId}/interviews/${proposalId}/accept`,
      )
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ACCEPTED');
    expect(mockService.respondToInterviewAsClient).toHaveBeenCalledWith(
      hiringManagerPrincipal,
      clientId,
      'membership-uuid-1',
      submissionId,
      proposalId,
      'ACCEPT',
    );
  });

  it('client rejects recruiter interview proposal with reason', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const proposalId = '523e4567-e89b-42d3-a456-426614174000';
    const mockService: Partial<WorkflowService> = {
      respondToInterviewAsClient: vi.fn().mockResolvedValue({
        success: true,
        action: 'REJECT',
        proposalId,
        status: 'REJECTED',
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    // Short reason (< 3 chars) is rejected with 400
    const failResponse = await request(app)
      .post(
        `/api/v1/clients/${clientId}/submissions/${submissionId}/interviews/${proposalId}/reject`,
      )
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ reason: 'no' });
    expect(failResponse.status).toBe(400);

    // Valid reason succeeds
    const response = await request(app)
      .post(
        `/api/v1/clients/${clientId}/submissions/${submissionId}/interviews/${proposalId}/reject`,
      )
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ reason: 'Team is unavailable during this time window' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
  });

  it('maps domain errors (missing submission, revoked consent, invalid submission state, fairness violation) to 4xx instead of 503 (F-05, F-13)', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService: Partial<WorkflowService> = {
      recordClientFeedback: vi
        .fn()
        .mockRejectedValueOnce(new WorkflowSubmissionNotFoundError())
        .mockRejectedValueOnce(new WorkflowConsentRequiredError())
        .mockRejectedValueOnce(new WorkflowSubmissionStateError()),
      recordClientInterviewProposal: vi
        .fn()
        .mockRejectedValueOnce(
          new WorkflowProhibitedFeedbackError('Prohibited demographic content', 'AGE'),
        ),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const notFoundRes = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/feedback`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ decision: 'SHORTLIST', reason: 'Strong technical fit' });
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body.error).toBe('not_found');

    const consentRes = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/feedback`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ decision: 'SHORTLIST', reason: 'Strong technical fit' });
    expect(consentRes.status).toBe(400);
    expect(consentRes.body.error).toBe('invalid_request');

    const stateRes = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/feedback`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ decision: 'SHORTLIST', reason: 'Strong technical fit' });
    expect(stateRes.status).toBe(400);
    expect(stateRes.body.error).toBe('invalid_request');

    const fairnessRes = await request(app)
      .post(`/api/v1/clients/${clientId}/submissions/${submissionId}/interviews`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({
        startAt: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'America/New_York',
        format: 'VIDEO',
        reason: 'Candidate is too old for the role',
      });
    expect(fairnessRes.status).toBe(400);
    expect(fairnessRes.body.error).toBe('invalid_request');
  });

  it('recruiter alternative interview proposal passes optional proposalId for countering a specific proposal (F-02)', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const proposalId = '523e4567-e89b-42d3-a456-426614174000';
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const mockService: Partial<WorkflowService> = {
      respondToInterview: vi.fn().mockResolvedValue({
        success: true,
        action: 'PROPOSE_ALTERNATIVE',
        proposalId: '623e4567-e89b-42d3-a456-426614174000',
        status: 'PROPOSED',
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/submissions/${submissionId}/interviews/propose`)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('Origin', applicationOrigin)
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({
        proposalId,
        startAt,
        timezone: 'America/New_York',
        format: 'VIDEO',
        reason: 'Proposing alternate slot',
      });

    expect(response.status).toBe(200);
    expect(mockService.respondToInterview).toHaveBeenCalledWith(
      recruiterPrincipal,
      requisitionId,
      submissionId,
      proposalId,
      'PROPOSE_ALTERNATIVE',
      expect.objectContaining({
        startAt,
        timezone: 'America/New_York',
        format: 'VIDEO',
        reason: 'Proposing alternate slot',
      }),
    );
  });

  it('GET /api/v1/clients returns authorized clients for recruiter and client hiring manager (F-06)', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const mockService: Partial<WorkflowService> = {
      listAuthorizedClients: vi.fn().mockResolvedValue([
        {
          id: clientId,
          name: 'Acme Enterprise',
          status: 'ACTIVE',
          membershipRole: 'CLIENT_HIRING_MANAGER',
        },
      ]),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get('/api/v1/clients')
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.clients).toEqual([
      {
        id: clientId,
        name: 'Acme Enterprise',
        status: 'ACTIVE',
        membershipRole: 'CLIENT_HIRING_MANAGER',
      },
    ]);
  });

  it('GET /api/v1/requisitions/:requisitionId/candidates/:candidateId/timeline returns candidate pipeline timeline for recruiter', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockService: Partial<WorkflowService> = {
      getCandidateTimeline: vi.fn().mockResolvedValue({
        candidateId,
        candidateCode: 'CAND-001',
        requisitionId,
        items: [
          {
            id: 'ev-1',
            fromStage: 'REVIEWED',
            toStage: 'RECRUITER_SHORTLISTED',
            actorRole: 'RECRUITER',
            submissionId: null,
            reason: 'Shortlisted after technical review',
            createdAt: '2026-11-04T16:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    };

    const app = createApp({
      workflow: {
        service: mockService as WorkflowService,
        sessionService,
        authorizationService: createMockAuthService(),
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get(
        `/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/timeline?limit=50&offset=0`,
      )
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.candidateId).toBe(candidateId);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].toStage).toBe('RECRUITER_SHORTLISTED');
  });

  describe('Client management routes (M9.3 Step 1 Part A)', () => {
    it('GET /api/v1/clients?includeInactive=true forwards includeInactive option to service', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService: Partial<WorkflowService> = {
        listAuthorizedClients: vi.fn().mockResolvedValue([
          {
            id: clientId,
            name: 'Acme Enterprise',
            status: 'ACTIVE',
            createdAt: '2026-11-05T00:00:00.000Z',
            updatedAt: '2026-11-05T00:00:00.000Z',
          },
          {
            id: 'client-inactive',
            name: 'Legacy Corp',
            status: 'INACTIVE',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-02T00:00:00.000Z',
          },
        ]),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .get('/api/v1/clients?includeInactive=true')
        .set('Cookie', [`talentlens_session=${rawToken}`]);

      expect(response.status).toBe(200);
      expect(response.body.clients).toHaveLength(2);
      expect(mockService.listAuthorizedClients).toHaveBeenCalledWith(recruiterPrincipal, {
        includeInactive: true,
      });
    });

    it('GET /api/v1/clients rejects invalid includeInactive query value with 400', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService: Partial<WorkflowService> = {
        listAuthorizedClients: vi.fn(),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .get('/api/v1/clients?includeInactive=invalid')
        .set('Cookie', [`talentlens_session=${rawToken}`]);

      expect(response.status).toBe(400);
      expect(mockService.listAuthorizedClients).not.toHaveBeenCalled();
    });

    it('POST /api/v1/clients creates a client for an authenticated recruiter (201)', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const createdClient = {
        id: clientId,
        name: 'Acme Enterprise',
        status: 'ACTIVE',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      };
      const mockService: Partial<WorkflowService> = {
        createClient: vi.fn().mockResolvedValue(createdClient),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .post('/api/v1/clients')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: '  Acme Enterprise  ' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ client: createdClient });
      expect(mockService.createClient).toHaveBeenCalledWith(recruiterPrincipal, {
        name: 'Acme Enterprise',
      });
    });

    it('POST /api/v1/clients validates whitespace, length boundaries, and rejects organizationId injection', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService: Partial<WorkflowService> = {
        createClient: vi.fn(),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      for (const invalidBody of [
        { name: '   ' },
        { name: 'A'.repeat(201) },
        { name: 'Valid Name', organizationId: 'attacker-org' },
      ]) {
        const res = await request(app)
          .post('/api/v1/clients')
          .set('Cookie', [`talentlens_session=${rawToken}`])
          .set('Origin', applicationOrigin)
          .set('x-csrf-token', deriveCsrfToken(rawToken))
          .send(invalidBody);

        expect(res.status).toBe(400);
      }

      expect(mockService.createClient).not.toHaveBeenCalled();
    });

    it('POST /api/v1/clients enforces recruiter role, CSRF, and Origin protection', async () => {
      const hmSessionService = createMockSessionService(hiringManagerPrincipal);
      const recruiterSessionService = createMockSessionService(recruiterPrincipal);
      const mockService: Partial<WorkflowService> = {
        createClient: vi.fn(),
      };

      const hmApp = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService: hmSessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      // Hiring manager forbidden (403)
      const hmRes = await request(hmApp)
        .post('/api/v1/clients')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: 'Acme' });
      expect(hmRes.status).toBe(403);

      const recruiterApp = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService: recruiterSessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      // Missing CSRF (403)
      const noCsrfRes = await request(recruiterApp)
        .post('/api/v1/clients')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .send({ name: 'Acme' });
      expect(noCsrfRes.status).toBe(403);

      // Wrong Origin (403)
      const badOriginRes = await request(recruiterApp)
        .post('/api/v1/clients')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', 'https://evil.example.com')
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: 'Acme' });
      expect(badOriginRes.status).toBe(403);

      expect(mockService.createClient).not.toHaveBeenCalled();
    });

    it('POST /api/v1/clients maps duplicate name conflict to 409 conflict', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService: Partial<WorkflowService> = {
        createClient: vi.fn().mockRejectedValue(new WorkflowClientConflictError()),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const res = await request(app)
        .post('/api/v1/clients')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: 'Acme Enterprise' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('conflict');
    });

    it('PATCH /api/v1/clients/:clientId updates client name and status, validates input, and maps 404/409', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const updatedClient = {
        id: clientId,
        name: 'Acme Global',
        status: 'INACTIVE',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T01:00:00.000Z',
      };
      const mockService: Partial<WorkflowService> = {
        updateClient: vi
          .fn()
          .mockResolvedValueOnce(updatedClient)
          .mockRejectedValueOnce(new WorkflowClientNotFoundError())
          .mockRejectedValueOnce(new WorkflowClientConflictError()),
      };

      const app = createApp({
        workflow: {
          service: mockService as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      // Empty update rejected (400)
      const emptyRes = await request(app)
        .patch(`/api/v1/clients/${clientId}`)
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({});
      expect(emptyRes.status).toBe(400);

      // Invalid UUID rejected (400)
      const badIdRes = await request(app)
        .patch('/api/v1/clients/not-a-uuid')
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ status: 'INACTIVE' });
      expect(badIdRes.status).toBe(400);

      // Valid update (200)
      const okRes = await request(app)
        .patch(`/api/v1/clients/${clientId}`)
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: '  Acme Global ', status: 'INACTIVE' });
      expect(okRes.status).toBe(200);
      expect(okRes.body).toEqual({ client: updatedClient });
      expect(mockService.updateClient).toHaveBeenCalledWith(recruiterPrincipal, clientId, {
        name: 'Acme Global',
        status: 'INACTIVE',
      });

      // Cross-tenant / missing client (404)
      const notFoundRes = await request(app)
        .patch(`/api/v1/clients/${clientId}`)
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ status: 'ACTIVE' });
      expect(notFoundRes.status).toBe(404);

      // Duplicate name conflict (409)
      const conflictRes = await request(app)
        .patch(`/api/v1/clients/${clientId}`)
        .set('Cookie', [`talentlens_session=${rawToken}`])
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', deriveCsrfToken(rawToken))
        .send({ name: 'Existing Client' });
      expect(conflictRes.status).toBe(409);
    });
  });
});
