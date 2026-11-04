import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { CreateRequisitionInput, UpdateRequisitionInput } from './requisition.schemas.js';

export interface ActiveClient {
  id: string;
}

export interface RequisitionRecord {
  id: string;
  organizationId: string;
  clientId: string;
  title: string;
  jdText: string;
  status: 'DRAFT' | 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';
  createdById: string;
  assignedRecruiterId: string | null;
  createdAt: Date;
  updatedAt: Date;
  client: {
    id: string;
    name: string;
  };
}

export interface RequisitionRepository {
  findActiveClient(organizationId: string, clientId: string): Promise<ActiveClient | null>;
  create(
    principal: AuthenticatedPrincipal,
    input: CreateRequisitionInput,
  ): Promise<RequisitionRecord>;
  listAssigned(organizationId: string, recruiterId: string): Promise<RequisitionRecord[]>;
  findAssigned(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<RequisitionRecord | null>;
  updateDraft(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    input: UpdateRequisitionInput,
  ): Promise<RequisitionRecord | null>;
}

type DatabaseRequisitionClient = Pick<PrismaClient, 'client' | 'requisition'>;

const requisitionSelect = {
  id: true,
  organizationId: true,
  clientId: true,
  title: true,
  jdText: true,
  status: true,
  createdById: true,
  assignedRecruiterId: true,
  createdAt: true,
  updatedAt: true,
  client: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

export function createRequisitionRepository(
  database: DatabaseRequisitionClient = getDatabaseClient(),
): RequisitionRepository {
  return {
    async findActiveClient(organizationId, clientId) {
      return database.client.findFirst({
        where: {
          id: clientId,
          organizationId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
        },
      });
    },

    async create(principal, input) {
      return database.requisition.create({
        data: {
          organizationId: principal.organizationId,
          clientId: input.clientId,
          title: input.title,
          jdText: input.jdText,
          createdById: principal.userId,
          assignedRecruiterId: principal.userId,
        },
        select: requisitionSelect,
      });
    },

    async listAssigned(organizationId, recruiterId) {
      return database.requisition.findMany({
        where: {
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        orderBy: {
          updatedAt: 'desc',
        },
        select: requisitionSelect,
      });
    },

    async findAssigned(organizationId, recruiterId, requisitionId) {
      return database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: requisitionSelect,
      });
    },

    async updateDraft(organizationId, recruiterId, requisitionId, input) {
      const data: {
        clientId?: string;
        title?: string;
        jdText?: string;
      } = {};
      if (input.clientId !== undefined) data.clientId = input.clientId;
      if (input.title !== undefined) data.title = input.title;
      if (input.jdText !== undefined) data.jdText = input.jdText;

      const result = await database.requisition.updateMany({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
          status: 'DRAFT',
        },
        data,
      });
      if (result.count !== 1) {
        return null;
      }

      return database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: requisitionSelect,
      });
    },
  };
}
