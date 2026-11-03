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
