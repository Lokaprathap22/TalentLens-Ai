import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import {
  WorkflowClientMemberConflictError,
  WorkflowClientNotFoundError,
  type WorkflowService,
} from './workflow.service.js';

const rawToken = 'B'.repeat(43);
const clientId = '323e4567-e89b-42d3-a456-426614174000';

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

describe('client-members.routes', () => {
  const applicationOrigin = 'https://app.talentlens.ai';
  const validCsrf = deriveCsrfToken(rawToken);

  describe('GET /api/v1/clients/:clientId', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const sessionService = createMockSessionService(null);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app).get(`/api/v1/clients/${clientId}`);
      expect(response.status).toBe(401);
    });

    it('rejects invalid client UUID with 400', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .get('/api/v1/clients/invalid-uuid')
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('returns client details for authorized recruiter', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        getClient: vi.fn().mockResolvedValue({
          id: clientId,
          name: 'Acme Corp',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as WorkflowService;

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
        .get(`/api/v1/clients/${clientId}`)
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(200);
      expect(response.body.client.name).toBe('Acme Corp');
      expect(mockService.getClient).toHaveBeenCalledWith(recruiterPrincipal, clientId);
    });

    it('returns 404 when client is not found', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        getClient: vi.fn().mockRejectedValue(new WorkflowClientNotFoundError('Client not found')),
      } as unknown as WorkflowService;

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
        .get(`/api/v1/clients/${clientId}`)
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });
  });

  describe('GET /api/v1/clients/:clientId/members', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const sessionService = createMockSessionService(null);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app).get(`/api/v1/clients/${clientId}/members`);
      expect(response.status).toBe(401);
    });

    it('rejects client hiring managers with 403', async () => {
      const sessionService = createMockSessionService(hiringManagerPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .get(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(403);
    });

    it('rejects invalid client UUID with 400', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .get('/api/v1/clients/not-a-uuid/members')
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(400);
    });

    it('returns members list for authorized recruiter', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockMembers = [
        {
          id: 'mem-1',
          membershipId: 'mem-1',
          userId: 'usr-1',
          clientId,
          organizationId: 'org-uuid-1',
          name: 'Jane Doe',
          email: 'jane@acme.com',
          role: 'CLIENT_HIRING_MANAGER',
          membershipStatus: 'ACTIVE',
          userStatus: 'INVITED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const mockService = {
        listClientMembers: vi.fn().mockResolvedValue(mockMembers),
      } as unknown as WorkflowService;

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
        .get(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(200);
      expect(response.body.members).toHaveLength(1);
      expect(response.body.members[0].email).toBe('jane@acme.com');
      expect(mockService.listClientMembers).toHaveBeenCalledWith(recruiterPrincipal, clientId);
    });

    it('returns 404 when client is not found or in different organization', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        listClientMembers: vi.fn().mockRejectedValue(new WorkflowClientNotFoundError()),
      } as unknown as WorkflowService;

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
        .get(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/clients/:clientId/members and /invite', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const sessionService = createMockSessionService(null);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .send({ email: 'new@example.com' });

      expect(response.status).toBe(401);
    });

    it('rejects client hiring managers from inviting members with 403', async () => {
      const sessionService = createMockSessionService(hiringManagerPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      const response = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'new@example.com' });

      expect(response.status).toBe(403);
    });

    it('enforces Origin and CSRF protection', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      // Missing origin
      const resNoOrigin = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'new@example.com' });
      expect(resNoOrigin.status).toBe(403);

      // Invalid CSRF
      const resBadCsrf = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', 'wrong-csrf-token')
        .send({ email: 'new@example.com' });
      expect(resBadCsrf.status).toBe(403);
    });

    it('validates email and name body schema with 400', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const app = createApp({
        workflow: {
          service: {} as WorkflowService,
          sessionService,
          authorizationService: createMockAuthService(),
          applicationOrigin,
          isProduction: false,
        },
      });

      // Missing email
      const res1 = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({});
      expect(res1.status).toBe(400);

      // Invalid email
      const res2 = await request(app)
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'not-an-email' });
      expect(res2.status).toBe(400);
    });

    it('handles existing account role conflict with 409', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        inviteClientMember: vi
          .fn()
          .mockRejectedValue(
            new WorkflowClientMemberConflictError(
              'A user with this email already exists as a recruiter or delivery head in your organization.',
              'role_conflict',
            ),
          ),
      } as unknown as WorkflowService;

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
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'existing-recruiter@example.com' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('role_conflict');
    });

    it('handles duplicate membership conflict with 409', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        inviteClientMember: vi
          .fn()
          .mockRejectedValue(
            new WorkflowClientMemberConflictError(
              'A member with this email address already exists for this client.',
              'duplicate_membership',
            ),
          ),
      } as unknown as WorkflowService;

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
        .post(`/api/v1/clients/${clientId}/members/invite`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'already-member@example.com' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('duplicate_membership');
    });

    it('handles duplicate invitation conflict with 409', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const mockService = {
        inviteClientMember: vi
          .fn()
          .mockRejectedValue(
            new WorkflowClientMemberConflictError(
              'An invitation is already pending for this email address with this client.',
              'duplicate_invitation',
            ),
          ),
      } as unknown as WorkflowService;

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
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({ email: 'pending-invite@example.com' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('duplicate_invitation');
    });

    it('successfully invites client hiring manager and returns 201 without leaking raw token', async () => {
      const sessionService = createMockSessionService(recruiterPrincipal);
      const createdMember = {
        id: 'mem-new',
        membershipId: 'mem-new',
        userId: 'usr-new',
        clientId,
        organizationId: 'org-uuid-1',
        name: 'Alex Rivera',
        email: 'alex.rivera@client.com',
        role: 'CLIENT_HIRING_MANAGER',
        membershipStatus: 'ACTIVE',
        userStatus: 'INVITED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockService = {
        inviteClientMember: vi.fn().mockResolvedValue(createdMember),
      } as unknown as WorkflowService;

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
        .post(`/api/v1/clients/${clientId}/members`)
        .set('Cookie', `talentlens_session=${rawToken}`)
        .set('Origin', applicationOrigin)
        .set('x-csrf-token', validCsrf)
        .send({
          email: 'alex.rivera@client.com',
          name: 'Alex Rivera',
        });

      expect(response.status).toBe(201);
      expect(response.body.member.email).toBe('alex.rivera@client.com');
      expect(response.body.member.userStatus).toBe('INVITED');
      // Crucial security invariant: raw token must NEVER be returned
      expect(response.body.token).toBeUndefined();
      expect(response.body.member.token).toBeUndefined();
      expect(response.body.member.tokenHash).toBeUndefined();
      expect(response.body.member.passwordHash).toBeUndefined();

      expect(mockService.inviteClientMember).toHaveBeenCalledWith(recruiterPrincipal, clientId, {
        email: 'alex.rivera@client.com',
        name: 'Alex Rivera',
      });
    });
  });
});
