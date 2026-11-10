import {
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_INITIAL_RETRY_DELAY_MS,
  DEFAULT_GROQ_MAX_RETRIES,
  DEFAULT_GROQ_MAX_RETRY_DELAY_MS,
  sanitizeAiErrorMessage,
} from './ai-failover.js';

export type GroqFailureKind =
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'USER_INPUT_INVALID'
  | 'CONTENT_SAFETY'
  | 'SCHEMA_FORMAT_UNSUPPORTED'
  | 'RATE_LIMIT_PROJECT_QUOTA'
  | 'RATE_LIMIT_SCOPED'
  | 'RATE_LIMIT_GENERIC'
  | 'TIMEOUT'
  | 'SERVICE_UNAVAILABLE'
  | 'TRANSIENT_UPSTREAM'
  | 'RESPONSE_EMPTY'
  | 'RESPONSE_INVALID_JSON'
  | 'RESPONSE_SCHEMA_INVALID';

export interface GroqClassifiedFailure {
  kind: GroqFailureKind;
  statusCode?: number | undefined;
  providerErrorCode?: string | undefined;
  retryable: boolean;
  allowJsonObjectFallback?: boolean | undefined;
  retryDelayMs?: number | undefined;
  finishReason?: string | undefined;
  sanitizedMessage: string;
}

export interface GroqAttemptDiagnosticEvent {
  provider: 'groq';
  model: string;
  attemptNumber: number;
  stage: 'primary' | 'retry' | 'json_object_fallback' | 'validation_retry';
  durationMs: number;
  outcome: 'success' | 'blocked' | 'error';
  httpStatus?: number | undefined;
  providerErrorCode?: string | undefined;
  classification?: GroqFailureKind | undefined;
  finishReason?: string | undefined;
  sanitizedErrorMessage?: string | undefined;
}

export interface GroqExecutionMetadata {
  provider: 'groq';
  modelUsed: string;
  attemptsTotal: number;
  responseFormatMode: 'json_schema' | 'json_object';
  fallbackUsed: boolean;
  totalDurationMs: number;
  finishReason?: string | undefined;
  attemptHistory: GroqAttemptDiagnosticEvent[];
  lastFailureClassification?: GroqClassifiedFailure | undefined;
}

export class GroqExecutionError extends Error {
  public readonly classification: GroqClassifiedFailure;
  public readonly metadata: GroqExecutionMetadata;
  public readonly allAttemptsTimedOut: boolean;

  constructor(
    classification: GroqClassifiedFailure,
    metadata: GroqExecutionMetadata,
    allAttemptsTimedOut: boolean,
  ) {
    super(classification.sanitizedMessage);
    this.name = 'GroqExecutionError';
    this.classification = classification;
    this.metadata = metadata;
    this.allAttemptsTimedOut = allAttemptsTimedOut;
  }
}

export type GroqFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const GEMINI_TO_JSON_TYPE_MAP: Record<string, string> = {
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  object: 'object',
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  array: 'array',
};

/**
 * Converts a Gemini/OpenAPI schema tree into Groq OpenAI-compatible strict JSON Schema (`strict: true`):
 * - Lowercases schema type names (`OBJECT` -> `object`, etc.)
 * - Sets `additionalProperties: false` on every object node
 * - Populates `required` with ALL keys defined in `properties` on every object node
 * - Translates OpenAPI `nullable: true` into explicit JSON Schema `type: [<type>, "null"]` (for plain
 *   primitives) or `anyOf: [<nonNullSchema>, { type: "null" }]` (for objects, arrays, or enums)
 */
export function convertGeminiSchemaToOpenAiStrictSchema(node: unknown): Record<string, unknown> {
  const converted = convertNode(node);
  if (!converted || typeof converted !== 'object' || Array.isArray(converted)) {
    throw new Error('Root JSON schema node must convert to an object');
  }
  return converted as Record<string, unknown>;
}

function convertNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => convertNode(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }

  const record = node as Record<string, unknown>;
  const isNullable = record['nullable'] === true;
  const rawType = typeof record['type'] === 'string' ? record['type'] : undefined;
  const normalizedType = rawType
    ? (GEMINI_TO_JSON_TYPE_MAP[rawType] ?? rawType.toLowerCase())
    : undefined;
  const description = typeof record['description'] === 'string' ? record['description'] : undefined;
  const rawEnum = Array.isArray(record['enum']) ? [...record['enum']] : undefined;

  if (normalizedType === 'object') {
    const rawProps =
      record['properties'] &&
      typeof record['properties'] === 'object' &&
      !Array.isArray(record['properties'])
        ? (record['properties'] as Record<string, unknown>)
        : {};

    const convertedProps: Record<string, unknown> = {};
    for (const [propKey, propSchema] of Object.entries(rawProps)) {
      convertedProps[propKey] = convertNode(propSchema);
    }

    const requiredKeys = Object.keys(convertedProps);
    const baseObjectSchema: Record<string, unknown> = {
      type: 'object',
      properties: convertedProps,
      required: requiredKeys,
      additionalProperties: false,
      ...(description ? { description } : {}),
    };

    if (isNullable) {
      return {
        anyOf: [baseObjectSchema, { type: 'null' }],
      };
    }
    return baseObjectSchema;
  }

  if (normalizedType === 'array') {
    const baseArraySchema: Record<string, unknown> = {
      type: 'array',
      ...(record['items'] !== undefined ? { items: convertNode(record['items']) } : {}),
      ...(description ? { description } : {}),
    };
    if (isNullable) {
      return {
        anyOf: [baseArraySchema, { type: 'null' }],
      };
    }
    return baseArraySchema;
  }

  // Scalar / enum / untyped node
  const scalarSchema: Record<string, unknown> = {};
  if (description) {
    scalarSchema['description'] = description;
  }
  if (rawEnum) {
    scalarSchema['enum'] = rawEnum;
  }

  if (normalizedType) {
    if (isNullable) {
      if (rawEnum) {
        const nonNull: Record<string, unknown> = {
          type: normalizedType,
          enum: rawEnum,
        };
        return {
          ...(description ? { description } : {}),
          anyOf: [nonNull, { type: 'null' }],
        };
      }
      scalarSchema['type'] = [normalizedType, 'null'];
      return scalarSchema;
    }
    scalarSchema['type'] = normalizedType;
  }

  for (const [key, value] of Object.entries(record)) {
    if (
      key === 'type' ||
      key === 'nullable' ||
      key === 'description' ||
      key === 'enum' ||
      key === '$schema' ||
      key === 'minLength' ||
      key === 'maxLength'
    ) {
      continue;
    }
    scalarSchema[key] = convertNode(value);
  }

  return scalarSchema;
}

export function parseRetryAfterHeaderMs(rawHeader: string | null | undefined): number | undefined {
  if (!rawHeader) {
    return undefined;
  }
  const trimmed = rawHeader.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return undefined;
}

interface GroqErrorBody {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    param?: unknown;
  };
  message?: unknown;
}

function extractGroqErrorFields(body: unknown): {
  message?: string | undefined;
  type?: string | undefined;
  code?: string | undefined;
} {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const rec = body as GroqErrorBody;
  const errObj = rec.error && typeof rec.error === 'object' ? rec.error : undefined;
  const message =
    typeof errObj?.message === 'string'
      ? errObj.message
      : typeof rec.message === 'string'
        ? rec.message
        : undefined;
  const type = typeof errObj?.type === 'string' ? errObj.type : undefined;
  const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
  return { message, type, code };
}

export function classifyGroqFailure(params: {
  statusCode?: number | undefined;
  body?: unknown;
  error?: unknown;
  retryAfterMs?: number | undefined;
  timedOut?: boolean | undefined;
  externallyAborted?: boolean | undefined;
  maxRetryDelayMs?: number | undefined;
}): GroqClassifiedFailure {
  const maxDelay = params.maxRetryDelayMs ?? DEFAULT_GROQ_MAX_RETRY_DELAY_MS;
  const { statusCode, retryAfterMs } = params;
  const bodyFields = extractGroqErrorFields(params.body);
  const errObj = params.error instanceof Error ? params.error : undefined;
  const rawMessage =
    bodyFields.message ??
    errObj?.message ??
    (params.error !== undefined ? String(params.error) : `HTTP ${statusCode ?? 'unknown'}`);
  const sanitizedMessage = sanitizeAiErrorMessage(rawMessage).replace(/\s+/g, ' ').trim();
  const lower = sanitizedMessage.toLowerCase();
  const errCode = bodyFields.code?.toLowerCase();
  const errType = bodyFields.type?.toLowerCase();

  if (params.externallyAborted) {
    return {
      kind: 'TIMEOUT',
      statusCode,
      providerErrorCode: 'ABORTED',
      retryable: false,
      sanitizedMessage: sanitizedMessage || 'Request aborted by caller',
    };
  }

  if (
    params.timedOut ||
    errObj?.name === 'TimeoutError' ||
    errObj?.name === 'AbortError' ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout')
  ) {
    return {
      kind: 'TIMEOUT',
      statusCode: statusCode ?? 408,
      providerErrorCode: 'TIMEOUT',
      retryable: true,
      retryDelayMs: retryAfterMs,
      sanitizedMessage: sanitizedMessage || 'Groq upstream request timed out',
    };
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errCode === 'invalid_api_key' ||
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('authentication')
  ) {
    return {
      kind: 'AUTH',
      statusCode,
      providerErrorCode: bodyFields.code ?? 'AUTH_ERROR',
      retryable: false,
      sanitizedMessage,
    };
  }

  if (
    statusCode === 404 ||
    errCode === 'model_not_found' ||
    lower.includes('model_not_found') ||
    lower.includes('does not exist')
  ) {
    return {
      kind: 'MODEL_NOT_FOUND',
      statusCode,
      providerErrorCode: bodyFields.code ?? 'MODEL_NOT_FOUND',
      retryable: false,
      sanitizedMessage,
    };
  }

  if (statusCode === 429 || errCode === 'rate_limit_exceeded' || errType === 'rate_limit_error') {
    const isQuotaExhausted =
      errCode === 'insufficient_quota' ||
      lower.includes('insufficient_quota') ||
      lower.includes('daily') ||
      lower.includes('billing') ||
      lower.includes('tpd') ||
      lower.includes('rpd');

    if (isQuotaExhausted) {
      return {
        kind: 'RATE_LIMIT_PROJECT_QUOTA',
        statusCode: statusCode ?? 429,
        providerErrorCode: bodyFields.code ?? 'RATE_LIMIT_QUOTA',
        retryable: false,
        retryDelayMs: retryAfterMs,
        sanitizedMessage,
      };
    }

    const delayOverCap = retryAfterMs !== undefined && retryAfterMs > maxDelay;
    return {
      kind:
        retryAfterMs !== undefined ||
        lower.includes('per minute') ||
        lower.includes('rpm') ||
        lower.includes('tpm')
          ? 'RATE_LIMIT_SCOPED'
          : 'RATE_LIMIT_GENERIC',
      statusCode: statusCode ?? 429,
      providerErrorCode: bodyFields.code ?? 'RATE_LIMIT',
      retryable: !delayOverCap,
      retryDelayMs: retryAfterMs,
      sanitizedMessage,
    };
  }

  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    if (
      errCode === 'content_filter' ||
      errCode === 'content_policy_violation' ||
      lower.includes('content policy') ||
      lower.includes('safety policy') ||
      lower.includes('moderation')
    ) {
      return {
        kind: 'CONTENT_SAFETY',
        statusCode,
        providerErrorCode: bodyFields.code ?? 'CONTENT_SAFETY',
        retryable: false,
        sanitizedMessage,
      };
    }

    if (
      errCode === 'json_validate_failed' ||
      lower.includes('response_format') ||
      lower.includes('json_schema')
    ) {
      return {
        kind: 'SCHEMA_FORMAT_UNSUPPORTED',
        statusCode,
        providerErrorCode: bodyFields.code ?? 'SCHEMA_FORMAT_UNSUPPORTED',
        retryable: false,
        allowJsonObjectFallback: true,
        sanitizedMessage,
      };
    }

    if (
      errCode === 'context_length_exceeded' ||
      lower.includes('context_length_exceeded') ||
      lower.includes('too large')
    ) {
      return {
        kind: 'USER_INPUT_INVALID',
        statusCode,
        providerErrorCode: bodyFields.code ?? 'USER_INPUT_INVALID',
        retryable: false,
        sanitizedMessage,
      };
    }

    return {
      kind: 'INVALID_REQUEST',
      statusCode,
      providerErrorCode: bodyFields.code ?? 'INVALID_REQUEST',
      retryable: false,
      sanitizedMessage,
    };
  }

  if (statusCode === 503) {
    return {
      kind: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      providerErrorCode: bodyFields.code ?? 'SERVICE_UNAVAILABLE',
      retryable: true,
      retryDelayMs: retryAfterMs,
      sanitizedMessage,
    };
  }

  if (statusCode === 500 || statusCode === 502 || statusCode === 504 || statusCode === undefined) {
    return {
      kind: 'TRANSIENT_UPSTREAM',
      statusCode,
      providerErrorCode: bodyFields.code ?? (statusCode ? `HTTP_${statusCode}` : 'NETWORK_ERROR'),
      retryable: true,
      retryDelayMs: retryAfterMs,
      sanitizedMessage,
    };
  }

  return {
    kind: 'TRANSIENT_UPSTREAM',
    statusCode,
    providerErrorCode: bodyFields.code ?? `HTTP_${statusCode}`,
    retryable: false,
    retryDelayMs: retryAfterMs,
    sanitizedMessage,
  };
}

function computeRetryDelayMs(options: {
  retryIndex: number;
  explicitDelayMs?: number | undefined;
  initialDelayMs: number;
  maxRetryDelayMs: number;
  random: () => number;
}): number | null {
  if (options.explicitDelayMs !== undefined) {
    if (options.explicitDelayMs > options.maxRetryDelayMs) {
      return null;
    }
    return Math.max(0, options.explicitDelayMs);
  }
  const exponential = options.initialDelayMs * 2 ** options.retryIndex;
  const bounded = Math.min(options.maxRetryDelayMs, exponential);
  const jitter = Math.floor(
    options.random() * Math.min(250, Math.max(1, Math.floor(bounded * 0.25))),
  );
  return Math.min(options.maxRetryDelayMs, bounded + jitter);
}

export interface GroqStructuredCompletionOptions<T> {
  apiKey: string;
  baseUrl?: string | undefined;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  strictSchema: Record<string, unknown>;
  parseAndValidate: (rawText: string, parsedJson: unknown) => T;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  maxValidationRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: GroqFetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  onAttempt?: ((event: GroqAttemptDiagnosticEvent) => void) | undefined;
}

export interface GroqStructuredCompletionResult<T> {
  data: T;
  rawText: string;
  tokenUsage?:
    | {
        promptTokens?: number | undefined;
        completionTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
  metadata: GroqExecutionMetadata;
}

interface GroqChatCompletionResponse {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      refusal?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join('');
  }
  return '';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeGroqStructuredCompletion<T>(
  options: GroqStructuredCompletionOptions<T>,
): Promise<GroqStructuredCompletionResult<T>> {
  const startTotalMs = Date.now();
  const baseUrl = (options.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_GROQ_MAX_RETRIES);
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_GROQ_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_GROQ_MAX_RETRY_DELAY_MS;
  const fetchFn: GroqFetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const sleepFn = options.sleep ?? defaultSleep;
  const randomFn = options.random ?? Math.random;

  const attemptHistory: GroqAttemptDiagnosticEvent[] = [];
  let responseFormatMode: 'json_schema' | 'json_object' = 'json_schema';
  let jsonObjectFallbackUsed = false;
  let lastClassification: GroqClassifiedFailure | undefined;
  let retriesUsed = 0;
  let validationRetriesUsed = 0;
  const maxValidationRetries = Math.max(
    0,
    options.maxValidationRetries ?? (maxRetries > 0 ? 1 : 0),
  );

  while (true) {
    const attemptNumber = attemptHistory.length + 1;
    const stage: GroqAttemptDiagnosticEvent['stage'] =
      attemptNumber === 1
        ? 'primary'
        : jsonObjectFallbackUsed &&
            attemptHistory.at(-1)?.classification === 'SCHEMA_FORMAT_UNSUPPORTED'
          ? 'json_object_fallback'
          : attemptHistory.at(-1)?.classification === 'RESPONSE_INVALID_JSON' ||
              attemptHistory.at(-1)?.classification === 'RESPONSE_SCHEMA_INVALID' ||
              attemptHistory.at(-1)?.classification === 'RESPONSE_EMPTY'
            ? 'validation_retry'
            : 'retry';

    const attemptStartMs = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;

    const onExternalAbort = (): void => {
      externallyAborted = true;
      controller.abort(options.signal?.reason);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        externallyAborted = true;
        controller.abort(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException(`Groq request timed out after ${timeoutMs}ms`, 'TimeoutError'),
      );
    }, timeoutMs);

    try {
      const requestBody = {
        model: options.model,
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: options.userPrompt },
        ],
        temperature: 0,
        response_format:
          responseFormatMode === 'json_object'
            ? { type: 'json_object' }
            : {
                type: 'json_schema',
                json_schema: {
                  name: options.schemaName,
                  strict: true,
                  schema: options.strictSchema,
                },
              },
      };

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey.trim()}`,
        },
        body: JSON.stringify(requestBody),
        redirect: 'error',
        signal: controller.signal,
      });

      const durationMs = Date.now() - attemptStartMs;

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterHeaderMs(response.headers?.get('retry-after'));
        let errorPayload: unknown;
        try {
          const rawErrText = await response.text();
          if (rawErrText) {
            try {
              errorPayload = JSON.parse(rawErrText);
            } catch {
              errorPayload = { message: rawErrText };
            }
          }
        } catch {
          errorPayload = undefined;
        }

        const classified = classifyGroqFailure({
          statusCode: response.status,
          body: errorPayload,
          retryAfterMs,
          maxRetryDelayMs,
        });
        lastClassification = classified;

        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: classified.kind === 'CONTENT_SAFETY' ? 'blocked' : 'error',
          httpStatus: classified.statusCode,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        // One-shot fallback to json_object mode when upstream reports strict schema grammar unsupported
        if (
          classified.allowJsonObjectFallback &&
          responseFormatMode === 'json_schema' &&
          !jsonObjectFallbackUsed
        ) {
          responseFormatMode = 'json_object';
          jsonObjectFallbackUsed = true;
          continue;
        }

        if (classified.retryable && retriesUsed < maxRetries) {
          const delayMs = computeRetryDelayMs({
            retryIndex: retriesUsed,
            explicitDelayMs: classified.retryDelayMs,
            initialDelayMs,
            maxRetryDelayMs,
            random: randomFn,
          });
          if (delayMs !== null) {
            retriesUsed += 1;
            await sleepFn(delayMs);
            continue;
          }
        }

        const allTimedOut =
          attemptHistory.length > 0 &&
          attemptHistory.every((item) => item.classification === 'TIMEOUT');
        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            attemptHistory,
            lastFailureClassification: classified,
          },
          allTimedOut,
        );
      }

      const rawResponseText = await response.text();
      let chatPayload: GroqChatCompletionResponse;
      try {
        chatPayload = JSON.parse(rawResponseText) as GroqChatCompletionResponse;
      } catch {
        const classified: GroqClassifiedFailure = {
          kind: 'RESPONSE_INVALID_JSON',
          statusCode: response.status,
          providerErrorCode: 'INVALID_ENVELOPE_JSON',
          retryable: false,
          sanitizedMessage: 'Groq HTTP response envelope was not valid JSON',
        };
        lastClassification = classified;
        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'error',
          httpStatus: response.status,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        if (validationRetriesUsed < maxValidationRetries) {
          validationRetriesUsed += 1;
          continue;
        }

        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            attemptHistory,
            lastFailureClassification: classified,
          },
          false,
        );
      }

      const firstChoice = chatPayload.choices?.[0];
      const finishReason =
        typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined;
      const refusal =
        typeof firstChoice?.message?.refusal === 'string' &&
        firstChoice.message.refusal.trim().length > 0
          ? firstChoice.message.refusal
          : undefined;

      if (finishReason === 'content_filter' || refusal !== undefined) {
        const classified: GroqClassifiedFailure = {
          kind: 'CONTENT_SAFETY',
          statusCode: response.status,
          providerErrorCode: 'CONTENT_FILTER',
          finishReason: finishReason ?? 'content_filter',
          retryable: false,
          sanitizedMessage: 'Groq blocked generation due to safety or content policy',
        };
        lastClassification = classified;
        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'blocked',
          httpStatus: response.status,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          finishReason: classified.finishReason,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            finishReason: classified.finishReason,
            attemptHistory,
            lastFailureClassification: classified,
          },
          false,
        );
      }

      const contentText = extractMessageText(firstChoice?.message?.content).trim();
      if (!contentText) {
        const classified: GroqClassifiedFailure = {
          kind: 'RESPONSE_EMPTY',
          statusCode: response.status,
          providerErrorCode: 'EMPTY_RESPONSE',
          finishReason,
          retryable: false,
          sanitizedMessage: 'Empty message content returned by Groq provider',
        };
        lastClassification = classified;
        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'error',
          httpStatus: response.status,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          finishReason,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        if (validationRetriesUsed < maxValidationRetries) {
          validationRetriesUsed += 1;
          continue;
        }

        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            finishReason,
            attemptHistory,
            lastFailureClassification: classified,
          },
          false,
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contentText);
      } catch {
        const classified: GroqClassifiedFailure = {
          kind: 'RESPONSE_INVALID_JSON',
          statusCode: response.status,
          providerErrorCode: 'INVALID_JSON',
          finishReason,
          retryable: false,
          sanitizedMessage: 'Failed to parse Groq response content as JSON',
        };
        lastClassification = classified;
        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'error',
          httpStatus: response.status,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          finishReason,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        if (validationRetriesUsed < maxValidationRetries) {
          validationRetriesUsed += 1;
          continue;
        }

        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            finishReason,
            attemptHistory,
            lastFailureClassification: classified,
          },
          false,
        );
      }

      let validated: T;
      try {
        validated = options.parseAndValidate(contentText, parsedJson);
      } catch (validationErr: unknown) {
        const safeValidationMsg = sanitizeAiErrorMessage(
          validationErr instanceof Error ? validationErr.message : String(validationErr),
        );
        const classified: GroqClassifiedFailure = {
          kind: 'RESPONSE_SCHEMA_INVALID',
          statusCode: response.status,
          providerErrorCode: 'SCHEMA_VALIDATION_FAILED',
          finishReason,
          retryable: false,
          sanitizedMessage: safeValidationMsg,
        };
        lastClassification = classified;
        const evt: GroqAttemptDiagnosticEvent = {
          provider: 'groq',
          model: options.model,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'error',
          httpStatus: response.status,
          providerErrorCode: classified.providerErrorCode,
          classification: classified.kind,
          finishReason,
          sanitizedErrorMessage: classified.sanitizedMessage,
        };
        attemptHistory.push(evt);
        options.onAttempt?.(evt);

        if (validationRetriesUsed < maxValidationRetries) {
          validationRetriesUsed += 1;
          continue;
        }

        throw new GroqExecutionError(
          classified,
          {
            provider: 'groq',
            modelUsed: options.model,
            attemptsTotal: attemptHistory.length,
            responseFormatMode,
            fallbackUsed: jsonObjectFallbackUsed,
            totalDurationMs: Date.now() - startTotalMs,
            finishReason,
            attemptHistory,
            lastFailureClassification: classified,
          },
          false,
        );
      }

      const resolvedModel =
        typeof chatPayload.model === 'string' && chatPayload.model.trim()
          ? chatPayload.model.trim()
          : options.model;
      const successEvt: GroqAttemptDiagnosticEvent = {
        provider: 'groq',
        model: resolvedModel,
        attemptNumber,
        stage,
        durationMs,
        outcome: 'success',
        httpStatus: response.status,
        finishReason,
      };
      attemptHistory.push(successEvt);
      options.onAttempt?.(successEvt);

      const usage = chatPayload.usage;
      const tokenUsage =
        usage &&
        (typeof usage.prompt_tokens === 'number' ||
          typeof usage.completion_tokens === 'number' ||
          typeof usage.total_tokens === 'number')
          ? {
              promptTokens:
                typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
              completionTokens:
                typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
              totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
            }
          : undefined;

      return {
        data: validated,
        rawText: contentText,
        tokenUsage,
        metadata: {
          provider: 'groq',
          modelUsed: resolvedModel,
          attemptsTotal: attemptHistory.length,
          responseFormatMode,
          fallbackUsed: jsonObjectFallbackUsed,
          totalDurationMs: Date.now() - startTotalMs,
          finishReason,
          attemptHistory,
          lastFailureClassification: lastClassification,
        },
      };
    } catch (error: unknown) {
      if (error instanceof GroqExecutionError) {
        throw error;
      }

      const durationMs = Date.now() - attemptStartMs;
      const classified = classifyGroqFailure({
        error,
        timedOut,
        externallyAborted,
        maxRetryDelayMs,
      });
      lastClassification = classified;

      const evt: GroqAttemptDiagnosticEvent = {
        provider: 'groq',
        model: options.model,
        attemptNumber,
        stage,
        durationMs,
        outcome: 'error',
        httpStatus: classified.statusCode,
        providerErrorCode: classified.providerErrorCode,
        classification: classified.kind,
        sanitizedErrorMessage: classified.sanitizedMessage,
      };
      attemptHistory.push(evt);
      options.onAttempt?.(evt);

      if (classified.retryable && retriesUsed < maxRetries) {
        const delayMs = computeRetryDelayMs({
          retryIndex: retriesUsed,
          explicitDelayMs: classified.retryDelayMs,
          initialDelayMs,
          maxRetryDelayMs,
          random: randomFn,
        });
        if (delayMs !== null) {
          retriesUsed += 1;
          await sleepFn(delayMs);
          continue;
        }
      }

      const allTimedOut =
        attemptHistory.length > 0 &&
        attemptHistory.every((item) => item.classification === 'TIMEOUT');
      throw new GroqExecutionError(
        classified,
        {
          provider: 'groq',
          modelUsed: options.model,
          attemptsTotal: attemptHistory.length,
          responseFormatMode,
          fallbackUsed: jsonObjectFallbackUsed,
          totalDurationMs: Date.now() - startTotalMs,
          attemptHistory,
          lastFailureClassification: classified,
        },
        allTimedOut,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
