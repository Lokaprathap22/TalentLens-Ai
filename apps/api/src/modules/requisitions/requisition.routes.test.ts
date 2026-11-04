import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { SessionService } from '../auth/session.service.js';
import { RequisitionNotFoundError, type RequisitionService } from './requisition.service.js';

const rawToken = 'A'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const principal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER' as const,
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
    principal?:
      typeof principal | { userId: string; organizationId: string; role: 'CLIENT_HIRING_MANAGER' };
    getError?: Error;
    updateError?: Error;
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
        role: 'RECRUITER',
      },
      requisitionId,
    );
  });

  it('returns 404 for cross-recruiter update access', async () => {
    const crossRecruiter = {
      userId: 'recruiter-b',
      organizationId: 'organization-a',
      role: 'RECRUITER' as const,
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
});
