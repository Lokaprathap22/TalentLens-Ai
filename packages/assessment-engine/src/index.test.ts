import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import {
  AssessmentProviderNotConfiguredError,
  AssessmentProviderRequestError,
  AssessmentProviderResponseError,
  AssessmentProviderTimeoutError,
  calculateAssessmentSummary,
  createAssessmentProvider,
  createDeterministicFakeAssessmentProvider,
  createGeminiAssessmentProvider,
  redactResumeText,
  validateScorecardCriterionWeights,
  verifyCriterionAssessments,
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
    process.env['GEMINI_MODEL'] = 'gemini-3.8-flash';

    const provider = createAssessmentProvider({
      client: mockClient,
    });

    const output = await provider.assess({
      jobTitle: 'Senior Engineer',
      criteria,
      resumeText: 'Experienced in TypeScript.',
    });

    expect(output.model).toBe('gemini-3.8-flash');
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
      model: 'gemini-3.8-flash',
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
      model: 'gemini-3.8-flash',
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

    // Auth error (API key not valid / 401 / 403) throws AssessmentProviderRequestError immediately
    const authErrorProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      client: {
        models: {
          generateContent: vi
            .fn()
            .mockRejectedValue(new Error('[403 Forbidden] API key not valid.')),
        },
      } as unknown as GoogleGenAI,
    });
    await expect(
      authErrorProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderRequestError);

    // Rate limit (429) retries and succeeds if attempt recovers
    let rateLimitAttempts = 0;
    const rateLimitRecoveringProvider = createGeminiAssessmentProvider({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      maxRetries: 2,
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
      model: 'gemini-3.8-flash',
      maxRetries: 0,
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
        model: 'gemini-3.8-flash',
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
        model: 'gemini-3.8-flash',
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
        model: 'gemini-3.8-flash',
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
        model: 'gemini-3.8-flash',
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
      expect(callReq?.model).toBe('gemini-3.8-flash');
      expect(callReq?.config?.responseMimeType).toBe('application/json');
      expect(callReq?.config?.responseSchema).toBeDefined();
      expect(callReq?.config?.systemInstruction).toBeDefined();
      expect(callReq?.config?.temperature).toBeUndefined();
      expect(callReq?.config?.topP).toBeUndefined();
      expect(callReq?.config?.top_p).toBeUndefined();
      expect(callReq?.config?.topK).toBeUndefined();
      expect(callReq?.config?.top_k).toBeUndefined();
    });
  });
});
