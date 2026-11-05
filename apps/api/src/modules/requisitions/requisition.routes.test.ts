import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthenticatedUserDto } from '../auth/auth.dto.js';
import type { SessionService } from '../auth/session.service.js';
import {
  RequisitionNotFoundError,
  RequisitionScorecardNotApprovedError,
  RequisitionStatusTransitionError,
  type RequisitionService,
} from './requisition.service.js';

const rawToken = 'A'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const principal: AuthenticatedUserDto = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  organizationName: 'Organization A',
  email: 'recruiter-a@example.com',
  role: 'RECRUITER',
};
const requisition = {
  id: 'requisition-a',
  clientId: 'client-a',
  clientName: 'Client A',
  title: 'Senior Java Developer',
  jdText: 'Build reliable services.',
  status: 'DRAFT' as const,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};

function createTestApp(
  options: {
    principal?: AuthenticatedUserDto;
    getError?: Error;
    updateError?: Error;
    transitionError?: Error;
  } = {},
) {
  const authenticatedPrincipal = options.principal ?? principal;
  const sessionService: Pick<SessionService, 'validateSession'> = {
    validateSession: vi.fn(async (token: string | null | undefined) =>
      token === rawToken ? authenticatedPrincipal : null,
    ),
  };
  const service: RequisitionService = {
    create: vi.fn(async () => requisition),
    list: vi.fn(async () => [requisition]),
    get: vi.fn(async () => {
      if (options.getError) throw options.getError;
      return requisition;
    }),
    update: vi.fn(async () => {
      if (options.updateError) throw options.updateError;
      return requisition;
    }),
    transitionStatus: vi.fn(async (_principal, _id, input) => {
      if (options.transitionError) throw options.transitionError;
      return { ...requisition, status: input.status };
    }),
  };
  return {
    service,
    app: createApp({
      requisitions: {
        service,
        sessionService,
        applicationOrigin: 'http://localhost:5173',
        isProduction: false,
      },
    }),
  };
}

function authorizedRequest(
  app: ReturnType<typeof createApp>,
  method: 'post' | 'patch',
  path: string,
) {
  const testRequest = method === 'post' ? request(app).post(path) : request(app).patch(path);
  return testRequest
    .set('Cookie', `talentlens_session=${rawToken}`)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', deriveCsrfToken(rawToken));
}

describe('requisition routes', () => {
  it('creates a requisition for the authenticated recruiter', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedRequest(app, 'post', '/api/v1/requisitions').send({
      clientId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Senior Java Developer',
      jdText: 'Build reliable services.',
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ requisition });
    expect(service.create).toHaveBeenCalledWith(principal, {
      clientId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Senior Java Developer',
      jdText: 'Build reliable services.',
    });
  });

  it('lists requisitions through the authenticated session', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .get('/api/v1/requisitions')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requisitions: [requisition] });
    expect(service.list).toHaveBeenCalledWith(principal);
  });

  it('rejects unauthenticated list requests', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get('/api/v1/requisitions');

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated list requests with a trailing slash', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get('/api/v1/requisitions/');

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated update requests', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .patch('/api/v1/requisitions/')
      .set('Origin', 'http://localhost:5173')
      .send({ title: 'Updated role' });

    expect(response.status).toBe(401);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects client hiring managers before accessing recruiter routes', async () => {
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
      .get(`/api/v1/requisitions/${requisitionId}`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(403);
    expect(service.get).not.toHaveBeenCalled();
  });

  it('rejects invalid input and does not call the service', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedRequest(app, 'post', '/api/v1/requisitions').send({
      clientId: 'not-a-uuid',
      title: '',
      jdText: '',
      organizationId: 'attacker-organization',
      assignedRecruiterId: 'attacker-recruiter',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects status injection in a valid update request', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedRequest(
      app,
      'patch',
      `/api/v1/requisitions/${requisitionId}`,
    ).send({
      title: 'Updated role',
      status: 'OPEN',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('returns 404 when updating a non-draft requisition', async () => {
    const { app, service } = createTestApp({
      updateError: new RequisitionNotFoundError(),
    });

    const response = await authorizedRequest(
      app,
      'patch',
      `/api/v1/requisitions/${requisitionId}`,
    ).send({ title: 'Updated role' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(service.update).toHaveBeenCalledWith(principal, requisitionId, {
      title: 'Updated role',
    });
  });

  it('returns 404 for cross-recruiter detail access', async () => {
    const { app, service } = createTestApp({
      principal: {
        userId: 'recruiter-b',
        organizationId: 'organization-a',
        organizationName: 'Organization A',
        email: 'recruiter-b@example.com',
        role: 'RECRUITER',
      },
      getError: new RequisitionNotFoundError(),
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(service.get).toHaveBeenCalledWith(
      {
        userId: 'recruiter-b',
        organizationId: 'organization-a',
        organizationName: 'Organization A',
        email: 'recruiter-b@example.com',
        role: 'RECRUITER',
      },
      requisitionId,
    );
  });

  it('returns 404 for cross-organization detail access', async () => {
    const { app, service } = createTestApp({
      principal: {
        userId: 'recruiter-a',
        organizationId: 'organization-b',
        organizationName: 'Organization B',
        email: 'recruiter-a@org-b.example.com',
        role: 'RECRUITER',
      },
      getError: new RequisitionNotFoundError(),
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(service.get).toHaveBeenCalledWith(
      {
        userId: 'recruiter-a',
        organizationId: 'organization-b',
        organizationName: 'Organization B',
        email: 'recruiter-a@org-b.example.com',
        role: 'RECRUITER',
      },
      requisitionId,
    );
  });

  it('returns 404 for cross-recruiter update access', async () => {
    const crossRecruiter: AuthenticatedUserDto = {
      userId: 'recruiter-b',
      organizationId: 'organization-a',
      organizationName: 'Organization A',
      email: 'recruiter-b@example.com',
      role: 'RECRUITER',
    };
    const { app, service } = createTestApp({
      principal: crossRecruiter,
      updateError: new RequisitionNotFoundError(),
    });

    const response = await authorizedRequest(
      app,
      'patch',
      `/api/v1/requisitions/${requisitionId}`,
    ).send({ title: 'Updated role' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
    expect(service.update).toHaveBeenCalledWith(crossRecruiter, requisitionId, {
      title: 'Updated role',
    });
  });

  it('rejects malformed detail IDs before invoking the service', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .get('/api/v1/requisitions/not-a-uuid')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(service.get).not.toHaveBeenCalled();
  });

  it('rejects malformed update IDs before invoking the service', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedRequest(app, 'patch', '/api/v1/requisitions/not-a-uuid').send({
      title: 'Updated role',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('requires CSRF protection for state-changing requests', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .post('/api/v1/requisitions')
      .set('Cookie', `talentlens_session=${rawToken}`)
      .set('Origin', 'http://localhost:5173')
      .send({
        clientId: '00000000-0000-0000-0000-000000000001',
        title: 'Role',
        jdText: 'Description',
      });

    expect(response.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });

  describe('POST /api/v1/requisitions/:id/status (M9.3 Step 1 Part B)', () => {
    it('transitions requisition status for the authenticated recruiter', async () => {
      const { app, service } = createTestApp();

      const response = await authorizedRequest(
        app,
        'post',
        `/api/v1/requisitions/${requisitionId}/status`,
      ).send({ status: 'OPEN' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        requisition: { ...requisition, status: 'OPEN' },
      });
      expect(service.transitionStatus).toHaveBeenCalledWith(principal, requisitionId, {
        status: 'OPEN',
      });
    });

    it('rejects invalid status values and malformed UUIDs with 400', async () => {
      const { app, service } = createTestApp();

      const badUuidRes = await authorizedRequest(
        app,
        'post',
        '/api/v1/requisitions/not-a-uuid/status',
      ).send({ status: 'OPEN' });
      expect(badUuidRes.status).toBe(400);

      for (const badBody of [
        { status: 'DRAFT' },
        { status: 'INVALID' },
        {},
        { status: 'OPEN', extra: true },
      ]) {
        const res = await authorizedRequest(
          app,
          'post',
          `/api/v1/requisitions/${requisitionId}/status`,
        ).send(badBody);
        expect(res.status).toBe(400);
      }

      expect(service.transitionStatus).not.toHaveBeenCalled();
    });

    it('enforces CSRF, Origin, and RECRUITER role on status transitions', async () => {
      const { app, service } = createTestApp();

      const noCsrfRes = await request(app)
        .post(`/api/v1/requisitions/${requisitionId}/status`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', 'http://localhost:5173')
        .send({ status: 'OPEN' });
      expect(noCsrfRes.status).toBe(403);

      const badOriginRes = await request(app)
        .post(`/api/v1/requisitions/${requisitionId}/status`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', 'http://evil.example.com')
        .set('X-CSRF-Token', deriveCsrfToken(rawToken))
        .send({ status: 'OPEN' });
      expect(badOriginRes.status).toBe(403);

      const { app: hmApp } = createTestApp({
        principal: {
          ...principal,
          role: 'CLIENT_HIRING_MANAGER',
        },
      });
      const hmRes = await authorizedRequest(
        hmApp,
        'post',
        `/api/v1/requisitions/${requisitionId}/status`,
      ).send({ status: 'OPEN' });
      expect(hmRes.status).toBe(403);

      expect(service.transitionStatus).not.toHaveBeenCalled();
    });

    it('returns 404 when requisition is missing or outside recruiter scope', async () => {
      const { app } = createTestApp({
        transitionError: new RequisitionNotFoundError(),
      });

      const response = await authorizedRequest(
        app,
        'post',
        `/api/v1/requisitions/${requisitionId}/status`,
      ).send({ status: 'OPEN' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'not_found' });
    });

    it('returns 400 when transition is invalid or DRAFT->OPEN lacks an approved scorecard', async () => {
      const { app: invalidTransitionApp } = createTestApp({
        transitionError: new RequisitionStatusTransitionError(),
      });
      const res1 = await authorizedRequest(
        invalidTransitionApp,
        'post',
        `/api/v1/requisitions/${requisitionId}/status`,
      ).send({ status: 'CLOSED' });
      expect(res1.status).toBe(400);
      expect(res1.body).toEqual({ error: 'invalid_request' });

      const { app: noScorecardApp } = createTestApp({
        transitionError: new RequisitionScorecardNotApprovedError(),
      });
      const res2 = await authorizedRequest(
        noScorecardApp,
        'post',
        `/api/v1/requisitions/${requisitionId}/status`,
      ).send({ status: 'OPEN' });
      expect(res2.status).toBe(400);
      expect(res2.body).toEqual({ error: 'invalid_request' });
    });
  });
});
