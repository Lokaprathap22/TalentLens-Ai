import express, { type RequestHandler, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import { createRequireRole } from '../../middleware/require-role.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import {
  acceptConsentSchema,
  createConsentInvitationSchema,
  declineConsentSchema,
  confirmWithdrawalSchema,
  inspectConsentSchema,
  requestWithdrawalSchema,
} from './consent.schemas.js';
import { ConsentError, type ConsentService } from './consent.service.js';

const uuidSchema = z.string().uuid();

function parseUuid(value: string | string[] | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface ConsentRouterDependencies {
  consentService: ConsentService;
  sessionService: Pick<SessionService, 'validateSession'>;
  applicationOrigin: string;
  isProduction: boolean;
  inspectRateLimiter?: RequestHandler;
  actionRateLimiter?: RequestHandler;
  withdrawalRateLimiter?: RequestHandler;
}

export function createConsentRouter(dependencies: ConsentRouterDependencies): Router {
  const router = express.Router();

  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });
  const requireRecruiterRole = createRequireRole(['RECRUITER']);
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);

  const defaultInspectLimiter =
    dependencies.inspectRateLimiter ??
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests' },
    });

  const defaultActionLimiter =
    dependencies.actionRateLimiter ??
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 15,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests' },
    });

  const defaultWithdrawalLimiter =
    dependencies.withdrawalRateLimiter ??
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests' },
    });

  // 1. Recruiter Endpoint: Create Consent Invitation
  router.post(
    '/requisitions/:requisitionId/candidates/:candidateId/consent-invitations',
    requireSession,
    requireRecruiterRole,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const parsed = createConsentInvitationSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          error: 'validation_error',
          details: parsed.error.issues,
        });
        return;
      }

      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_parameters' });
        return;
      }

      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal | undefined;
      if (!principal) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }

      try {
        const result = await dependencies.consentService.createInvitation(
          principal,
          requisitionId,
          candidateId,
          parsed.data.email,
        );
        response.status(201).json(result);
      } catch (err: unknown) {
        if (err instanceof ConsentError) {
          response.status(err.statusCode).json({
            error: err.code,
            message: err.message,
          });
          return;
        }
        response.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // 2. Candidate Public Endpoint: Inspect Notice (Strictly POST body only; tokens are not accepted in query strings or paths to prevent log leakage)
  router.post('/consent/inspect', defaultInspectLimiter, async (request, response) => {
    const parsed = inspectConsentSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const notice = await dependencies.consentService.inspectNotice(parsed.data.token);
      response.status(200).json(notice);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 3. Candidate Public Endpoint: Accept Consent
  router.post('/consent/accept', defaultActionLimiter, async (request, response) => {
    const parsed = acceptConsentSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.acceptConsent(
        parsed.data.token,
        parsed.data.confirmationName,
      );
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 4. Candidate Public Endpoint: Decline Consent
  router.post('/consent/decline', defaultActionLimiter, async (request, response) => {
    const parsed = declineConsentSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.declineConsent(
        parsed.data.token,
        parsed.data.reason,
      );
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 5. Candidate Public Endpoint: Request Withdrawal Verification
  router.post('/consent/withdraw/request', defaultWithdrawalLimiter, async (request, response) => {
    const parsed = requestWithdrawalSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.requestWithdrawal(
        parsed.data.email,
        parsed.data.candidateCode,
      );
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 6. Candidate Public Endpoint: Confirm Withdrawal Verification
  router.post('/consent/withdraw/confirm', defaultActionLimiter, async (request, response) => {
    const parsed = confirmWithdrawalSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.confirmWithdrawal(parsed.data.token);
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 6b. Candidate Public Endpoint: Request Candidate Data Erasure (Deletion)
  router.post('/consent/deletion/request', defaultWithdrawalLimiter, async (request, response) => {
    const parsed = requestWithdrawalSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.requestCandidateDeletion(
        parsed.data.email,
        parsed.data.candidateCode,
      );
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 6c. Candidate Public Endpoint: Confirm Candidate Data Erasure (Deletion)
  router.post('/consent/deletion/confirm', defaultActionLimiter, async (request, response) => {
    const parsed = confirmWithdrawalSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'validation_error',
        details: parsed.error.issues,
      });
      return;
    }

    try {
      const result = await dependencies.consentService.confirmCandidateDeletion(parsed.data.token);
      response.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof ConsentError) {
        response.status(err.statusCode).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    }
  });

  // 7. Recruiter Endpoint: Create Candidate Deletion Request
  router.post(
    '/candidates/:candidateId/deletion-requests',
    requireSession,
    requireRecruiterRole,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const candidateId = parseUuid(request.params['candidateId']);
      if (!candidateId) {
        response.status(400).json({ error: 'invalid_parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.consentService.createDeletionRequest(
          principal,
          candidateId,
        );
        response.status(201).json(result);
      } catch (err: unknown) {
        if (err instanceof ConsentError) {
          response.status(err.statusCode).json({ error: err.code, message: err.message });
          return;
        }
        response.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // 8. Recruiter Endpoint: Process Candidate Deletion Request
  router.post(
    '/deletion-requests/:requestId/process',
    requireSession,
    requireRecruiterRole,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requestId = parseUuid(request.params['requestId']);
      if (!requestId) {
        response.status(400).json({ error: 'invalid_parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.consentService.processDeletionRequest(
          principal,
          requestId,
        );
        response.status(200).json(result);
      } catch (err: unknown) {
        if (err instanceof ConsentError) {
          response.status(err.statusCode).json({ error: err.code, message: err.message });
          return;
        }
        response.status(500).json({ error: 'internal_error' });
      }
    },
  );

  return router;
}
