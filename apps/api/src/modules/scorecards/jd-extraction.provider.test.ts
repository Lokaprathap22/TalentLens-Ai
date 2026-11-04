import { describe, expect, it } from 'vitest';

import {
  JdProviderNotConfiguredError,
  JdProviderConfigurationError,
  JdProviderRequestError,
  JdProviderTimeoutError,
  createOpenAiCompatibleProvider,
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

function response(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('JD extraction provider', () => {
  it('accepts valid structured output', async () => {
    const fetch = async () =>
      response({ choices: [{ message: { content: JSON.stringify(validOutput) } }] });
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetch,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' })).resolves.toEqual(
      validOutput,
    );
  });

  it('rejects malformed model output without exposing it', async () => {
    const fetch = async () => response({ choices: [{ message: { content: '{"criteria":' } }] });
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetch,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderRequestError,
    );
  });

  it('fails safely when not configured', async () => {
    const provider = createOpenAiCompatibleProvider({});

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderNotConfiguredError,
    );
  });

  it('sanitizes provider timeouts', async () => {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 1_000,
      fetch,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderTimeoutError,
    );
  });

  it('rejects non-HTTPS provider URLs', async () => {
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderConfigurationError,
    );
  });
});
