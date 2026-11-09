import type { RequestHandler, Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { createRequireSession } from '../../middleware/require-session.js';
import { deriveCsrfToken, verifyCsrfToken } from '../../middleware/csrf.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import {
  activateAccountSchema,
  changePasswordSchema,
  confirmPasswordResetSchema,
  loginRequestSchema,
  requestPasswordResetSchema,
  updateProfileSchema,
} from './auth.schemas.js';
import {
  AuthenticationError,
  CurrentPasswordIncorrectError,
  InvalidTokenError,
  type AuthService,
} from './auth.service.js';
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

  router.post(
    '/activate',
    loginRateLimiter,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = activateAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      try {
        const session = await dependencies.authService.activate(
          parsed.data.token,
          parsed.data.password,
        );
        response.setHeader('Set-Cookie', setSessionCookie(session.token, cookieOptions));
        response.status(200).json({ user: session.user });
      } catch (error) {
        if (error instanceof InvalidTokenError) {
          response.status(400).json({ error: 'invalid_token', message: error.message });
          return;
        }

        response.status(500).json({ error: 'activation_failed' });
      }
    },
  );

  router.post(
    '/password/change',
    requireSession,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      const token = response.locals.sessionToken;
      if (typeof token !== 'string' || !verifyCsrfToken(token, request.get('x-csrf-token'))) {
        response.status(403).json({ error: 'request_not_allowed' });
        return;
      }

      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      try {
        const principal = response.locals.authPrincipal;
        await dependencies.authService.changePassword(
          principal.userId,
          parsed.data.currentPassword,
          parsed.data.newPassword,
          token,
        );
        response.status(200).json({ status: 'ok', message: 'Password updated successfully' });
      } catch (error) {
        if (error instanceof CurrentPasswordIncorrectError) {
          response
            .status(400)
            .json({ error: 'current_password_incorrect', message: error.message });
          return;
        }

        if (error instanceof AuthenticationError) {
          response.status(401).json({ error: 'unauthenticated' });
          return;
        }

        response.status(500).json({ error: 'password_change_failed' });
      }
    },
  );

  router.post(
    '/password/reset/request',
    loginRateLimiter,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = requestPasswordResetSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      try {
        await dependencies.authService.requestPasswordReset(
          parsed.data.organization,
          parsed.data.email,
        );
      } catch {
        // Anti-enumeration: ignore background errors
      }

      // Always return 200 generic success response
      response.status(200).json({
        status: 'ok',
        message: 'If an account matches those details, a password reset link has been sent.',
      });
    },
  );

  router.post(
    '/password/reset/confirm',
    loginRateLimiter,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = confirmPasswordResetSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      try {
        await dependencies.authService.confirmPasswordReset(
          parsed.data.token,
          parsed.data.newPassword,
        );
        response.status(200).json({
          status: 'ok',
          message: 'Password has been reset successfully. Please sign in with your new password.',
        });
      } catch (error) {
        if (error instanceof InvalidTokenError) {
          response.status(400).json({ error: 'invalid_token', message: error.message });
          return;
        }

        response.status(500).json({ error: 'password_reset_failed' });
      }
    },
  );

  router.patch(
    '/profile',
    requireSession,
    sameOrigin,
    express.json({ limit: '20kb', type: 'application/json' }),
    async (request, response) => {
      const token = response.locals.sessionToken;
      if (typeof token !== 'string' || !verifyCsrfToken(token, request.get('x-csrf-token'))) {
        response.status(403).json({ error: 'request_not_allowed' });
        return;
      }

      if (!request.is('application/json')) {
        response.status(415).json({ error: 'invalid_request' });
        return;
      }

      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
        return;
      }

      try {
        const principal = response.locals.authPrincipal;
        const updated = await dependencies.authService.updateProfile(
          principal.userId,
          parsed.data.name,
        );
        response.status(200).json({ user: updated });
      } catch {
        response.status(500).json({ error: 'profile_update_failed' });
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
