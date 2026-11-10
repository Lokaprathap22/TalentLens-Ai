import { describe, expect, it, vi } from 'vitest';
import { ThinkingLevel, type GoogleGenAI } from '@google/genai';

import { runWithRequestContext } from '../../middleware/request-context.js';
import { scorecardMetadataSchema } from './scorecard.metadata.js';
import {
  CANONICAL_GROQ_MODEL,
  JdProviderAuthError,
  JdProviderConfigurationError,
  JdProviderContentBlockedError,
  JdProviderInvalidRequestError,
  JdProviderNotConfiguredError,
  JdProviderRateLimitError,
  JdProviderRequestError,
  JdProviderResponseError,
  JdProviderTimeoutError,
  cleanGeminiSchemaNode,
  createGeminiJdExtractionProvider,
  createGroqJdExtractionProvider,
  createMultiProviderJdExtractionProvider,
  getJdExtractionResponseSchema,
  getJdExtractionStrictJsonSchema,
  jdExtractionResponseSchema,
  type JdExtractionDiagnosticLog,
  type ProviderFailoverEvent,
} from './jd-extraction.provider.js';

const validOutput = {
  jobTitle: {
    originalText: 'Engineer',
    evidence: {
      sourceQuote: 'Engineer',
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: 'PENDING_RECRUITER_REVIEW',
    },
  },
  minimumExperienceYears: null,
  maximumExperienceYears: null,
  experienceRequirement: null,
  requiredSkills: [
    {
      originalText: 'TypeScript',
      evidence: {
        sourceQuote: 'TypeScript',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
  preferredSkills: [],
  educationRequirements: [],
  certifications: [],
  domainExperience: [],
  compensation: null,
  noticePeriod: null,
  otherRequirements: [],
  warnings: [],
  criteria: [
    {
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      label: 'TypeScript',
      description: 'TypeScript experience',
      weight: 100,
      evidence: {
        sourceQuote: 'TypeScript',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
};

describe('JD extraction provider', () => {
  it('derives a Gemini-compatible JSON schema matching the extraction contract', () => {
    const schema = getJdExtractionResponseSchema();
    expect(schema.type).toBe('OBJECT');

    const requiredKeys = schema.required as string[];
    expect(requiredKeys).toEqual(
      expect.arrayContaining([
        'jobTitle',
        'minimumExperienceYears',
        'maximumExperienceYears',
        'experienceRequirement',
        'requiredSkills',
        'preferredSkills',
        'educationRequirements',
        'certifications',
        'domainExperience',
        'compensation',
        'noticePeriod',
        'otherRequirements',
        'warnings',
        'criteria',
      ]),
    );

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties).toBeDefined();

    // jobTitle must be an object { originalText, evidence } and nullable: true (OpenAPI 3.0 Gemini schema)
    const jobTitleSchema = properties.jobTitle;
    expect(jobTitleSchema).toBeDefined();
    expect(jobTitleSchema?.type).toBe('OBJECT');
    expect(jobTitleSchema?.nullable).toBe(true);

    const jobTitleProps =
      (jobTitleSchema?.properties as Record<string, Record<string, unknown>>) || {};
    expect(jobTitleProps.originalText).toBeDefined();
    expect(jobTitleProps.evidence).toBeDefined();

    // Verify evidence structure includes PENDING_RECRUITER_REVIEW
    const evidenceProps =
      (jobTitleProps.evidence?.properties as Record<string, Record<string, unknown>>) || {};
    expect(evidenceProps.sourceQuote).toBeDefined();
    expect(evidenceProps.sourceStart).toBeDefined();
    expect(evidenceProps.sourceEnd).toBeDefined();
    expect((evidenceProps.verificationStatus?.enum as string[]) || []).toContain(
      'PENDING_RECRUITER_REVIEW',
    );

    // Verify nullable fields declare nullable: true without anyOf/oneOf
    const nullableFields = [
      'jobTitle',
      'minimumExperienceYears',
      'maximumExperienceYears',
      'experienceRequirement',
      'compensation',
      'noticePeriod',
    ] as const;

    for (const fieldName of nullableFields) {
      const fieldSchema = properties[fieldName];
      expect(fieldSchema).toBeDefined();
      expect(fieldSchema?.nullable).toBe(true);
      expect(fieldSchema?.anyOf).toBeUndefined();
      expect(fieldSchema?.oneOf).toBeUndefined();
    }

    // Recursively verify disallowed Gemini OpenAPI keywords ($schema, anyOf, oneOf) are absent
    const disallowed = ['$schema', 'anyOf', 'oneOf'];
    function checkNode(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(checkNode);
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k !== 'properties') {
          expect(disallowed).not.toContain(k);
          checkNode(v);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const propSchema of Object.values(v)) {
            checkNode(propSchema);
          }
        }
      }
    }
    checkNode(schema);
  });

  it('preserves minItems, maxItems, minimum, and maximum in cleanGeminiSchemaNode while removing unsupported keywords', () => {
    const rawSampleNode = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1, // unsupported, must be stripped
          maxLength: 100, // unsupported, must be stripped
          nullable: true, // unsupported, must be stripped
        },
        tags: {
          type: 'array',
          minItems: 1, // supported, must be preserved
          maxItems: 20, // supported, must be preserved
          items: {
            type: 'string',
            minLength: 2, // unsupported, must be stripped
          },
        },
        score: {
          type: 'number',
          minimum: 0, // supported, must be preserved
          maximum: 100, // supported, must be preserved
        },
      },
      required: ['title', 'tags', 'score'],
      additionalProperties: false,
    };

    const cleaned = cleanGeminiSchemaNode(rawSampleNode) as Record<string, unknown>;
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.type).toBe('object');
    expect(cleaned.required).toEqual(['title', 'tags', 'score']);
    expect(cleaned.additionalProperties).toBe(false);

    const cleanedProps = cleaned.properties as Record<string, Record<string, unknown>>;
    // title: minLength, maxLength, and nullable stripped
    expect(cleanedProps.title).toEqual({ type: 'string' });
    expect(cleanedProps.title?.nullable).toBeUndefined();

    // tags: minItems and maxItems preserved, inner items minLength stripped
    expect(cleanedProps.tags?.minItems).toBe(1);
    expect(cleanedProps.tags?.maxItems).toBe(20);
    expect(cleanedProps.tags?.items).toEqual({ type: 'string' });

    // score: minimum and maximum preserved
    expect(cleanedProps.score?.minimum).toBe(0);
    expect(cleanedProps.score?.maximum).toBe(100);
  });

  it('accepts valid structured output and passes responseSchema to Gemini', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify(validOutput),
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      client: mockClient,
    });

    const result = await provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(result).toEqual(validOutput);

    // Verify Gemini received canonical gemini-3.6-flash defaults, thinkingConfig, response schema,
    // and zero unsupported Gemini 3 sampling overrides (temperature, topP, topK, candidateCount, thinkingBudget)
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.6-flash',
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseSchema: jdExtractionResponseSchema,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        }),
      }),
    );
    const callConfig = mockGenerateContent.mock.calls[0]?.[0]?.config as Record<string, unknown>;
    const thinkingConfig = callConfig.thinkingConfig as Record<string, unknown> | undefined;
    expect(thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(thinkingConfig?.thinkingLevel).not.toBe(ThinkingLevel.MINIMAL);
    expect(thinkingConfig?.thinkingLevel).not.toBe('minimal');
    expect(thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(thinkingConfig?.thinking_budget).toBeUndefined();
    expect(callConfig.candidateCount).toBeUndefined();
    expect(callConfig.candidate_count).toBeUndefined();
    expect(callConfig.temperature).toBeUndefined();
    expect(callConfig.topP).toBeUndefined();
    expect(callConfig.top_p).toBeUndefined();
    expect(callConfig.topK).toBeUndefined();
    expect(callConfig.top_k).toBeUndefined();
  });

  it('rejects invalid response shape where jobTitle is a string instead of object', async () => {
    const invalidOutput = {
      ...validOutput,
      jobTitle: 'Senior Systems Engineer', // String instead of { originalText, evidence }
    };

    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify(invalidOutput),
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toThrow(
      JdProviderResponseError,
    );
  });

  it('rejects invalid response shape with missing required fields or invalid enum', async () => {
    const invalidVerificationOutput = {
      ...validOutput,
      criteria: [
        {
          ...validOutput.criteria[0],
          evidence: {
            sourceQuote: 'TypeScript',
            sourceStart: null,
            sourceEnd: null,
            verificationStatus: 'INVALID_STATUS',
          },
        },
      ],
    };

    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify(invalidVerificationOutput),
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toThrow(
      JdProviderResponseError,
    );
  });

  it('rejects malformed model output without exposing it', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '{"criteria":',
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderResponseError,
    );
  });

  it('fails safely when not configured', async () => {
    const provider = createGeminiJdExtractionProvider({});

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderNotConfiguredError,
    );
  });

  it('sanitizes provider timeouts', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockRejectedValue(new Error('Request timed out (TIMED_OUT)')),
      },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      timeoutMs: 1_000,
      maxRetries: 0,
      sleep: async () => undefined,
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderTimeoutError,
    );
  });

  it('handles 401 and 403 auth errors and rejects without retry or fallback', async () => {
    for (const authErrorMessage of [
      '[403] API key not valid',
      '[401 UNAUTHENTICATED] API_KEY_INVALID',
    ]) {
      const generateContent = vi.fn().mockRejectedValue(new Error(authErrorMessage));
      const mockClient = {
        models: { generateContent },
      } as unknown as GoogleGenAI;

      const provider = createGeminiJdExtractionProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 2,
        sleep: async () => undefined,
        client: mockClient,
      });

      await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
        JdProviderAuthError,
      );
      expect(generateContent).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects placeholder API keys, Flash-Lite models, gemini-3.8-flash, and legacy Gemini models as configuration errors', async () => {
    const generateContent = vi.fn();
    const mockClient = {
      models: { generateContent },
    } as unknown as GoogleGenAI;

    const placeholderProvider = createGeminiJdExtractionProvider({
      apiKey: 'your_gemini_api_key_here',
      model: 'gemini-3.6-flash',
      client: mockClient,
    });

    await expect(
      placeholderProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
    ).rejects.toBeInstanceOf(JdProviderConfigurationError);

    for (const invalidModel of [
      'gpt-4o',
      'gemini-3.8-flash',
      'gemini-3.6-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-1.5-pro',
    ]) {
      const invalidModelProvider = createGeminiJdExtractionProvider({
        apiKey: 'valid-looking-key-123',
        model: invalidModel,
        client: mockClient,
      });

      await expect(
        invalidModelProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
      ).rejects.toBeInstanceOf(JdProviderConfigurationError);
    }
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('classifies 404 model not found as configuration error without retry or fallback', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValue(new Error('[404 NOT_FOUND] models/gemini-3.6-flash is not found'));
    const mockClient = {
      models: { generateContent },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'valid-looking-key-123',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderConfigurationError,
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('throws JdProviderRateLimitError on exhausted 429 and redacts leaked API keys in sanitized provider errors', async () => {
    const leakedKey = 'AIzaSySecretKey12345678901234567890';
    const rateLimitGenerateContent = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `429 RESOURCE_EXHAUSTED for https://generativelanguage.googleapis.com?key=${leakedKey}`,
        ),
      );

    const rateLimitProvider = createGeminiJdExtractionProvider({
      apiKey: leakedKey,
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      maxRetries: 0,
      sleep: async () => undefined,
      client: { models: { generateContent: rateLimitGenerateContent } } as unknown as GoogleGenAI,
    });

    await expect(
      rateLimitProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
    ).rejects.toBeInstanceOf(JdProviderRateLimitError);

    const upstreamGenerateContent = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `500 Internal Error for https://generativelanguage.googleapis.com?key=${leakedKey}`,
        ),
      );

    const upstreamProvider = createGeminiJdExtractionProvider({
      apiKey: leakedKey,
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      maxRetries: 0,
      sleep: async () => undefined,
      client: { models: { generateContent: upstreamGenerateContent } } as unknown as GoogleGenAI,
    });

    let caught: unknown;
    try {
      await upstreamProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(JdProviderRequestError);
    expect((caught as Error).message).not.toContain(leakedKey);
    expect((caught as Error).message).toContain('[REDACTED]');
  });

  it('handles 429 rate limit with bounded retries', async () => {
    let callCount = 0;
    const generateContent = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('429 RESOURCE_EXHAUSTED');
      }
      return {
        text: JSON.stringify(validOutput),
      };
    });

    const mockClient = {
      models: { generateContent },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: mockClient,
    });

    const result = await provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(result).toEqual(validOutput);
    expect(callCount).toBe(2);
  });

  it('recovers from 503 capacity failures using backoff + bounded fallback while keeping JdExtractionOutput keys unchanged', async () => {
    const sleeps: number[] = [];
    const calledModels: string[] = [];
    const onFallback = vi.fn();
    const onExecutionMetadata = vi.fn();

    const generateContent = vi.fn().mockImplementation(async (req: { model: string }) => {
      calledModels.push(req.model);
      if (req.model === 'gemini-3.6-flash') {
        throw new Error('503 UNAVAILABLE: capacity exhausted');
      }
      return { text: JSON.stringify(validOutput) };
    });

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      initialDelayMs: 500,
      maxRetryDelayMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      onFallback,
      onExecutionMetadata,
      client: { models: { generateContent } } as unknown as GoogleGenAI,
    });

    const result = await provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(result).toEqual(validOutput);
    expect(calledModels).toEqual([
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ]);
    expect(sleeps).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith({
      fromModel: 'gemini-3.6-flash',
      toModel: 'gemini-3.5-flash',
      reasonKind: 'SERVICE_UNAVAILABLE',
      primaryAttempts: 3,
    });
    expect(onExecutionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryModel: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        modelUsed: 'gemini-3.5-flash',
        fallbackUsed: true,
        attemptedModels: ['gemini-3.6-flash', 'gemini-3.5-flash'],
      }),
    );
  });

  it('distinguishes project quota 429, model-scoped RPM 429 fallback, 400 invalid argument, and safety blocks', async () => {
    // 1. Project daily / zero quota -> 1 call only, no fallback
    const rpdMock = vi.fn().mockRejectedValue(
      new Error(
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [
                  {
                    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                    quotaValue: '0',
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    const rpdProvider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: rpdMock } } as unknown as GoogleGenAI,
    });
    await expect(
      rpdProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
    ).rejects.toBeInstanceOf(JdProviderRateLimitError);
    expect(rpdMock).toHaveBeenCalledTimes(1);

    // 2. Model-scoped RPM -> retries primary + falls back to gemini-3.5-flash once
    const rpmCalls: string[] = [];
    const rpmMock = vi.fn().mockImplementation(async (req: { model: string }) => {
      rpmCalls.push(req.model);
      if (req.model === 'gemini-3.6-flash') {
        throw new Error(
          JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [
                    {
                      quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
                      quotaDimensions: { model: 'gemini-3.6-flash' },
                    },
                  ],
                },
              ],
            },
          }),
        );
      }
      return { text: JSON.stringify(validOutput) };
    });
    const rpmProvider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: rpmMock } } as unknown as GoogleGenAI,
    });
    const rpmRes = await rpmProvider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(rpmRes).toEqual(validOutput);
    expect(rpmCalls).toEqual([
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ]);

    // 3. 400 INVALID_ARGUMENT and content safety blocks fail cleanly in 1 call
    const badReqMock = vi.fn().mockRejectedValue(new Error('400 INVALID_ARGUMENT: bad payload'));
    const badReqProvider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: badReqMock } } as unknown as GoogleGenAI,
    });
    await expect(
      badReqProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
    ).rejects.toBeInstanceOf(JdProviderInvalidRequestError);
    expect(badReqMock).toHaveBeenCalledTimes(1);

    const safetyMock = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'SAFETY' }],
      text: '',
    });
    const safetyProvider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      maxRetries: 2,
      sleep: async () => undefined,
      client: { models: { generateContent: safetyMock } } as unknown as GoogleGenAI,
    });
    await expect(
      safetyProvider.extract({ jobTitle: 'Engineer', jdText: 'JD' }),
    ).rejects.toBeInstanceOf(JdProviderContentBlockedError);
    expect(safetyMock).toHaveBeenCalledTimes(1);
  });

  it('requires nullable subfields in jdExtractionGeminiSchema and normalizes omitted nullable subfields from Gemini 200 responses to null', async () => {
    const schema = getJdExtractionResponseSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const jobTitleProps =
      (properties.jobTitle?.properties as Record<string, Record<string, unknown>>) || {};
    const evidenceRequired = (jobTitleProps.evidence?.required as string[]) || [];
    expect(evidenceRequired).toEqual(
      expect.arrayContaining(['sourceQuote', 'sourceStart', 'sourceEnd', 'verificationStatus']),
    );
    expect((properties.compensation?.required as string[]) || []).toEqual(
      expect.arrayContaining([
        'minimum',
        'maximum',
        'currency',
        'period',
        'originalText',
        'evidence',
      ]),
    );
    expect((properties.noticePeriod?.required as string[]) || []).toEqual(
      expect.arrayContaining(['normalizedDays', 'originalUnit', 'originalText', 'evidence']),
    );

    const omittedSubfieldsPayload = {
      jobTitle: {
        originalText: 'Junior Backend Software Engineer',
        evidence: {
          sourceQuote: 'Junior Backend Software Engineer',
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
      minimumExperienceYears: 1,
      maximumExperienceYears: 2,
      experienceRequirement: {
        originalText: '1 to 2 years',
        evidence: {
          sourceQuote: '1 to 2 years',
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
      requiredSkills: [
        {
          originalText: 'TypeScript',
          evidence: {
            sourceQuote: 'TypeScript',
            verificationStatus: 'PENDING_RECRUITER_REVIEW',
          },
        },
      ],
      preferredSkills: [],
      educationRequirements: [],
      certifications: [],
      domainExperience: [],
      compensation: {
        minimum: 800000,
        currency: '',
        originalText: 'INR 800000 - 1200000 per year',
        evidence: {
          sourceQuote: 'INR 800000 - 1200000 per year',
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
      noticePeriod: {
        originalText: '30 days preferred',
        evidence: {
          sourceQuote: '30 days preferred',
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
      otherRequirements: [],
      warnings: [],
      criteria: [
        {
          category: 'SKILL',
          requirementType: 'MUST_HAVE',
          label: 'TypeScript',
          description: 'Strong proficiency in TypeScript',
          weight: 100,
          evidence: {
            sourceQuote: 'TypeScript',
            verificationStatus: 'PENDING_RECRUITER_REVIEW',
          },
        },
      ],
    };

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      client: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify(omittedSubfieldsPayload),
            candidates: [{ finishReason: 'STOP' }],
          }),
        },
      } as unknown as GoogleGenAI,
    });

    const result = await provider.extract({
      jobTitle: 'Junior Backend Software Engineer',
      jdText: 'TypeScript',
    });

    expect(result.jobTitle?.evidence).toEqual({
      sourceQuote: 'Junior Backend Software Engineer',
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: 'PENDING_RECRUITER_REVIEW',
    });
    expect(result.compensation).toEqual({
      minimum: 800000,
      maximum: null,
      currency: null,
      period: null,
      originalText: 'INR 800000 - 1200000 per year',
      evidence: {
        sourceQuote: 'INR 800000 - 1200000 per year',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    });
    expect(result.noticePeriod).toEqual({
      normalizedDays: null,
      originalUnit: null,
      originalText: '30 days preferred',
      evidence: {
        sourceQuote: '30 days preferred',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    });

    const metadataParse = scorecardMetadataSchema.safeParse({
      contractVersion: 1,
      extractionSchemaVersion: 'jd-extraction-v2',
      jobTitle: result.jobTitle,
      requiredSkills: result.requiredSkills,
      preferredSkills: result.preferredSkills,
      educationRequirements: result.educationRequirements,
      certifications: result.certifications,
      domainExperience: result.domainExperience,
      experience: {
        minimumYears: result.minimumExperienceYears,
        maximumYears: result.maximumExperienceYears,
        requirement: result.experienceRequirement,
      },
      compensation: result.compensation,
      notice: result.noticePeriod,
      otherRequirements: result.otherRequirements,
      warnings: result.warnings,
    });
    expect(metadataParse.success).toBe(true);
  });

  it('still rejects invalid scalar types or negative offsets in nullable fields with JdProviderResponseError', async () => {
    const wrongTypePayload = {
      ...validOutput,
      compensation: {
        minimum: 'not-a-number',
        maximum: null,
        currency: 'USD',
        period: 'year',
        originalText: 'Competitive',
        evidence: {
          sourceQuote: 'Competitive',
          sourceStart: -1,
          sourceEnd: null,
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
    };

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      client: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify(wrongTypePayload),
            candidates: [{ finishReason: 'STOP' }],
          }),
        },
      } as unknown as GoogleGenAI,
    });

    let caught: unknown;
    try {
      await provider.extract({ jobTitle: 'Engineer', jdText: 'Competitive' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(JdProviderResponseError);
    expect((caught as JdProviderResponseError).diagnostics?.classification).toBe(
      'RESPONSE_SCHEMA_INVALID',
    );
    expect((caught as JdProviderResponseError).diagnostics?.validationIssues).toEqual(
      expect.arrayContaining([
        'compensation.minimum:invalid_type',
        'compensation.evidence.sourceStart:too_small',
      ]),
    );
  });

  it('emits structured diagnostic logs with correlation IDs and strictly redacts secrets, cookies, JD text, and raw model responses', async () => {
    const logs: JdExtractionDiagnosticLog[] = [];
    const secretKey = 'AIzaSyDiagnosticSecretKey1234567890';
    const sessionSecret = 'session_secret_cookie_value_999';
    const bearerSecret = 'eyJhbGciOiJIUzI1NiJ9.secretpayload.signature';
    const jdSecretMarker = 'CONFIDENTIAL_JD_MARKER_TEXT';
    const rawResponseMarker = 'RAW_MODEL_OUTPUT_MARKER_TEXT';

    let attempt = 0;
    const generateContent = vi.fn().mockImplementation(async (req: { model: string }) => {
      attempt += 1;
      if (req.model === 'gemini-3.6-flash') {
        throw new Error(
          `503 UNAVAILABLE url=https://generativelanguage.googleapis.com/v1?key=${secretKey} Authorization: Bearer ${bearerSecret} Cookie: talentlens_session=${sessionSecret}`,
        );
      }
      return {
        text: JSON.stringify({ malformed: rawResponseMarker }).slice(0, 14),
        candidates: [{ finishReason: 'STOP' }],
      };
    });

    const provider = createGeminiJdExtractionProvider({
      apiKey: secretKey,
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 1,
      sleep: async () => undefined,
      onDiagnosticLog: (entry) => logs.push(entry),
      client: { models: { generateContent } } as unknown as GoogleGenAI,
    });

    let caught: unknown;
    await runWithRequestContext('req-corr-jd-123', async () => {
      try {
        await provider.extract({ jobTitle: 'Engineer', jdText: jdSecretMarker });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(JdProviderResponseError);
    expect(attempt).toBe(3); // primary + 1 retry + 1 fallback (200 invalid JSON)
    expect(logs.map((entry) => entry.event)).toEqual([
      'jd_extraction_attempt_failed',
      'jd_extraction_attempt_failed',
      'jd_extraction_fallback',
      'jd_extraction_fallback_recovered',
      'jd_extraction_failed',
    ]);

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(secretKey);
    expect(serializedLogs).not.toContain(sessionSecret);
    expect(serializedLogs).not.toContain(bearerSecret);
    expect(serializedLogs).not.toContain(jdSecretMarker);
    expect(serializedLogs).not.toContain(rawResponseMarker);

    const terminalLog = logs.at(-1)!;
    expect(terminalLog).toEqual(
      expect.objectContaining({
        correlationId: 'req-corr-jd-123',
        operation: 'jd_extraction',
        primaryModel: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        attemptNumber: 3,
        stage: 'response',
        httpStatus: 200,
        providerErrorCode: 'INVALID_JSON',
        classification: 'RESPONSE_INVALID_JSON',
        fallbackAttempted: true,
        succeededModel: 'gemini-3.5-flash',
        failedModel: 'gemini-3.5-flash',
        finishReason: 'STOP',
        blockReason: null,
      }),
    );
    expect(typeof terminalLog.durationMs).toBe('number');
  });

  it('derives an OpenAI/Groq strict JSON schema with additionalProperties: false and exhaustive required keys', () => {
    const strictSchema = getJdExtractionStrictJsonSchema();
    expect(strictSchema.type).toBe('object');
    expect(strictSchema.additionalProperties).toBe(false);

    function assertStrictObjectCompliance(node: unknown, pathLabel = '<root>'): void {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((child, idx) => assertStrictObjectCompliance(child, `${pathLabel}[${idx}]`));
        return;
      }
      const record = node as Record<string, unknown>;
      expect(record.nullable, `Unexpected OpenAPI nullable at ${pathLabel}`).toBeUndefined();
      if (record.type === 'object' && record.properties && typeof record.properties === 'object') {
        expect(
          record.additionalProperties,
          `Missing additionalProperties:false at ${pathLabel}`,
        ).toBe(false);
        const propKeys = Object.keys(record.properties as Record<string, unknown>);
        expect(record.required, `Required mismatch at ${pathLabel}`).toEqual(propKeys);
        for (const [k, v] of Object.entries(record.properties as Record<string, unknown>)) {
          assertStrictObjectCompliance(v, `${pathLabel}.${k}`);
        }
      }
      if (record.items) {
        assertStrictObjectCompliance(record.items, `${pathLabel}.items`);
      }
      if (Array.isArray(record.anyOf)) {
        record.anyOf.forEach((opt, i) =>
          assertStrictObjectCompliance(opt, `${pathLabel}.anyOf[${i}]`),
        );
      }
    }

    assertStrictObjectCompliance(strictSchema);

    const props = strictSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.minimumExperienceYears).toEqual({ type: ['number', 'null'] });
    expect(props.jobTitle?.anyOf).toHaveLength(2);
    expect(props.compensation?.anyOf).toHaveLength(2);
    expect(props.noticePeriod?.anyOf).toHaveLength(2);
    expect(typeof props.criteria?.description).toBe('string');
    expect(props.criteria?.description).toContain('summing to 100');
  });

  it('executes Groq JD extraction with strict json_schema, json_object fallback, error mapping, and secret redaction', async () => {
    const groqOk = (payload: unknown, model = CANONICAL_GROQ_MODEL) =>
      new Response(
        JSON.stringify({
          model,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    // 1. Valid Groq extraction including nullable omission preprocessing
    const omittedSubfieldsPayload = {
      ...validOutput,
      compensation: {
        minimum: 120000,
        maximum: null,
        currency: '',
        period: null,
        originalText: '120k USD',
        evidence: {
          sourceQuote: '120k USD',
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
    };
    const capturedCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const groqProvider = createGroqJdExtractionProvider({
      apiKey: 'gsk_valid_jd_key_123',
      fetchFn: vi.fn(async (url, init) => {
        capturedCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return groqOk(omittedSubfieldsPayload);
      }),
    });

    const extracted = await groqProvider.extract({
      jobTitle: 'Engineer',
      jdText: 'TypeScript 120k USD',
    });
    expect(extracted.compensation?.currency).toBeNull();
    expect(extracted.compensation?.evidence.sourceStart).toBeNull();
    expect(capturedCalls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((capturedCalls[0]?.body.response_format as Record<string, unknown>).type).toBe(
      'json_schema',
    );
    const messages = capturedCalls[0]?.body.messages as Array<{ role: string; content: string }>;
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain(
      'populate criteria with concrete weighted scorecard evaluation items',
    );
    expect(systemPrompt).toContain('prose or bullet points');

    // 2. json_validate_failed triggers fallback to json_object
    const formats: string[] = [];
    const fallbackProvider = createGroqJdExtractionProvider({
      apiKey: 'gsk_valid_jd_key_123',
      fetchFn: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { response_format: { type: string } };
        formats.push(body.response_format.type);
        if (formats.length === 1) {
          return new Response(
            JSON.stringify({
              error: { code: 'json_validate_failed', message: 'Grammar unsupported' },
            }),
            { status: 400 },
          );
        }
        return groqOk(validOutput);
      }),
    });
    await fallbackProvider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(formats).toEqual(['json_schema', 'json_object']);

    // 3. content_filter maps to JdProviderContentBlockedError
    const blockedProvider = createGroqJdExtractionProvider({
      apiKey: 'gsk_valid_jd_key_123',
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: CANONICAL_GROQ_MODEL,
              choices: [{ finish_reason: 'content_filter', message: { content: '' } }],
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(
      blockedProvider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' }),
    ).rejects.toThrow(JdProviderContentBlockedError);

    // 4. Schema invalid response captures validationIssues & scrubs JD text / keys from logs
    const logs: JdExtractionDiagnosticLog[] = [];
    const secretMarker = 'gsk_secret_jd_leak_999';
    const jdMarker = 'SECRET_JD_CONTENT_MARKER';
    const badSchemaProvider = createGroqJdExtractionProvider({
      apiKey: secretMarker,
      maxRetries: 0,
      maxValidationRetries: 0,
      onDiagnosticLog: (entry) => logs.push(entry),
      fetchFn: vi.fn(async () => groqOk({ ...validOutput, jobTitle: 'not-an-object' })),
    });
    let caught: unknown;
    try {
      await badSchemaProvider.extract({ jobTitle: 'Engineer', jdText: jdMarker });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JdProviderResponseError);
    expect((caught as JdProviderResponseError).diagnostics?.provider).toBe('groq');
    expect((caught as JdProviderResponseError).diagnostics?.validationIssues).toContain(
      'jobTitle:invalid_type',
    );
    const logBlob = JSON.stringify(logs);
    expect(logBlob).not.toContain(secretMarker);
    expect(logBlob).not.toContain(jdMarker);
  });

  it('executes ordered multi-provider JD failover (Gemini -> Groq) while halting on CONTENT_SAFETY', async () => {
    // 1. Primary Gemini 200 succeeds -> Groq never called
    const groqNotCalled = vi.fn();
    const geminiOk = createMultiProviderJdExtractionProvider({
      providerOrder: 'gemini,groq',
      geminiApiKey: 'AIzaSyValidPrimary',
      groqApiKey: 'gsk_valid_backup',
      geminiClient: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify(validOutput),
            candidates: [{ finishReason: 'STOP' }],
          }),
        },
      } as unknown as GoogleGenAI,
      fetchFn: groqNotCalled,
    });
    const okRes = await geminiOk.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(okRes).toEqual(validOutput);
    expect(groqNotCalled).not.toHaveBeenCalled();

    // 2. Gemini 503 fails -> automatic failover to Groq recovers with correlation ID logging
    const logs: JdExtractionDiagnosticLog[] = [];
    const failoverEvents: ProviderFailoverEvent[] = [];
    const gemini503GroqOk = createMultiProviderJdExtractionProvider({
      providerOrder: 'gemini,groq',
      geminiApiKey: 'AIzaSyValidPrimary',
      groqApiKey: 'gsk_valid_backup',
      maxRetries: 0,
      sleep: async () => undefined,
      onDiagnosticLog: (entry) => logs.push(entry),
      onProviderFailover: (evt) => failoverEvents.push(evt),
      geminiClient: {
        models: {
          generateContent: vi.fn().mockRejectedValue(new Error('503 UNAVAILABLE')),
        },
      } as unknown as GoogleGenAI,
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: CANONICAL_GROQ_MODEL,
              choices: [
                { finish_reason: 'stop', message: { content: JSON.stringify(validOutput) } },
              ],
            }),
            { status: 200 },
          ),
      ),
    });

    const recovered = await runWithRequestContext('jd-failover-corr-1', () =>
      gemini503GroqOk.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' }),
    );
    expect(recovered).toEqual(validOutput);
    expect(failoverEvents).toHaveLength(1);
    expect(failoverEvents[0]).toEqual(
      expect.objectContaining({
        operation: 'jd_extraction',
        correlationId: 'jd-failover-corr-1',
        fromProvider: 'gemini',
        toProvider: 'groq',
        skippedUnconfigured: false,
      }),
    );
    expect(logs.some((l) => l.event === 'jd_extraction_provider_failover')).toBe(true);

    // 3. Gemini CONTENT_SAFETY block NEVER fails over to Groq
    const groqBlockedCheck = vi.fn();
    const safetyStop = createMultiProviderJdExtractionProvider({
      providerOrder: 'gemini,groq',
      geminiApiKey: 'AIzaSyValidPrimary',
      groqApiKey: 'gsk_valid_backup',
      geminiClient: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            promptFeedback: { blockReason: 'SAFETY' },
            text: '',
          }),
        },
      } as unknown as GoogleGenAI,
      fetchFn: groqBlockedCheck,
    });
    await expect(
      safetyStop.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' }),
    ).rejects.toThrow(JdProviderContentBlockedError);
    expect(groqBlockedCheck).not.toHaveBeenCalled();

    // 4. Both Gemini & Groq fail -> enriches diagnostics with attemptedProviders & failoverUsed
    const bothFail = createMultiProviderJdExtractionProvider({
      providerOrder: 'gemini,groq',
      geminiApiKey: 'AIzaSySecret1',
      groqApiKey: 'gsk_Secret2',
      maxRetries: 0,
      sleep: async () => undefined,
      geminiClient: {
        models: {
          generateContent: vi.fn().mockRejectedValue(new Error('503 UNAVAILABLE')),
        },
      } as unknown as GoogleGenAI,
      fetchFn: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Groq 503 with gsk_Secret2' } }), {
            status: 503,
          }),
      ),
    });
    let bothErr: unknown;
    try {
      await bothFail.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    } catch (err) {
      bothErr = err;
    }
    expect(bothErr).toBeInstanceOf(JdProviderRequestError);
    expect((bothErr as JdProviderRequestError).diagnostics?.attemptedProviders).toEqual([
      'gemini',
      'groq',
    ]);
    expect((bothErr as JdProviderRequestError).diagnostics?.failoverUsed).toBe(true);
    expect((bothErr as Error).message).not.toContain('gsk_Secret2');

    // 5. Neither provider configured -> JdProviderNotConfiguredError
    const unconfigured = createMultiProviderJdExtractionProvider({
      providerOrder: 'gemini,groq',
    });
    await expect(
      unconfigured.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' }),
    ).rejects.toThrow(JdProviderNotConfiguredError);
  });
});
