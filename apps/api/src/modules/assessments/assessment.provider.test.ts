import { describe, expect, it, vi } from 'vitest';
import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import {
  AssessmentProviderAuthError,
  AssessmentProviderConfigurationError,
  AssessmentProviderNotConfiguredError,
  AssessmentProviderRateLimitError,
  AssessmentProviderRequestError,
  AssessmentProviderResponseError,
  AssessmentProviderTimeoutError,
  CANONICAL_GEMINI_FALLBACK_MODEL,
  CANONICAL_GEMINI_MODEL,
  createAssessmentProvider,
  createDeterministicFakeAssessmentProvider,
  createGeminiAssessmentProvider,
} from './assessment.provider.js';

describe('assessment.provider', () => {
  const sampleInput = {
    jobTitle: 'Backend Engineer',
    criteria: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        key: 'python',
        label: 'Python',
        category: 'SKILL',
        requirementType: 'MUST_HAVE' as const,
        weight: 100,
      },
    ],
    resumeText: 'Experienced in Python and Django.',
  };

  it('fails safely when provider is not configured', async () => {
    const provider = createGeminiAssessmentProvider({});
    await expect(provider.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderNotConfiguredError,
    );
  });

  it('1. Fake provider works in test environment', async () => {
    const originalEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'test';
      const provider = createAssessmentProvider({ providerType: 'fake' });
      const result = await provider.assess(sampleInput);
      expect(result.criteria).toHaveLength(1);
      expect(result.criteria[0]!.status).toBe('MATCH');
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('2. Fake provider is rejected in development', () => {
    const originalEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'development';
      expect(() =>
        createAssessmentProvider({
          providerType: 'fake',
        }),
      ).toThrow(/SECURITY_VIOLATION.*only permitted when NODE_ENV === 'test'/);
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('3. Fake provider is rejected in staging', () => {
    const originalEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'staging';
      expect(() =>
        createAssessmentProvider({
          providerType: 'fake',
        }),
      ).toThrow(/SECURITY_VIOLATION.*only permitted when NODE_ENV === 'test'/);
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('4. Fake provider is rejected in production', () => {
    const originalEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      expect(() =>
        createAssessmentProvider({
          providerType: 'fake',
        }),
      ).toThrow(/SECURITY_VIOLATION.*only permitted when NODE_ENV === 'test'/);
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('5. Fake provider is rejected when NODE_ENV is undefined', () => {
    const originalEnv = process.env['NODE_ENV'];
    try {
      delete process.env['NODE_ENV'];
      expect(() =>
        createAssessmentProvider({
          providerType: 'fake',
        }),
      ).toThrow(/SECURITY_VIOLATION.*only permitted when NODE_ENV === 'test'/);
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('6. Missing provider configuration in production does not select a fake provider', async () => {
    const originalEnv = process.env['NODE_ENV'];
    const originalProvider = process.env['ASSESSMENT_PROVIDER'];
    const originalKey = process.env['GEMINI_API_KEY'];
    try {
      process.env['NODE_ENV'] = 'production';
      delete process.env['ASSESSMENT_PROVIDER'];
      delete process.env['GEMINI_API_KEY'];
      delete process.env['AI_API_KEY'];

      // In production without provider configuration, assess() must throw ASSESSMENT_PROVIDER_NOT_CONFIGURED
      const provider = createAssessmentProvider({});
      await expect(provider.assess(sampleInput)).rejects.toThrow(
        AssessmentProviderNotConfiguredError,
      );
    } finally {
      process.env['NODE_ENV'] = originalEnv;
      if (originalProvider) process.env['ASSESSMENT_PROVIDER'] = originalProvider;
      if (originalKey) process.env['GEMINI_API_KEY'] = originalKey;
    }
  });

  it('returns controlled ASSESSMENT_PROVIDER_NOT_CONFIGURED when credentials are missing', async () => {
    const originalEnv = process.env['NODE_ENV'];
    const originalKey = process.env['GEMINI_API_KEY'];
    try {
      delete process.env['GEMINI_API_KEY'];
      delete process.env['AI_API_KEY'];
      const provider = createAssessmentProvider({
        providerType: 'gemini',
      });
      await expect(provider.assess(sampleInput)).rejects.toThrow(
        AssessmentProviderNotConfiguredError,
      );
    } finally {
      process.env['NODE_ENV'] = originalEnv;
      if (originalKey) process.env['GEMINI_API_KEY'] = originalKey;
    }
  });

  it('performs bounded retries on 429 rate limit and succeeds when recovered', async () => {
    let callCount = 0;
    const mockClient = {
      models: {
        generateContent: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('429 RESOURCE_EXHAUSTED: rate limit exceeded');
          }
          return {
            text: JSON.stringify({
              criteria: [
                {
                  criterionId: '11111111-1111-4111-8111-111111111111',
                  status: 'MATCH',
                  score: 0.95,
                  explanation: 'Python experience confirmed',
                  evidenceQuotes: ['Python and Django'],
                },
              ],
            }),
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: mockClient,
    });

    const result = await provider.assess(sampleInput);
    expect(callCount).toBe(2);
    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(0.95);
  });

  it('performs bounded retries on 503 upstream error and falls back once to gemini-3.5-flash when fallback is enabled', async () => {
    const calledModels: string[] = [];
    const mockClientNoFallback = {
      models: {
        generateContent: vi.fn().mockImplementation(async (req: { model: string }) => {
          calledModels.push(req.model);
          throw new Error('503 UNAVAILABLE: backend service temporarily unavailable');
        }),
      },
    } as unknown as GoogleGenAI;

    const providerNoFallback = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      maxRetries: 2,
      sleep: async () => undefined,
      client: mockClientNoFallback,
    });

    await expect(providerNoFallback.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderRequestError,
    );
    expect(calledModels).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);

    const fallbackModels: string[] = [];
    const fallbackClient = {
      models: {
        generateContent: vi.fn().mockImplementation(async (req: { model: string }) => {
          fallbackModels.push(req.model);
          if (req.model === 'gemini-3.6-flash') {
            throw new Error('503 UNAVAILABLE: capacity squeeze');
          }
          return {
            text: JSON.stringify({
              criteria: [
                {
                  criterionId: '11111111-1111-4111-8111-111111111111',
                  status: 'MATCH',
                  score: 0.9,
                  explanation: 'Fallback succeeded',
                  evidenceQuotes: ['Python and Django'],
                },
              ],
            }),
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const providerWithFallback = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: CANONICAL_GEMINI_MODEL,
      fallbackModel: CANONICAL_GEMINI_FALLBACK_MODEL,
      maxRetries: 2,
      sleep: async () => undefined,
      client: fallbackClient,
    });

    const fallbackRes = await providerWithFallback.assess(sampleInput);
    expect(fallbackModels).toEqual([
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ]);
    expect(fallbackRes.model).toBe('gemini-3.5-flash');
    expect(fallbackRes.primaryModel).toBe('gemini-3.6-flash');
    expect(fallbackRes.fallbackUsed).toBe(true);
  });

  it('deterministic fake provider matches keywords and returns exact excerpts', async () => {
    const provider = createDeterministicFakeAssessmentProvider();
    const result = await provider.assess(sampleInput);

    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.criterionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(1.0);
    expect(result.criteria[0]!.evidenceQuotes).toContain('Python');
    expect(result.promptVersion).toBe('2026-11-gemini-v1');
    expect(result.inputHash).toBeDefined();
    expect(result.outputHash).toBeDefined();
  });

  it('deterministic fake provider simulates timeouts safely', async () => {
    const timeoutProvider = createDeterministicFakeAssessmentProvider({ forceError: 'TIMEOUT' });
    await expect(timeoutProvider.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderTimeoutError,
    );
  });

  it('validates Gemini provider output against schema and omits Gemini 3 sampling overrides', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        criteria: [
          {
            criterionId: '11111111-1111-4111-8111-111111111111',
            status: 'MATCH',
            score: 0.9,
            explanation: 'Python experience confirmed',
            evidenceQuotes: ['Python and Django'],
          },
        ],
      }),
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    const result = await provider.assess(sampleInput);

    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(0.9);
    const callReq = mockGenerateContent.mock.calls[0]?.[0] as {
      model?: string;
      config?: Record<string, unknown>;
    };
    expect(callReq.model).toBe('gemini-3.6-flash');
    expect(callReq.config?.responseMimeType).toBe('application/json');
    expect(callReq.config?.responseSchema).toBeDefined();
    expect(callReq.config?.systemInstruction).toBeDefined();
    expect(callReq.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    const thinkingConfig = callReq.config?.thinkingConfig as Record<string, unknown> | undefined;
    expect(thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(thinkingConfig?.thinking_budget).toBeUndefined();
    expect(callReq.config?.candidateCount).toBeUndefined();
    expect(callReq.config?.candidate_count).toBeUndefined();
    expect(callReq.config?.temperature).toBeUndefined();
    expect(callReq.config?.topP).toBeUndefined();
    expect(callReq.config?.top_p).toBeUndefined();
    expect(callReq.config?.topK).toBeUndefined();
    expect(callReq.config?.top_k).toBeUndefined();
  });

  it('rejects malformed JSON from Gemini provider', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: 'not a json',
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    await expect(provider.assess(sampleInput)).rejects.toThrow(AssessmentProviderResponseError);
  });

  it('falls back past empty strings to subsequent API keys and resolves Free-Tier GEMINI_MODEL / AI_FALLBACK_MODEL env vars', async () => {
    const originalEnv = { ...process.env };
    try {
      process.env['NODE_ENV'] = 'production';
      process.env['ASSESSMENT_PROVIDER'] = 'gemini';
      process.env['GEMINI_API_KEY'] = '   ';
      process.env['AI_API_KEY'] = 'gemini-secret-key';
      process.env['GEMINI_MODEL'] = '';
      process.env['AI_MODEL'] = 'gemini-3.6-flash';
      process.env['GEMINI_FALLBACK_MODEL'] = '';
      process.env['AI_FALLBACK_MODEL'] = 'gemini-3.5-flash';

      const mockGenerateContent = vi.fn().mockImplementation(async (req) => {
        if (req.model === 'gemini-3.6-flash') {
          throw new Error('503 UNAVAILABLE');
        }
        expect(req.model).toBe('gemini-3.5-flash');
        return {
          text: JSON.stringify({
            criteria: [
              {
                criterionId: '11111111-1111-4111-8111-111111111111',
                status: 'MATCH',
                score: 0.95,
                explanation: 'Matches requirements',
                evidenceQuotes: ['Experienced in Python'],
              },
            ],
          }),
        };
      });

      const mockClient = {
        models: {
          generateContent: mockGenerateContent,
        },
      } as unknown as GoogleGenAI;

      const provider = createAssessmentProvider({
        sleep: async () => undefined,
        client: mockClient,
      });

      const result = await provider.assess(sampleInput);
      expect(result.criteria[0]!.status).toBe('MATCH');
      expect(result.provider).toBe('gemini');
      expect(result.model).toBe('gemini-3.5-flash');
      expect(result.fallbackUsed).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledTimes(4);
    } finally {
      process.env = originalEnv;
    }
  });

  it('rejects disallowed Gemini models (3.8, Flash-Lite) and classifies 401/403 auth, 404 model, and project-quota 429 errors without retry or fallback', async () => {
    for (const disallowedModel of ['gemini-3.8-flash', 'gemini-3.6-flash-lite', 'gemini-2.5-pro']) {
      const deprecatedProvider = createGeminiAssessmentProvider({
        apiKey: 'valid-key',
        model: disallowedModel,
      });
      await expect(deprecatedProvider.assess(sampleInput)).rejects.toThrow(
        AssessmentProviderConfigurationError,
      );
    }

    const authGenerate = vi
      .fn()
      .mockRejectedValue(new Error('401 UNAUTHENTICATED: API_KEY_INVALID'));
    const authProvider = createGeminiAssessmentProvider({
      apiKey: 'bad-key',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: authGenerate } } as unknown as GoogleGenAI,
    });
    await expect(authProvider.assess(sampleInput)).rejects.toThrow(AssessmentProviderAuthError);
    expect(authGenerate).toHaveBeenCalledTimes(1);

    const modelNotFoundGenerate = vi
      .fn()
      .mockRejectedValue(new Error('404 NOT_FOUND: model not found'));
    const modelNotFoundProvider = createGeminiAssessmentProvider({
      apiKey: 'valid-key',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: modelNotFoundGenerate } } as unknown as GoogleGenAI,
    });
    await expect(modelNotFoundProvider.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderConfigurationError,
    );
    expect(modelNotFoundGenerate).toHaveBeenCalledTimes(1);

    const projectQuotaGenerate = vi
      .fn()
      .mockRejectedValue(
        new Error('429 RESOURCE_EXHAUSTED: GenerateRequestsPerDayPerProjectPerModel exhausted'),
      );
    const projectQuotaProvider = createGeminiAssessmentProvider({
      apiKey: 'valid-key',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: projectQuotaGenerate } } as unknown as GoogleGenAI,
    });
    await expect(projectQuotaProvider.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderRateLimitError,
    );
    expect(projectQuotaGenerate).toHaveBeenCalledTimes(1);
  });
});
