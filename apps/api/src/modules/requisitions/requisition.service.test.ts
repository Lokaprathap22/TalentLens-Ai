import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  ActiveClient,
  RequisitionRecord,
  RequisitionRepository,
} from './requisition.repository.js';
import {
  RequisitionClientNotFoundError,
  RequisitionNotFoundError,
  RequisitionRoleError,
  RequisitionScorecardNotApprovedError,
  RequisitionStatusTransitionError,
  createRequisitionService,
  isValidRequisitionStatusTransition,
} from './requisition.service.js';
import type { RequisitionStatus } from './requisition.dto.js';

const recruiter: AuthenticatedPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER',
};

const client: ActiveClient = { id: 'client-a' };

const record: RequisitionRecord = {
  id: 'requisition-a',
  organizationId: 'organization-a',
  clientId: 'client-a',
  title: 'Senior Java Developer',
  jdText: 'Build reliable services.',
  status: 'DRAFT',
  createdById: 'recruiter-a',
  assignedRecruiterId: 'recruiter-a',
  createdAt: new Date('2026-11-04T00:00:00.000Z'),
  updatedAt: new Date('2026-11-04T00:00:00.000Z'),
  client: { id: 'client-a', name: 'Client A' },
};

function createService(
  activeClient: ActiveClient | null = client,
  requisition: RequisitionRecord | null = record,
) {
  const repository: RequisitionRepository = {
    findActiveClient: vi.fn(async () => activeClient),
    create: vi.fn(async () => record),
    listAssigned: vi.fn(async () => (requisition ? [requisition] : [])),
    findAssigned: vi.fn(async () => requisition),
    updateDraft: vi.fn(async () => requisition),
    transitionStatus: vi.fn(async (_principal, _id, status) =>
      requisition
        ? { status: 'ok' as const, record: { ...requisition, status } }
        : { status: 'not_found' as const },
    ),
  };
  return { repository, service: createRequisitionService({ repository }) };
}

describe('requisition service', () => {
  it('creates an assigned requisition using principal organization and recruiter IDs', async () => {
    const { repository, service } = createService();

    await expect(
      service.create(recruiter, {
        clientId: 'client-a',
        title: 'Senior Java Developer',
        jdText: 'Build reliable services.',
      }),
    ).resolves.toMatchObject({
      id: 'requisition-a',
      clientId: 'client-a',
      clientName: 'Client A',
      status: 'DRAFT',
    });
    expect(repository.findActiveClient).toHaveBeenCalledWith('organization-a', 'client-a');
    expect(repository.create).toHaveBeenCalledWith(recruiter, {
      clientId: 'client-a',
      title: 'Senior Java Developer',
      jdText: 'Build reliable services.',
    });
  });

  it('rejects inactive or unrelated client associations', async () => {
    const { service, repository } = createService(null);

    await expect(
      service.create(recruiter, {
        clientId: 'client-b',
        title: 'Role',
        jdText: 'Description',
      }),
    ).rejects.toBeInstanceOf(RequisitionClientNotFoundError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('lists only the authenticated recruiter organization and assignment scope', async () => {
    const { service, repository } = createService();

    await service.list(recruiter);

    expect(repository.listAssigned).toHaveBeenCalledWith('organization-a', 'recruiter-a');
  });

  it('denies access when an assigned requisition is not found in scope', async () => {
    const { service, repository } = createService(client, null);

    await expect(service.get(recruiter, 'requisition-other')).rejects.toBeInstanceOf(
      RequisitionNotFoundError,
    );
    expect(repository.findAssigned).toHaveBeenCalledWith(
      'organization-a',
      'recruiter-a',
      'requisition-other',
    );
  });

  it('updates only draft requisitions and never accepts a status field', async () => {
    const { service, repository } = createService();

    await expect(
      service.update(recruiter, 'requisition-a', { title: 'Updated title' }),
    ).resolves.toMatchObject({ title: 'Senior Java Developer' });
    expect(repository.updateDraft).toHaveBeenCalledWith(
      'organization-a',
      'recruiter-a',
      'requisition-a',
      { title: 'Updated title' },
    );
  });

  it('rejects non-recruiter principals', async () => {
    const clientManager: AuthenticatedPrincipal = {
      ...recruiter,
      role: 'CLIENT_HIRING_MANAGER',
    };

    const { service } = createService();
    await expect(service.list(clientManager)).rejects.toBeInstanceOf(RequisitionRoleError);
    await expect(
      service.transitionStatus(clientManager, 'requisition-a', { status: 'OPEN' }),
    ).rejects.toBeInstanceOf(RequisitionRoleError);
  });

  describe('status lifecycle state machine (isValidRequisitionStatusTransition & transitionStatus)', () => {
    it('validates every allowed and prohibited status transition in the state machine', () => {
      const allStatuses: RequisitionStatus[] = ['DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'FILLED'];
      const expectedAllowed = new Set([
        'DRAFT->OPEN',
        'OPEN->PAUSED',
        'OPEN->CLOSED',
        'OPEN->FILLED',
        'PAUSED->OPEN',
        'PAUSED->CLOSED',
        'PAUSED->FILLED',
      ]);

      for (const from of allStatuses) {
        for (const to of allStatuses) {
          const key = `${from}->${to}`;
          expect(isValidRequisitionStatusTransition(from, to)).toBe(expectedAllowed.has(key));
        }
      }
    });

    it('transitions status when repository returns ok', async () => {
      const { service, repository } = createService();
      const result = await service.transitionStatus(recruiter, 'requisition-a', { status: 'OPEN' });
      expect(result.status).toBe('OPEN');
      expect(repository.transitionStatus).toHaveBeenCalledWith(recruiter, 'requisition-a', 'OPEN');
    });

    it('throws RequisitionNotFoundError when repository returns not_found', async () => {
      const { service, repository } = createService();
      vi.mocked(repository.transitionStatus).mockResolvedValueOnce({ status: 'not_found' });

      await expect(
        service.transitionStatus(recruiter, 'requisition-a', { status: 'OPEN' }),
      ).rejects.toBeInstanceOf(RequisitionNotFoundError);
    });

    it('throws RequisitionScorecardNotApprovedError when DRAFT->OPEN lacks approved scorecard', async () => {
      const { service, repository } = createService();
      vi.mocked(repository.transitionStatus).mockResolvedValueOnce({
        status: 'scorecard_not_approved',
      });

      await expect(
        service.transitionStatus(recruiter, 'requisition-a', { status: 'OPEN' }),
      ).rejects.toBeInstanceOf(RequisitionScorecardNotApprovedError);
    });

    it('throws RequisitionStatusTransitionError when transition is prohibited or stale', async () => {
      const { service, repository } = createService();
      vi.mocked(repository.transitionStatus).mockResolvedValueOnce({
        status: 'invalid_transition',
        currentStatus: 'CLOSED',
      });

      await expect(
        service.transitionStatus(recruiter, 'requisition-a', { status: 'OPEN' }),
      ).rejects.toBeInstanceOf(RequisitionStatusTransitionError);
    });
  });
});
