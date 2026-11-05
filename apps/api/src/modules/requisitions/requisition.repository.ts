import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { RequisitionStatus } from './requisition.dto.js';
import type {
  CreateRequisitionInput,
  TransitionTargetStatus,
  UpdateRequisitionInput,
} from './requisition.schemas.js';

const ALLOWED_REQUISITION_TRANSITIONS: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['PAUSED', 'CLOSED', 'FILLED'],
  PAUSED: ['OPEN', 'CLOSED', 'FILLED'],
  CLOSED: [],
  FILLED: [],
};

export function isValidRequisitionStatusTransition(
  fromStatus: RequisitionStatus,
  toStatus: RequisitionStatus,
): boolean {
  return ALLOWED_REQUISITION_TRANSITIONS[fromStatus].includes(toStatus);
}

export type RequisitionTransitionResult =
  | { status: 'ok'; record: RequisitionRecord }
  | { status: 'not_found' }
  | { status: 'invalid_transition'; currentStatus: RequisitionStatus }
  | { status: 'scorecard_not_approved' };

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
  transitionStatus(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    targetStatus: TransitionTargetStatus,
  ): Promise<RequisitionTransitionResult>;
}

type DatabaseRequisitionTransactionClient = Pick<PrismaClient, 'client' | 'requisition'> &
  Partial<Pick<PrismaClient, 'scorecardVersion' | 'auditLog' | '$queryRaw'>>;

type DatabaseRequisitionClient = DatabaseRequisitionTransactionClient & {
  $transaction?: <T>(fn: (tx: DatabaseRequisitionTransactionClient) => Promise<T>) => Promise<T>;
};

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

    async transitionStatus(principal, requisitionId, targetStatus) {
      const execute = async (
        tx: DatabaseRequisitionTransactionClient,
      ): Promise<RequisitionTransitionResult> => {
        if (typeof tx.$queryRaw === 'function') {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "requisitions" WHERE id = CAST(${requisitionId} AS uuid) FOR UPDATE`,
          );
        }

        const current = await tx.requisition.findFirst({
          where: {
            id: requisitionId,
            organizationId: principal.organizationId,
            assignedRecruiterId: principal.userId,
          },
          select: requisitionSelect,
        });

        if (!current) {
          return { status: 'not_found' };
        }

        if (!isValidRequisitionStatusTransition(current.status, targetStatus)) {
          return { status: 'invalid_transition', currentStatus: current.status };
        }

        if (current.status === 'DRAFT' && targetStatus === 'OPEN') {
          if (!tx.scorecardVersion) {
            return { status: 'scorecard_not_approved' };
          }
          const approvedScorecard = await tx.scorecardVersion.findFirst({
            where: {
              requisitionId,
              organizationId: principal.organizationId,
              status: 'APPROVED',
            },
            select: { id: true },
          });
          if (!approvedScorecard) {
            return { status: 'scorecard_not_approved' };
          }
        }

        const updated = await tx.requisition.updateMany({
          where: {
            id: requisitionId,
            organizationId: principal.organizationId,
            assignedRecruiterId: principal.userId,
            status: current.status,
          },
          data: {
            status: targetStatus,
          },
        });

        if (updated.count !== 1) {
          return { status: 'invalid_transition', currentStatus: current.status };
        }

        if (tx.auditLog) {
          await tx.auditLog.create({
            data: {
              organizationId: principal.organizationId,
              actorId: principal.userId,
              action: 'REQUISITION_STATUS_TRANSITIONED',
              resourceType: 'Requisition',
              resourceId: requisitionId,
              requisitionId,
              clientId: current.clientId,
              metadataJson: {
                fromStatus: current.status,
                toStatus: targetStatus,
              },
            },
          });
        }

        const refreshed = await tx.requisition.findFirst({
          where: {
            id: requisitionId,
            organizationId: principal.organizationId,
            assignedRecruiterId: principal.userId,
          },
          select: requisitionSelect,
        });

        if (!refreshed) {
          return { status: 'not_found' };
        }

        return { status: 'ok', record: refreshed };
      };

      if (typeof database.$transaction === 'function') {
        return database.$transaction(execute);
      }
      return execute(database);
    },
  };
}
