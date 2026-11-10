import { isPlaceholderGeminiKey, sanitizeGeminiErrorMessage } from './gemini-resilience.js';

export const SUPPORTED_AI_PROVIDERS = ['gemini', 'groq'] as const;

export type AiProviderId = (typeof SUPPORTED_AI_PROVIDERS)[number];

export const DEFAULT_AI_PROVIDER_ORDER: readonly AiProviderId[] = ['gemini', 'groq'];

export const CANONICAL_GROQ_MODEL = 'openai/gpt-oss-120b' as const;
export const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1' as const;
export const DEFAULT_AI_TIMEOUT_MS = 90_000;
export const DEFAULT_GROQ_MAX_RETRIES = 2;
export const DEFAULT_GROQ_INITIAL_RETRY_DELAY_MS = 500;
export const DEFAULT_GROQ_MAX_RETRY_DELAY_MS = 10_000;

export function sanitizeAiErrorMessage(message: string): string {
  return sanitizeGeminiErrorMessage(message);
}

export function isPlaceholderAiKey(apiKey: string | undefined | null): boolean {
  if (!apiKey || !apiKey.trim()) {
    return true;
  }
  const normalized = apiKey.trim().toLowerCase();
  return (
    isPlaceholderGeminiKey(apiKey) ||
    normalized.includes('replace_with') ||
    normalized.includes('insert_') ||
    normalized === 'none' ||
    normalized === 'null' ||
    normalized === 'undefined'
  );
}

export type ParseAiProviderOrderResult =
  | {
      ok: true;
      order: AiProviderId[];
      explicitlyConfigured: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

export function parseAiProviderOrder(
  rawOrder?: string | readonly AiProviderId[],
): ParseAiProviderOrderResult {
  if (Array.isArray(rawOrder)) {
    const deduped: AiProviderId[] = [];
    for (const item of rawOrder) {
      if (typeof item !== 'string') {
        return {
          ok: false,
          reason: `AI_PROVIDER_ORDER contains an invalid entry. Allowed providers: ${SUPPORTED_AI_PROVIDERS.join(', ')}.`,
        };
      }
      const normalized = item.trim().toLowerCase();
      if (!(SUPPORTED_AI_PROVIDERS as readonly string[]).includes(normalized)) {
        return {
          ok: false,
          reason: `AI_PROVIDER_ORDER contains unsupported provider "${item}". Allowed providers: ${SUPPORTED_AI_PROVIDERS.join(', ')}.`,
        };
      }
      const typed = normalized as AiProviderId;
      if (!deduped.includes(typed)) {
        deduped.push(typed);
      }
    }
    if (deduped.length === 0) {
      return {
        ok: false,
        reason: `AI_PROVIDER_ORDER must specify at least one provider (${SUPPORTED_AI_PROVIDERS.join(', ')}).`,
      };
    }
    return { ok: true, order: deduped, explicitlyConfigured: true };
  }

  if (rawOrder === undefined || (typeof rawOrder === 'string' && rawOrder.trim() === '')) {
    return {
      ok: true,
      order: [...DEFAULT_AI_PROVIDER_ORDER],
      explicitlyConfigured: false,
    };
  }

  const segments = String(rawOrder).split(',');
  const deduped: AiProviderId[] = [];
  for (const segment of segments) {
    const normalized = segment.trim().toLowerCase();
    if (!normalized) {
      return {
        ok: false,
        reason: `AI_PROVIDER_ORDER cannot contain empty provider entries. Expected comma-separated list from: ${SUPPORTED_AI_PROVIDERS.join(', ')}.`,
      };
    }
    if (!(SUPPORTED_AI_PROVIDERS as readonly string[]).includes(normalized)) {
      return {
        ok: false,
        reason: `AI_PROVIDER_ORDER contains unsupported provider "${normalized}". Allowed providers: ${SUPPORTED_AI_PROVIDERS.join(', ')}.`,
      };
    }
    const typed = normalized as AiProviderId;
    if (!deduped.includes(typed)) {
      deduped.push(typed);
    }
  }

  if (deduped.length === 0) {
    return {
      ok: false,
      reason: `AI_PROVIDER_ORDER must include at least one supported provider (${SUPPORTED_AI_PROVIDERS.join(', ')}).`,
    };
  }

  return {
    ok: true,
    order: deduped,
    explicitlyConfigured: true,
  };
}

export type GroqModelValidationResult =
  { valid: true; model: string } | { valid: false; reason: string };

export function validateGroqModelId(rawModel: string): GroqModelValidationResult {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return {
      valid: false,
      reason: 'GROQ_MODEL configuration cannot be empty.',
    };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(trimmed)) {
    return {
      valid: false,
      reason: `GROQ_MODEL "${trimmed}" contains invalid characters or exceeds length limits.`,
    };
  }
  return {
    valid: true,
    model: trimmed,
  };
}

export type GroqBaseUrlValidationResult =
  { valid: true; baseUrl: string } | { valid: false; reason: string };

export function validateGroqBaseUrl(
  rawUrl: string,
  options: { allowInsecureHttp?: boolean | undefined } = {},
): GroqBaseUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      reason: 'GROQ_BASE_URL configuration cannot be empty.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      reason: `GROQ_BASE_URL must be a valid URL (received "${trimmed}").`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: 'GROQ_BASE_URL must not embed username or password credentials.',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      valid: false,
      reason: 'GROQ_BASE_URL must not contain query parameters or fragments.',
    };
  }

  const isHttps = parsed.protocol === 'https:';
  const isHttp = parsed.protocol === 'http:';
  const isLoopbackHttp =
    isHttp &&
    (parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1');

  if (!isHttps && !(options.allowInsecureHttp && (isHttp || isLoopbackHttp))) {
    return {
      valid: false,
      reason: 'GROQ_BASE_URL must use HTTPS.',
    };
  }

  return {
    valid: true,
    baseUrl: trimmed.replace(/\/+$/, ''),
  };
}

export type ProviderFailoverEligibility =
  | 'not_configured'
  | 'configuration_error'
  | 'auth'
  | 'model_not_found'
  | 'rate_limit'
  | 'timeout'
  | 'transient_upstream'
  | 'invalid_response'
  | 'content_safety'
  | 'user_input_invalid';

export function shouldFailoverToNextProvider(classification: ProviderFailoverEligibility): boolean {
  return classification !== 'content_safety' && classification !== 'user_input_invalid';
}

export interface ProviderFailoverEvent {
  operation: 'assessment' | 'jd_extraction';
  correlationId?: string | undefined;
  fromProvider: AiProviderId;
  toProvider: AiProviderId;
  reasonKind: string;
  errorClass: ProviderFailoverEligibility;
  fromModel?: string | undefined;
  toModel?: string | undefined;
  skippedUnconfigured?: boolean | undefined;
}

export interface AiProviderChainCandidate<T> {
  id: AiProviderId;
  configured: boolean;
  disabledReason?: string | undefined;
  skipEligibility?: 'not_configured' | 'configuration_error' | undefined;
  model?: string | undefined;
  run: () => Promise<T>;
}

export interface AiProviderChainExecutionOptions<T> {
  operation: 'assessment' | 'jd_extraction';
  correlationId?: string | undefined;
  providers: readonly AiProviderChainCandidate<T>[];
  classifyError: (error: unknown) => {
    errorClass: ProviderFailoverEligibility;
    reasonKind: string;
  };
  createNotConfiguredError: () => Error;
  createConfigurationError: (reason: string) => Error;
  onFailover?: ((event: ProviderFailoverEvent) => void) | undefined;
}

export interface AiProviderChainExecutionResult<T> {
  result: T;
  providerId: AiProviderId;
  attemptedProviders: AiProviderId[];
  failoverUsed: boolean;
  priorProviderFailures: Array<{
    providerId: AiProviderId;
    errorClass: ProviderFailoverEligibility;
    reasonKind: string;
  }>;
}

export async function executeAiProviderChain<T>(
  options: AiProviderChainExecutionOptions<T>,
): Promise<AiProviderChainExecutionResult<T>> {
  const { providers } = options;
  const attemptedProviders: AiProviderId[] = [];
  const priorProviderFailures: Array<{
    providerId: AiProviderId;
    errorClass: ProviderFailoverEligibility;
    reasonKind: string;
  }> = [];

  let firstConfigurationIssue: string | undefined;
  let lastAttemptError: unknown;
  let skippedConfiguredFailureOrMissing: {
    id: AiProviderId;
    model?: string | undefined;
    errorClass: ProviderFailoverEligibility;
    reasonKind: string;
  } | null = null;

  for (let idx = 0; idx < providers.length; idx += 1) {
    const candidate = providers[idx];
    if (!candidate) {
      continue;
    }

    if (!candidate.configured) {
      const errorClass: ProviderFailoverEligibility =
        candidate.skipEligibility ??
        (candidate.disabledReason ? 'configuration_error' : 'not_configured');
      const reasonKind = candidate.disabledReason ? 'CONFIGURATION_ERROR' : 'NOT_CONFIGURED';
      if (candidate.disabledReason && !firstConfigurationIssue) {
        firstConfigurationIssue = candidate.disabledReason;
      }

      // Notify if a subsequent configured provider exists so operators can observe skip->failover.
      const nextConfigured = providers.slice(idx + 1).find((p) => p.configured);
      if (nextConfigured) {
        options.onFailover?.({
          operation: options.operation,
          correlationId: options.correlationId,
          fromProvider: candidate.id,
          toProvider: nextConfigured.id,
          reasonKind,
          errorClass,
          fromModel: candidate.model,
          toModel: nextConfigured.model,
          skippedUnconfigured: true,
        });
        skippedConfiguredFailureOrMissing = {
          id: candidate.id,
          model: candidate.model,
          errorClass,
          reasonKind,
        };
      }
      continue;
    }

    attemptedProviders.push(candidate.id);

    try {
      const result = await candidate.run();
      const failoverUsed =
        attemptedProviders.length > 1 || skippedConfiguredFailureOrMissing !== null;
      return {
        result,
        providerId: candidate.id,
        attemptedProviders,
        failoverUsed,
        priorProviderFailures,
      };
    } catch (error: unknown) {
      const classified = options.classifyError(error);
      if (!shouldFailoverToNextProvider(classified.errorClass)) {
        throw error;
      }

      lastAttemptError = error;
      priorProviderFailures.push({
        providerId: candidate.id,
        errorClass: classified.errorClass,
        reasonKind: classified.reasonKind,
      });

      const nextConfigured = providers.slice(idx + 1).find((p) => p.configured);
      if (nextConfigured) {
        options.onFailover?.({
          operation: options.operation,
          correlationId: options.correlationId,
          fromProvider: candidate.id,
          toProvider: nextConfigured.id,
          reasonKind: classified.reasonKind,
          errorClass: classified.errorClass,
          fromModel: candidate.model,
          toModel: nextConfigured.model,
          skippedUnconfigured: false,
        });
      }
    }
  }

  if (lastAttemptError !== undefined) {
    throw lastAttemptError;
  }

  if (firstConfigurationIssue) {
    throw options.createConfigurationError(firstConfigurationIssue);
  }

  throw options.createNotConfiguredError();
}
