import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../modules/auth/session.service.js';
import type { AuthorizationService } from '../modules/authorization/authorization.service.js';
import { AuthorizationDeniedError } from '../modules/authorization/authorization.service.js';
import { createRequireClientMembership } from './require-client-membership.js';

const principal: AuthenticatedPrincipal = {
  userId: 'manager-a',
  organizationId: 'organization-a',
  role: 'CLIENT_HIRING_MANAGER',
};

function responseWithPrincipal(
  principalValue: AuthenticatedPrincipal | null = principal,
): Response {
  return {
    locals: { authPrincipal: principalValue },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('require client membership middleware', () => {
  it('returns 401 without an authenticated principal', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'> = {
      authorizeClientMembership: vi.fn(),
    };
    const response = responseWithPrincipal(null);
    const next = vi.fn();

    await createRequireClientMembership({ authorizationService })(
      { params: { clientId: 'client-a' } } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'unauthenticated' });
    expect(authorizationService.authorizeClientMembership).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the authenticated principal and route client ID to authorization', async () => {
    const context = {
      principal,
      clientId: 'client-a',
      membershipId: 'membership-a',
      membershipRole: 'CLIENT_HIRING_MANAGER' as const,
    };
    const authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'> = {
      authorizeClientMembership: vi.fn(async () => context),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await createRequireClientMembership({ authorizationService })(
      { params: { clientId: 'client-a' } } as unknown as Request,
      response,
      next,
    );

    expect(authorizationService.authorizeClientMembership).toHaveBeenCalledWith(
      principal,
      'client-a',
    );
    expect(response.locals.authorizationContext).toEqual(context);
    expect(next).toHaveBeenCalledOnce();
  });

  it('denies an absent or inactive membership without revealing details', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'> = {
      authorizeClientMembership: vi.fn(async () => {
        throw new AuthorizationDeniedError();
      }),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await createRequireClientMembership({ authorizationService })(
      { params: { clientId: 'client-a' } } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('handles a missing client route parameter safely', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'> = {
      authorizeClientMembership: vi.fn(),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await expect(
      createRequireClientMembership({ authorizationService })(
        { params: {} } as unknown as Request,
        response,
        next,
      ),
    ).resolves.toBeUndefined();

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(authorizationService.authorizeClientMembership).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
