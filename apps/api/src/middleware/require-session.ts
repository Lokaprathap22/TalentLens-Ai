import type { RequestHandler } from 'express';

import { getSessionCookieName, readCookie } from '../modules/auth/session-cookie.js';
import type { SessionService } from '../modules/auth/session.service.js';

export interface SessionMiddlewareDependencies {
  sessionService: Pick<SessionService, 'validateSession'>;
  isProduction: boolean;
}

export function createRequireSession(dependencies: SessionMiddlewareDependencies): RequestHandler {
  return async (request, response, next) => {
    const token = readCookie(
      request.headers.cookie,
      getSessionCookieName(dependencies.isProduction),
    );
    const principal = await dependencies.sessionService.validateSession(token);

    if (!principal) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    response.locals.authPrincipal = principal;
    response.locals.sessionToken = token;
    next();
  };
}
