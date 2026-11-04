import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { createRequisitionRepository } from './requisition.repository.js';

const principal: AuthenticatedPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER',
};

function createDatabase() {
  const client = { findFirst: vi.fn(async () => ({ id: 'client-a' })) };
  const requisition = {
    create: vi.fn(),
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const database = {
    client,
    requisition,
  } as unknown as Pick<PrismaClient, 'client' | 'requisition'>;
  return { client, requisition, database };
}

describe('requisition repository', () => {
  it('checks active client ownership within the principal organization', async () => {
    const { client, database } = createDatabase();
    const repository = createRequisitionRepository(database);

    await repository.findActiveClient('organization-a', 'client-a');

    expect(client.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'client-a',
        organizationId: 'organization-a',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  });

  it('assigns creation to the authenticated recruiter', async () => {
    const { requisition, database } = createDatabase();
    const record = {
      id: 'requisition-a',
      organizationId: 'organization-a',
      clientId: 'client-a',
      title: 'Role',
      jdText: 'Description',
      status: 'DRAFT',
      createdById: 'recruiter-a',
      assignedRecruiterId: 'recruiter-a',
      createdAt: new Date(),
      updatedAt: new Date(),
      client: { id: 'client-a', name: 'Client A' },
    };
    vi.mocked(requisition.create).mockResolvedValue(record);
    const repository = createRequisitionRepository(database);

    await repository.create(principal, {
      clientId: 'client-a',
      title: 'Role',
      jdText: 'Description',
    });

    expect(requisition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId: 'organization-a',
          clientId: 'client-a',
          title: 'Role',
          jdText: 'Description',
          createdById: 'recruiter-a',
          assignedRecruiterId: 'recruiter-a',
        },
      }),
    );
  });

  it('scopes list, detail, and draft update queries by organization and recruiter', async () => {
    const { requisition, database } = createDatabase();
    const repository = createRequisitionRepository(database);

    await repository.listAssigned('organization-a', 'recruiter-a');
    await repository.findAssigned('organization-a', 'recruiter-a', 'requisition-a');
    await repository.updateDraft('organization-a', 'recruiter-a', 'requisition-a', {
      title: 'Updated',
    });

    expect(requisition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'organization-a', assignedRecruiterId: 'recruiter-a' },
      }),
    );
    expect(requisition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'requisition-a',
          organizationId: 'organization-a',
          assignedRecruiterId: 'recruiter-a',
        },
      }),
    );
    expect(requisition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'requisition-a',
          organizationId: 'organization-a',
          assignedRecruiterId: 'recruiter-a',
          status: 'DRAFT',
        },
      }),
    );
  });
});
