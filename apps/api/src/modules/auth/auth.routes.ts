import type { RequestHandler, Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { createRequireSession } from '../../middleware/require-session.js';
import { deriveCsrfToken, verifyCsrfToken } from '../../middleware/csrf.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import { loginRequestSchema } from './auth.schemas.js';
import { AuthenticationError, type AuthService } from './auth.service.js';
import {
  clearSessionCookie,
  getSessionCookieName,
  readCookie,
  setSessionCookie,
} from './session-cookie.js';
import type { SessionService } from './session.service.js';

export interface AuthRouterDependencies {
  authService: AuthService;
  sessionService: Pick<SessionService, 'validateSession' | 'revokeSession'>;
  applicationOrigin: string;
  isProduction: boolean;
  loginRateLimiter?: RequestHandler;
}

export function createAuthRouter(dependencies: AuthRouterDependencies): Router {
  const router = express.Router();
  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);
  const loginRateLimiter =
    dependencies.loginRateLimiter ??
    // This limiter is process-local; deploy a shared limiter before scaling horizontally.
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests' },
    });
  const cookieOptions = { secure: dependencies.isProduction };

  router.post(
    '/login',
    loginRateLimiter,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }

      try {
        const session = await dependencies.authService.login(
          parsed.data.organization,
          parsed.data.email,
          parsed.data.password,
        );
        response.setHeader('Set-Cookie', setSessionCookie(session.token, cookieOptions));
        response.status(200).json({ user: session.user });
      } catch (error) {
        if (error instanceof AuthenticationError) {
          response.status(401).json({ error: 'invalid_credentials' });
          return;
        }

        response.status(503).json({ error: 'authentication_unavailable' });
      }
    },
  );

  router.get('/csrf', requireSession, (request, response) => {
    const token = response.locals.sessionToken;
    if (typeof token !== 'string') {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    response.json({ csrfToken: deriveCsrfToken(token) });
  });

  router.get('/me', requireSession, (_request, response) => {
    response.json({ user: response.locals.authPrincipal });
  });

  router.post('/logout', sameOrigin, async (request, response) => {
    const token = readCookie(
      request.headers.cookie,
      getSessionCookieName(dependencies.isProduction),
    );
    const principal = token ? await dependencies.sessionService.validateSession(token) : null;

    if (token && principal) {
      if (!verifyCsrfToken(token, request.get('x-csrf-token'))) {
        response.status(403).json({ error: 'request_not_allowed' });
        return;
      }

      await dependencies.sessionService.revokeSession(token);
    }

    response.setHeader('Set-Cookie', clearSessionCookie(cookieOptions));
    response.status(200).json({ status: 'ok' });
  });

  return router;
}
