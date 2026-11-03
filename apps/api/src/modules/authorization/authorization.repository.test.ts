import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { createAuthorizationRepository } from './authorization.repository.js';

const principal: AuthenticatedPrincipal = {
  userId: 'manager-a',
  organizationId: 'organization-a',
  role: 'CLIENT_HIRING_MANAGER',
};

function createDatabase() {
  const clientMembership = {
    findFirst: vi.fn(async () => null),
  };
  const candidateSubmission = {
    findFirst: vi.fn(async () => null),
  };
  const database = {
    clientMembership,
    candidateSubmission,
  } as unknown as Pick<PrismaClient, 'clientMembership' | 'candidateSubmission'>;

  return { clientMembership, candidateSubmission, database };
}

describe('authorization repository', () => {
  it('scopes membership by principal, client, active statuses, and role', async () => {
    const { clientMembership, database } = createDatabase();
    const repository = createAuthorizationRepository(database);

    await repository.findActiveClientMembership(principal, 'client-a');

    expect(clientMembership.findFirst).toHaveBeenCalledWith({
      where: {
        clientId: 'client-a',
        userId: 'manager-a',
        organizationId: 'organization-a',
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        user: { status: 'ACTIVE' },
        client: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        clientId: true,
        userId: true,
        organizationId: true,
        role: true,
      },
    });
  });

  it('scopes submission lookup by organization, client, and submission ID', async () => {
    const { candidateSubmission, database } = createDatabase();
    const repository = createAuthorizationRepository(database);

    await repository.findSubmission(principal, 'client-a', 'submission-a');

    expect(candidateSubmission.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'submission-a',
        clientId: 'client-a',
        organizationId: 'organization-a',
      },
      select: {
        id: true,
        clientId: true,
        organizationId: true,
      },
    });
  });
});
