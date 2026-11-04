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
  createRequisitionService,
} from './requisition.service.js';

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
  });
});
