import type { RequestHandler } from 'express';

import type { AuthenticatedPrincipal } from '../modules/auth/session.service.js';

export type AuthorizationRole = AuthenticatedPrincipal['role'];

export function createRequireRole(allowedRoles: readonly AuthorizationRole[]): RequestHandler {
  return (_request, response, next) => {
    const principal = response.locals.authPrincipal as AuthenticatedPrincipal | undefined;
    if (!principal) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    if (!allowedRoles.includes(principal.role)) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}
