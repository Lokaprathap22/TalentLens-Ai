import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createRequireRole } from './require-role.js';

function responseWithPrincipal(principal: unknown): Response {
  return {
    locals: { authPrincipal: principal },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('require role middleware', () => {
  it('permits an explicitly allowed recruiter role', () => {
    const next = vi.fn();
    const response = responseWithPrincipal({
      userId: 'user-a',
      organizationId: 'organization-a',
      role: 'RECRUITER',
    });

    createRequireRole(['RECRUITER'])({} as Request, response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('denies a client hiring manager on a recruiter-only route', () => {
    const next = vi.fn();
    const response = responseWithPrincipal({
      userId: 'user-a',
      organizationId: 'organization-a',
      role: 'CLIENT_HIRING_MANAGER',
    });

    createRequireRole(['RECRUITER'])({} as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies a delivery head when recruiter and client roles are allowed', () => {
    const next = vi.fn();
    const response = responseWithPrincipal({
      userId: 'user-a',
      organizationId: 'organization-a',
      role: 'DELIVERY_HEAD',
    });

    createRequireRole(['RECRUITER', 'CLIENT_HIRING_MANAGER'])({} as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 without an authenticated principal', () => {
    const next = vi.fn();
    const response = responseWithPrincipal(undefined);

    createRequireRole(['RECRUITER', 'CLIENT_HIRING_MANAGER'])({} as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores a role supplied in the request object', () => {
    const next = vi.fn();
    const response = responseWithPrincipal({
      userId: 'user-a',
      organizationId: 'organization-a',
      role: 'CLIENT_HIRING_MANAGER',
    });
    const request = { body: { role: 'RECRUITER' }, headers: { role: 'RECRUITER' } };

    createRequireRole(['RECRUITER'])(request as unknown as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
