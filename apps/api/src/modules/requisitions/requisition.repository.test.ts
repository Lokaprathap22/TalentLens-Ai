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

  describe('transitionStatus', () => {
    function makeRecord(status: 'DRAFT' | 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED') {
      return {
        id: 'requisition-a',
        organizationId: 'organization-a',
        clientId: 'client-a',
        title: 'Role',
        jdText: 'Description',
        status,
        createdById: 'recruiter-a',
        assignedRecruiterId: 'recruiter-a',
        createdAt: new Date('2026-11-05T00:00:00.000Z'),
        updatedAt: new Date('2026-11-05T00:00:00.000Z'),
        client: { id: 'client-a', name: 'Client A' },
      };
    }

    it('enforces row lock, approved scorecard check, conditional update, and audit write for DRAFT -> OPEN', async () => {
      const $queryRaw = vi.fn(async () => []);
      const requisition = {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(makeRecord('DRAFT'))
          .mockResolvedValueOnce(makeRecord('OPEN')),
        updateMany: vi.fn(async () => ({ count: 1 })),
      };
      const scorecardVersion = {
        findFirst: vi.fn(async () => ({ id: 'scorecard-approved-1' })),
      };
      const auditLog = {
        create: vi.fn(async () => undefined),
      };
      const tx = {
        $queryRaw,
        requisition,
        scorecardVersion,
        auditLog,
      };
      const database = {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      } as unknown as Parameters<typeof createRequisitionRepository>[0];

      const repository = createRequisitionRepository(database);
      const result = await repository.transitionStatus(principal, 'requisition-a', 'OPEN');

      expect(result.status).toBe('ok');
      expect($queryRaw).toHaveBeenCalled();
      expect(scorecardVersion.findFirst).toHaveBeenCalledWith({
        where: {
          requisitionId: 'requisition-a',
          organizationId: 'organization-a',
          status: 'APPROVED',
        },
        select: { id: true },
      });
      expect(requisition.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'requisition-a',
          organizationId: 'organization-a',
          assignedRecruiterId: 'recruiter-a',
          status: 'DRAFT',
        },
        data: { status: 'OPEN' },
      });
      expect(auditLog.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'organization-a',
          actorId: 'recruiter-a',
          action: 'REQUISITION_STATUS_TRANSITIONED',
          resourceType: 'Requisition',
          resourceId: 'requisition-a',
          requisitionId: 'requisition-a',
          clientId: 'client-a',
          metadataJson: {
            fromStatus: 'DRAFT',
            toStatus: 'OPEN',
          },
        },
      });
    });

    it('rejects DRAFT -> OPEN when no approved scorecard exists and does not mutate or audit', async () => {
      const requisition = {
        findFirst: vi.fn().mockResolvedValueOnce(makeRecord('DRAFT')),
        updateMany: vi.fn(),
      };
      const scorecardVersion = {
        findFirst: vi.fn(async () => null),
      };
      const auditLog = {
        create: vi.fn(),
      };
      const tx = {
        $queryRaw: vi.fn(async () => []),
        requisition,
        scorecardVersion,
        auditLog,
      };
      const database = {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      } as unknown as Parameters<typeof createRequisitionRepository>[0];

      const repository = createRequisitionRepository(database);
      const result = await repository.transitionStatus(principal, 'requisition-a', 'OPEN');

      expect(result).toEqual({ status: 'scorecard_not_approved' });
      expect(requisition.updateMany).not.toHaveBeenCalled();
      expect(auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects invalid transitions and stale concurrent state without writing audit logs', async () => {
      const requisition = {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(makeRecord('CLOSED'))
          .mockResolvedValueOnce(makeRecord('OPEN')),
        updateMany: vi.fn(async () => ({ count: 0 })), // simulates concurrent state change
      };
      const auditLog = {
        create: vi.fn(),
      };
      const tx = {
        $queryRaw: vi.fn(async () => []),
        requisition,
        auditLog,
      };
      const database = {
        $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      } as unknown as Parameters<typeof createRequisitionRepository>[0];

      const repository = createRequisitionRepository(database);

      // Prohibited transition from CLOSED
      const closedResult = await repository.transitionStatus(principal, 'requisition-a', 'OPEN');
      expect(closedResult).toEqual({
        status: 'invalid_transition',
        currentStatus: 'CLOSED',
      });

      // Stale concurrent updateMany (count: 0)
      const staleResult = await repository.transitionStatus(principal, 'requisition-a', 'PAUSED');
      expect(staleResult).toEqual({
        status: 'invalid_transition',
        currentStatus: 'OPEN',
      });
      expect(auditLog.create).not.toHaveBeenCalled();
    });
  });
});
