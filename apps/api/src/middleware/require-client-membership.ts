import type { RequestHandler } from 'express';

import type { AuthenticatedPrincipal } from '../modules/auth/session.service.js';
import {
  AuthorizationDeniedError,
  type AuthorizationService,
} from '../modules/authorization/authorization.service.js';

export interface ClientMembershipMiddlewareDependencies {
  authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'>;
  clientParam?: string;
}

export function createRequireClientMembership(
  dependencies: ClientMembershipMiddlewareDependencies,
): RequestHandler {
  const clientParam = dependencies.clientParam ?? 'clientId';

  return async (request, response, next) => {
    const principal = response.locals.authPrincipal as AuthenticatedPrincipal | undefined;
    if (!principal) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const clientId = request.params[clientParam];
    if (typeof clientId !== 'string' || clientId.length === 0) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }

    try {
      response.locals.authorizationContext =
        await dependencies.authorizationService.authorizeClientMembership(principal, clientId);
      next();
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      next(error);
    }
  };
}
