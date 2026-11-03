import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../modules/auth/session.service.js';
import type { AuthorizationService } from '../modules/authorization/authorization.service.js';
import { AuthorizedResourceNotFoundError } from '../modules/authorization/authorization.service.js';
import { createRequireSubmissionAccess } from './require-submission-access.js';

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

describe('require submission access middleware', () => {
  it('returns 401 without an authenticated principal', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeSubmission'> = {
      authorizeSubmission: vi.fn(),
    };
    const response = responseWithPrincipal(null);
    const next = vi.fn();

    await createRequireSubmissionAccess({ authorizationService })(
      { params: { clientId: 'client-a', submissionId: 'submission-a' } } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'unauthenticated' });
    expect(authorizationService.authorizeSubmission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('passes only the route client and submission IDs to authorization', async () => {
    const context = {
      principal,
      clientId: 'client-a',
      membershipId: 'membership-a',
      membershipRole: 'CLIENT_HIRING_MANAGER' as const,
      submissionId: 'submission-a',
    };
    const authorizationService: Pick<AuthorizationService, 'authorizeSubmission'> = {
      authorizeSubmission: vi.fn(async () => context),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await createRequireSubmissionAccess({ authorizationService })(
      {
        params: {
          clientId: 'client-a',
          submissionId: 'submission-a',
          candidateId: 'guessed-candidate',
          membershipId: 'untrusted-membership',
        },
      } as unknown as Request,
      response,
      next,
    );

    expect(authorizationService.authorizeSubmission).toHaveBeenCalledWith(
      principal,
      'client-a',
      'submission-a',
    );
    expect(response.locals.authorizationContext).toEqual(context);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns a generic not-found response when the submission is inaccessible', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeSubmission'> = {
      authorizeSubmission: vi.fn(async () => {
        throw new AuthorizedResourceNotFoundError();
      }),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await createRequireSubmissionAccess({ authorizationService })(
      { params: { clientId: 'client-a', submissionId: 'missing' } } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: 'not_found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('handles a missing client route parameter safely', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeSubmission'> = {
      authorizeSubmission: vi.fn(),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await expect(
      createRequireSubmissionAccess({ authorizationService })(
        { params: { submissionId: 'submission-a' } } as unknown as Request,
        response,
        next,
      ),
    ).resolves.toBeUndefined();

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: 'not_found' });
    expect(authorizationService.authorizeSubmission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('handles a missing submission route parameter safely', async () => {
    const authorizationService: Pick<AuthorizationService, 'authorizeSubmission'> = {
      authorizeSubmission: vi.fn(),
    };
    const response = responseWithPrincipal();
    const next = vi.fn();

    await expect(
      createRequireSubmissionAccess({ authorizationService })(
        { params: { clientId: 'client-a' } } as unknown as Request,
        response,
        next,
      ),
    ).resolves.toBeUndefined();

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: 'not_found' });
    expect(authorizationService.authorizeSubmission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
