import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';

export interface ClientMembershipAccess {
  id: string;
  clientId: string;
  userId: string;
  organizationId: string;
  role: 'CLIENT_HIRING_MANAGER';
}

export interface SubmissionAccess {
  id: string;
  clientId: string;
  organizationId: string;
}

export interface AuthorizationRepository {
  findActiveClientMembership(
    principal: AuthenticatedPrincipal,
    clientId: string,
  ): Promise<ClientMembershipAccess | null>;
  findSubmission(
    principal: AuthenticatedPrincipal,
    clientId: string,
    submissionId: string,
  ): Promise<SubmissionAccess | null>;
}

type DatabaseAuthorizationClient = Pick<PrismaClient, 'clientMembership' | 'candidateSubmission'>;

export function createAuthorizationRepository(
  database: DatabaseAuthorizationClient = getDatabaseClient(),
): AuthorizationRepository {
  return {
    async findActiveClientMembership(principal, clientId) {
      return database.clientMembership.findFirst({
        where: {
          clientId,
          userId: principal.userId,
          organizationId: principal.organizationId,
          role: 'CLIENT_HIRING_MANAGER',
          status: 'ACTIVE',
          user: {
            status: 'ACTIVE',
          },
          client: {
            status: 'ACTIVE',
          },
        },
        select: {
          id: true,
          clientId: true,
          userId: true,
          organizationId: true,
          role: true,
        },
      });
    },

    async findSubmission(principal, clientId, submissionId) {
      return database.candidateSubmission.findFirst({
        where: {
          id: submissionId,
          clientId,
          organizationId: principal.organizationId,
        },
        select: {
          id: true,
          clientId: true,
          organizationId: true,
        },
      });
    },
  };
}
