import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { AuthenticatedUserDto } from '../auth/auth.dto.js';
import type { SessionService } from '../auth/session.service.js';
import {
  ScorecardCriterionKeyConflictError,
  ScorecardCriterionScopeError,
} from './scorecard.repository.js';
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
  ScorecardInvalidError,
  ScorecardNotFoundError,
  type ScorecardService,
} from './scorecard.service.js';

const token = 'B'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const scorecardId = '123e4567-e89b-42d3-a456-426614174001';
const recruiter: AuthenticatedUserDto = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  organizationName: 'Organization A',
  email: 'recruiter-a@example.com',
  role: 'RECRUITER',
};
const scorecard = {
  id: scorecardId,
  requisitionId,
  version: 1,
  status: 'DRAFT' as const,
  weights: {},
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
  criteria: [],
};

function createTestApp(
  options: {
    principal?: AuthenticatedUserDto;
    getError?: Error;
    updateError?: Error;
    approveError?: Error;
  } = {},
) {
  const principal = options.principal ?? recruiter;
  const sessionService: Pick<SessionService, 'validateSession'> = {
    validateSession: vi.fn(async (value: string | null | undefined) =>
      value === token ? principal : null,
    ),
  };
  const service: ScorecardService = {
    generate: vi.fn(async () => scorecard),
    list: vi.fn(async () => [scorecard]),
    get: vi.fn(async () => {
      if (options.getError) throw options.getError;
      return scorecard;
    }),
    update: vi.fn(async () => {
      if (options.updateError) throw options.updateError;
      return scorecard;
    }),
    approve: vi.fn(async () => {
      if (options.approveError) throw options.approveError;
      return scorecard;
    }),
  };
  return {
    service,
    app: createApp({
      scorecards: {
        service,
        sessionService,
        applicationOrigin: 'http://localhost:5173',
        isProduction: false,
      },
    }),
  };
}

function authorizedPost(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .post(path)
    .set('Cookie', `talentlens_session=${token}`)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', deriveCsrfToken(token));
}

function authorizedPatch(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .patch(path)
    .set('Cookie', `talentlens_session=${token}`)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', deriveCsrfToken(token));
}

describe('scorecard routes', () => {
  it('requires an authenticated recruiter for scorecard listing', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get(`/api/v1/requisitions/${requisitionId}/scorecards`);

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('denies client hiring managers before service access', async () => {
    const { app, service } = createTestApp({
      principal: {
        userId: 'client-manager-a',
        organizationId: 'organization-a',
        organizationName: 'Organization A',
        email: 'client-manager-a@example.com',
        role: 'CLIENT_HIRING_MANAGER',
      },
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/scorecards`)
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects malformed requisition IDs before service access', async () => {
    const { app, service } = createTestApp();

    const response = await request(app).get('/api/v1/requisitions/not-a-uuid/scorecards');

    expect(response.status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects malformed authenticated requisition IDs before service access', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .get('/api/v1/requisitions/not-a-uuid/scorecards')
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('generates a draft with the authenticated principal and saved requisition ID', async () => {
    const { app, service } = createTestApp();

    const response = await authorizedPost(
      app,
      `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
    ).send({});

    expect(response.status).toBe(201);
    expect(service.generate).toHaveBeenCalledWith(recruiter, requisitionId);
  });

  it('supports explicit AI, manual, and clone draft creation modes and rejects contradictory inputs', async () => {
    const { app, service } = createTestApp();
    const sourceVersionId = '223e4567-e89b-42d3-a456-426614174000';

    // Explicit AI mode
    const aiRes = await authorizedPost(
      app,
      `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
    ).send({ mode: 'ai' });
    expect(aiRes.status).toBe(201);
    expect(service.generate).toHaveBeenCalledWith(recruiter, requisitionId, { mode: 'ai' });

    // Manual mode
    const manualRes = await authorizedPost(
      app,
      `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
    ).send({ mode: 'manual' });
    expect(manualRes.status).toBe(201);
    expect(service.generate).toHaveBeenCalledWith(recruiter, requisitionId, { mode: 'manual' });

    // Clone mode
    const cloneRes = await authorizedPost(
      app,
      `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
    ).send({ cloneFromVersionId: sourceVersionId });
    expect(cloneRes.status).toBe(201);
    expect(service.generate).toHaveBeenCalledWith(recruiter, requisitionId, {
      cloneFromVersionId: sourceVersionId,
    });

    vi.mocked(service.generate).mockClear();

    // Contradictory inputs rejected with 400
    for (const invalidBody of [
      { mode: 'ai', cloneFromVersionId: sourceVersionId },
      { mode: 'manual', cloneFromVersionId: sourceVersionId },
      { cloneFromVersionId: 'not-a-uuid' },
      { mode: 'invalid' },
      { extra: 'field' },
    ]) {
      const badRes = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
      ).send(invalidBody);
      expect(badRes.status).toBe(400);
    }

    expect(service.generate).not.toHaveBeenCalled();
  });

  it('rejects status and approver injection in edits', async () => {
    const { app, service } = createTestApp();

    const response = await request(app)
      .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
      .set('Cookie', `talentlens_session=${token}`)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', deriveCsrfToken(token))
      .send({ status: 'APPROVED', approvedById: 'attacker' });

    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('returns not found for an inaccessible scorecard', async () => {
    const { app, service } = createTestApp({
      getError: new ScorecardNotFoundError(),
    });

    const response = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
      .set('Cookie', `talentlens_session=${token}`);

    expect(response.status).toBe(404);
    expect(service.get).toHaveBeenCalledWith(recruiter, requisitionId, scorecardId);
  });

  describe('PATCH and approve routes', () => {
    it('updates scorecard criteria when authorized recruiter supplies valid input', async () => {
      const { app, service } = createTestApp();

      const response = await authorizedPatch(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`,
      ).send({
        criteria: [
          {
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(service.update).toHaveBeenCalledWith(
        recruiter,
        requisitionId,
        scorecardId,
        expect.objectContaining({
          criteria: [
            expect.objectContaining({
              label: 'TypeScript',
            }),
          ],
        }),
      );
    });

    it('rejects PATCH with missing CSRF token', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects PATCH with wrong Origin', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .patch(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://malicious-origin.com')
        .set('X-CSRF-Token', deriveCsrfToken(token))
        .send({
          criteria: [
            {
              label: 'TypeScript',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('maps ScorecardCriterionKeyConflictError and ScorecardCriterionScopeError to 400 invalid_request', async () => {
      const { app } = createTestApp({
        updateError: new ScorecardCriterionKeyConflictError(),
      });

      const conflictRes = await authorizedPatch(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`,
      ).send({
        criteria: [
          {
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      });

      expect(conflictRes.status).toBe(400);
      expect(conflictRes.body).toEqual({ error: 'invalid_request' });

      const { app: scopeApp } = createTestApp({
        updateError: new ScorecardCriterionScopeError(),
      });

      const scopeRes = await authorizedPatch(
        scopeApp,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}`,
      ).send({
        criteria: [
          {
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      });

      expect(scopeRes.status).toBe(400);
      expect(scopeRes.body).toEqual({ error: 'invalid_request' });
    });

    it('approves a scorecard when authorized recruiter supplies valid request', async () => {
      const { app, service } = createTestApp();

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(200);
      expect(service.approve).toHaveBeenCalledWith(recruiter, requisitionId, scorecardId);
    });

    it('rejects approve request with missing CSRF token', async () => {
      const { app, service } = createTestApp();

      const response = await request(app)
        .post(`/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`)
        .set('Cookie', `talentlens_session=${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({});

      expect(response.status).toBe(403);
      expect(service.approve).not.toHaveBeenCalled();
    });

    it('returns 400 when approve service returns ScorecardInvalidError', async () => {
      const { app } = createTestApp({
        approveError: new ScorecardInvalidError(),
      });

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(400);
    });

    it('returns 404 when approve service returns ScorecardNotFoundError', async () => {
      const { app } = createTestApp({
        approveError: new ScorecardNotFoundError(),
      });

      const response = await authorizedPost(
        app,
        `/api/v1/requisitions/${requisitionId}/scorecards/${scorecardId}/approve`,
      ).send({});

      expect(response.status).toBe(404);
    });
  });

  describe('AI provider error classification on draft generation', () => {
    it.each([
      {
        error: new JdProviderNotConfiguredError(),
        expectedStatus: 503,
        expectedCode: 'provider_not_configured',
      },
      {
        error: new JdProviderConfigurationError('Invalid model configured'),
        expectedStatus: 503,
        expectedCode: 'provider_configuration_error',
      },
      {
        error: new JdProviderAuthError('Rejected API key'),
        expectedStatus: 502,
        expectedCode: 'provider_auth_error',
      },
      {
        error: new JdProviderRateLimitError('Quota exceeded'),
        expectedStatus: 429,
        expectedCode: 'provider_rate_limited',
      },
      {
        error: new JdProviderTimeoutError(),
        expectedStatus: 504,
        expectedCode: 'provider_timeout',
      },
      {
        error: new JdProviderContentBlockedError('Safety filter blocked generation', {
          correlationId: 'req-corr-blocked',
          operation: 'jd_extraction',
          primaryModel: 'gemini-3.6-flash',
          fallbackModel: 'gemini-3.5-flash',
          attemptNumber: 1,
          stage: 'primary',
          httpStatus: 200,
          providerErrorCode: null,
          classification: 'CONTENT_SAFETY',
          durationMs: 120,
          fallbackAttempted: false,
          succeededModel: null,
          failedModel: 'gemini-3.6-flash',
          finishReason: 'SAFETY',
          blockReason: 'SAFETY',
        }),
        expectedStatus: 422,
        expectedCode: 'provider_content_blocked',
      },
      {
        error: new JdProviderInvalidRequestError('400 INVALID_ARGUMENT', {
          correlationId: 'req-corr-invalid-req',
          operation: 'jd_extraction',
          primaryModel: 'gemini-3.6-flash',
          fallbackModel: 'gemini-3.5-flash',
          attemptNumber: 1,
          stage: 'primary',
          httpStatus: 400,
          providerErrorCode: 'INVALID_ARGUMENT',
          classification: 'INVALID_REQUEST',
          durationMs: 95,
          fallbackAttempted: false,
          succeededModel: null,
          failedModel: 'gemini-3.6-flash',
          finishReason: null,
          blockReason: null,
        }),
        expectedStatus: 502,
        expectedCode: 'provider_invalid_request',
      },
      {
        error: new JdProviderResponseError('Extracted schema validation failed', {
          correlationId: 'req-corr-invalid-resp',
          operation: 'jd_extraction',
          primaryModel: 'gemini-3.6-flash',
          fallbackModel: 'gemini-3.5-flash',
          attemptNumber: 1,
          stage: 'response',
          httpStatus: 200,
          providerErrorCode: 'SCHEMA_VALIDATION_FAILED',
          classification: 'RESPONSE_SCHEMA_INVALID',
          durationMs: 210,
          fallbackAttempted: false,
          succeededModel: 'gemini-3.6-flash',
          failedModel: 'gemini-3.6-flash',
          finishReason: 'STOP',
          blockReason: null,
          validationIssues: ['compensation.maximum:invalid_type'],
        }),
        expectedStatus: 502,
        expectedCode: 'provider_invalid_response',
      },
      {
        error: new JdProviderRequestError('Upstream error'),
        expectedStatus: 502,
        expectedCode: 'provider_unavailable',
      },
    ])(
      'maps $expectedCode to HTTP $expectedStatus without leaking internal details',
      async ({ error, expectedStatus, expectedCode }) => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const { app, service } = createTestApp();
          vi.mocked(service.generate).mockRejectedValueOnce(error);

          const response = await authorizedPost(
            app,
            `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
          ).send({ mode: 'ai' });

          expect(response.status).toBe(expectedStatus);
          expect(response.body).toEqual(
            expect.objectContaining({
              error: expectedCode,
              message: expect.any(String),
            }),
          );
          expect(JSON.stringify(response.body)).not.toContain('validationIssues');
          expect(JSON.stringify(response.body)).not.toContain('diagnostics');
          expect(errorSpy).toHaveBeenCalled();
        } finally {
          errorSpy.mockRestore();
        }
      },
    );

    it('propagates sanitized correlation IDs into x-request-id and structured safe route logs without exposing secrets or JD text', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { app, service } = createTestApp();
        vi.mocked(service.generate).mockRejectedValueOnce(
          new JdProviderResponseError('Schema mismatch', {
            correlationId: 'trace-corr-42',
            operation: 'jd_extraction',
            primaryModel: 'gemini-3.6-flash',
            fallbackModel: 'gemini-3.5-flash',
            attemptNumber: 1,
            stage: 'response',
            httpStatus: 200,
            providerErrorCode: 'SCHEMA_VALIDATION_FAILED',
            classification: 'RESPONSE_SCHEMA_INVALID',
            durationMs: 320,
            fallbackAttempted: false,
            succeededModel: 'gemini-3.6-flash',
            failedModel: 'gemini-3.6-flash',
            finishReason: 'STOP',
            blockReason: null,
            validationIssues: ['jobTitle.evidence.sourceStart:invalid_type'],
          }),
        );

        const response = await authorizedPost(
          app,
          `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
        )
          .set('x-request-id', 'trace-corr-42')
          .send({ mode: 'ai' });

        expect(response.status).toBe(502);
        expect(response.headers['x-request-id']).toBe('trace-corr-42');
        expect(response.body).toEqual(
          expect.objectContaining({
            error: 'provider_invalid_response',
          }),
        );

        const logCall = errorSpy.mock.calls.find(
          (args) => typeof args[0] === 'string' && args[0].startsWith('[jd-extraction-route] '),
        );
        expect(logCall).toBeDefined();
        const rawLog = String(logCall?.[0]);
        expect(rawLog).not.toContain(token);
        const parsedLog = JSON.parse(rawLog.replace('[jd-extraction-route] ', '')) as Record<
          string,
          unknown
        >;
        expect(parsedLog).toEqual(
          expect.objectContaining({
            event: 'jd_extraction_route_error',
            correlationId: 'trace-corr-42',
            operation: 'jd_extraction',
            httpResponseStatus: 502,
            clientErrorCode: 'provider_invalid_response',
            primaryModel: 'gemini-3.6-flash',
            fallbackModel: 'gemini-3.5-flash',
            attemptNumber: 1,
            stage: 'response',
            httpStatus: 200,
            providerErrorCode: 'SCHEMA_VALIDATION_FAILED',
            classification: 'RESPONSE_SCHEMA_INVALID',
            durationMs: 320,
            fallbackAttempted: false,
            succeededModel: 'gemini-3.6-flash',
            failedModel: 'gemini-3.6-flash',
            finishReason: 'STOP',
            blockReason: null,
            validationIssues: ['jobTitle.evidence.sourceStart:invalid_type'],
          }),
        );

        // Unsafe characters in x-request-id are replaced with a generated UUID
        vi.mocked(service.generate).mockRejectedValueOnce(new JdProviderTimeoutError());
        const unsafeHeaderRes = await authorizedPost(
          app,
          `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
        )
          .set('x-request-id', 'bad header value with spaces!')
          .send({ mode: 'ai' });
        expect(unsafeHeaderRes.status).toBe(504);
        expect(unsafeHeaderRes.headers['x-request-id']).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        // Multi-provider diagnostics (provider, attemptedProviders, failoverUsed) are logged cleanly
        vi.mocked(service.generate).mockRejectedValueOnce(
          new JdProviderRateLimitError('Rate limited after failover', {
            correlationId: 'trace-corr-groq',
            operation: 'jd_extraction',
            provider: 'groq',
            primaryModel: 'openai/gpt-oss-120b',
            fallbackModel: null,
            attemptNumber: 1,
            stage: 'failover',
            httpStatus: 429,
            providerErrorCode: 'rate_limit_exceeded',
            classification: 'RATE_LIMIT_SCOPED',
            durationMs: 410,
            fallbackAttempted: true,
            failoverUsed: true,
            attemptedProviders: ['gemini', 'groq'],
            succeededModel: null,
            failedModel: 'openai/gpt-oss-120b',
            finishReason: null,
            blockReason: null,
          }),
        );
        const groqRouteRes = await authorizedPost(
          app,
          `/api/v1/requisitions/${requisitionId}/scorecards/drafts`,
        )
          .set('x-request-id', 'trace-corr-groq')
          .send({ mode: 'ai' });
        expect(groqRouteRes.status).toBe(429);
        const groqLogCall = [...errorSpy.mock.calls]
          .reverse()
          .find(
            (args) => typeof args[0] === 'string' && args[0].startsWith('[jd-extraction-route] '),
          );
        const parsedGroqLog = JSON.parse(
          String(groqLogCall?.[0]).replace('[jd-extraction-route] ', ''),
        ) as Record<string, unknown>;
        expect(parsedGroqLog).toEqual(
          expect.objectContaining({
            correlationId: 'trace-corr-groq',
            provider: 'groq',
            failoverUsed: true,
            attemptedProviders: ['gemini', 'groq'],
          }),
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
