import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import {
  JdProviderNotConfiguredError,
  JdProviderConfigurationError,
  JdProviderRequestError,
  JdProviderTimeoutError,
  ScorecardDisallowedCriterionError,
  ScorecardInvalidError,
  ScorecardMissingJdError,
  ScorecardNotFoundError,
  ScorecardRoleError,
  type ScorecardService,
} from './scorecard.service.js';
import { ScorecardCriterionScopeError } from './scorecard.repository.js';
import { emptyGenerationSchema, updateScorecardSchema } from './scorecard.schemas.js';

const uuidSchema = z.string().uuid();

export interface ScorecardRouterDependencies {
  service: ScorecardService;
  sessionService: Pick<SessionService, 'validateSession'>;
  applicationOrigin: string;
  isProduction: boolean;
}

function parseUuid(value: string | string[] | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function handleError(error: unknown, response: Response): void {
  if (error instanceof ScorecardNotFoundError) {
    response.status(404).json({ error: 'not_found' });
  } else if (error instanceof ScorecardRoleError) {
    response.status(403).json({ error: 'forbidden' });
  } else if (
    error instanceof ScorecardInvalidError ||
    error instanceof ScorecardMissingJdError ||
    error instanceof ScorecardDisallowedCriterionError ||
    error instanceof ScorecardCriterionScopeError
  ) {
    response.status(400).json({ error: 'invalid_request' });
  } else if (
    error instanceof JdProviderNotConfiguredError ||
    error instanceof JdProviderConfigurationError
  ) {
    response.status(503).json({ error: 'service_unavailable' });
  } else if (error instanceof JdProviderTimeoutError) {
    response.status(504).json({ error: 'provider_timeout' });
  } else if (error instanceof JdProviderRequestError) {
    response.status(502).json({ error: 'provider_unavailable' });
  } else {
    response.status(503).json({ error: 'service_unavailable' });
  }
}

export function createScorecardRouter(dependencies: ScorecardRouterDependencies): Router {
  const router = express.Router();
  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });
  const requireRecruiter = createRequireRole(['RECRUITER']);
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);

  router.use(requireSession, requireRecruiter);

  router.post(
    '/:requisitionId/scorecards/drafts',
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params.requisitionId);
      if (!requisitionId || !emptyGenerationSchema.safeParse(request.body).success) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      try {
        const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
        response.status(201).json({
          scorecard: await dependencies.service.generate(principal, requisitionId),
        });
      } catch (error) {
        handleError(error, response);
      }
    },
  );

  router.get('/:requisitionId/scorecards', async (request, response) => {
    const requisitionId = parseUuid(request.params.requisitionId);
    if (!requisitionId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      response.status(200).json({
        scorecards: await dependencies.service.list(principal, requisitionId),
      });
    } catch (error) {
      handleError(error, response);
    }
  });

  router.get('/:requisitionId/scorecards/:scorecardVersionId', async (request, response) => {
    const requisitionId = parseUuid(request.params.requisitionId);
    const scorecardVersionId = parseUuid(request.params.scorecardVersionId);
    if (!requisitionId || !scorecardVersionId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      response.status(200).json({
        scorecard: await dependencies.service.get(principal, requisitionId, scorecardVersionId),
      });
    } catch (error) {
      handleError(error, response);
    }
  });

  router.patch(
    '/:requisitionId/scorecards/:scorecardVersionId',
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params.requisitionId);
      const scorecardVersionId = parseUuid(request.params.scorecardVersionId);
      const parsed = updateScorecardSchema.safeParse(request.body);
      if (!requisitionId || !scorecardVersionId || !parsed.success) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      try {
        const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
        response.status(200).json({
          scorecard: await dependencies.service.update(
            principal,
            requisitionId,
            scorecardVersionId,
            parsed.data,
          ),
        });
      } catch (error) {
        handleError(error, response);
      }
    },
  );

  router.post(
    '/:requisitionId/scorecards/:scorecardVersionId/approve',
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params.requisitionId);
      const scorecardVersionId = parseUuid(request.params.scorecardVersionId);
      if (
        !requisitionId ||
        !scorecardVersionId ||
        !emptyGenerationSchema.safeParse(request.body).success
      ) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      try {
        const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
        response.status(200).json({
          scorecard: await dependencies.service.approve(
            principal,
            requisitionId,
            scorecardVersionId,
          ),
        });
      } catch (error) {
        handleError(error, response);
      }
    },
  );

  return router;
}
