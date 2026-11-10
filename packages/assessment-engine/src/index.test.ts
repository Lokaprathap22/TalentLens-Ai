import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import {
  AssessmentProviderAuthError,
  AssessmentProviderConfigurationError,
  AssessmentProviderContentBlockedError,
  AssessmentProviderNotConfiguredError,
  AssessmentProviderRateLimitError,
  AssessmentProviderRequestError,
  AssessmentProviderResponseError,
  AssessmentProviderTimeoutError,
  CANONICAL_GEMINI_FALLBACK_MODEL,
  CANONICAL_GEMINI_MODEL,
  CANONICAL_GROQ_MODEL,
  DEFAULT_GROQ_BASE_URL,
  SUPPORTED_GEMINI_MODELS,
  assessmentGeminiResponseSchema,
  calculateAssessmentSummary,
  convertGeminiSchemaToOpenAiStrictSchema,
  createAssessmentProvider,
  createDeterministicFakeAssessmentProvider,
  createGeminiAssessmentProvider,
  createGroqAssessmentProvider,
  executeGeminiWithResilience,
  executeGroqStructuredCompletion,
  getAssessmentStrictJsonSchema,
  isPlaceholderAiKey,
  parseAiProviderOrder,
  parseRetryAfterHeaderMs,
  parseRetryDelayMs,
  redactResumeText,
  resolveGeminiModelPair,
  sanitizeAiErrorMessage,
  sanitizeGeminiErrorMessage,
  validateGroqBaseUrl,
  validateGroqModelId,
  validateScorecardCriterionWeights,
  verifyCriterionAssessments,
  type GeminiAttemptDiagnosticEvent,
  type ProviderFailoverEvent,
  type ScorecardCriterionDefinition,
} from './index.js';

describe('@talentlens/assessment-engine', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('redacts candidate identifiers while preserving 1:1 offset alignment and technical terms', () => {
    const raw =
      'Alice Smith (CAN-001234) built TypeScript and PostgreSQL systems at Acme Corp. Email: alice@example.com, Phone: +1 555-234-5678';
    const result = redactResumeText(raw, {
      candidateNames: ['Alice Smith'],
      extraIdentifiers: ['CAN-001234'],
    });

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('Alice Smith');
    expect(result.redactedText).not.toContain('CAN-001234');
    expect(result.redactedText).not.toContain('alice@example.com');
    expect(result.redactedText).toContain('TypeScript');
    expect(result.redactedText).toContain('PostgreSQL');
  });

  it('redacts protected demographic attributes (gender, age, marital status, nationality) without affecting skills', () => {
    const resumeWithDemographics =
      'Mr. John Smith. Gender: Male. Age: 34 years old. Marital Status: Married. Nationality: Canadian. Expert in Docker, Kubernetes, and Golang with 8 years building distributed systems.';
    const result = redactResumeText(resumeWithDemographics, {
      candidateNames: ['John Smith'],
    });

    expect(result.redactedText.length).toBe(resumeWithDemographics.length);
    expect(result.redactedText).not.toContain('Gender: Male');
    expect(result.redactedText).not.toContain('Age: 34');
    expect(result.redactedText).not.toContain('Marital Status: Married');
    expect(result.redactedText).not.toContain('Nationality: Canadian');
    expect(result.redactedText).not.toContain('John Smith');
    // Technical qualifications preserved exactly
    expect(result.redactedText).toContain('Docker');
    expect(result.redactedText).toContain('Kubernetes');
    expect(result.redactedText).toContain('Golang');
    expect(result.redactedText).toContain('8 years building distributed systems');
  });

  it('validates criterion weights and rejects zero, negative, or non-finite weights', () => {
    const validCriteria: ScorecardCriterionDefinition[] = [
      {
        id: randomUUID(),
        key: 'ts',
        label: 'TypeScript',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 60,
      },
      {
        id: randomUUID(),
        key: 'pg',
        label: 'PostgreSQL',
        category: 'Technical',
        requirementType: 'PREFERRED',
        weight: 40,
      },
    ];
    expect(validateScorecardCriterionWeights(validCriteria).valid).toBe(true);

    const invalidCriteria: ScorecardCriterionDefinition[] = [
      validCriteria[0]!,
      {
        ...validCriteria[1]!,
        weight: 0,
      },
    ];
    const invalidRes = validateScorecardCriterionWeights(invalidCriteria);
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.offendingCriterion?.key).toBe('pg');
  });

  it('verifies quotes against source text and computes complete vs incomplete weighted summaries', () => {
    const crit1Id = randomUUID();
    const crit2Id = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: crit1Id,
        key: 'typescript',
        label: 'TypeScript',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
      {
        id: crit2Id,
        key: 'postgresql',
        label: 'PostgreSQL',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
    ];
    const sourceText = 'Built production TypeScript microservices and PostgreSQL clusters.';

    const verified = verifyCriterionAssessments(
      sourceText,
      { pages: [{ pageNumber: 1, startOffset: 0, endOffset: sourceText.length }] },
      'sc-v1',
      criteria,
      [
        {
          criterionId: crit1Id,
          status: 'MATCH',
          score: 1.0,
          explanation: 'Strong TypeScript experience',
          evidenceQuotes: ['production TypeScript microservices'],
        },
        {
          criterionId: crit2Id,
          status: 'MATCH',
          score: 0.8,
          explanation: 'PostgreSQL experience',
          evidenceQuotes: ['PostgreSQL clusters'],
        },
      ],
    );

    const summary = calculateAssessmentSummary(criteria, verified);
    expect(summary.isComplete).toBe(true);
    expect(summary.status).toBe('COMPLETE');
    expect(summary.coverage).toBe(100);
    expect(summary.score).toBe(90);

    // Unverified hallucinated quote forces UNVERIFIED, null score, and NEEDS_REVIEW
    const unverified = verifyCriterionAssessments(sourceText, null, 'sc-v1', criteria, [
      {
        criterionId: crit1Id,
        status: 'MATCH',
        score: 1.0,
        explanation: 'Hallucinated quote',
        evidenceQuotes: ['Nonexistent Kubernetes cluster quote'],
      },
      {
        criterionId: crit2Id,
        status: 'MATCH',
        score: 1.0,
        explanation: 'Valid quote',
        evidenceQuotes: ['PostgreSQL clusters'],
      },
    ]);
    const incompleteSummary = calculateAssessmentSummary(criteria, unverified);
    expect(incompleteSummary.isComplete).toBe(false);
    expect(incompleteSummary.status).toBe('NEEDS_REVIEW');
    expect(incompleteSummary.score).toBeNull();
  });

  it('executes Gemini assessment provider with mocked client, timeout, retries, and schema validation (F-01)', async () => {
    const critId = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: critId,
        key: 'ts',
        label: 'TypeScript',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 100,
      },
    ];

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        criteria: [
          {
            criterionId: critId,
            status: 'MATCH',
            score: 0.95,
            explanation: 'Verified TypeScript usage',
            evidenceQuotes: ['TypeScript'],
          },
        ],
      }),
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, totalTokenCount: 165 },
    });

    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    process.env['NODE_ENV'] = 'development';
    process.env['ASSESSMENT_PROVIDER'] = 'gemini';
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';
    process.env['GEMINI_MODEL'] = 'gemini-3.6-flash';
    process.env['GEMINI_FALLBACK_MODEL'] = 'gemini-3.5-flash';

    const provider = createAssessmentProvider({
      client: mockClient,
    });

    const output = await provider.assess({
      jobTitle: 'Senior Engineer',
      criteria,
      resumeText: 'Experienced in TypeScript.',
    });

    expect(output.provider).toBe('gemini');
    expect(output.model).toBe(CANONICAL_GEMINI_MODEL);
    expect(output.primaryModel).toBe(CANONICAL_GEMINI_MODEL);
    expect(output.fallbackUsed).toBe(false);
    expect(output.attemptedModels).toEqual([CANONICAL_GEMINI_MODEL]);
    expect(output.promptVersion).toBe('2026-11-gemini-v1');
    expect(output.criteria).toHaveLength(1);
    expect(output.criteria[0]?.score).toBe(0.95);
    expect(output.tokenUsage?.totalTokens).toBe(165);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // Rejects fake provider outside NODE_ENV=test
    expect(() =>
      createAssessmentProvider({
        providerType: 'fake',
      }),
    ).toThrow(/SECURITY_VIOLATION/);

    // Missing credentials in non-test throws AssessmentProviderNotConfiguredError on assess
    delete process.env['GEMINI_API_KEY'];
    delete process.env['AI_API_KEY'];
    const unconfigured = createAssessmentProvider();
    await expect(
      unconfigured.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderNotConfiguredError);

    // Invalid JSON from provider throws AssessmentProviderResponseError
    const badJsonProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: {
        models: {
          generateContent: vi.fn().mockResolvedValue({ text: 'not-json' }),
        },
      } as unknown as GoogleGenAI,
    });
    await expect(
      badJsonProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderResponseError);

    // Malformed schema structure throws AssessmentProviderResponseError
    const badSchemaProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify({ wrongField: [] }),
          }),
        },
      } as unknown as GoogleGenAI,
    });
    await expect(
      badSchemaProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderResponseError);

    // Auth error (API key not valid / 401 / 403 / API_KEY_INVALID) throws AssessmentProviderAuthError without retry or fallback
    for (const authMsg of [
      '[403 Forbidden] API key not valid.',
      '[401 UNAUTHENTICATED] API_KEY_INVALID',
    ]) {
      const authGenerate = vi.fn().mockRejectedValue(new Error(authMsg));
      const authErrorProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 2,
        sleep: async () => undefined,
        client: {
          models: {
            generateContent: authGenerate,
          },
        } as unknown as GoogleGenAI,
      });
      const authPromise = authErrorProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      });
      await expect(authPromise).rejects.toThrow(AssessmentProviderRequestError);
      await expect(authPromise).rejects.toThrow(AssessmentProviderAuthError);
      expect(authGenerate).toHaveBeenCalledTimes(1);
    }

    // Placeholder API keys, disallowed/deprecated/Flash-Lite models, and 404 model errors fail cleanly without retry/fallback
    const placeholderProvider = createGeminiAssessmentProvider({
      apiKey: 'your_gemini_api_key_here',
      client: mockClient,
    });
    await expect(
      placeholderProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderConfigurationError);

    for (const badModel of [
      'gpt-4o',
      'gemini-3.8-flash',
      'gemini-3.6-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-2.5-pro',
    ]) {
      const badModelProvider = createGeminiAssessmentProvider({
        apiKey: 'valid-looking-test-key',
        model: badModel,
        client: mockClient,
      });
      await expect(
        badModelProvider.assess({
          jobTitle: 'Senior Engineer',
          criteria,
          resumeText: 'Experienced in TypeScript.',
        }),
      ).rejects.toThrow(AssessmentProviderConfigurationError);
    }

    const notFoundGenerate = vi
      .fn()
      .mockRejectedValue(new Error('[404 NOT_FOUND] models/gemini-3.6-flash is not found'));
    const notFoundProvider = createGeminiAssessmentProvider({
      apiKey: 'valid-looking-test-key',
      model: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: {
        models: { generateContent: notFoundGenerate },
      } as unknown as GoogleGenAI,
    });
    await expect(
      notFoundProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderConfigurationError);
    expect(notFoundGenerate).toHaveBeenCalledTimes(1);

    // Rate limit and upstream errors redact leaked API keys in error messages
    const leakedKey = 'AIzaSySecretAssessmentKey1234567890';
    const leakedErrorProvider = createGeminiAssessmentProvider({
      apiKey: leakedKey,
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      maxRetries: 0,
      sleep: async () => undefined,
      client: {
        models: {
          generateContent: vi
            .fn()
            .mockRejectedValue(
              new Error(
                `500 Internal error calling https://generativelanguage.googleapis.com?key=${leakedKey}`,
              ),
            ),
        },
      } as unknown as GoogleGenAI,
    });
    let leakedErr: unknown;
    try {
      await leakedErrorProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      });
    } catch (err) {
      leakedErr = err;
    }
    expect(leakedErr).toBeInstanceOf(AssessmentProviderRequestError);
    expect((leakedErr as Error).message).not.toContain(leakedKey);
    expect((leakedErr as Error).message).toContain('[REDACTED]');

    // Ambiguous 429 rate limit retries primary boundedly and succeeds when attempt recovers
    let rateLimitAttempts = 0;
    const rateLimitRecoveringProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      maxRetries: 2,
      sleep: async () => undefined,
      client: {
        models: {
          generateContent: vi.fn().mockImplementation(async () => {
            rateLimitAttempts++;
            if (rateLimitAttempts === 1) {
              throw new Error('429 Resource Exhausted: rate limit exceeded');
            }
            return {
              text: JSON.stringify({
                criteria: [
                  {
                    criterionId: critId,
                    status: 'MATCH',
                    score: 1.0,
                    explanation: 'Recovered after rate limit',
                    evidenceQuotes: ['TypeScript'],
                  },
                ],
              }),
            };
          }),
        },
      } as unknown as GoogleGenAI,
    });

    const recoveredOutput = await rateLimitRecoveringProvider.assess({
      jobTitle: 'Senior Engineer',
      criteria,
      resumeText: 'TypeScript experience',
    });
    expect(recoveredOutput.criteria[0]?.explanation).toBe('Recovered after rate limit');
    expect(rateLimitAttempts).toBe(2);

    // Timeout throws AssessmentProviderTimeoutError
    const timeoutProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      fallbackModel: null,
      maxRetries: 0,
      sleep: async () => undefined,
      client: {
        models: {
          generateContent: vi
            .fn()
            .mockRejectedValue(new Error('Request timeout exceeded (ETIMEDOUT)')),
        },
      } as unknown as GoogleGenAI,
    });
    await expect(
      timeoutProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'TypeScript experience',
      }),
    ).rejects.toThrow(AssessmentProviderTimeoutError);

    // Deterministic fake provider in test env with TIMEOUT scenario
    const abortProvider = createDeterministicFakeAssessmentProvider({
      forceError: 'TIMEOUT',
    });
    await expect(
      abortProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderTimeoutError);
  });

  it('accurately verifies quotes spanning irregular newlines and whitespace back to source text offsets', () => {
    const critId = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: critId,
        key: 'cloud',
        label: 'Cloud Infrastructure',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 100,
      },
    ];

    const sourceText =
      'Senior Cloud Architect\n\nwith extensive experience in\n  AWS, GCP, and Kubernetes\nacross large enterprises.';
    const pages = { pages: [{ pageNumber: 1, startOffset: 0, endOffset: sourceText.length }] };

    // AI returned a single-line normalized quote
    const aiOutput = [
      {
        criterionId: critId,
        status: 'MATCH' as const,
        score: 1.0,
        explanation: 'Cloud experience found',
        evidenceQuotes: ['with extensive experience in AWS, GCP, and Kubernetes'],
      },
    ];

    const verified = verifyCriterionAssessments(sourceText, pages, 'sc-v1', criteria, aiOutput);
    expect(verified[0]?.status).toBe('MATCH');
    expect(verified[0]?.evidenceSnippets.length).toBe(1);
    expect(verified[0]?.evidenceSnippets[0]?.verified).toBe(true);

    const snippet = verified[0]!.evidenceSnippets[0]!;
    // Must extract the actual substring from sourceText preserving original newlines
    expect(sourceText.slice(snippet.startOffset, snippet.endOffset)).toBe(
      'with extensive experience in\n  AWS, GCP, and Kubernetes',
    );
  });

  it('disallows MUST_HAVE criteria from being marked complete on PARTIAL match without recruiter override', () => {
    const mustHaveId = randomUUID();
    const preferredId = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: mustHaveId,
        key: 'go',
        label: 'Golang',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 60,
      },
      {
        id: preferredId,
        key: 'k8s',
        label: 'Kubernetes',
        category: 'Technical',
        requirementType: 'PREFERRED',
        weight: 40,
      },
    ];

    // Must-have criterion only has PARTIAL satisfaction
    const results = [
      {
        criterionId: mustHaveId,
        scorecardVersionId: 'sc-1',
        status: 'PARTIAL' as const,
        normalizedValue: 0.5,
        explanation: 'Only 1 year of Golang experience, 3+ required',
        weight: 60,
        evidenceSnippets: [
          {
            quote: 'Golang 1 year',
            startOffset: 0,
            endOffset: 13,
            pageNumber: 1,
            verified: true,
            verificationMethod: 'EXACT_QUOTE' as const,
          },
        ],
      },
      {
        criterionId: preferredId,
        scorecardVersionId: 'sc-1',
        status: 'MATCH' as const,
        normalizedValue: 1.0,
        explanation: 'Kubernetes production expert',
        weight: 40,
        evidenceSnippets: [
          {
            quote: 'Kubernetes production',
            startOffset: 14,
            endOffset: 35,
            pageNumber: 1,
            verified: true,
            verificationMethod: 'EXACT_QUOTE' as const,
          },
        ],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    // MUST_HAVE failed to achieve full MATCH, so assessment cannot be COMPLETE and overallScore must be null
    expect(summary.isComplete).toBe(false);
    expect(summary.status).toBe('NEEDS_REVIEW');
    expect(summary.score).toBeNull();
  });

  describe('Exact AI criterion output validation', () => {
    const crit1 = randomUUID();
    const crit2 = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: crit1,
        key: 'c1',
        label: 'Criterion 1',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
      {
        id: crit2,
        key: 'c2',
        label: 'Criterion 2',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
    ];

    it('rejects duplicate criterion IDs with AssessmentProviderResponseError', async () => {
      const mockClient = {
        models: {
          generateContent: vi.fn(async () => ({
            text: JSON.stringify({
              criteria: [
                {
                  criterionId: crit1,
                  status: 'MATCH',
                  score: 1.0,
                  explanation: 'Pass 1',
                  evidenceQuotes: ['quote1'],
                },
                {
                  criterionId: crit1, // Duplicate!
                  status: 'MATCH',
                  score: 1.0,
                  explanation: 'Pass 1 duplicate',
                  evidenceQuotes: ['quote1'],
                },
              ],
            }),
            usageMetadata: undefined,
          })),
        },
      } as unknown as GoogleGenAI;

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        client: mockClient,
      });

      await expect(
        provider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'quote1 quote2',
        }),
      ).rejects.toThrow(AssessmentProviderResponseError);
    });

    it('rejects unknown criterion IDs with AssessmentProviderResponseError', async () => {
      const unknownCrit = randomUUID();
      const mockClient = {
        models: {
          generateContent: vi.fn(async () => ({
            text: JSON.stringify({
              criteria: [
                {
                  criterionId: crit1,
                  status: 'MATCH',
                  score: 1.0,
                  explanation: 'Pass 1',
                  evidenceQuotes: ['quote1'],
                },
                {
                  criterionId: unknownCrit, // Unknown!
                  status: 'MATCH',
                  score: 1.0,
                  explanation: 'Unknown',
                  evidenceQuotes: ['quote'],
                },
              ],
            }),
            usageMetadata: undefined,
          })),
        },
      } as unknown as GoogleGenAI;

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        client: mockClient,
      });

      await expect(
        provider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'quote1 quote2',
        }),
      ).rejects.toThrow(AssessmentProviderResponseError);
    });

    it('rejects missing criterion IDs with AssessmentProviderResponseError', async () => {
      const mockClient = {
        models: {
          generateContent: vi.fn(async () => ({
            text: JSON.stringify({
              criteria: [
                {
                  criterionId: crit1, // crit2 is missing!
                  status: 'MATCH',
                  score: 1.0,
                  explanation: 'Pass 1',
                  evidenceQuotes: ['quote1'],
                },
              ],
            }),
            usageMetadata: undefined,
          })),
        },
      } as unknown as GoogleGenAI;

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        client: mockClient,
      });

      await expect(
        provider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'quote1 quote2',
        }),
      ).rejects.toThrow(AssessmentProviderResponseError);
    });

    it('verifyCriterionAssessments throws on duplicate criterionId in provider outputs', () => {
      const duplicateOutputs = [
        {
          criterionId: crit1,
          status: 'MATCH' as const,
          score: 1.0,
          explanation: 'First',
          evidenceQuotes: [],
        },
        {
          criterionId: crit1,
          status: 'MATCH' as const,
          score: 1.0,
          explanation: 'Second',
          evidenceQuotes: [],
        },
      ];

      expect(() =>
        verifyCriterionAssessments('resume', [], 'sc-1', criteria, duplicateOutputs),
      ).toThrow('Duplicate criterionId in provider outputs');
    });

    it('accepts exact 1:1 valid criterion set successfully without Gemini 3 sampling overrides', async () => {
      const mockGenerateContent = vi.fn(
        async (_request: { model?: string; config?: Record<string, unknown> }) => ({
          text: JSON.stringify({
            criteria: [
              {
                criterionId: crit1,
                status: 'MATCH',
                score: 1.0,
                explanation: 'Pass 1',
                evidenceQuotes: ['quote1'],
              },
              {
                criterionId: crit2,
                status: 'MATCH',
                score: 1.0,
                explanation: 'Pass 2',
                evidenceQuotes: ['quote2'],
              },
            ],
          }),
          usageMetadata: undefined,
        }),
      );
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

      const res = await provider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'quote1 quote2',
      });

      expect(res.criteria).toHaveLength(2);
      expect(res.criteria.map((c) => c.criterionId)).toEqual([crit1, crit2]);
      const callReq = mockGenerateContent.mock.calls[0]?.[0];
      expect(callReq?.model).toBe('gemini-3.6-flash');
      expect(callReq?.config?.responseMimeType).toBe('application/json');
      expect(callReq?.config?.responseSchema).toBeDefined();
      expect(callReq?.config?.systemInstruction).toBeDefined();
      expect(callReq?.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
      const thinkingConfig = callReq?.config?.thinkingConfig as Record<string, unknown> | undefined;
      expect(thinkingConfig?.thinkingLevel).not.toBe(ThinkingLevel.MINIMAL);
      expect(thinkingConfig?.thinkingLevel).not.toBe('minimal');
      expect(thinkingConfig?.thinkingBudget).toBeUndefined();
      expect(thinkingConfig?.thinking_budget).toBeUndefined();
      expect(callReq?.config?.candidateCount).toBeUndefined();
      expect(callReq?.config?.candidate_count).toBeUndefined();
      expect(callReq?.config?.temperature).toBeUndefined();
      expect(callReq?.config?.topP).toBeUndefined();
      expect(callReq?.config?.top_p).toBeUndefined();
      expect(callReq?.config?.topK).toBeUndefined();
      expect(callReq?.config?.top_k).toBeUndefined();
    });
  });

  describe('Free-Tier Gemini resilience, backoff/jitter, and bounded fallback', () => {
    const critId = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: critId,
        key: 'ts',
        label: 'TypeScript',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 100,
      },
    ];

    const validResponseText = (explanation = 'Verified TypeScript experience') =>
      JSON.stringify({
        criteria: [
          {
            criterionId: critId,
            status: 'MATCH',
            score: 0.9,
            explanation,
            evidenceQuotes: ['TypeScript'],
          },
        ],
      });

    it('normalizes model names, deduplicates identical fallback, and parses RPC RetryInfo durations', () => {
      expect(SUPPORTED_GEMINI_MODELS).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
      expect(CANONICAL_GEMINI_MODEL).toBe('gemini-3.6-flash');
      expect(CANONICAL_GEMINI_FALLBACK_MODEL).toBe('gemini-3.5-flash');

      const defaultPair = resolveGeminiModelPair({});
      expect(defaultPair).toEqual({
        ok: true,
        value: {
          primaryModel: 'gemini-3.6-flash',
          fallbackModel: 'gemini-3.5-flash',
          deduplicatedFallback: false,
        },
      });

      const dedupedPair = resolveGeminiModelPair({
        primaryModel: 'models/GEMINI-3.5-FLASH',
        fallbackModel: 'gemini-3.5-flash',
      });
      expect(dedupedPair).toEqual({
        ok: true,
        value: {
          primaryModel: 'gemini-3.5-flash',
          fallbackModel: null,
          deduplicatedFallback: true,
        },
      });

      expect(resolveGeminiModelPair({ primaryModel: 'gemini-3.6-flash-lite' }).ok).toBe(false);
      expect(resolveGeminiModelPair({ fallbackModel: 'gemini-3.8-flash' }).ok).toBe(false);
      expect(parseRetryDelayMs('3s')).toBe(3000);
      expect(parseRetryDelayMs('250ms')).toBe(250);
      expect(parseRetryDelayMs({ seconds: '2', nanos: 500_000_000 })).toBe(2500);
    });

    it('recovers on primary after transient 503 with bounded exponential backoff + jitter and no fallback call', async () => {
      const sleeps: number[] = [];
      const mockGenerateContent = vi
        .fn()
        .mockRejectedValueOnce(new Error('[503 UNAVAILABLE] temporary capacity squeeze'))
        .mockRejectedValueOnce(new Error('[503 UNAVAILABLE] temporary capacity squeeze'))
        .mockResolvedValueOnce({
          text: validResponseText('Primary succeeded on 3rd try'),
        });

      const onFallback = vi.fn();
      const provider = createGeminiAssessmentProvider({
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
        client: { models: { generateContent: mockGenerateContent } } as unknown as GoogleGenAI,
      });

      const result = await provider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'Built TypeScript services.',
      });

      expect(result.model).toBe('gemini-3.6-flash');
      expect(result.primaryModel).toBe('gemini-3.6-flash');
      expect(result.fallbackUsed).toBe(false);
      expect(result.attemptedModels).toEqual(['gemini-3.6-flash']);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      expect(mockGenerateContent.mock.calls.every((c) => c[0].model === 'gemini-3.6-flash')).toBe(
        true,
      );
      expect(onFallback).not.toHaveBeenCalled();
      expect(sleeps).toHaveLength(2);
      expect(sleeps[0]).toBeGreaterThanOrEqual(500);
      expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    });

    it('honors RPC RetryInfo retryDelay under cap and short-circuits immediately to fallback when RetryInfo exceeds cap', async () => {
      const sleepsUnderCap: number[] = [];
      const underCapMock = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            JSON.stringify({
              error: {
                code: 503,
                status: 'UNAVAILABLE',
                message: 'Temporary overload',
                details: [
                  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' },
                ],
              },
            }),
          ),
        )
        .mockResolvedValueOnce({ text: validResponseText() });

      const underCapProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        initialDelayMs: 500,
        maxRetryDelayMs: 10_000,
        sleep: async (ms) => {
          sleepsUnderCap.push(ms);
        },
        client: { models: { generateContent: underCapMock } } as unknown as GoogleGenAI,
      });

      await underCapProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' });
      expect(sleepsUnderCap).toEqual([3000]);

      const sleepsOverCap: number[] = [];
      const overCapMock = vi
        .fn()
        .mockImplementationOnce(async (req: { model: string }) => {
          expect(req.model).toBe('gemini-3.6-flash');
          throw new Error(
            JSON.stringify({
              error: {
                code: 503,
                status: 'UNAVAILABLE',
                message: 'Overloaded; retry in 30s',
                details: [
                  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
                ],
              },
            }),
          );
        })
        .mockImplementationOnce(async (req: { model: string }) => {
          expect(req.model).toBe('gemini-3.5-flash');
          return { text: validResponseText('Fallback after RetryInfo > maxRetryDelayMs') };
        });

      const overCapProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        maxRetryDelayMs: 10_000,
        sleep: async (ms) => {
          sleepsOverCap.push(ms);
        },
        client: { models: { generateContent: overCapMock } } as unknown as GoogleGenAI,
      });

      const res = await overCapProvider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(sleepsOverCap).toEqual([]);
      expect(overCapMock).toHaveBeenCalledTimes(2);
      expect(res.model).toBe('gemini-3.5-flash');
      expect(res.fallbackUsed).toBe(true);
    });

    it('falls back to gemini-3.5-flash strictly once when primary exhausts 503 retries and persists true fallback model', async () => {
      const sleeps: number[] = [];
      const calledModels: string[] = [];
      const onFallback = vi.fn();

      const mockGenerateContent = vi.fn().mockImplementation(async (req: { model: string }) => {
        calledModels.push(req.model);
        if (req.model === 'gemini-3.6-flash') {
          throw new Error('503 UNAVAILABLE: This model is currently experiencing high demand.');
        }
        return {
          text: validResponseText('Fallback succeeded'),
        };
      });

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
        onFallback,
        client: { models: { generateContent: mockGenerateContent } } as unknown as GoogleGenAI,
      });

      const result = await provider.assess({
        jobTitle: 'Backend Engineer',
        criteria,
        resumeText: 'TypeScript engineer',
      });

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
      expect(result.model).toBe('gemini-3.5-flash');
      expect(result.primaryModel).toBe('gemini-3.6-flash');
      expect(result.fallbackUsed).toBe(true);
      expect(result.attemptedModels).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
    });

    it('fails cleanly after 4 total calls when both primary (3 attempts) and fallback (1 attempt) return 503', async () => {
      const calledModels: string[] = [];
      const mockGenerateContent = vi.fn().mockImplementation(async (req: { model: string }) => {
        calledModels.push(req.model);
        throw new Error('503 UNAVAILABLE');
      });

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: mockGenerateContent } } as unknown as GoogleGenAI,
      });

      await expect(
        provider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRequestError);

      expect(calledModels).toEqual([
        'gemini-3.6-flash',
        'gemini-3.6-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
      ]);
    });

    it('stops after 1 call with zero retries and zero fallback on 400 INVALID_ARGUMENT or Gemini content safety blocks', async () => {
      const invalidReqMock = vi
        .fn()
        .mockRejectedValue(new Error('400 INVALID_ARGUMENT: bad schema'));
      const invalidReqProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: invalidReqMock } } as unknown as GoogleGenAI,
      });
      await expect(
        invalidReqProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRequestError);
      expect(invalidReqMock).toHaveBeenCalledTimes(1);

      const promptBlockedMock = vi.fn().mockResolvedValue({
        promptFeedback: { blockReason: 'SAFETY' },
        text: '',
      });
      const promptBlockedProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: promptBlockedMock } } as unknown as GoogleGenAI,
      });
      await expect(
        promptBlockedProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRequestError);
      expect(promptBlockedMock).toHaveBeenCalledTimes(1);

      const candidateBlockedMock = vi.fn().mockResolvedValue({
        candidates: [{ finishReason: 'PROHIBITED_CONTENT' }],
        text: '',
      });
      const candidateBlockedProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: candidateBlockedMock } } as unknown as GoogleGenAI,
      });
      await expect(
        candidateBlockedProvider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'TypeScript',
        }),
      ).rejects.toThrow(AssessmentProviderRequestError);
      expect(candidateBlockedMock).toHaveBeenCalledTimes(1);
    });

    it('distinguishes project daily/zero quota 429 (no retry, no fallback) from model-scoped RPM 429 (retry + bounded fallback)', async () => {
      // Case 1: Project RPD / quotaValue 0 -> 1 call only, zero fallback
      const projectQuotaMock = vi.fn().mockRejectedValue(
        new Error(
          JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Quota exceeded for GenerateRequestsPerDayPerProjectPerModel',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [
                    {
                      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                      quotaMetric:
                        'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                      quotaValue: '0',
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      const projectQuotaProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: projectQuotaMock } } as unknown as GoogleGenAI,
      });

      await expect(
        projectQuotaProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRateLimitError);
      expect(projectQuotaMock).toHaveBeenCalledTimes(1);

      // Case 2: Model-scoped RPM -> retries primary + falls back to gemini-3.5-flash once
      const rpmCalls: string[] = [];
      const modelRpmMock = vi.fn().mockImplementation(async (req: { model: string }) => {
        rpmCalls.push(req.model);
        if (req.model === 'gemini-3.6-flash') {
          throw new Error(
            JSON.stringify({
              error: {
                code: 429,
                status: 'RESOURCE_EXHAUSTED',
                message: 'Rate limit exceeded per minute for model gemini-3.6-flash',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                    violations: [
                      {
                        quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
                        quotaDimensions: { model: 'gemini-3.6-flash' },
                        quotaValue: '15',
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }
        return { text: validResponseText('Fallback recovered from model-scoped RPM') };
      });

      const modelRpmProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: modelRpmMock } } as unknown as GoogleGenAI,
      });

      const rpmRes = await modelRpmProvider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(rpmCalls).toEqual([
        'gemini-3.6-flash',
        'gemini-3.6-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
      ]);
      expect(rpmRes.model).toBe('gemini-3.5-flash');
      expect(rpmRes.fallbackUsed).toBe(true);

      // Case 3: Ambiguous generic 429 -> retries primary conservatively, NO fallback
      const ambiguousCalls: string[] = [];
      const ambiguousMock = vi.fn().mockImplementation(async (req: { model: string }) => {
        ambiguousCalls.push(req.model);
        throw new Error('429 RESOURCE_EXHAUSTED');
      });

      const ambiguousProvider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: ambiguousMock } } as unknown as GoogleGenAI,
      });

      await expect(
        ambiguousProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRateLimitError);
      expect(ambiguousCalls).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);
    });

    it('deduplicates fallback when primary and fallback normalize identically', async () => {
      const calledModels: string[] = [];
      const mockGenerateContent = vi.fn().mockImplementation(async (req: { model: string }) => {
        calledModels.push(req.model);
        throw new Error('503 UNAVAILABLE');
      });

      const provider = createGeminiAssessmentProvider({
        apiKey: 'test-key',
        model: 'models/GEMINI-3.5-FLASH',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 2,
        sleep: async () => undefined,
        client: { models: { generateContent: mockGenerateContent } } as unknown as GoogleGenAI,
      });

      await expect(
        provider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRequestError);

      expect(calledModels).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash']);
    });

    it('records structured attempt diagnostics with finishReason/blockReason and redacts cookies/authorization headers', async () => {
      const events: GeminiAttemptDiagnosticEvent[] = [];
      let callCount = 0;

      const { metadata } = await executeGeminiWithResilience({
        primaryModel: 'gemini-3.6-flash',
        fallbackModel: 'gemini-3.5-flash',
        maxRetries: 1,
        sleep: async () => undefined,
        onAttempt: (event) => events.push(event),
        invokeModel: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error(
              '503 UNAVAILABLE Authorization: Bearer jwt.token.sig Cookie: talentlens_session=secret_sess_123 x-goog-api-key: AIzaSyTestSecret999',
            );
          }
          return {
            text: validResponseText('Recovered on retry'),
            candidates: [{ finishReason: 'STOP' }],
          };
        },
      });

      expect(metadata.attemptsTotal).toBe(2);
      expect(metadata.finishReason).toBe('STOP');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          model: 'gemini-3.6-flash',
          attemptNumber: 1,
          stage: 'primary',
          outcome: 'error',
          httpStatus: 503,
          providerErrorCode: 'UNAVAILABLE',
          classification: 'SERVICE_UNAVAILABLE',
        }),
      );
      expect(events[0]?.sanitizedErrorMessage).not.toContain('jwt.token.sig');
      expect(events[0]?.sanitizedErrorMessage).not.toContain('secret_sess_123');
      expect(events[0]?.sanitizedErrorMessage).not.toContain('AIzaSyTestSecret999');
      expect(events[1]).toEqual(
        expect.objectContaining({
          model: 'gemini-3.6-flash',
          attemptNumber: 2,
          stage: 'retry',
          outcome: 'success',
          httpStatus: 200,
          finishReason: 'STOP',
        }),
      );

      const redacted = sanitizeGeminiErrorMessage(
        'Authorization: Bearer abc.def Cookie: talentlens_session=xyz123; other=1 ?key=AIzaSy12345',
      );
      expect(redacted).not.toContain('abc.def');
      expect(redacted).not.toContain('xyz123');
      expect(redacted).not.toContain('AIzaSy12345');
    });
  });

  describe('Multi-provider AI failover & Groq structured completion engine', () => {
    const critId = randomUUID();
    const criteria: ScorecardCriterionDefinition[] = [
      {
        id: critId,
        key: 'ts',
        label: 'TypeScript',
        category: 'Technical',
        requirementType: 'MUST_HAVE',
        weight: 100,
      },
    ];

    function buildGroqOkResponse(
      payload: unknown,
      model: string = CANONICAL_GROQ_MODEL,
      finishReason: string = 'stop',
    ): Response {
      return new Response(
        JSON.stringify({
          model,
          choices: [
            {
              finish_reason: finishReason,
              message: {
                content: typeof payload === 'string' ? payload : JSON.stringify(payload),
              },
            },
          ],
          usage: { prompt_tokens: 90, completion_tokens: 35, total_tokens: 125 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const validCriterionPayload = {
      criteria: [
        {
          criterionId: critId,
          status: 'MATCH',
          score: 0.92,
          explanation: 'Verified TypeScript evidence in resume',
          evidenceQuotes: ['TypeScript'],
        },
      ],
    };

    it('parses AI_PROVIDER_ORDER with deduplication and rejects invalid or empty entries', () => {
      expect(parseAiProviderOrder(undefined)).toEqual({
        ok: true,
        order: ['gemini', 'groq'],
        explicitlyConfigured: false,
      });
      expect(parseAiProviderOrder('')).toEqual({
        ok: true,
        order: ['gemini', 'groq'],
        explicitlyConfigured: false,
      });
      expect(parseAiProviderOrder(' groq , GEMINI , groq ')).toEqual({
        ok: true,
        order: ['groq', 'gemini'],
        explicitlyConfigured: true,
      });
      expect(parseAiProviderOrder('gemini')).toEqual({
        ok: true,
        order: ['gemini'],
        explicitlyConfigured: true,
      });
      expect(parseAiProviderOrder('groq')).toEqual({
        ok: true,
        order: ['groq'],
        explicitlyConfigured: true,
      });

      expect(parseAiProviderOrder('gemini,,groq').ok).toBe(false);
      expect(parseAiProviderOrder('openai,groq').ok).toBe(false);
      expect(parseAiProviderOrder([]).ok).toBe(false);
    });

    it('validates GROQ_BASE_URL, GROQ_MODEL, placeholders, and redacts gsk_/sk_/postgres secrets', () => {
      expect(validateGroqBaseUrl(DEFAULT_GROQ_BASE_URL)).toEqual({
        valid: true,
        baseUrl: 'https://api.groq.com/openai/v1',
      });
      expect(validateGroqBaseUrl('https://api.groq.com/openai/v1/')).toEqual({
        valid: true,
        baseUrl: 'https://api.groq.com/openai/v1',
      });
      expect(validateGroqBaseUrl('http://api.groq.com/openai/v1').valid).toBe(false);
      expect(
        validateGroqBaseUrl('http://127.0.0.1:8080/v1', { allowInsecureHttp: true }).valid,
      ).toBe(true);
      expect(validateGroqBaseUrl('https://user:pass@api.groq.com/openai/v1').valid).toBe(false);
      expect(validateGroqBaseUrl('https://api.groq.com/openai/v1?foo=bar').valid).toBe(false);

      expect(validateGroqModelId(CANONICAL_GROQ_MODEL)).toEqual({
        valid: true,
        model: 'openai/gpt-oss-120b',
      });
      expect(validateGroqModelId('')).toEqual({
        valid: false,
        reason: 'GROQ_MODEL configuration cannot be empty.',
      });
      expect(validateGroqModelId('bad model id!').valid).toBe(false);

      expect(isPlaceholderAiKey(undefined)).toBe(true);
      expect(isPlaceholderAiKey('')).toBe(true);
      expect(isPlaceholderAiKey('your_groq_api_key_here')).toBe(true);
      expect(isPlaceholderAiKey('gsk_replace_with_key')).toBe(true);
      expect(isPlaceholderAiKey('gsk_live_actual_token_value_123456')).toBe(false);

      const cleaned = sanitizeAiErrorMessage(
        'gsk_secret_token_999 sk-anotherkey12345 postgresql://talentlens:pwd@localhost:5432/db groq-api-key: gsk_inline_abc',
      );
      expect(cleaned).not.toContain('gsk_secret_token_999');
      expect(cleaned).not.toContain('sk-anotherkey12345');
      expect(cleaned).not.toContain('talentlens:pwd');
      expect(cleaned).not.toContain('gsk_inline_abc');
      expect(cleaned).toContain('[REDACTED]');
    });

    it('converts assessmentGeminiResponseSchema to strict OpenAI/Groq JSON Schema with exhaustive required keys', () => {
      expect(assessmentGeminiResponseSchema.properties.criteria.items.required).toContain('score');

      const strict = getAssessmentStrictJsonSchema();
      expect(strict.type).toBe('object');
      expect(strict.additionalProperties).toBe(false);
      expect(strict.required).toEqual(['criteria']);

      const criteriaProp = (strict.properties as Record<string, Record<string, unknown>>).criteria!;
      expect(criteriaProp.type).toBe('array');
      const itemSchema = criteriaProp.items as Record<string, unknown>;
      expect(itemSchema.type).toBe('object');
      expect(itemSchema.additionalProperties).toBe(false);
      expect(itemSchema.required).toEqual([
        'criterionId',
        'status',
        'score',
        'explanation',
        'evidenceQuotes',
      ]);

      const itemProps = itemSchema.properties as Record<string, Record<string, unknown>>;
      expect(itemProps.score).toEqual({ type: ['number', 'null'] });

      // Nullable object / enum conversion sanity
      const customConverted = convertGeminiSchemaToOpenAiStrictSchema({
        type: 'OBJECT',
        properties: {
          nullableObj: {
            type: 'OBJECT',
            nullable: true,
            properties: { note: { type: 'STRING' } },
          },
          nullableEnum: {
            type: 'STRING',
            nullable: true,
            enum: ['A', 'B'],
          },
        },
      });
      expect(customConverted.additionalProperties).toBe(false);
      expect(customConverted.required).toEqual(['nullableObj', 'nullableEnum']);
      const customProps = customConverted.properties as Record<string, Record<string, unknown>>;
      expect(customProps.nullableObj?.anyOf).toEqual([
        {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
          additionalProperties: false,
        },
        { type: 'null' },
      ]);
      expect(customProps.nullableEnum?.anyOf).toEqual([
        { type: 'string', enum: ['A', 'B'] },
        { type: 'null' },
      ]);
    });

    it('executes Groq structured completion with strict json_schema and handles json_object fallback, retries, Retry-After, timeouts, and content_filter', async () => {
      // 1. Happy path verifies exact endpoint, Bearer header, temperature: 0, strict json_schema, and null score normalization
      const requests: Array<{
        url: string;
        headers: HeadersInit | undefined;
        body: Record<string, unknown>;
      }> = [];
      const okProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        baseUrl: 'https://api.groq.com/openai/v1/',
        model: CANONICAL_GROQ_MODEL,
        fetchFn: vi.fn(async (url, init) => {
          requests.push({
            url: String(url),
            headers: init?.headers,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          });
          return buildGroqOkResponse({
            criteria: [
              {
                criterionId: critId,
                status: 'NOT_FOUND',
                explanation: 'No TypeScript evidence',
                evidenceQuotes: [],
              },
            ],
          });
        }),
      });

      const okRes = await okProvider.assess({
        jobTitle: 'Backend Engineer',
        criteria,
        resumeText: 'Python developer',
      });
      expect(okRes.provider).toBe('groq');
      expect(okRes.model).toBe(CANONICAL_GROQ_MODEL);
      expect(okRes.fallbackUsed).toBe(false);
      expect(okRes.criteria[0]?.score).toBeNull();
      expect(requests[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect((requests[0]?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer gsk_test_real_key_123456',
      );
      expect(requests[0]?.body.temperature).toBe(0);
      expect((requests[0]?.body.response_format as Record<string, unknown>).type).toBe(
        'json_schema',
      );

      // 2. json_validate_failed triggers single fallback to json_object + strict Zod validation
      const formatTypes: string[] = [];
      const fallbackProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        fetchFn: vi.fn(async (_url, init) => {
          const parsed = JSON.parse(String(init?.body)) as { response_format: { type: string } };
          formatTypes.push(parsed.response_format.type);
          if (formatTypes.length === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 'json_validate_failed',
                  message: 'json_schema grammar rejected for custom model',
                },
              }),
              { status: 400 },
            );
          }
          return buildGroqOkResponse(validCriterionPayload, 'custom-groq-model');
        }),
      });
      const fallbackRes = await fallbackProvider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(formatTypes).toEqual(['json_schema', 'json_object']);
      expect(fallbackRes.fallbackUsed).toBe(true);

      // 3. 429 with Retry-After honors delay when under cap, aborts when over cap
      expect(parseRetryAfterHeaderMs('2')).toBe(2000);
      const retrySleeps: number[] = [];
      const rpmProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        maxRetries: 2,
        maxRetryDelayMs: 10_000,
        sleep: async (ms) => {
          retrySleeps.push(ms);
        },
        fetchFn: vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' } }),
              { status: 429, headers: { 'Retry-After': '2' } },
            ),
          )
          .mockResolvedValueOnce(buildGroqOkResponse(validCriterionPayload)),
      });
      await rpmProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' });
      expect(retrySleeps).toEqual([2000]);

      const overCapFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'RPM exceeded' } }),
            { status: 429, headers: { 'Retry-After': '30' } },
          ),
        );
      const overCapProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        maxRetries: 2,
        maxRetryDelayMs: 10_000,
        sleep: async () => undefined,
        fetchFn: overCapFetch,
      });
      await expect(
        overCapProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRateLimitError);
      expect(overCapFetch).toHaveBeenCalledTimes(1);

      // 4. 401 -> AssessmentProviderAuthError without retries; secret redacted
      const authFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: 'Invalid API key gsk_super_secret_leaked_key',
            },
          }),
          { status: 401 },
        ),
      );
      const authProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_super_secret_leaked_key',
        maxRetries: 2,
        sleep: async () => undefined,
        fetchFn: authFetch,
      });
      await expect(
        authProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderAuthError);
      expect(authFetch).toHaveBeenCalledTimes(1);

      // 5. content_filter / refusal -> AssessmentProviderContentBlockedError with zero retries
      const safetyFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: CANONICAL_GROQ_MODEL,
            choices: [
              {
                finish_reason: 'content_filter',
                message: { content: '', refusal: 'Safety policy triggered' },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const safetyProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        maxRetries: 2,
        fetchFn: safetyFetch,
      });
      await expect(
        safetyProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderContentBlockedError);
      expect(safetyFetch).toHaveBeenCalledTimes(1);

      // 6. Malformed schema from Groq triggers validation retry and throws AssessmentProviderResponseError if still invalid
      const badOutputFetch = vi.fn(async () =>
        buildGroqOkResponse({ criteria: [{ criterionId: 'not-a-uuid', status: 'MATCH' }] }),
      );
      const badOutputProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        maxRetries: 1,
        maxValidationRetries: 1,
        fetchFn: badOutputFetch,
      });
      await expect(
        badOutputProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderResponseError);
      expect(badOutputFetch).toHaveBeenCalledTimes(2);

      // 7. AbortController timeout triggers AssessmentProviderTimeoutError
      const slowFetch = vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('Timed out', 'TimeoutError'));
          });
        });
      });
      const timeoutProvider = createGroqAssessmentProvider({
        apiKey: 'gsk_test_real_key_123456',
        timeoutMs: 25,
        maxRetries: 0,
        fetchFn: slowFetch,
      });
      await expect(
        timeoutProvider.assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderTimeoutError);

      // 8. 503 retries with bounded backoff and recovers; 429 insufficient_quota does not retry; external signal aborts immediately
      const recoverySleeps: number[] = [];
      const recoveryFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'Temporary 503' } }), { status: 503 }),
        )
        .mockResolvedValueOnce(buildGroqOkResponse(validCriterionPayload));
      const directRecovered = await executeGroqStructuredCompletion({
        apiKey: 'gsk_test_real_key_123456',
        model: CANONICAL_GROQ_MODEL,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schemaName: 'test_schema',
        strictSchema: getAssessmentStrictJsonSchema(),
        parseAndValidate: (_raw, parsed) => parsed as typeof validCriterionPayload,
        maxRetries: 2,
        initialDelayMs: 200,
        random: () => 0,
        sleep: async (ms) => {
          recoverySleeps.push(ms);
        },
        fetchFn: recoveryFetch,
      });
      expect(directRecovered.data).toEqual(validCriterionPayload);
      expect(recoverySleeps).toEqual([200]);

      const quotaFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'insufficient_quota', message: 'Daily quota exhausted' },
            }),
            { status: 429 },
          ),
      );
      await expect(
        createGroqAssessmentProvider({
          apiKey: 'gsk_test_real_key_123456',
          maxRetries: 2,
          sleep: async () => undefined,
          fetchFn: quotaFetch,
        }).assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderRateLimitError);
      expect(quotaFetch).toHaveBeenCalledTimes(1);

      const externalController = new AbortController();
      externalController.abort(new Error('caller cancelled'));
      const neverCalledFetch = vi.fn();
      await expect(
        createGroqAssessmentProvider({
          apiKey: 'gsk_test_real_key_123456',
          signal: externalController.signal,
          maxRetries: 2,
          fetchFn: neverCalledFetch,
        }).assess({ jobTitle: 'Engineer', criteria, resumeText: 'TypeScript' }),
      ).rejects.toThrow(AssessmentProviderTimeoutError);
    });

    it('implements ordered multi-provider failover between Gemini and Groq cleanly', async () => {
      process.env['NODE_ENV'] = 'development';

      // Case 1: Default order (gemini,groq) succeeds on Gemini without calling Groq
      const groqFetchNotCalled = vi.fn();
      const geminiOkClient = {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            text: JSON.stringify(validCriterionPayload),
          }),
        },
      } as unknown as GoogleGenAI;

      const primaryOkProvider = createAssessmentProvider({
        providerType: 'gemini',
        apiKey: 'AIzaSyValidPrimaryKey',
        groqApiKey: 'gsk_valid_backup_key_123',
        client: geminiOkClient,
        fetchFn: groqFetchNotCalled,
      });
      const primaryRes = await primaryOkProvider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(primaryRes.provider).toBe('gemini');
      expect(primaryRes.failoverUsed).toBe(false);
      expect(primaryRes.attemptedProviders).toEqual(['gemini']);
      expect(groqFetchNotCalled).not.toHaveBeenCalled();

      // Case 2: Gemini fails with 503 (or 401/429 quota/timeout/invalid JSON) -> fails over to Groq
      const failoverEvents: ProviderFailoverEvent[] = [];
      for (const failure of [
        new Error('503 UNAVAILABLE'),
        new Error('[401 UNAUTHENTICATED] API_KEY_INVALID'),
        new Error('429 RESOURCE_EXHAUSTED quotaValue: 0 GenerateRequestsPerDayPerProjectPerModel'),
        new Error('Request timeout exceeded (ETIMEDOUT)'),
        null, // Invalid JSON response from Gemini
      ]) {
        const geminiClient = {
          models: {
            generateContent:
              failure === null
                ? vi.fn().mockResolvedValue({ text: '{bad-json' })
                : vi.fn().mockRejectedValue(failure),
          },
        } as unknown as GoogleGenAI;
        const groqFetch = vi.fn().mockResolvedValue(buildGroqOkResponse(validCriterionPayload));

        const failoverProvider = createAssessmentProvider({
          providerOrder: 'gemini,groq',
          apiKey: 'AIzaSyPrimaryKey',
          groqApiKey: 'gsk_backup_key_12345',
          maxRetries: 0,
          sleep: async () => undefined,
          client: geminiClient,
          fetchFn: groqFetch,
          onProviderFailover: (evt) => failoverEvents.push(evt),
        });

        const res = await failoverProvider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'TypeScript',
        });
        expect(res.provider).toBe('groq');
        expect(res.model).toBe(CANONICAL_GROQ_MODEL);
        expect(res.fallbackUsed).toBe(true);
        expect(res.failoverUsed).toBe(true);
        expect(res.attemptedProviders).toEqual(['gemini', 'groq']);
        expect(groqFetch).toHaveBeenCalledTimes(1);
      }
      expect(failoverEvents).toHaveLength(5);

      // Case 3: Custom AI_PROVIDER_ORDER=groq,gemini uses Groq primary without calling Gemini
      const geminiShouldNotRun = vi.fn();
      const groqPrimaryFetch = vi
        .fn()
        .mockResolvedValue(buildGroqOkResponse(validCriterionPayload));
      const reversedProvider = createAssessmentProvider({
        providerOrder: 'groq,gemini',
        apiKey: 'AIzaSyBackupKey',
        groqApiKey: 'gsk_primary_key_12345',
        client: { models: { generateContent: geminiShouldNotRun } } as unknown as GoogleGenAI,
        fetchFn: groqPrimaryFetch,
      });
      const reversedRes = await reversedProvider.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(reversedRes.provider).toBe('groq');
      expect(reversedRes.failoverUsed).toBe(false);
      expect(reversedRes.attemptedProviders).toEqual(['groq']);
      expect(geminiShouldNotRun).not.toHaveBeenCalled();

      // Case 4: Gemini unconfigured -> skips safely to Groq when Groq configured
      const skipEvents: ProviderFailoverEvent[] = [];
      const groqOnlyWhenGeminiUnset = createAssessmentProvider({
        providerOrder: 'gemini,groq',
        groqApiKey: 'gsk_only_key_12345',
        fetchFn: vi.fn().mockResolvedValue(buildGroqOkResponse(validCriterionPayload)),
        onProviderFailover: (evt) => skipEvents.push(evt),
      });
      const skipRes = await groqOnlyWhenGeminiUnset.assess({
        jobTitle: 'Engineer',
        criteria,
        resumeText: 'TypeScript',
      });
      expect(skipRes.provider).toBe('groq');
      expect(skipRes.failoverUsed).toBe(true);
      expect(skipEvents[0]).toEqual(
        expect.objectContaining({
          fromProvider: 'gemini',
          toProvider: 'groq',
          skippedUnconfigured: true,
        }),
      );

      // Case 5: Content safety block on Gemini NEVER fails over to Groq
      const groqNeverCalledOnSafety = vi.fn();
      const safetyGeminiClient = {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            promptFeedback: { blockReason: 'SAFETY' },
            text: '',
          }),
        },
      } as unknown as GoogleGenAI;
      const safetyProvider = createAssessmentProvider({
        providerOrder: 'gemini,groq',
        apiKey: 'AIzaSyPrimaryKey',
        groqApiKey: 'gsk_backup_key_12345',
        client: safetyGeminiClient,
        fetchFn: groqNeverCalledOnSafety,
      });
      await expect(
        safetyProvider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'TypeScript',
        }),
      ).rejects.toThrow(AssessmentProviderContentBlockedError);
      expect(groqNeverCalledOnSafety).not.toHaveBeenCalled();

      // Case 6: Both Gemini and Groq fail -> propagates sanitized error without leaking secrets
      const bothFailProvider = createAssessmentProvider({
        providerOrder: 'gemini,groq',
        apiKey: 'AIzaSySecretPrimary999',
        groqApiKey: 'gsk_SecretBackup999',
        maxRetries: 0,
        sleep: async () => undefined,
        client: {
          models: {
            generateContent: vi.fn().mockRejectedValue(new Error('503 AIzaSySecretPrimary999')),
          },
        } as unknown as GoogleGenAI,
        fetchFn: vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ error: { message: 'Upstream 503 with key gsk_SecretBackup999' } }),
              { status: 503 },
            ),
          ),
      });
      let bothErr: unknown;
      try {
        await bothFailProvider.assess({
          jobTitle: 'Engineer',
          criteria,
          resumeText: 'TypeScript',
        });
      } catch (err) {
        bothErr = err;
      }
      expect(bothErr).toBeInstanceOf(AssessmentProviderRequestError);
      expect((bothErr as Error).message).not.toContain('gsk_SecretBackup999');
      expect((bothErr as Error).message).not.toContain('AIzaSySecretPrimary999');
    });
  });
});
