import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import {
  CurrentPasswordIncorrectError,
  InvalidTokenError,
  type AuthService,
} from './auth.service.js';
import { DEVELOPMENT_SESSION_COOKIE } from './session-cookie.js';
import type { SessionService } from './session.service.js';

const rawToken = 'A'.repeat(43);
const user = {
  userId: 'user-1',
  organizationId: 'organization-1',
  organizationName: 'TalentLens',
  name: 'Alex Recruiter',
  email: 'recruiter@example.com',
  role: 'RECRUITER' as const,
};

function createAuthFakes() {
  let valid = true;
  const revokeSession = vi.fn(async () => {
    valid = false;
  });
  const sessionService: Pick<SessionService, 'validateSession' | 'revokeSession'> = {
    validateSession: vi.fn(async (token: string | null | undefined) =>
      valid && token === rawToken
        ? {
            userId: user.userId,
            organizationId: user.organizationId,
            organizationName: user.organizationName,
            name: user.name,
            email: user.email,
            role: user.role,
          }
        : null,
    ),
    revokeSession,
  };
  const authService: AuthService = {
    login: vi.fn(async () => ({
      token: rawToken,
      expiresAt: new Date('2026-11-04T07:33:39.684Z'),
      user,
    })),
    activate: vi.fn(async (token: string, _password: string) => {
      if (token.includes('bad-token')) throw new InvalidTokenError('Invalid or expired token');
      return {
        token: rawToken,
        expiresAt: new Date('2026-11-04T07:33:39.684Z'),
        user,
      };
    }),
    changePassword: vi.fn(async (_userId: string, currentPassword: string) => {
      if (currentPassword === 'wrong') throw new CurrentPasswordIncorrectError();
    }),
    requestPasswordReset: vi.fn(async () => {}),
    confirmPasswordReset: vi.fn(async (token: string) => {
      if (token.includes('bad-token')) throw new InvalidTokenError('Invalid or expired token');
    }),
    updateProfile: vi.fn(async (_userId: string, name: string) => ({
      ...user,
      name,
    })),
  };

  return { authService, sessionService, revokeSession };
}

function createTestApp() {
  const fakes = createAuthFakes();
  return {
    ...fakes,
    app: createApp({
      auth: {
        authService: fakes.authService,
        sessionService: fakes.sessionService,
        applicationOrigin: 'http://localhost:5173',
        isProduction: false,
        loginRateLimiter: (_request, _response, next) => next(),
      },
    }),
  };
}

describe('HTTP authentication layer', () => {
  it('rejects invalid login input and accepts a valid JSON login', async () => {
    const { app, authService } = createTestApp();
    const invalid = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ organization: '', email: 'bad', password: '' });
    expect(invalid.status).toBe(400);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({
        organization: 'TalentLens',
        email: 'Recruiter@Example.com',
        password: 'password',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user });
    expect(response.body).not.toHaveProperty('token');
    expect(response.headers['set-cookie']?.[0]).toContain(
      `${DEVELOPMENT_SESSION_COOKIE}=${rawToken}`,
    );
    expect(authService.login).toHaveBeenCalledWith(
      'TalentLens',
      'Recruiter@Example.com',
      'password',
    );
  });

  it('requires same-origin JSON login and uses generic authentication errors', async () => {
    const { app, authService } = createTestApp();
    vi.mocked(authService.login).mockRejectedValueOnce(new Error('database details'));

    const crossOrigin = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ organization: 'TalentLens', email: 'a@b.com', password: 'x' });
    expect(crossOrigin.status).toBe(403);

    const unavailable = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ organization: 'TalentLens', email: 'a@b.com', password: 'x' });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).not.toContain('database details');
  });

  it('uses the secure __Host cookie in production', async () => {
    const fakes = createAuthFakes();
    const app = createApp({
      auth: {
        authService: fakes.authService,
        sessionService: fakes.sessionService,
        applicationOrigin: 'https://app.example.com',
        isProduction: true,
        loginRateLimiter: (_request, _response, next) => next(),
      },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://app.example.com')
      .send({ organization: 'TalentLens', email: 'a@b.com', password: 'x' });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']?.[0]).toContain('__Host-talentlens_session=');
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(response.headers['set-cookie']?.[0]).toContain('Secure');
    expect(response.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']?.[0]).toContain('Path=/');
    expect(response.headers['set-cookie']?.[0]).not.toContain('Domain=');
  });

  it('protects me and csrf endpoints with the session cookie', async () => {
    const { app } = createTestApp();
    const missing = await request(app).get('/api/v1/auth/me');
    expect(missing.status).toBe(401);

    const cookie = `${DEVELOPMENT_SESSION_COOKIE}=${rawToken}`;
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({
        organization: 'TalentLens',
        email: 'recruiter@example.com',
        password: 'password',
      });
    expect(login.status).toBe(200);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user });
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');

    const csrf = await request(app).get('/api/v1/auth/csrf').set('Cookie', cookie);
    expect(csrf.status).toBe(200);
    expect(csrf.body).toEqual({ csrfToken: deriveCsrfToken(rawToken) });
  });

  it('requires a valid CSRF token and origin for logout, then remains idempotent', async () => {
    const { app, revokeSession } = createTestApp();
    const cookie = `${DEVELOPMENT_SESSION_COOKIE}=${rawToken}`;
    const csrfToken = deriveCsrfToken(rawToken);

    const missing = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173');
    expect(missing.status).toBe(403);

    const invalid = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', 'invalid');
    expect(invalid.status).toBe(403);

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ status: 'ok' });
    expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect(revokeSession).toHaveBeenCalledWith(rawToken);

    const repeated = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'http://localhost:5173');
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({ status: 'ok' });
  });

  it('handles account activation: rejects bad payload, rejects invalid token, sets session on success', async () => {
    const { app, authService } = createTestApp();

    const badPayload = await request(app)
      .post('/api/v1/auth/activate')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'short', password: '123' });
    expect(badPayload.status).toBe(400);

    const invalidToken = await request(app)
      .post('/api/v1/auth/activate')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'bad-token-value-1234', password: 'new-secure-password' });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.body.error).toBe('invalid_token');

    const success = await request(app)
      .post('/api/v1/auth/activate')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'valid-activation-token-123', password: 'new-secure-password' });
    expect(success.status).toBe(200);
    expect(success.body).toEqual({ user });
    expect(success.headers['set-cookie']?.[0]).toContain(DEVELOPMENT_SESSION_COOKIE);
    expect(authService.activate).toHaveBeenCalledWith(
      'valid-activation-token-123',
      'new-secure-password',
    );
  });

  it('handles password change: requires session & CSRF, rejects wrong current password, updates on valid', async () => {
    const { app, authService } = createTestApp();
    const cookie = `${DEVELOPMENT_SESSION_COOKIE}=${rawToken}`;
    const csrfToken = deriveCsrfToken(rawToken);

    const unauth = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Origin', 'http://localhost:5173')
      .send({ currentPassword: 'pass', newPassword: 'new-secure-password' });
    expect(unauth.status).toBe(401);

    const noCsrf = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .send({ currentPassword: 'pass', newPassword: 'new-secure-password' });
    expect(noCsrf.status).toBe(403);

    const wrongPass = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: 'wrong', newPassword: 'new-secure-password' });
    expect(wrongPass.status).toBe(400);
    expect(wrongPass.body.error).toBe('current_password_incorrect');

    const success = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: 'valid-pass', newPassword: 'brand-new-password-123' });
    expect(success.status).toBe(200);
    expect(success.body.status).toBe('ok');
    expect(authService.changePassword).toHaveBeenCalledWith(
      'user-1',
      'valid-pass',
      'brand-new-password-123',
      rawToken,
    );
  });

  it('handles password reset request: returns generic 200 to prevent account enumeration', async () => {
    const { app, authService } = createTestApp();

    const invalidEmail = await request(app)
      .post('/api/v1/auth/password/reset/request')
      .set('Origin', 'http://localhost:5173')
      .send({ organization: 'TalentLens', email: 'not-an-email' });
    expect(invalidEmail.status).toBe(400);

    const response = await request(app)
      .post('/api/v1/auth/password/reset/request')
      .set('Origin', 'http://localhost:5173')
      .send({ organization: 'TalentLens', email: 'user@example.com' });
    expect(response.status).toBe(200);
    expect(response.body.message).toContain('If an account matches');
    expect(authService.requestPasswordReset).toHaveBeenCalledWith('TalentLens', 'user@example.com');
  });

  it('handles password reset confirmation: rejects invalid token, resets password on valid', async () => {
    const { app, authService } = createTestApp();

    const invalidToken = await request(app)
      .post('/api/v1/auth/password/reset/confirm')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'bad-token-value-1234', newPassword: 'brand-new-password-123' });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.body.error).toBe('invalid_token');

    const success = await request(app)
      .post('/api/v1/auth/password/reset/confirm')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'valid-reset-token-1234', newPassword: 'brand-new-password-123' });
    expect(success.status).toBe(200);
    expect(success.body.status).toBe('ok');
    expect(authService.confirmPasswordReset).toHaveBeenCalledWith(
      'valid-reset-token-1234',
      'brand-new-password-123',
    );
  });

  it('handles profile update: requires session & CSRF, validates input, returns updated user', async () => {
    const { app, authService } = createTestApp();
    const cookie = `${DEVELOPMENT_SESSION_COOKIE}=${rawToken}`;
    const csrfToken = deriveCsrfToken(rawToken);

    const unauth = await request(app)
      .patch('/api/v1/auth/profile')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Alex' });
    expect(unauth.status).toBe(401);

    const emptyName = await request(app)
      .patch('/api/v1/auth/profile')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: '   ' });
    expect(emptyName.status).toBe(400);

    const success = await request(app)
      .patch('/api/v1/auth/profile')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Alexandria Recruiter' });
    expect(success.status).toBe(200);
    expect(success.body.user.name).toBe('Alexandria Recruiter');
    expect(authService.updateProfile).toHaveBeenCalledWith('user-1', 'Alexandria Recruiter');
  });
});
