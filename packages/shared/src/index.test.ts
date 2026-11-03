import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from './index.js';

describe('healthResponseSchema', () => {
  it('accepts a valid API health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'talentlens-api',
      timestamp: '2026-11-03T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a response with an incorrect service', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'wrong-service',
      timestamp: '2026-11-03T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});
