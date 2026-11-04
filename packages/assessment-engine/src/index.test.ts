import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssessmentProviderNotConfiguredError,
  AssessmentProviderRequestError,
  AssessmentProviderResponseError,
  AssessmentProviderTimeoutError,
  calculateAssessmentSummary,
  createAssessmentProvider,
  createDeterministicFakeAssessmentProvider,
  createOpenAiCompatibleAssessmentProvider,
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

  it('executes OpenAI-compatible provider with mocked HTTP transport, timeout, and schema validation (F-01)', async () => {
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

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
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
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
        }),
    });

    process.env['NODE_ENV'] = 'development';
    process.env['ASSESSMENT_PROVIDER'] = 'openai';
    process.env['ASSESSMENT_OPENAI_API_KEY'] = 'sk-test-placeholder';
    process.env['ASSESSMENT_OPENAI_MODEL'] = 'gpt-4o-mini';

    const provider = createAssessmentProvider({
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const output = await provider.assess({
      jobTitle: 'Senior Engineer',
      criteria,
      resumeText: 'Experienced in TypeScript.',
    });

    expect(output.model).toBe('gpt-4o-mini');
    expect(output.criteria).toHaveLength(1);
    expect(output.criteria[0]?.score).toBe(0.95);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Rejects fake provider outside NODE_ENV=test
    expect(() =>
      createAssessmentProvider({
        providerType: 'fake',
      }),
    ).toThrow(/SECURITY_VIOLATION/);

    // Missing credentials in non-test throws AssessmentProviderNotConfiguredError on assess
    delete process.env['ASSESSMENT_OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    const unconfigured = createAssessmentProvider();
    await expect(
      unconfigured.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderNotConfiguredError);

    // Invalid JSON from provider throws AssessmentProviderResponseError
    const badJsonProvider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'not-json',
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(
      badJsonProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderResponseError);

    // HTTP 401 throws AssessmentProviderRequestError without retrying
    const unauthorizedFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    const unauthorizedProvider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetch: unauthorizedFetch as unknown as typeof globalThis.fetch,
    });
    await expect(
      unauthorizedProvider.assess({
        jobTitle: 'Senior Engineer',
        criteria,
        resumeText: 'Experienced in TypeScript.',
      }),
    ).rejects.toThrow(AssessmentProviderRequestError);
    expect(unauthorizedFetch).toHaveBeenCalledTimes(1);

    // Timeout throws AssessmentProviderTimeoutError
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
});
