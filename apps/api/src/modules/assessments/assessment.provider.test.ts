import { describe, expect, it } from 'vitest';
import {
  AssessmentProviderNotConfiguredError,
  AssessmentProviderRequestError,
  AssessmentProviderResponseError,
  AssessmentProviderTimeoutError,
  createAssessmentProvider,
  createDeterministicFakeAssessmentProvider,
  createOpenAiCompatibleAssessmentProvider,
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
    const provider = createOpenAiCompatibleAssessmentProvider({});
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

  it('6. Missing provider configuration does not select a fake provider', async () => {
    const originalEnv = process.env['NODE_ENV'];
    const originalProvider = process.env['ASSESSMENT_PROVIDER'];
    const originalKey = process.env['ASSESSMENT_OPENAI_API_KEY'];
    try {
      process.env['NODE_ENV'] = 'production';
      delete process.env['ASSESSMENT_PROVIDER'];
      delete process.env['ASSESSMENT_OPENAI_API_KEY'];
      delete process.env['OPENAI_API_KEY'];

      // In production without provider configuration, assess() must throw ASSESSMENT_PROVIDER_NOT_CONFIGURED
      const provider = createAssessmentProvider({});
      await expect(provider.assess(sampleInput)).rejects.toThrow(
        AssessmentProviderNotConfiguredError,
      );
    } finally {
      process.env['NODE_ENV'] = originalEnv;
      if (originalProvider) process.env['ASSESSMENT_PROVIDER'] = originalProvider;
      if (originalKey) process.env['ASSESSMENT_OPENAI_API_KEY'] = originalKey;
    }
  });

  it('returns controlled ASSESSMENT_PROVIDER_NOT_CONFIGURED when credentials are missing', async () => {
    const originalEnv = process.env['NODE_ENV'];
    const originalKey = process.env['ASSESSMENT_OPENAI_API_KEY'];
    try {
      delete process.env['ASSESSMENT_OPENAI_API_KEY'];
      delete process.env['OPENAI_API_KEY'];
      const provider = createAssessmentProvider({
        providerType: 'openai',
      });
      await expect(provider.assess(sampleInput)).rejects.toThrow(
        AssessmentProviderNotConfiguredError,
      );
    } finally {
      process.env['NODE_ENV'] = originalEnv;
      if (originalKey) process.env['ASSESSMENT_OPENAI_API_KEY'] = originalKey;
    }
  });

  it('performs bounded retries on HTTP 429 rate limit and succeeds', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
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
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 2,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await provider.assess(sampleInput);
    expect(callCount).toBe(2);
    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(0.95);
  });

  it('performs bounded retries on HTTP 503 upstream error and exhausts retries cleanly', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    };

    const provider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 2,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    await expect(provider.assess(sampleInput)).rejects.toThrow(AssessmentProviderRequestError);
    expect(callCount).toBe(3); // Initial try + 2 retries
  });

  it('deterministic fake provider matches keywords and returns exact excerpts', async () => {
    const provider = createDeterministicFakeAssessmentProvider();
    const result = await provider.assess(sampleInput);

    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.criterionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(1.0);
    expect(result.criteria[0]!.evidenceQuotes).toContain('Python');
    expect(result.promptVersion).toBe('2026-11-assessment-v1');
    expect(result.inputHash).toBeDefined();
    expect(result.outputHash).toBeDefined();
  });

  it('deterministic fake provider simulates timeouts safely', async () => {
    const timeoutProvider = createDeterministicFakeAssessmentProvider({ forceError: 'TIMEOUT' });
    await expect(timeoutProvider.assess(sampleInput)).rejects.toThrow(
      AssessmentProviderTimeoutError,
    );
  });

  it('validates OpenAI compatible provider output against schema', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
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
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await provider.assess(sampleInput);

    expect(result.criteria[0]!.status).toBe('MATCH');
    expect(result.criteria[0]!.score).toBe(0.9);
  });

  it('rejects malformed JSON from OpenAI compatible provider', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'not a json' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = createOpenAiCompatibleAssessmentProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    await expect(provider.assess(sampleInput)).rejects.toThrow(AssessmentProviderResponseError);
  });
});
