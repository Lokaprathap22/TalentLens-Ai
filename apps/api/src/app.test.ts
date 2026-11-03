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
