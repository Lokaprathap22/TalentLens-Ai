import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { GlobalCandidateSummaryDto, ListGlobalCandidatesResponseDto } from './workflow.dto.js';
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

const mockCandidateDto: GlobalCandidateSummaryDto = {
  candidateId: 'cand-1',
  candidateCode: 'CAN-1001',
  createdAt: '2026-11-05T09:00:00.000Z',
  lastActivityAt: '2026-11-05T12:00:00.000Z',
  requisitionId: 'c1000000-0000-4000-8000-000000000001',
  requisitionTitle: 'Staff Backend Engineer',
  clientName: 'Acme Corp',
  resumeDocumentId: 'doc-1',
  resumeFileName: 'resume.pdf',
  parseStatus: 'PARSED',
  currentRole: 'Senior Software Engineer',
  experienceYears: 6.5,
  location: 'Bangalore, India',
  skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
  assessmentId: 'ass-1',
  assessmentStatus: 'COMPLETE',
  overallScore: 85,
  coverage: 0.9,
  isComplete: true,
  criteriaCount: 5,
  criteriaMetCount: 4,
  reviewStatus: 'REVIEWED',
  reviewedAt: '2026-11-05T11:00:00.000Z',
  isShortlisted: true,
  shortlistedAt: '2026-11-05T11:30:00.000Z',
  submissionStatus: 'SUBMITTED',
  submittedAt: '2026-11-05T12:00:00.000Z',
  statusCategory: 'ASSESSED',
};

const mockListResult: ListGlobalCandidatesResponseDto = {
  items: [mockCandidateDto],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

describe('global-candidates.routes: GET /api/v1/candidates', () => {
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

    const response = await request(app).get('/api/v1/candidates');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthenticated');
  });

  it('rejects non-recruiter roles with 403', async () => {
    const sessionService = createMockSessionService(hiringManagerPrincipal);
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
      .get('/api/v1/candidates')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('allows RECRUITER and returns 200 with candidates list', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const listGlobalCandidates = vi.fn().mockResolvedValue(mockListResult);
    const app = createApp({
      workflow: {
        service: {
          listGlobalCandidates,
        } as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .get('/api/v1/candidates')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockListResult);
    expect(listGlobalCandidates).toHaveBeenCalledWith(
      recruiterPrincipal,
      expect.objectContaining({
        page: 1,
        pageSize: 20,
        sortBy: 'activity',
        sortOrder: 'desc',
      }),
    );
  });

  it('parses search, requisitionId, statusCategory, and sorting query parameters', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const listGlobalCandidates = vi.fn().mockResolvedValue(mockListResult);
    const app = createApp({
      workflow: {
        service: {
          listGlobalCandidates,
        } as unknown as WorkflowService,
        sessionService: sessionService as SessionService,
        authorizationService: createMockAuthService() as AuthorizationService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const reqId = 'c1000000-0000-4000-8000-000000000001';
    const response = await request(app)
      .get(
        `/api/v1/candidates?page=2&pageSize=10&search=typescript&requisitionId=${reqId}&statusCategory=ASSESSED&sortBy=score&sortOrder=asc`,
      )
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(listGlobalCandidates).toHaveBeenCalledWith(recruiterPrincipal, {
      page: 2,
      pageSize: 10,
      search: 'typescript',
      requisitionId: reqId,
      statusCategory: 'ASSESSED',
      sortBy: 'score',
      sortOrder: 'asc',
    });
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

    // Invalid page (< 1)
    const res1 = await request(app)
      .get('/api/v1/candidates?page=0')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res1.status).toBe(400);

    // Invalid pageSize (> 100)
    const res2 = await request(app)
      .get('/api/v1/candidates?pageSize=101')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res2.status).toBe(400);

    // Invalid requisitionId (not UUID)
    const res3 = await request(app)
      .get('/api/v1/candidates?requisitionId=not-a-uuid')
      .set('Cookie', `talentlens_session=${rawToken}`);
    expect(res3.status).toBe(400);
  });
});
