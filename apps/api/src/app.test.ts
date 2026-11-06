import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from '@talentlens/shared';

import { createApp } from './app.js';

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
