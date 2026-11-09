import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { healthResponseSchema } from '@talentlens/shared';

import { createApp } from './app.js';
import type { AuthService } from './modules/auth/auth.service.js';
import type { SessionService } from './modules/auth/session.service.js';

describe('GET /api/v1/health', () => {
  it('returns a schema-valid health response', async () => {
    const response = await request(createApp()).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(healthResponseSchema.safeParse(response.body).success).toBe(true);
  });
});

describe('GET /api/v1/health/ready', () => {
  it('returns ready when the database health check succeeds', async () => {
    const response = await request(
      createApp({
        databaseHealthChecker: async () => undefined,
      }),
    ).get('/api/v1/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      database: 'connected',
    });
  });

  it('returns a sanitized unavailable response when the database health check fails', async () => {
    const response = await request(
      createApp({
        databaseHealthChecker: async () => {
          throw new Error('postgresql://secret-user:secret-password@db.example/app');
        },
      }),
    ).get('/api/v1/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'not_ready',
      database: 'unavailable',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-password');
  });
});

describe('API Error Handling and Unmapped Endpoints', () => {
  it('returns clean JSON 404 for unmapped API endpoints without HTML leakage', async () => {
    const response = await request(createApp()).get('/api/v1/nonexistent-route');

    expect(response.status).toBe(404);
    expect(response.header['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'not_found' });
  });

  it('handles malformed JSON request bodies with clean JSON 400 without leaking stack traces', async () => {
    const response = await request(createApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"malformed": invalid_json');

    expect(response.status).toBe(400);
    expect(response.header['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'invalid_json' });
    expect(JSON.stringify(response.body)).not.toContain('SyntaxError');
  });
});

describe('Reverse-proxy trust and rate limiting', () => {
  function createAuthFakes() {
    const sessionService: SessionService = {
      createSession: vi.fn(async () => ({
        token: 'test-token',
        expiresAt: new Date(Date.now() + 3600000),
      })),
      validateSession: vi.fn(async () => null),
      revokeSession: vi.fn(async () => undefined),
      revokeUserSessions: vi.fn(async () => undefined),
      revokeOtherUserSessions: vi.fn(async () => undefined),
    };
    const authService: AuthService = {
      login: vi.fn(async () => {
        throw new Error('invalid_credentials');
      }),
      activate: vi.fn(async () => {
        throw new Error('not_implemented');
      }),
      changePassword: vi.fn(async () => undefined),
      requestPasswordReset: vi.fn(async () => undefined),
      confirmPasswordReset: vi.fn(async () => undefined),
      updateProfile: vi.fn(async () => {
        throw new Error('not_implemented');
      }),
    };
    return { authService, sessionService };
  }

  it('configures trust proxy to 1 by default (single Caddy hop)', () => {
    const app = createApp();
    expect(app.get('trust proxy')).toBe(1);
  });

  it('allows overriding trust proxy configuration', () => {
    const appDisabled = createApp({ trustProxy: false });
    expect(appDisabled.get('trust proxy')).toBe(false);

    const appCustom = createApp({ trustProxy: 2 });
    expect(appCustom.get('trust proxy')).toBe(2);
  });

  it('resolves real client IP from X-Forwarded-For under 1-hop reverse proxy', async () => {
    const app = createApp();
    app.get('/test-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    const response = await request(app).get('/test-ip').set('X-Forwarded-For', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body.ip).toBe('203.0.113.10');
  });

  it('defends against client IP spoofing by taking only the single trusted hop', async () => {
    const app = createApp();
    app.get('/test-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    // Attacker sends forged header '198.51.100.99, 203.0.113.10'
    // Under trust proxy: 1, Express trusts 1 hop from the socket and evaluates req.ip as 203.0.113.10
    const response = await request(app)
      .get('/test-ip')
      .set('X-Forwarded-For', '198.51.100.99, 203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body.ip).toBe('203.0.113.10');
  });

  it('ignores X-Forwarded-For when trust proxy is disabled', async () => {
    const app = createApp({ trustProxy: false });
    app.get('/test-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    const response = await request(app).get('/test-ip').set('X-Forwarded-For', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body.ip).not.toBe('203.0.113.10');
  });

  it('evaluates multi-hop trust proxy correctly using createTrustProxyEvaluator', async () => {
    const { createTrustProxyEvaluator } = await import('./app.js');

    // Evaluator with specific trusted proxy IP and CIDR subnet for 2 hops (Caddy -> Nginx)
    const evaluator = createTrustProxyEvaluator(['10.0.0.5', '172.18.0.0/16'], 2);

    // Loopback peer (e.g. local Nginx/Caddy) is trusted at distance 0 and 1
    expect(evaluator('127.0.0.1', 0)).toBe(true);
    expect(evaluator('::1', 0)).toBe(true);
    expect(evaluator('::ffff:127.0.0.1', 0)).toBe(true);
    expect(evaluator('127.0.0.1', 1)).toBe(true);

    // Explicitly trusted proxy is trusted at distance 0 and 1
    expect(evaluator('10.0.0.5', 0)).toBe(true);
    expect(evaluator('10.0.0.5', 1)).toBe(true);

    // CIDR range matches peer IPs in subnet
    expect(evaluator('172.18.0.9', 0)).toBe(true);
    expect(evaluator('172.18.254.1', 0)).toBe(true);
    expect(evaluator('172.18.0.9', 1)).toBe(true);

    // Peer outside CIDR subnet is NOT trusted
    expect(evaluator('172.19.0.9', 0)).toBe(false);
    expect(evaluator('172.19.0.9', 1)).toBe(false);

    // Untrusted external client IP is NOT trusted at distance 1
    expect(evaluator('203.0.113.10', 1)).toBe(false);

    // Hops at or exceeding maxHops (2) are strictly NOT trusted
    expect(evaluator('127.0.0.1', 2)).toBe(false);
    expect(evaluator('10.0.0.5', 2)).toBe(false);
    expect(evaluator('203.0.113.10', 2)).toBe(false);

    // Multi-hop resolution in createApp (Browser -> Caddy -> Nginx -> Express)
    const appWithEvaluator = createApp({
      trustedProxyIps: ['10.0.0.5', '127.0.0.1'],
      maxProxyHops: 2,
    });
    appWithEvaluator.get('/test-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    // In multi-hop: Caddy (10.0.0.5) appended client IP, Nginx forwarded to Express
    // Header format: <ClientIP>, <CaddyIP>
    const res = await request(appWithEvaluator)
      .get('/test-ip')
      .set('X-Forwarded-For', '203.0.113.50, 10.0.0.5');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.50');

    // Spoofing defense: an attacker sending a prepended fake IP is rejected; real client IP is preserved
    const spoofRes = await request(appWithEvaluator)
      .get('/test-ip')
      .set('X-Forwarded-For', '198.51.100.99, 203.0.113.50, 10.0.0.5');
    expect(spoofRes.status).toBe(200);
    expect(spoofRes.body.ip).toBe('203.0.113.50');
  });

  it('correctly handles production Docker bridge topology (172.28.0.0/16) and rejects spoofing', async () => {
    const { createTrustProxyEvaluator } = await import('./app.js');

    // Production configuration with Docker bridge topology defaults:
    // web: 172.28.0.10, gateway: 172.28.0.1, localhost: 127.0.0.1
    const prodTrustedIps = ['172.28.0.10', '172.28.0.1', '127.0.0.1'];
    const evaluator = createTrustProxyEvaluator(prodTrustedIps, 2);

    // Trusted proxies at distance 0 and 1
    expect(evaluator('172.28.0.10', 0)).toBe(true);
    expect(evaluator('172.28.0.1', 0)).toBe(true);
    expect(evaluator('127.0.0.1', 0)).toBe(true);
    expect(evaluator('172.28.0.10', 1)).toBe(true);
    expect(evaluator('172.28.0.1', 1)).toBe(true);

    // Non-trusted container IP in bridge network is NOT trusted
    expect(evaluator('172.28.0.99', 0)).toBe(false);
    expect(evaluator('172.28.0.99', 1)).toBe(false);

    // Real client IP at distance 1 or 2 is NOT trusted as proxy
    expect(evaluator('198.51.100.42', 1)).toBe(false);
    expect(evaluator('198.51.100.42', 2)).toBe(false);

    const app = createApp({
      trustedProxyIps: prodTrustedIps,
      maxProxyHops: 2,
    });
    app.get('/test-prod-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    // Valid 2-hop flow: External Client (198.51.100.42) -> Caddy Host (172.28.0.1) -> Web Nginx (172.28.0.10) -> API
    // X-Forwarded-For: 198.51.100.42, 172.28.0.1
    const res = await request(app)
      .get('/test-prod-ip')
      .set('X-Forwarded-For', '198.51.100.42, 172.28.0.1');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('198.51.100.42');

    // Spoofed X-Forwarded-For with fake injected client IP
    // Attacker sends: 1.1.1.1, 198.51.100.42, 172.28.0.1
    // Evaluator stops at 198.51.100.42 because it is not in prodTrustedIps
    const spoofRes = await request(app)
      .get('/test-prod-ip')
      .set('X-Forwarded-For', '1.1.1.1, 198.51.100.42, 172.28.0.1');
    expect(spoofRes.status).toBe(200);
    expect(spoofRes.body.ip).toBe('198.51.100.42');
  });

  it('enforces IP-isolated rate limiting and throttles after 10 requests from same client IP', async () => {
    const { authService, sessionService } = createAuthFakes();
    const app = createApp({
      auth: {
        authService,
        sessionService,
        applicationOrigin: 'http://localhost:3000',
        isProduction: false,
      },
    });

    const clientA = '203.0.113.50';
    const clientB = '198.51.100.77';

    // Send 10 requests from client A — none should be 429
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', clientA)
        .set('Content-Type', 'application/json')
        .send({ organization: 'Org', email: 'user@example.com', password: 'bad-password' });
      expect(res.status).not.toBe(429);
    }

    // 11th request from client A must be rate limited with 429
    const blockedRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientA)
      .set('Content-Type', 'application/json')
      .send({ organization: 'Org', email: 'user@example.com', password: 'bad-password' });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body).toEqual({ error: 'too_many_requests' });

    // Client B from a different IP is NOT throttled (proves IP isolation under reverse proxy)
    const clientBRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientB)
      .set('Content-Type', 'application/json')
      .send({ organization: 'Org', email: 'user@example.com', password: 'bad-password' });

    expect(clientBRes.status).not.toBe(429);

    // Attacker attempting to spoof a different client IP by prepending it still maps to clientA
    const spoofAttemptRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', `1.2.3.4, ${clientA}`)
      .set('Content-Type', 'application/json')
      .send({ organization: 'Org', email: 'user@example.com', password: 'bad-password' });

    expect(spoofAttemptRes.status).toBe(429);
  });
});
