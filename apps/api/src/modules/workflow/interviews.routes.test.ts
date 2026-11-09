import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { InterviewItemDto, ListInterviewsResponseDto } from './workflow.dto.js';
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

const mockInterviewDto: InterviewItemDto = {
  id: '11111111-1111-4111-8111-111111111111',
  submissionId: '22222222-2222-4222-8222-222222222222',
  requisitionId: '33333333-3333-4333-8333-333333333333',
  requisitionTitle: 'Senior Platform Engineer',
  clientId: '44444444-4444-4444-8444-444444444444',
  clientName: 'Acme Corp',
  candidateId: '55555555-5555-4555-8555-555555555555',
  candidateCode: 'CAN-90210',
  proposerUserId: '66666666-6666-4666-8666-666666666666',
  proposerRole: 'CLIENT_HIRING_MANAGER',
  startAt: '2026-11-12T14:00:00.000Z',
  endAt: '2026-11-12T15:00:00.000Z',
  timezone: 'America/New_York',
  format: 'VIDEO',
  status: 'PROPOSED',
  reason: 'Technical screening',
  expiresAt: '2026-11-11T14:00:00.000Z',
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
  canAccept: true,
  canReject: true,
  canReschedule: true,
  canComplete: false,
};

const mockListResult: ListInterviewsResponseDto = {
  items: [mockInterviewDto],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
  counts: {
    total: 1,
    upcoming: 0,
    pendingAction: 1,
    completed: 0,
    rejected: 0,
  },
};

describe('interviews.routes: GET /api/v1/interviews', () => {
  const applicationOrigin = 'https://app.talentlens.ai';

  it('rejects unauthenticated requests with 401', async () => {
    const sessionService = createMockSessionService(null);
    const app = createApp({
      workflow: {
        service: {} as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app).get('/api/v1/interviews');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthenticated');
  });

  it('rejects unauthorized roles with 403', async () => {
    const sessionService = createMockSessionService(deliveryHeadPrincipal);
    const app = createApp({
      workflow: {
        service: {} as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get('/api/v1/interviews')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('allows RECRUITER to list interviews', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const listInterviews = vi.fn().mockResolvedValue(mockListResult);
    const app = createApp({
      workflow: {
        service: {
          listInterviews,
        } as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get('/api/v1/interviews')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].candidateCode).toBe('CAN-90210');
    expect(response.body.counts.pendingAction).toBe(1);
    expect(listInterviews).toHaveBeenCalledWith(
      recruiterPrincipal,
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it('allows CLIENT_HIRING_MANAGER to list interviews', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
    const listInterviews = vi.fn().mockResolvedValue(mockListResult);
    const app = createApp({
      workflow: {
        service: {
          listInterviews,
        } as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get('/api/v1/interviews')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(listInterviews).toHaveBeenCalledWith(
      hiringManagerPrincipal,
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it('parses and forwards valid query parameters', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const listInterviews = vi.fn().mockResolvedValue(mockListResult);
    const app = createApp({
      workflow: {
        service: {
          listInterviews,
        } as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const clientId = '44444444-4444-4444-8444-444444444444';
    const response = await request(app)
      .get(
        `/api/v1/interviews?page=2&pageSize=10&statusCategory=UPCOMING&search=Acme&clientId=${clientId}&sortBy=createdAt&sortOrder=asc`,
      )
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(listInterviews).toHaveBeenCalledWith(
      recruiterPrincipal,
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        statusCategory: 'UPCOMING',
        search: 'Acme',
        clientId,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      }),
    );
  });

  it('rejects invalid query parameters with 400', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const app = createApp({
      workflow: {
        service: {} as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const res1 = await request(app)
      .get('/api/v1/interviews?page=0')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .get('/api/v1/interviews?clientId=not-a-uuid')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res2.status).toBe(400);

    const res3 = await request(app)
      .get('/api/v1/interviews?status=INVALID_STATUS')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res3.status).toBe(400);
  });
});
