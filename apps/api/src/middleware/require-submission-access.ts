import type { RequestHandler } from 'express';

import type { AuthenticatedPrincipal } from '../modules/auth/session.service.js';
import {
  AuthorizedResourceNotFoundError,
  type AuthorizationService,
} from '../modules/authorization/authorization.service.js';

export interface SubmissionAccessMiddlewareDependencies {
  authorizationService: Pick<AuthorizationService, 'authorizeSubmission'>;
  clientParam?: string;
  submissionParam?: string;
}

export function createRequireSubmissionAccess(
  dependencies: SubmissionAccessMiddlewareDependencies,
): RequestHandler {
  const clientParam = dependencies.clientParam ?? 'clientId';
  const submissionParam = dependencies.submissionParam ?? 'submissionId';

  return async (request, response, next) => {
    const principal = response.locals.authPrincipal as AuthenticatedPrincipal | undefined;
    if (!principal) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const clientId = request.params[clientParam];
    const submissionId = request.params[submissionParam];
    if (
      typeof clientId !== 'string' ||
      clientId.length === 0 ||
      typeof submissionId !== 'string' ||
      submissionId.length === 0
    ) {
      response.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      response.locals.authorizationContext =
        await dependencies.authorizationService.authorizeSubmission(
          principal,
          clientId,
          submissionId,
        );
      next();
    } catch (error) {
      if (error instanceof AuthorizedResourceNotFoundError) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      next(error);
    }
  };
}
