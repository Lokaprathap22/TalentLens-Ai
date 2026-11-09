import { describe, expect, it, vi } from 'vitest';
import type { GoogleGenAI } from '@google/genai';

import {
  JdProviderNotConfiguredError,
  JdProviderRequestError,
  JdProviderTimeoutError,
  createGeminiJdExtractionProvider,
  jdExtractionResponseSchema,
  getJdExtractionResponseSchema,
  cleanGeminiSchemaNode,
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
      model: 'gemini-3.8-flash',
      client: mockClient,
    });

    const result = await provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(result).toEqual(validOutput);

    // Verify Gemini received the structured response schema and MIME type without unsupported Gemini 3 sampling overrides
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.8-flash',
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseSchema: jdExtractionResponseSchema,
        }),
      }),
    );
    const callConfig = mockGenerateContent.mock.calls[0]?.[0]?.config as Record<string, unknown>;
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
      model: 'gemini-3.8-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toThrow(
      JdProviderRequestError,
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
      model: 'gemini-3.8-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toThrow(
      JdProviderRequestError,
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
      model: 'gemini-3.8-flash',
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderRequestError,
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
      model: 'gemini-3.8-flash',
      timeoutMs: 1_000,
      maxRetries: 0,
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderTimeoutError,
    );
  });

  it('handles auth error and rejects without retry', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('[403] API key not valid'));
    const mockClient = {
      models: { generateContent },
    } as unknown as GoogleGenAI;

    const provider = createGeminiJdExtractionProvider({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      maxRetries: 2,
      client: mockClient,
    });

    await expect(provider.extract({ jobTitle: 'Engineer', jdText: 'JD' })).rejects.toBeInstanceOf(
      JdProviderRequestError,
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('handles 429 rate limit with retries', async () => {
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
      model: 'gemini-3.8-flash',
      maxRetries: 2,
      client: mockClient,
    });

    const result = await provider.extract({ jobTitle: 'Engineer', jdText: 'TypeScript' });
    expect(result).toEqual(validOutput);
    expect(callCount).toBe(2);
  });
});
