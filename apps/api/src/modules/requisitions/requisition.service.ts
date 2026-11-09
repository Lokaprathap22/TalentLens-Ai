import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { RequisitionDto } from './requisition.dto.js';
import {
  createRequisitionRepository,
  isValidRequisitionStatusTransition,
  type RequisitionRecord,
  type RequisitionRepository,
} from './requisition.repository.js';
import type {
  CreateRequisitionInput,
  TransitionRequisitionStatusInput,
  UpdateRequisitionInput,
} from './requisition.schemas.js';

export { isValidRequisitionStatusTransition };

export class RequisitionNotFoundError extends Error {
  constructor() {
    super('Requisition not found');
    this.name = 'RequisitionNotFoundError';
  }
}

export class RequisitionClientNotFoundError extends Error {
  constructor() {
    super('Client not found');
    this.name = 'RequisitionClientNotFoundError';
  }
}

export class RequisitionRoleError extends Error {
  constructor() {
    super('Recruiter role required');
    this.name = 'RequisitionRoleError';
  }
}

export class RequisitionStatusTransitionError extends Error {
  constructor(message = 'Invalid requisition status transition') {
    super(message);
    this.name = 'RequisitionStatusTransitionError';
  }
}

export class RequisitionScorecardNotApprovedError extends Error {
  constructor(message = 'Requisition requires an approved scorecard before opening') {
    super(message);
    this.name = 'RequisitionScorecardNotApprovedError';
  }
}

export interface RequisitionServiceDependencies {
  repository?: RequisitionRepository;
}

function toDto(record: RequisitionRecord): RequisitionDto {
  return {
    id: record.id,
    clientId: record.clientId,
    clientName: record.client.name,
    title: record.title,
    jdText: record.jdText,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function requireRecruiter(principal: AuthenticatedPrincipal): void {
  if (principal.role !== 'RECRUITER') {
    throw new RequisitionRoleError();
  }
}

export function createRequisitionService(dependencies: RequisitionServiceDependencies = {}) {
  const repository = dependencies.repository ?? createRequisitionRepository();

  return {
    async create(
      principal: AuthenticatedPrincipal,
      input: CreateRequisitionInput,
    ): Promise<RequisitionDto> {
      requireRecruiter(principal);
      const client = await repository.findActiveClient(principal.organizationId, input.clientId);
      if (!client) {
        throw new RequisitionClientNotFoundError();
      }

      return toDto(await repository.create(principal, input));
    },

    async list(principal: AuthenticatedPrincipal): Promise<RequisitionDto[]> {
      requireRecruiter(principal);
      const records = await repository.listAssigned(principal.organizationId, principal.userId);
      return records.map(toDto);
    },

    async get(principal: AuthenticatedPrincipal, requisitionId: string): Promise<RequisitionDto> {
      requireRecruiter(principal);
      const record = await repository.findAssigned(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!record) {
        throw new RequisitionNotFoundError();
      }

      return toDto(record);
    },

    async update(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      input: UpdateRequisitionInput,
    ): Promise<RequisitionDto> {
      requireRecruiter(principal);
      if (input.clientId) {
        const client = await repository.findActiveClient(principal.organizationId, input.clientId);
        if (!client) {
          throw new RequisitionClientNotFoundError();
        }
      }

      const record = await repository.updateDraft(
        principal.organizationId,
        principal.userId,
        requisitionId,
        input,
      );
      if (!record) {
        throw new RequisitionNotFoundError();
      }

      return toDto(record);
    },

    async transitionStatus(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      input: TransitionRequisitionStatusInput,
    ): Promise<RequisitionDto> {
      requireRecruiter(principal);

      const result = await repository.transitionStatus(principal, requisitionId, input.status);
      if (result.status === 'not_found') {
        throw new RequisitionNotFoundError();
      }
      if (result.status === 'scorecard_not_approved') {
        throw new RequisitionScorecardNotApprovedError();
      }
      if (result.status === 'invalid_transition') {
        throw new RequisitionStatusTransitionError(
          `Cannot transition requisition from ${result.currentStatus} to ${input.status}`,
        );
      }

      return toDto(result.record);
    },
  };
}

export type RequisitionService = ReturnType<typeof createRequisitionService>;
