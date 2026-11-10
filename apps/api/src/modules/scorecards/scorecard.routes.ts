import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import {
  createRequestCorrelationMiddleware,
  getCorrelationId,
} from '../../middleware/request-context.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import {
  JdProviderAuthError,
  JdProviderConfigurationError,
  JdProviderContentBlockedError,
  JdProviderInvalidRequestError,
  JdProviderNotConfiguredError,
  JdProviderRateLimitError,
  JdProviderRequestError,
  JdProviderResponseError,
  JdProviderTimeoutError,
  ScorecardDisallowedCriterionError,
  ScorecardInvalidError,
  ScorecardMissingJdError,
  ScorecardNotFoundError,
  ScorecardRoleError,
  type JdProviderError,
  type ScorecardService,
} from './scorecard.service.js';
import {
  ScorecardCriterionKeyConflictError,
  ScorecardCriterionScopeError,
} from './scorecard.repository.js';
import {
  createScorecardDraftSchema,
  emptyGenerationSchema,
  updateScorecardSchema,
} from './scorecard.schemas.js';

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

function resolveRouteCorrelationId(response: Response): string {
  const fromContext = getCorrelationId();
  if (fromContext) {
    return fromContext;
  }
  const fromLocals = response.locals.requestId;
  return typeof fromLocals === 'string' && fromLocals.length > 0 ? fromLocals : 'none';
}

function logScorecardProviderRouteError(
  error: JdProviderError,
  correlationId: string,
  httpResponseStatus: number,
  clientErrorCode: string,
): void {
  const payload = {
    event: 'jd_extraction_route_error',
    correlationId,
    operation: error.diagnostics?.operation ?? 'jd_extraction',
    provider: error.diagnostics?.provider ?? null,
    httpResponseStatus,
    clientErrorCode,
    errorName: error.name,
    primaryModel: error.diagnostics?.primaryModel ?? null,
    fallbackModel: error.diagnostics?.fallbackModel ?? null,
    attemptNumber: error.diagnostics?.attemptNumber ?? null,
    stage: error.diagnostics?.stage ?? null,
    httpStatus: error.diagnostics?.httpStatus ?? null,
    providerErrorCode: error.diagnostics?.providerErrorCode ?? null,
    classification: error.diagnostics?.classification ?? error.name,
    durationMs: error.diagnostics?.durationMs ?? null,
    fallbackAttempted: error.diagnostics?.fallbackAttempted ?? false,
    failoverUsed: error.diagnostics?.failoverUsed ?? false,
    attemptedProviders: error.diagnostics?.attemptedProviders,
    succeededModel: error.diagnostics?.succeededModel ?? null,
    failedModel: error.diagnostics?.failedModel ?? null,
    finishReason: error.diagnostics?.finishReason ?? null,
    blockReason: error.diagnostics?.blockReason ?? null,
    validationIssues: error.diagnostics?.validationIssues,
  };
  console.error(`[jd-extraction-route] ${JSON.stringify(payload)}`);
}

function respondWithProviderError(
  error: JdProviderError,
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  const correlationId = resolveRouteCorrelationId(response);
  logScorecardProviderRouteError(error, correlationId, status, code);
  response.status(status).json({
    error: code,
    message,
  });
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
    error instanceof ScorecardCriterionScopeError ||
    error instanceof ScorecardCriterionKeyConflictError
  ) {
    response.status(400).json({ error: 'invalid_request' });
  } else if (error instanceof JdProviderNotConfiguredError) {
    respondWithProviderError(
      error,
      response,
      503,
      'provider_not_configured',
      'AI scorecard extraction is not configured. Configure GEMINI_API_KEY or GROQ_API_KEY on the server or create a manual draft.',
    );
  } else if (error instanceof JdProviderConfigurationError) {
    respondWithProviderError(
      error,
      response,
      503,
      'provider_configuration_error',
      'AI scorecard extraction model or API configuration is invalid. Verify GEMINI_MODEL / GROQ_MODEL and API keys or create a manual draft.',
    );
  } else if (error instanceof JdProviderAuthError) {
    respondWithProviderError(
      error,
      response,
      502,
      'provider_auth_error',
      'AI provider authentication failed. Verify configured GEMINI_API_KEY / GROQ_API_KEY permissions and validity, or create a manual draft.',
    );
  } else if (error instanceof JdProviderRateLimitError) {
    respondWithProviderError(
      error,
      response,
      429,
      'provider_rate_limited',
      'AI provider rate limit or quota exceeded. Please wait briefly and retry, or create a manual draft.',
    );
  } else if (error instanceof JdProviderTimeoutError) {
    respondWithProviderError(
      error,
      response,
      504,
      'provider_timeout',
      'AI extraction timed out while analyzing the job description. Retry or create a manual draft.',
    );
  } else if (error instanceof JdProviderContentBlockedError) {
    respondWithProviderError(
      error,
      response,
      422,
      'provider_content_blocked',
      'AI extraction could not process this job description because the upstream safety filter blocked generation. Review the job description or create a manual draft.',
    );
  } else if (error instanceof JdProviderInvalidRequestError) {
    respondWithProviderError(
      error,
      response,
      502,
      'provider_invalid_request',
      'AI extraction request was rejected by the upstream provider due to an invalid request or schema. Retry or create a manual draft.',
    );
  } else if (error instanceof JdProviderResponseError) {
    respondWithProviderError(
      error,
      response,
      502,
      'provider_invalid_response',
      'AI requirement extraction returned an invalid or incomplete structured response. Retry or create a manual draft.',
    );
  } else if (error instanceof JdProviderRequestError) {
    respondWithProviderError(
      error,
      response,
      502,
      'provider_unavailable',
      'AI requirement extraction failed due to an upstream provider error. Retry or create a manual draft.',
    );
  } else {
    const correlationId = resolveRouteCorrelationId(response);
    console.error(
      `[scorecard-route] ${JSON.stringify({
        event: 'scorecard_route_unexpected_error',
        correlationId,
        operation: 'scorecard_route',
        httpResponseStatus: 503,
        clientErrorCode: 'service_unavailable',
        errorName: error instanceof Error ? error.name : typeof error,
      })}`,
    );
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

  router.use(createRequestCorrelationMiddleware(), requireSession, requireRecruiter);

  router.post(
    '/:requisitionId/scorecards/drafts',
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params.requisitionId);
      const parsedBody = createScorecardDraftSchema.safeParse(request.body);
      if (!requisitionId || !parsedBody.success) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      try {
        const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
        const hasExplicitOptions =
          parsedBody.data.mode !== undefined || parsedBody.data.cloneFromVersionId !== undefined;
        const scorecard = hasExplicitOptions
          ? await dependencies.service.generate(principal, requisitionId, parsedBody.data)
          : await dependencies.service.generate(principal, requisitionId);
        response.status(201).json({
          scorecard,
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
