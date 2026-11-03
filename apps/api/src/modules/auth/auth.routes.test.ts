import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthService } from './auth.service.js';
import { DEVELOPMENT_SESSION_COOKIE } from './session-cookie.js';
import type { SessionService } from './session.service.js';

const rawToken = 'A'.repeat(43);
const user = {
  userId: 'user-1',
  organizationId: 'organization-1',
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
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user: {
        userId: user.userId,
        organizationId: user.organizationId,
        role: user.role,
      },
    });
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
});
