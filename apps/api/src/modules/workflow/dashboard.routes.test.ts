import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { ClientDashboardSummaryDto, RecruiterDashboardSummaryDto } from './workflow.dto.js';
import type { WorkflowService } from './workflow.service.js';

const rawToken = 'A'.repeat(43);

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

const deliveryHeadPrincipal: AuthenticatedPrincipal = {
  userId: 'dh-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'DELIVERY_HEAD' as unknown as AuthenticatedPrincipal['role'],
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
    authorizeClientMembership: vi.fn().mockResolvedValue(null),
  };
}

const mockRecruiterSummary: RecruiterDashboardSummaryDto = {
  role: 'RECRUITER',
  generatedAt: '2026-11-08T12:00:00.000Z',
  metrics: {
    totalActiveRequisitions: 3,
    requisitionsRequiringAttention: 2,
    candidatesInPipeline: 15,
    candidatesAwaitingAssessment: 4,
    candidatesAwaitingReview: 5,
    pendingClientDecisions: 2,
    upcomingConfirmedInterviews: 1,
  },
  pipelineStages: [
    { key: 'intake', label: 'Intake & parsing', count: 4, hint: 'Awaiting text extraction' },
    { key: 'assessed', label: 'Assessed', count: 8, hint: 'Scored against scorecard' },
    { key: 'review', label: 'Recruiter review', count: 5, hint: 'Reviewed, pending shortlist' },
    { key: 'shortlisted', label: 'Shortlisted', count: 3, hint: 'Approved for submission' },
    { key: 'client', label: 'With client', count: 2, hint: 'Submitted for client review' },
    { key: 'interview', label: 'Interviewing', count: 1, hint: 'Proposed or confirmed' },
  ],
  recentRequisitions: [
    {
      id: 'req-1',
      title: 'Senior Backend Engineer',
      clientName: 'Acme Corp',
      status: 'OPEN',
      candidatesCount: 10,
      awaitingReviewCount: 3,
      withClientCount: 2,
      updatedAt: '2026-11-08T11:00:00.000Z',
    },
  ],
  reviewQueue: [
    {
      candidateId: 'cand-1',
      requisitionId: 'req-1',
      candidateCode: 'CAN-1001',
      requisitionTitle: 'Senior Backend Engineer',
      assessmentStatus: 'COMPLETE',
      score: 88,
      coverage: 92,
      consent: 'ACTIVE',
      lastActivityAt: '2026-11-08T11:30:00.000Z',
    },
  ],
  upcomingInterviews: [],
  recentActivity: [
    {
      id: 'act-1',
      kind: 'submitted',
      summary: 'CAN-1001 submitted to client for Senior Backend Engineer',
      actor: 'Recruiter',
      createdAt: '2026-11-08T11:45:00.000Z',
    },
  ],
};

const mockClientSummary: ClientDashboardSummaryDto = {
  role: 'CLIENT_HIRING_MANAGER',
  generatedAt: '2026-11-08T12:00:00.000Z',
  metrics: {
    pendingCandidateReviews: 2,
    submittedAwaitingDecisions: 2,
    upcomingConfirmedInterviews: 1,
    recentDecisionsCount: 1,
    activeRequisitionsCount: 1,
  },
  pendingReviews: [
    {
      submissionId: 'sub-1',
      candidateCode: 'CAN-1001',
      requisitionId: 'req-1',
      requisitionTitle: 'Senior Backend Engineer',
      clientId: 'client-1',
      clientName: 'Acme Corp',
      submittedAt: '2026-11-08T10:00:00.000Z',
      advisoryScore: 88,
      criteriaCount: 5,
      status: 'SUBMITTED',
    },
  ],
  upcomingInterviews: [],
  recentDecisions: [
    {
      id: 'dec-1',
      decision: 'SHORTLIST',
      reason: 'Strong match on distributed systems',
      candidateCode: 'CAN-1000',
      requisitionTitle: 'Senior Backend Engineer',
      createdAt: '2026-11-08T09:00:00.000Z',
    },
  ],
  activeRequisitions: [
    {
      id: 'req-1',
      title: 'Senior Backend Engineer',
      clientId: 'client-1',
      clientName: 'Acme Corp',
      status: 'OPEN',
      activeSubmissionsCount: 2,
      interviewsCount: 1,
    },
  ],
  recentActivity: [
    {
      id: 'act-2',
      kind: 'client_shortlisted',
      summary: 'CAN-1000 shortlisted by client for Senior Backend Engineer',
      actor: 'Client Hiring Manager',
      createdAt: '2026-11-08T09:00:00.000Z',
    },
  ],
};

function createWorkflowServiceMock(overrides: Partial<WorkflowService> = {}): WorkflowService {
  return {
    listCandidatesForRequisition: vi.fn(),
    getCandidateDetail: vi.fn(),
    recordCandidateReview: vi.fn(),
    recordShortlist: vi.fn(),
    submitCandidateToClient: vi.fn(),
    listSubmissionsForRequisition: vi.fn(),
    getSubmissionForRequisition: vi.fn(),
    listSubmissionsForClient: vi.fn(),
    getSubmissionForClient: vi.fn(),
    recordClientFeedback: vi.fn(),
    recordClientInterviewProposal: vi.fn(),
    respondToInterview: vi.fn(),
    respondToInterviewAsClient: vi.fn(),
    listAuthorizedClients: vi.fn(),
    createClient: vi.fn(),
    updateClient: vi.fn(),
    getClient: vi.fn(),
    listClientMembers: vi.fn(),
    inviteClientMember: vi.fn(),
    getCandidateTimeline: vi.fn(),
    listGlobalCandidates: vi.fn(),
    listInterviews: vi.fn(),
    getDashboardSummary: vi.fn().mockResolvedValue(mockRecruiterSummary),
    ...overrides,
  };
}

describe('GET /api/v1/dashboard/summary routes', () => {
  it('1. returns 401 when no session cookie is provided', async () => {
    const sessionService = createMockSessionService(null);
    const authService = createMockAuthService();
    const workflowService = createWorkflowServiceMock();

    const app = createApp({
      workflow: {
        service: workflowService,
        sessionService: sessionService as unknown as SessionService,
        authorizationService: authService as unknown as AuthorizationService,
        applicationOrigin: 'http://localhost:3000',
        isProduction: false,
      },
    });

    const res = await request(app).get('/api/v1/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('2. returns 403 when role is not RECRUITER or CLIENT_HIRING_MANAGER', async () => {
    const sessionService = createMockSessionService(deliveryHeadPrincipal);
    const authService = createMockAuthService();
    const workflowService = createWorkflowServiceMock();

    const app = createApp({
      workflow: {
        service: workflowService,
        sessionService: sessionService as unknown as SessionService,
        authorizationService: authService as unknown as AuthorizationService,
        applicationOrigin: 'http://localhost:3000',
        isProduction: false,
      },
    });

    const res = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('3. returns 200 with recruiter summary for RECRUITER', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const authService = createMockAuthService();
    const workflowService = createWorkflowServiceMock({
      getDashboardSummary: vi.fn().mockResolvedValue(mockRecruiterSummary),
    });

    const app = createApp({
      workflow: {
        service: workflowService,
        sessionService: sessionService as unknown as SessionService,
        authorizationService: authService as unknown as AuthorizationService,
        applicationOrigin: 'http://localhost:3000',
        isProduction: false,
      },
    });

    const res = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('RECRUITER');
    expect(res.body.metrics.totalActiveRequisitions).toBe(3);
    expect(res.body.pipelineStages).toHaveLength(6);
    expect(res.body.recentRequisitions).toHaveLength(1);
    expect(res.body.reviewQueue).toHaveLength(1);
    expect(res.body.recentActivity).toHaveLength(1);
  });

  it('4. returns 200 with client summary for CLIENT_HIRING_MANAGER', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const authService = createMockAuthService();
    const workflowService = createWorkflowServiceMock({
      getDashboardSummary: vi.fn().mockResolvedValue(mockClientSummary),
    });

    const app = createApp({
      workflow: {
        service: workflowService,
        sessionService: sessionService as unknown as SessionService,
        authorizationService: authService as unknown as AuthorizationService,
        applicationOrigin: 'http://localhost:3000',
        isProduction: false,
      },
    });

    const res = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Cookie', [`talentlens_session=${rawToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('CLIENT_HIRING_MANAGER');
    expect(res.body.metrics.pendingCandidateReviews).toBe(2);
    expect(res.body.pendingReviews).toHaveLength(1);
    expect(res.body.pendingReviews[0].candidateCode).toBe('CAN-1001');
    expect(res.body.recentDecisions).toHaveLength(1);
    expect(res.body.activeRequisitions).toHaveLength(1);
    expect(res.body.recentActivity).toHaveLength(1);
  });
});
