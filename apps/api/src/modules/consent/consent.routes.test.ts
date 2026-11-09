import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { SessionService } from '../auth/session.service.js';
import {
  ConsentPolicyUnapprovedError,
  WithdrawalInvalidOrExpiredError,
  type ConsentService,
} from './consent.service.js';

const rawToken = 'A'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const candidateId = '223e4567-e89b-42d3-a456-426614174000';

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

describe('consent routes integration tests', () => {
  const applicationOrigin = 'https://app.talentlens.ai';

  it('rejects invitation creation when unauthenticated', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {} as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .send({ email: 'test@example.com' });

    expect(response.status).toBe(401);
  });

  it('rejects invitation creation when role is not RECRUITER', async () => {
    const sessionService = createMockSessionService(
      hiringManagerPrincipal as unknown as typeof recruiterPrincipal,
    );
    const mockConsentService = {} as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .send({ email: 'test@example.com' });

    expect(response.status).toBe(403);
  });

  it('rejects invitation creation when CSRF token is missing or invalid', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockConsentService = {
      createInvitation: vi.fn(),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const missingCsrfResponse = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .send({ email: 'candidate@example.com' });

    expect(missingCsrfResponse.status).toBe(403);
    expect(missingCsrfResponse.body.error).toBe('request_not_allowed');

    const invalidCsrfResponse = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('x-csrf-token', 'invalid-csrf-token')
      .send({ email: 'candidate@example.com' });

    expect(invalidCsrfResponse.status).toBe(403);
    expect(invalidCsrfResponse.body.error).toBe('request_not_allowed');
    expect(mockConsentService.createInvitation).not.toHaveBeenCalled();
  });

  it('validates email format on invitation creation', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockConsentService = {
      createInvitation: vi.fn(),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
  });

  it('successfully creates invitation for authenticated recruiter', async () => {
    const sessionService = createMockSessionService(recruiterPrincipal);
    const mockConsentService = {
      createInvitation: vi.fn().mockResolvedValue({
        id: 'inv-1',
        candidateId,
        requisitionId,
        email: 'candidate@example.com',
        purpose: 'HIRING_USE',
        status: 'PENDING',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash',
        deliveryStatus: 'SENT',
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/candidates/${candidateId}/consent-invitations`)
      .set('Origin', applicationOrigin)
      .set('Cookie', [`talentlens_session=${rawToken}`])
      .set('x-csrf-token', deriveCsrfToken(rawToken))
      .send({ email: 'candidate@example.com' });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe('inv-1');
    expect(mockConsentService.createInvitation).toHaveBeenCalledWith(
      recruiterPrincipal,
      requisitionId,
      candidateId,
      'candidate@example.com',
    );
  });

  it('inspects notice without authentication (public link scanner safe)', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      inspectNotice: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isExpired: false,
        organizationName: 'Acme Corp',
        requisitionTitle: 'Fullstack Dev',
        policyVersion: '2026-11-v1',
        noticeText: 'Notice body text',
        noticeTextHash: 'hash-abc',
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    // Test GET /consent/inspect returns 404 (tokens in query parameters are strictly forbidden to prevent log leakage)
    const getRes = await request(app)
      .get('/api/v1/consent/inspect')
      .query({ token: 'test-token-1234567890' });

    expect(getRes.status).toBe(404);

    // Test POST /consent/inspect with JSON body succeeds
    const postRes = await request(app)
      .post('/api/v1/consent/inspect')
      .send({ token: 'test-token-1234567890' });

    expect(postRes.status).toBe(200);
    expect(postRes.body.organizationName).toBe('Acme Corp');
  });

  it('accepts consent with confirmed name', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      acceptConsent: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        candidateId,
        requisitionId,
        consentId: 'con-1',
        status: 'ACCEPTED',
        releasedJobCount: 1,
        acceptedAt: new Date().toISOString(),
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app).post('/api/v1/consent/accept').send({
      token: 'test-token-1234567890',
      confirmationName: 'Jane Candidate',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ACCEPTED');
    expect(mockConsentService.acceptConsent).toHaveBeenCalledWith(
      'test-token-1234567890',
      'Jane Candidate',
    );
  });

  it('rejects acceptance with 400 when policy version is not approved', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      acceptConsent: vi
        .fn()
        .mockRejectedValue(new ConsentPolicyUnapprovedError('2026-11-unapproved')),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app).post('/api/v1/consent/accept').send({
      token: 'test-token-1234567890',
      confirmationName: 'Jane Candidate',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('CONSENT_POLICY_UNAPPROVED');
    expect(response.body.message).toContain('2026-11-unapproved');
  });

  it('declines consent', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      declineConsent: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        status: 'DECLINED',
        declinedAt: new Date().toISOString(),
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app).post('/api/v1/consent/decline').send({
      token: 'test-token-1234567890',
      reason: 'Not interested',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DECLINED');
  });

  it('handles withdrawal request with anti-enumeration response', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      requestWithdrawal: vi.fn().mockResolvedValue({
        message:
          'If an active consent record is associated with this email, a verification link has been sent.',
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post('/api/v1/consent/withdraw/request')
      .send({ email: 'candidate@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.message).toContain('verification link has been sent');
  });

  it('confirms withdrawal', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      confirmWithdrawal: vi.fn().mockResolvedValue({
        withdrawalRequestId: 'wreq-1',
        revokedConsentCount: 1,
        heldJobCount: 2,
        status: 'CONFIRMED',
        withdrawnAt: new Date().toISOString(),
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post('/api/v1/consent/withdraw/confirm')
      .send({ token: 'test-token-1234567890' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CONFIRMED');
    expect(response.body.heldJobCount).toBe(2);
  });

  it('handles self-deletion request with anti-enumeration response', async () => {
    const sessionService = createMockSessionService(null);
    const mockConsentService = {
      requestCandidateDeletion: vi.fn().mockResolvedValue({
        message:
          'If an active candidate record is associated with this email, a verification link has been sent.',
      }),
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const response = await request(app)
      .post('/api/v1/consent/deletion/request')
      .send({ email: 'candidate@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.message).toContain('verification link has been sent');
    expect(mockConsentService.requestCandidateDeletion).toHaveBeenCalledWith(
      'candidate@example.com',
      undefined,
    );
  });

  it('confirms candidate deletion and rejects replayed/expired tokens with 400 WITHDRAWAL_INVALID_OR_EXPIRED', async () => {
    const sessionService = createMockSessionService(null);
    const confirmCandidateDeletion = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'COMPLETED',
        candidateId,
        deletionRequestId: 'del-req-1',
      })
      .mockRejectedValueOnce(new WithdrawalInvalidOrExpiredError());

    const mockConsentService = {
      confirmCandidateDeletion,
    } as unknown as ConsentService;

    const app = createApp({
      consent: {
        consentService: mockConsentService,
        sessionService,
        applicationOrigin,
        isProduction: false,
      },
    });

    const first = await request(app)
      .post('/api/v1/consent/deletion/confirm')
      .send({ token: 'valid-deletion-token-123456' });

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('COMPLETED');
    expect(first.body.candidateId).toBe(candidateId);

    const replay = await request(app)
      .post('/api/v1/consent/deletion/confirm')
      .send({ token: 'valid-deletion-token-123456' });

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('WITHDRAWAL_INVALID_OR_EXPIRED');
  });
});
