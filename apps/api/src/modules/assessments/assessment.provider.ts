import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AssessmentCriterionOutput,
  AssessmentProvider,
  AssessmentProviderInput,
  AssessmentProviderOutput,
} from './assessment.types.js';

export const ASSESSMENT_PROMPT_VERSION = '2026-11-assessment-v1';

export class AssessmentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentProviderError';
  }
}

export class AssessmentProviderNotConfiguredError extends AssessmentProviderError {
  constructor(
    message = 'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Assessment AI provider is not configured.',
  ) {
    super(message);
    this.name = 'AssessmentProviderNotConfiguredError';
  }
}

export class AssessmentProviderTimeoutError extends AssessmentProviderError {
  constructor(message = 'AI assessment provider request timed out.') {
    super(message);
    this.name = 'AssessmentProviderTimeoutError';
  }
}

export class AssessmentProviderRequestError extends AssessmentProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentProviderRequestError';
  }
}

export class AssessmentProviderResponseError extends AssessmentProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentProviderResponseError';
  }
}

const providerCriterionSchema = z.object({
  criterionId: z.string().uuid({ message: 'criterionId must be a valid UUID' }),
  status: z.enum(['MATCH', 'PARTIAL', 'NOT_FOUND', 'UNCERTAIN']),
  score: z.number().nullable(),
  explanation: z.string().min(1),
  evidenceQuotes: z.array(z.string()).default([]),
});

const providerOutputSchema = z.object({
  criteria: z.array(providerCriterionSchema).min(1),
});

const SYSTEM_INSTRUCTIONS = `You are an evidence-grounded AI assessment engine for recruitment.
Evaluate the candidate's resume strictly against each provided scorecard criterion.
Requirements:
1. Provide exact, verbatim quotations from the resume as evidence in evidenceQuotes.
2. If evidence is missing, set status to NOT_FOUND and score to null.
3. If evidence is conflicting or contradictory, set status to UNCERTAIN and score to null.
4. If evidence is found, set status to MATCH or PARTIAL and provide a normalized score between 0.0 and 1.0.
5. Do not invent or assume qualifications not grounded in the resume text.
6. Return output strictly in valid JSON matching the schema: {"criteria": [{"criterionId": string, "status": "MATCH"|"PARTIAL"|"NOT_FOUND"|"UNCERTAIN", "score": number|null, "explanation": string, "evidenceQuotes": string[]}]}`;

export interface OpenAiCompatibleOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export function createOpenAiCompatibleAssessmentProvider(
  options: OpenAiCompatibleOptions = {},
): AssessmentProvider {
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    async assess(input: AssessmentProviderInput): Promise<AssessmentProviderOutput> {
      if (!options.apiKey || !options.model) {
        throw new AssessmentProviderNotConfiguredError();
      }

      const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
      let providerUrl: string;
      try {
        const u = new URL('/chat/completions', baseUrl);
        providerUrl = u.toString();
      } catch {
        throw new AssessmentProviderRequestError('Invalid provider baseUrl');
      }

      const userContent = JSON.stringify({
        jobTitle: input.jobTitle,
        criteria: input.criteria.map((c) => ({
          criterionId: c.id,
          key: c.key,
          label: c.label,
          category: c.category,
          requirementType: c.requirementType,
          weight: c.weight,
          description: c.description ?? '',
        })),
        resumeText: input.resumeText,
      });

      const inputHash = createHash('sha256')
        .update(SYSTEM_INSTRUCTIONS + userContent)
        .digest('hex');

      const maxRetries = options.maxRetries ?? 2;
      let lastError: Error | null = null;
      let response: Response | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          Math.max(1_000, options.timeoutMs ?? 30_000),
        );

        try {
          response = await fetcher(providerUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: options.model,
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: SYSTEM_INSTRUCTIONS },
                {
                  role: 'user',
                  content: `Evaluate the following resume against these criteria:\n${userContent}`,
                },
              ],
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          // Retry on 429 rate limit or 502/503/504 server errors if attempts remain
          if (
            (response.status === 429 ||
              response.status === 502 ||
              response.status === 503 ||
              response.status === 504) &&
            attempt < maxRetries
          ) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }

          if (!response.ok) {
            throw new AssessmentProviderRequestError(
              `AI provider returned HTTP ${response.status}`,
            );
          }

          break;
        } catch (err: unknown) {
          clearTimeout(timeout);
          const isTimeout = (err as Error)?.name === 'AbortError';
          lastError = isTimeout
            ? new AssessmentProviderTimeoutError()
            : err instanceof AssessmentProviderRequestError
              ? err
              : new AssessmentProviderRequestError(
                  `AI assessment provider network error: ${(err as Error).message}`,
                );

          // Retry on timeout or 502/503/504 transient network errors
          if (
            attempt < maxRetries &&
            (isTimeout ||
              (lastError instanceof AssessmentProviderRequestError &&
                !lastError.message.includes('400') &&
                !lastError.message.includes('401') &&
                !lastError.message.includes('403')))
          ) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }

          throw lastError;
        }
      }

      if (!response || !response.ok) {
        throw lastError ?? new AssessmentProviderRequestError('AI provider request failed');
      }

      const bodyText = await response.text();
      const outputHash = createHash('sha256').update(bodyText).digest('hex');

      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(bodyText);
      } catch {
        throw new AssessmentProviderResponseError('Failed to parse AI response as JSON');
      }

      const rawContent = (parsedPayload as { choices?: Array<{ message?: { content?: unknown } }> })
        ?.choices?.[0]?.message?.content;

      if (!rawContent) {
        throw new AssessmentProviderResponseError('Empty or missing content in AI response');
      }

      let contentJson: unknown;
      if (typeof rawContent === 'string') {
        try {
          contentJson = JSON.parse(rawContent);
        } catch {
          throw new AssessmentProviderResponseError('AI content is not valid JSON string');
        }
      } else {
        contentJson = rawContent;
      }

      const validatedOutput = providerOutputSchema.safeParse(contentJson);
      if (!validatedOutput.success) {
        throw new AssessmentProviderResponseError(
          `AI output validation failed: ${validatedOutput.error.message}`,
        );
      }

      const usage = (
        parsedPayload as {
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        }
      )?.usage;

      return {
        criteria: validatedOutput.data.criteria as AssessmentCriterionOutput[],
        model: options.model,
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        inputHash,
        outputHash,
        tokenUsage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
      };
    },
  };
}

export interface FakeAssessmentScenario {
  forceError?: 'TIMEOUT' | 'NOT_CONFIGURED' | 'NETWORK' | 'INVALID_JSON';
  criterionOverrides?: Map<string, Partial<AssessmentCriterionOutput>>;
}

export function createDeterministicFakeAssessmentProvider(
  scenario: FakeAssessmentScenario = {},
): AssessmentProvider {
  return {
    async assess(input: AssessmentProviderInput): Promise<AssessmentProviderOutput> {
      if (scenario.forceError === 'NOT_CONFIGURED') {
        throw new AssessmentProviderNotConfiguredError();
      }
      if (scenario.forceError === 'TIMEOUT') {
        throw new AssessmentProviderTimeoutError();
      }
      if (scenario.forceError === 'NETWORK') {
        throw new AssessmentProviderRequestError('Mock network error');
      }
      if (scenario.forceError === 'INVALID_JSON') {
        throw new AssessmentProviderResponseError('Mock invalid json error');
      }

      const criteriaOutputs: AssessmentCriterionOutput[] = input.criteria.map((c) => {
        const override = scenario.criterionOverrides?.get(c.id);
        if (override) {
          return {
            criterionId: c.id,
            status: override.status ?? 'MATCH',
            score: override.score !== undefined ? override.score : 1.0,
            explanation: override.explanation ?? `Evaluated ${c.label}`,
            evidenceQuotes: override.evidenceQuotes ?? [],
          };
        }

        // Deterministic matching based on criterion key/label presence in resumeText
        const textLower = input.resumeText.toLowerCase();
        const keyLower = c.key.toLowerCase();
        const labelLower = c.label.toLowerCase();

        let foundWord: string | null = null;
        if (textLower.includes(keyLower)) {
          foundWord = c.key;
        } else if (textLower.includes(labelLower)) {
          foundWord = c.label;
        }

        if (foundWord) {
          const idx = textLower.indexOf(foundWord.toLowerCase());
          const quote = input.resumeText.slice(idx, idx + foundWord.length);
          return {
            criterionId: c.id,
            status: 'MATCH',
            score: 1.0,
            explanation: `Found evidence for ${c.label}`,
            evidenceQuotes: [quote],
          };
        }

        return {
          criterionId: c.id,
          status: 'NOT_FOUND',
          score: null,
          explanation: `No evidence found in resume for ${c.label}`,
          evidenceQuotes: [],
        };
      });

      const payloadStr = JSON.stringify(criteriaOutputs);
      const inputHash = createHash('sha256').update(input.resumeText).digest('hex');
      const outputHash = createHash('sha256').update(payloadStr).digest('hex');

      return {
        criteria: criteriaOutputs,
        model: 'deterministic-fake-model-v1',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        inputHash,
        outputHash,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
}

export interface AssessmentProviderFactoryOptions {
  providerType?: 'openai' | 'fake' | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  fakeScenario?: FakeAssessmentScenario | undefined;
}

/**
 * Resolves the assessment AI provider with explicit safety checks.
 *
 * SAFETY INVARIANTS:
 * 1. DeterministicFakeAssessmentProvider is restricted to test environments ONLY (NODE_ENV === 'test').
 * 2. Fake-provider selection is strictly rejected in development, staging, production, and unset environments.
 * 3. Missing ASSESSMENT_PROVIDER must NEVER silently select the fake provider in non-test environments.
 * 4. Production requires explicit real-provider selection and valid credentials/model configuration.
 * 5. In production/staging/dev, missing API credentials produce a controlled ASSESSMENT_PROVIDER_NOT_CONFIGURED error.
 */
export function createAssessmentProvider(
  options: AssessmentProviderFactoryOptions = {},
): AssessmentProvider {
  const nodeEnv = process.env['NODE_ENV'];
  const isTestEnv = nodeEnv === 'test';
  const isProdEnv = nodeEnv === 'production';

  // In non-test environments, default to 'openai' so fake provider is NEVER silently selected
  const requestedType =
    options.providerType ?? process.env['ASSESSMENT_PROVIDER'] ?? (isTestEnv ? 'fake' : 'openai');

  if (requestedType === 'fake') {
    if (!isTestEnv) {
      throw new Error(
        `SECURITY_VIOLATION: DeterministicFakeAssessmentProvider is only permitted when NODE_ENV === 'test'. Current environment: ${nodeEnv || '(unset)'}`,
      );
    }
    return createDeterministicFakeAssessmentProvider(options.fakeScenario);
  }

  // Production must require explicit real-provider selection
  if (isProdEnv) {
    const explicitProvider = options.providerType ?? process.env['ASSESSMENT_PROVIDER'];
    if (!explicitProvider) {
      return {
        async assess(): Promise<AssessmentProviderOutput> {
          throw new AssessmentProviderNotConfiguredError(
            'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Production environment requires explicit ASSESSMENT_PROVIDER configuration.',
          );
        },
      };
    }
  }

  const apiKey =
    options.apiKey ?? process.env['ASSESSMENT_OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  const model =
    options.model ?? process.env['ASSESSMENT_OPENAI_MODEL'] ?? process.env['OPENAI_MODEL'];
  const baseUrl =
    options.baseUrl ??
    process.env['ASSESSMENT_OPENAI_BASE_URL'] ??
    process.env['OPENAI_BASE_URL'] ??
    'https://api.openai.com/v1';

  if (!apiKey || !apiKey.trim() || !model || !model.trim()) {
    return {
      async assess(): Promise<AssessmentProviderOutput> {
        throw new AssessmentProviderNotConfiguredError(
          'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Production AI provider requires ASSESSMENT_OPENAI_API_KEY and ASSESSMENT_OPENAI_MODEL.',
        );
      },
    };
  }

  return createOpenAiCompatibleAssessmentProvider({
    apiKey,
    model,
    baseUrl,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    fetch: options.fetch,
  });
}
