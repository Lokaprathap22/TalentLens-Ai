import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthenticatedUserDto } from '../auth/auth.dto.js';
import type { SessionService } from '../auth/session.service.js';
import {
  ScorecardInvalidError,
  ScorecardNotFoundError,
  type ScorecardService,
} from './scorecard.service.js';

const token = 'B'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const scorecardId = '123e4567-e89b-42d3-a456-426614174001';
const recruiter: AuthenticatedUserDto = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  organizationName: 'Organization A',
  email: 'recruiter-a@example.com',
  role: 'RECRUITER',
};
const scorecard = {
  id: scorecardId,
  requisitionId,
  version: 1,
  status: 'DRAFT' as const,
  weights: {},
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
  criteria: [],
};

function createTestApp(
  options: {
    principal?: AuthenticatedUserDto;
    getError?: Error;
    updateError?: Error;
    approveError?: Error;
  } = {},
) {
  const principal = options.principal ?? recruiter;
  const sessionService: Pick<SessionService, 'validateSession'> = {
    validateSession: vi.fn(async (value: string | null | undefined) =>
      value === token ? principal : null,
    ),
  };
  const service: ScorecardService = {
    generate: vi.fn(async () => scorecard),
    list: vi.fn(async () => [scorecard]),
    get: vi.fn(async () => {
      if (options.getError) throw options.getError;
      return scorecard;
    }),
    update: vi.fn(async () => {
      if (options.updateError) throw options.updateError;
      return scorecard;
    }),
    approve: vi.fn(async () => {
      if (options.approveError) throw options.approveError;
      return scorecard;
    }),
  };
  return {
    service,
    app: createApp({
      scorecards: {
        service,
        sessionService,
        applicationOrigin: 'http://localhost:5173',
        isProduction: false,
      },
    }),
  };
}

function authorizedPost(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .post(path)
    .set('Cookie', `talentlens_session=${token}`)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', deriveCsrfToken(token));
}

function authorizedPatch(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .patch(path)
    .set('Cookie', `talentlens_session=${token}`)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', deriveCsrfToken(token));
}

describe('scorecard routes', () => {
  it('requires an authenticated recruiter for scorecard listing', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get(`/api/v1/requisitions/${requisitionId}/scorecards`);

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('denies client hiring managers before service access', async () => {
    const { app, service } = createTestApp({
      principal: {
        userId: 'client-manager-a',
        organizationId: 'organization-a',
        organizationName: 'Organization A',
        email: 'client-manager-a@example.com',
        role: 'CLIENT_HIRING_MANAGER',
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/scorecards`)
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects malformed requisition IDs before service access', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get('/api/v1/requisitions/not-a-uuid/scorecards');

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects malformed authenticated requisition IDs before service access', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .get('/api/v1/requisitions/not-a-uuid/scorecards')
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('generates a draft with the authenticated principal and saved requisition ID', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedPost(
      app,
      `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
    ).send({});

    expect(response.status).toBe(201);
    expect(service.generate).toHaveBeenCalledWith(recruiter, requisitionId);
  });

  it('rejects status and approver injection in edits', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
      .set('Cookie', `talentlens_session=${token}`)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', deriveCsrfToken(token))
      .send({ status: 'APPROVED', approvedById: 'attacker' });

    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('returns not found for an inaccessible scorecard', async () => {
    const { app, service } = createTestApp({
      getError: new ScorecardNotFoundError(),
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(404);
    expect(service.get).toHaveBeenCalledWith(recruiter, requisitionId, scorecardId);
  });

  describe('PATCH and approve routes', () => {
    it('updates scorecard criteria when authorized recruiter supplies valid input', async () => {
      const { app, service } = createTestApp();

      const response = await authorizedPatch(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`,
      ).send({
        criteria: [
          {
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(service.update).toHaveBeenCalledWith(
        recruiter,
        requisitionId,
        scorecardId,
        expect.objectContaining({
          criteria: [
            expect.objectContaining({
              label: 'TypeScript',
            }),
          ],
        }),
      );
    });

    it('rejects PATCH with missing CSRF token', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects PATCH with wrong Origin', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://malicious-origin.com')
        .set('X-CSRF-Token', deriveCsrfToken(token))
        .send({
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('approves a scorecard when authorized recruiter supplies valid request', async () => {
      const { app, service } = createTestApp();

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(200);
      expect(service.approve).toHaveBeenCalledWith(recruiter, requisitionId, scorecardId);
    });

    it('rejects approve request with missing CSRF token', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .post(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({});

      expect(response.status).toBe(403);
      expect(service.approve).not.toHaveBeenCalled();
    });

    it('returns 400 when approve service returns ScorecardInvalidError', async () => {
      const { app } = createTestApp({
        approveError: new ScorecardInvalidError(),
      });

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(400);
    });

    it('returns 404 when approve service returns ScorecardNotFoundError', async () => {
      const { app } = createTestApp({
        approveError: new ScorecardNotFoundError(),
      });

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(404);
    });
  });
});
