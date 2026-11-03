import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  AuthorizationRepository,
  ClientMembershipAccess,
  SubmissionAccess,
} from './authorization.repository.js';
import {
  AuthorizationDeniedError,
  AuthorizedResourceNotFoundError,
  createAuthorizationService,
} from './authorization.service.js';

const recruiter: AuthenticatedPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER',
};

const clientManager: AuthenticatedPrincipal = {
  userId: 'manager-a',
  organizationId: 'organization-a',
  role: 'CLIENT_HIRING_MANAGER',
};

const activeMembership: ClientMembershipAccess = {
  id: 'membership-a',
  clientId: 'client-a',
  userId: 'manager-a',
  organizationId: 'organization-a',
  role: 'CLIENT_HIRING_MANAGER',
};

const submittedCandidate: SubmissionAccess = {
  id: 'submission-a',
  clientId: 'client-a',
  organizationId: 'organization-a',
};

function createService(
  membership: ClientMembershipAccess | null = activeMembership,
  submission: SubmissionAccess | null = submittedCandidate,
) {
  const repository: AuthorizationRepository = {
    findActiveClientMembership: vi.fn(async () => membership),
    findSubmission: vi.fn(async () => submission),
  };
  return {
    repository,
    service: createAuthorizationService({ repository }),
  };
}

describe('authorization service', () => {
  it('accepts an active membership using the authenticated principal', async () => {
    const { repository, service } = createService();

    await expect(service.authorizeClientMembership(clientManager, 'client-a')).resolves.toEqual({
      principal: clientManager,
      clientId: 'client-a',
      membershipId: 'membership-a',
      membershipRole: 'CLIENT_HIRING_MANAGER',
    });
    expect(repository.findActiveClientMembership).toHaveBeenCalledWith(clientManager, 'client-a');
  });

  it.each([
    ['missing membership', null],
    ['membership for another client', { ...activeMembership, clientId: 'client-b' }],
    [
      'membership for another organization',
      { ...activeMembership, organizationId: 'organization-b' },
    ],
    ['membership for another user', { ...activeMembership, userId: 'manager-b' }],
  ])('%s is denied', async (_label, membership) => {
    const { service } = createService(membership);

    await expect(
      service.authorizeClientMembership(clientManager, 'client-a'),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('authorizes a submitted resource only after membership authorization', async () => {
    const { repository, service } = createService();

    await expect(
      service.authorizeSubmission(clientManager, 'client-a', 'submission-a'),
    ).resolves.toMatchObject({
      clientId: 'client-a',
      membershipId: 'membership-a',
      submissionId: 'submission-a',
    });
    expect(repository.findSubmission).toHaveBeenCalledWith(
      clientManager,
      'client-a',
      'submission-a',
    );
  });

  it.each([
    ['missing submission', null],
    ['submission for another client', { ...submittedCandidate, clientId: 'client-b' }],
    [
      'submission for another organization',
      { ...submittedCandidate, organizationId: 'organization-b' },
    ],
  ])('%s is not disclosed', async (_label, submission) => {
    const { service } = createService(activeMembership, submission);

    await expect(
      service.authorizeSubmission(clientManager, 'client-a', 'submission-a'),
    ).rejects.toBeInstanceOf(AuthorizedResourceNotFoundError);
  });

  it('does not authorize a recruiter through client membership context', async () => {
    const { service } = createService();

    await expect(
      service.authorizeSubmission(recruiter, 'client-a', 'submission-a'),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });
});
