import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import {
  createAuthorizationRepository,
  type AuthorizationRepository,
} from './authorization.repository.js';

export class AuthorizationDeniedError extends Error {
  constructor() {
    super('Access denied');
    this.name = 'AuthorizationDeniedError';
  }
}

export class AuthorizedResourceNotFoundError extends Error {
  constructor() {
    super('Resource not found');
    this.name = 'AuthorizedResourceNotFoundError';
  }
}

export interface AuthorizedClientContext {
  principal: AuthenticatedPrincipal;
  clientId: string;
  membershipId: string;
  membershipRole: 'CLIENT_HIRING_MANAGER';
}

export interface AuthorizedSubmissionContext extends AuthorizedClientContext {
  submissionId: string;
}

export interface AuthorizationServiceDependencies {
  repository?: AuthorizationRepository;
}

export function createAuthorizationService(dependencies: AuthorizationServiceDependencies = {}) {
  const repository = dependencies.repository ?? createAuthorizationRepository();

  async function authorizeClientMembership(
    principal: AuthenticatedPrincipal,
    clientId: string,
  ): Promise<AuthorizedClientContext> {
    if (principal.role !== 'CLIENT_HIRING_MANAGER') {
      throw new AuthorizationDeniedError();
    }

    const membership = await repository.findActiveClientMembership(principal, clientId);
    if (
      !membership ||
      membership.clientId !== clientId ||
      membership.userId !== principal.userId ||
      membership.organizationId !== principal.organizationId ||
      membership.role !== 'CLIENT_HIRING_MANAGER'
    ) {
      throw new AuthorizationDeniedError();
    }

    return {
      principal,
      clientId: membership.clientId,
      membershipId: membership.id,
      membershipRole: membership.role,
    };
  }

  async function authorizeSubmission(
    principal: AuthenticatedPrincipal,
    clientId: string,
    submissionId: string,
  ): Promise<AuthorizedSubmissionContext> {
    const clientContext = await authorizeClientMembership(principal, clientId);
    const submission = await repository.findSubmission(principal, clientId, submissionId);
    if (
      !submission ||
      submission.id !== submissionId ||
      submission.clientId !== clientContext.clientId ||
      submission.organizationId !== principal.organizationId
    ) {
      throw new AuthorizedResourceNotFoundError();
    }

    return {
      ...clientContext,
      submissionId: submission.id,
    };
  }

  return {
    authorizeClientMembership,
    authorizeSubmission,
  };
}

export type AuthorizationService = ReturnType<typeof createAuthorizationService>;
