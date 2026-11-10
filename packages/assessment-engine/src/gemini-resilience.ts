export const CANONICAL_GEMINI_MODEL = 'gemini-3.6-flash' as const;
export const CANONICAL_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash' as const;
export const DEFAULT_GEMINI_TIMEOUT_MS = 90_000;
export const DEFAULT_GEMINI_MAX_RETRIES = 2;
export const DEFAULT_GEMINI_INITIAL_RETRY_DELAY_MS = 500;
export const DEFAULT_GEMINI_MAX_RETRY_DELAY_MS = 10_000;

export const SUPPORTED_GEMINI_MODELS = [
  CANONICAL_GEMINI_MODEL,
  CANONICAL_GEMINI_FALLBACK_MODEL,
] as const;

export type SupportedGeminiModel = (typeof SUPPORTED_GEMINI_MODELS)[number];

export type GeminiFailureKind =
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'CONTENT_SAFETY'
  | 'RATE_LIMIT_PROJECT_QUOTA'
  | 'RATE_LIMIT_MODEL_SCOPED'
  | 'RATE_LIMIT_GENERIC'
  | 'TIMEOUT'
  | 'SERVICE_UNAVAILABLE'
  | 'TRANSIENT_UPSTREAM';

export interface GeminiQuotaViolation {
  quotaId?: string | undefined;
  quotaMetric?: string | undefined;
  quotaDimensions?: Record<string, string> | undefined;
  quotaValue?: string | undefined;
  description?: string | undefined;
}

export interface GeminiClassifiedFailure {
  kind: GeminiFailureKind;
  statusCode?: number | undefined;
  rpcStatus?: string | undefined;
  retryable: boolean;
  allowFallback: boolean;
  retryDelayMs?: number | undefined;
  sanitizedMessage: string;
  quotaViolations: GeminiQuotaViolation[];
}

export type GeminiExecutionStage = 'primary' | 'retry' | 'fallback';

export interface GeminiAttemptDiagnosticEvent {
  model: SupportedGeminiModel;
  attemptNumber: number;
  stage: GeminiExecutionStage;
  durationMs: number;
  outcome: 'success' | 'blocked' | 'error';
  httpStatus?: number | undefined;
  providerErrorCode?: string | undefined;
  classification?: GeminiFailureKind | undefined;
  finishReason?: string | undefined;
  blockReason?: string | undefined;
  sanitizedErrorMessage?: string | undefined;
}

export interface GeminiExecutionMetadata {
  provider: 'gemini';
  primaryModel: SupportedGeminiModel;
  fallbackModel: SupportedGeminiModel | null;
  modelUsed: SupportedGeminiModel;
  fallbackUsed: boolean;
  attemptedModels: SupportedGeminiModel[];
  attemptsTotal: number;
  primaryAttempts: number;
  fallbackAttempts: number;
  totalDurationMs?: number | undefined;
  finishReason?: string | undefined;
  blockReason?: string | undefined;
  attemptHistory?: GeminiAttemptDiagnosticEvent[] | undefined;
  lastFailureClassification?: GeminiClassifiedFailure | undefined;
}

export class GeminiExecutionError extends Error {
  public readonly classification: GeminiClassifiedFailure;
  public readonly metadata: Omit<GeminiExecutionMetadata, 'modelUsed'>;
  public readonly allAttemptsTimedOut: boolean;

  constructor(
    classification: GeminiClassifiedFailure,
    metadata: Omit<GeminiExecutionMetadata, 'modelUsed'>,
    allAttemptsTimedOut: boolean,
  ) {
    super(classification.sanitizedMessage);
    this.name = 'GeminiExecutionError';
    this.classification = classification;
    this.metadata = metadata;
    this.allAttemptsTimedOut = allAttemptsTimedOut;
  }
}

export function sanitizeGeminiErrorMessage(message: string): string {
  return message
    .replace(/AIza[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/gsk_[A-Za-z0-9_-]+/g, '[REDACTED_GROQ_API_KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/([?&](?:api_?key|key|token|access_token)=)[^&\s"'`]+/gi, '$1[REDACTED]')
    .replace(
      /((?:x-goog-api-key|x-api-key|groq-api-key)\s*[:=]\s*)[^\s"',;]+/gi,
      '$1[REDACTED_API_KEY]',
    )
    .replace(/(authorization\s*[:=]\s*)[^\r\n"';]+/gi, '$1[REDACTED_AUTH]')
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED_COOKIE]')
    .replace(/(talentlens_session\s*=\s*)[^\s;,"']+/gi, '$1[REDACTED_SESSION]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://[REDACTED]')
    .replace(
      /("(?:api_?key|apiKey|token|accessToken|authorization|cookie)"\s*:\s*")[^"]+(")/gi,
      '$1[REDACTED]$2',
    );
}

export function isPlaceholderGeminiKey(apiKey: string): boolean {
  const normalized = apiKey.trim().toLowerCase();
  return (
    normalized.includes('placeholder') ||
    normalized.includes('your_') ||
    normalized.includes('change_this') ||
    normalized.includes('aizasysynthetic') ||
    normalized.startsWith('<')
  );
}

export function normalizeGeminiModelId(model: string): string {
  return model
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

export function isDisallowedFlashLiteModel(model: string): boolean {
  const normalized = normalizeGeminiModelId(model);
  return normalized.includes('flash-lite') || /(?:^|-)lite$/.test(normalized);
}

export function isSupportedGeminiModel(model: string): model is SupportedGeminiModel {
  const normalized = normalizeGeminiModelId(model);
  return (SUPPORTED_GEMINI_MODELS as readonly string[]).includes(normalized);
}

export type GeminiModelValidationResult =
  | { valid: true; model: SupportedGeminiModel }
  | { valid: false; normalized: string; reason: string };

export function validateGeminiModelId(
  rawModel: string,
  role: 'primary' | 'fallback' = 'primary',
): GeminiModelValidationResult {
  const trimmed = rawModel.trim();
  const normalized = normalizeGeminiModelId(rawModel);
  const label = role === 'fallback' ? 'GEMINI_FALLBACK_MODEL' : 'GEMINI_MODEL';

  if (!trimmed) {
    return {
      valid: false,
      normalized,
      reason: `${label} configuration cannot be empty.`,
    };
  }

  if (isDisallowedFlashLiteModel(normalized)) {
    return {
      valid: false,
      normalized,
      reason: `${label} cannot use Flash-Lite models (${trimmed}); configure ${SUPPORTED_GEMINI_MODELS.join(' or ')}.`,
    };
  }

  if (!normalized.startsWith('gemini-') || !isSupportedGeminiModel(normalized)) {
    return {
      valid: false,
      normalized,
      reason: `Unsupported Gemini model "${trimmed}" for ${label}; allowed Free-Tier models are ${SUPPORTED_GEMINI_MODELS.join(', ')} (primary default: ${CANONICAL_GEMINI_MODEL}, fallback default: ${CANONICAL_GEMINI_FALLBACK_MODEL}).`,
    };
  }

  return { valid: true, model: normalized };
}

export interface ResolvedGeminiModelPair {
  primaryModel: SupportedGeminiModel;
  fallbackModel: SupportedGeminiModel | null;
  deduplicatedFallback: boolean;
}

export type ResolveGeminiModelPairResult =
  | { ok: true; value: ResolvedGeminiModelPair }
  | { ok: false; field: 'primary' | 'fallback'; reason: string };

export function resolveGeminiModelPair(options: {
  primaryModel?: string | undefined;
  fallbackModel?: string | null | undefined;
}): ResolveGeminiModelPairResult {
  if (options.primaryModel !== undefined && options.primaryModel.trim() === '') {
    return {
      ok: false,
      field: 'primary',
      reason: 'GEMINI_MODEL configuration cannot be empty.',
    };
  }

  const rawPrimary = options.primaryModel?.trim() || CANONICAL_GEMINI_MODEL;
  const primaryCheck = validateGeminiModelId(rawPrimary, 'primary');
  if (!primaryCheck.valid) {
    return {
      ok: false,
      field: 'primary',
      reason: primaryCheck.reason,
    };
  }

  if (options.fallbackModel === null) {
    return {
      ok: true,
      value: {
        primaryModel: primaryCheck.model,
        fallbackModel: null,
        deduplicatedFallback: false,
      },
    };
  }

  if (options.fallbackModel !== undefined && options.fallbackModel.trim() === '') {
    return {
      ok: false,
      field: 'fallback',
      reason: 'GEMINI_FALLBACK_MODEL configuration cannot be empty.',
    };
  }

  const rawFallback = options.fallbackModel?.trim() || CANONICAL_GEMINI_FALLBACK_MODEL;
  const fallbackCheck = validateGeminiModelId(rawFallback, 'fallback');
  if (!fallbackCheck.valid) {
    return {
      ok: false,
      field: 'fallback',
      reason: fallbackCheck.reason,
    };
  }

  if (fallbackCheck.model === primaryCheck.model) {
    return {
      ok: true,
      value: {
        primaryModel: primaryCheck.model,
        fallbackModel: null,
        deduplicatedFallback: true,
      },
    };
  }

  return {
    ok: true,
    value: {
      primaryModel: primaryCheck.model,
      fallbackModel: fallbackCheck.model,
      deduplicatedFallback: false,
    },
  };
}

export function parseRetryDelayMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const msMatch = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(trimmed);
    if (msMatch?.[1]) {
      const parsed = Math.ceil(Number(msMatch[1]));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    const secMatch = /^(\d+(?:\.\d+)?)\s*s$/i.exec(trimmed);
    if (secMatch?.[1]) {
      const parsed = Math.ceil(Number(secMatch[1]) * 1000);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    const obj = value as { seconds?: unknown; nanos?: unknown };
    const secNum =
      typeof obj.seconds === 'number'
        ? obj.seconds
        : typeof obj.seconds === 'string' && /^-?\d+$/.test(obj.seconds.trim())
          ? Number(obj.seconds.trim())
          : 0;
    const nanosNum =
      typeof obj.nanos === 'number'
        ? obj.nanos
        : typeof obj.nanos === 'string' && /^-?\d+$/.test(obj.nanos.trim())
          ? Number(obj.nanos.trim())
          : 0;
    if (Number.isFinite(secNum) && Number.isFinite(nanosNum)) {
      const totalMs = Math.ceil(secNum * 1000 + nanosNum / 1_000_000);
      return totalMs > 0 ? totalMs : undefined;
    }
  }

  return undefined;
}

function tryParseEmbeddedJson(message: string): Record<string, unknown> | null {
  const firstBrace = message.indexOf('{');
  const lastBrace = message.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  const candidate = message.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function extractQuotaViolations(details: unknown[]): GeminiQuotaViolation[] {
  const violations: GeminiQuotaViolation[] = [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      continue;
    }
    const record = detail as Record<string, unknown>;
    const typeUrl = typeof record['@type'] === 'string' ? record['@type'] : '';
    if (!typeUrl.includes('QuotaFailure') && !Array.isArray(record.violations)) {
      continue;
    }
    if (!Array.isArray(record.violations)) {
      continue;
    }
    for (const item of record.violations) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const v = item as Record<string, unknown>;
      let quotaDimensions: Record<string, string> | undefined;
      if (
        v.quotaDimensions &&
        typeof v.quotaDimensions === 'object' &&
        !Array.isArray(v.quotaDimensions)
      ) {
        quotaDimensions = {};
        for (const [dk, dv] of Object.entries(v.quotaDimensions as Record<string, unknown>)) {
          if (typeof dv === 'string') {
            quotaDimensions[dk] = dv;
          }
        }
      }
      violations.push({
        quotaId: typeof v.quotaId === 'string' ? v.quotaId : undefined,
        quotaMetric: typeof v.quotaMetric === 'string' ? v.quotaMetric : undefined,
        quotaDimensions,
        quotaValue:
          typeof v.quotaValue === 'string' || typeof v.quotaValue === 'number'
            ? String(v.quotaValue)
            : undefined,
        description: typeof v.description === 'string' ? v.description : undefined,
      });
    }
  }
  return violations;
}

function extractRetryDelayFromDetailsOrText(details: unknown[], text: string): number | undefined {
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      continue;
    }
    const record = detail as Record<string, unknown>;
    const typeUrl = typeof record['@type'] === 'string' ? record['@type'] : '';
    if (typeUrl.includes('RetryInfo') || record.retryDelay !== undefined) {
      const parsed = parseRetryDelayMs(record.retryDelay);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  const inlineMatch =
    /Please retry in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text) ??
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?\s*(?:ms|s))"/i.exec(text);
  if (inlineMatch?.[1]) {
    const rawUnit = inlineMatch[2] ? `${inlineMatch[1]}${inlineMatch[2]}` : inlineMatch[1];
    const parsed = parseRetryDelayMs(rawUnit);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function extractNumericStatus(
  err: unknown,
  embeddedJson: Record<string, unknown> | null,
  text: string,
): number | undefined {
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    for (const key of ['status', 'statusCode']) {
      const val = rec[key];
      if (typeof val === 'number' && Number.isInteger(val) && val >= 400 && val <= 599) {
        return val;
      }
    }
  }

  const embeddedError =
    embeddedJson?.error &&
    typeof embeddedJson.error === 'object' &&
    !Array.isArray(embeddedJson.error)
      ? (embeddedJson.error as Record<string, unknown>)
      : null;
  if (
    embeddedError &&
    typeof embeddedError.code === 'number' &&
    embeddedError.code >= 400 &&
    embeddedError.code <= 599
  ) {
    return embeddedError.code;
  }

  const msgMatch =
    /(?:^|\[|\bHTTP\s+|\bgot status:\s*|\bstatus[:\s]+)\s*(400|401|403|404|408|413|422|429|500|502|503|504)\b/i.exec(
      text,
    );
  if (msgMatch?.[1]) {
    return Number(msgMatch[1]);
  }
  return undefined;
}

export function classifyGeminiFailure(error: unknown): GeminiClassifiedFailure {
  const errObj = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const errorName = typeof errObj?.name === 'string' ? errObj.name : '';
  const rawMessage =
    error instanceof Error ? error.message : String(error ?? 'Unknown Gemini error');
  const sanitizedMessage = sanitizeGeminiErrorMessage(rawMessage);
  const embeddedJson = tryParseEmbeddedJson(rawMessage);

  const embeddedError =
    embeddedJson?.error &&
    typeof embeddedJson.error === 'object' &&
    !Array.isArray(embeddedJson.error)
      ? (embeddedJson.error as Record<string, unknown>)
      : embeddedJson;

  const statusCode = extractNumericStatus(error, embeddedJson, sanitizedMessage);
  const rpcStatus =
    typeof embeddedError?.status === 'string'
      ? embeddedError.status.trim().toUpperCase()
      : typeof errObj?.rpcStatus === 'string'
        ? errObj.rpcStatus.trim().toUpperCase()
        : undefined;

  const details: unknown[] = [];
  if (Array.isArray(embeddedError?.details)) {
    details.push(...embeddedError.details);
  }
  if (Array.isArray(errObj?.details)) {
    details.push(...errObj.details);
  }
  if (Array.isArray(errObj?.errorDetails)) {
    details.push(...errObj.errorDetails);
  }

  const rpcMessage =
    typeof embeddedError?.message === 'string'
      ? sanitizeGeminiErrorMessage(embeddedError.message)
      : '';
  const quotaViolations = extractQuotaViolations(details);
  const retryDelayMs = extractRetryDelayFromDetailsOrText(
    details,
    `${sanitizedMessage} ${rpcMessage}`,
  );

  const violationText = quotaViolations
    .map((v) =>
      [
        v.quotaId ?? '',
        v.quotaMetric ?? '',
        v.quotaValue ?? '',
        v.description ?? '',
        v.quotaDimensions ? JSON.stringify(v.quotaDimensions) : '',
      ].join(' '),
    )
    .join(' ');
  const combinedText = `${sanitizedMessage} ${rpcMessage} ${violationText}`.trim();

  // 1. Auth errors (401/403 or invalid API key): fail fast, never retry or fallback
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    rpcStatus === 'UNAUTHENTICATED' ||
    rpcStatus === 'PERMISSION_DENIED' ||
    /API key not valid|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED|invalid api key/i.test(
      combinedText,
    )
  ) {
    return {
      kind: 'AUTH',
      statusCode,
      rpcStatus,
      retryable: false,
      allowFallback: false,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 2. Model not found (404 / NOT_FOUND): fail fast, never retry or fallback
  if (
    statusCode === 404 ||
    rpcStatus === 'NOT_FOUND' ||
    /\bNOT_FOUND\b|is not found for api version|model not found/i.test(combinedText)
  ) {
    return {
      kind: 'MODEL_NOT_FOUND',
      statusCode,
      rpcStatus,
      retryable: false,
      allowFallback: false,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 3. Content safety / prompt block: never retry or model-hop
  if (
    /prompt\s*(?:was\s*)?blocked|candidate\s*(?:was\s*)?blocked|finishReason["':\s]+(?:SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII)|blockReason["':\s]+(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT|MODEL_ARMOR|JAILBREAK|OTHER)|\b(?:PROHIBITED_CONTENT|HARM_CATEGORY_)/i.test(
      combinedText,
    )
  ) {
    return {
      kind: 'CONTENT_SAFETY',
      statusCode,
      rpcStatus,
      retryable: false,
      allowFallback: false,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 4. Malformed / client request errors (400/413/422): never retry or fallback
  if (
    statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 422 ||
    rpcStatus === 'INVALID_ARGUMENT' ||
    rpcStatus === 'FAILED_PRECONDITION' ||
    rpcStatus === 'OUT_OF_RANGE' ||
    /\bINVALID_ARGUMENT\b|\bFAILED_PRECONDITION\b|payload\s+too\s+large|request\s+(?:entity|size)\s+too\s+large|malformed\s+request/i.test(
      combinedText,
    )
  ) {
    return {
      kind: 'INVALID_REQUEST',
      statusCode,
      rpcStatus,
      retryable: false,
      allowFallback: false,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 5. Rate limit & quota (429 / RESOURCE_EXHAUSTED): inspect QuotaFailure carefully
  if (
    statusCode === 429 ||
    rpcStatus === 'RESOURCE_EXHAUSTED' ||
    /\bRESOURCE_EXHAUSTED\b|rate\s*limit|quota\s*exceeded/i.test(combinedText)
  ) {
    const hasHardProjectQuotaViolation = quotaViolations.some((v) => {
      if (v.quotaValue !== undefined && v.quotaValue.trim() === '0') {
        return true;
      }
      const idAndMetric = `${v.quotaId ?? ''} ${v.quotaMetric ?? ''} ${v.description ?? ''}`;
      return /(per\s*_?day|\brpd\b|requests_?per_?day|daily|billing|spend|budget|project_?wide|account_?wide)/i.test(
        idAndMetric,
      );
    });

    const hasHardProjectQuotaText =
      /\blimit\s*[:=]\s*0\b|per\s*day|daily\s*(?:quota|limit)|requests\s*per\s*day|\bRPD\b|exceeded your current quota.*billing|plan and billing details|billing\s+(?:account|cap|limit|disabled)|spend\s*(?:cap|limit)|zero\s*quota/i.test(
        combinedText,
      );

    if (hasHardProjectQuotaViolation || hasHardProjectQuotaText) {
      return {
        kind: 'RATE_LIMIT_PROJECT_QUOTA',
        statusCode: statusCode ?? 429,
        rpcStatus: rpcStatus ?? 'RESOURCE_EXHAUSTED',
        retryable: false,
        allowFallback: false,
        retryDelayMs,
        sanitizedMessage,
        quotaViolations,
      };
    }

    const hasModelScopedViolation = quotaViolations.some((v) => {
      const idAndMetric = `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`;
      const isPerMinute =
        /(per\s*_?minute|per_?min|\bRPM\b|\bTPM\b|tokens_?per_?minute|requests_?per_?minute)/i.test(
          idAndMetric,
        );
      const isPerModel =
        /(per_?model|perprojectpermodel)/i.test(idAndMetric) || Boolean(v.quotaDimensions?.model);
      return isPerMinute && isPerModel;
    });

    const hasModelScopedText =
      /Generate(?:Requests|ContentInputTokens|Tokens)PerMinutePer(?:ProjectPer)?Model|\bper[-_\s]*model\s+(?:RPM|TPM|rate\s*limit)|(?:RPM|TPM)\s+(?:limit|exceeded)\s+(?:for|on)\s+model|model[-_\s]+specific\s+(?:RPM|TPM|rate\s*limit)/i.test(
        combinedText,
      );

    if (hasModelScopedViolation || hasModelScopedText) {
      return {
        kind: 'RATE_LIMIT_MODEL_SCOPED',
        statusCode: statusCode ?? 429,
        rpcStatus: rpcStatus ?? 'RESOURCE_EXHAUSTED',
        retryable: true,
        allowFallback: true,
        retryDelayMs,
        sanitizedMessage,
        quotaViolations,
      };
    }

    return {
      kind: 'RATE_LIMIT_GENERIC',
      statusCode: statusCode ?? 429,
      rpcStatus: rpcStatus ?? 'RESOURCE_EXHAUSTED',
      retryable: true,
      allowFallback: false,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 6. Timeout / deadline exceeded: retry boundedly + allow fallback
  if (
    statusCode === 408 ||
    rpcStatus === 'DEADLINE_EXCEEDED' ||
    errorName === 'AbortError' ||
    errorName === 'TimeoutError' ||
    /timeout|timed[\s_]*out|ETIMEDOUT|DEADLINE_EXCEEDED/i.test(combinedText)
  ) {
    return {
      kind: 'TIMEOUT',
      statusCode,
      rpcStatus,
      retryable: true,
      allowFallback: true,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 7. Service unavailable (503 / UNAVAILABLE): retry with backoff/jitter + single fallback
  if (
    statusCode === 503 ||
    rpcStatus === 'UNAVAILABLE' ||
    /\bUNAVAILABLE\b|service(?:\s+is)?\s+(?:currently\s+|temporarily\s+)?unavailable|overloaded|high demand/i.test(
      combinedText,
    )
  ) {
    return {
      kind: 'SERVICE_UNAVAILABLE',
      statusCode: statusCode ?? 503,
      rpcStatus: rpcStatus ?? 'UNAVAILABLE',
      retryable: true,
      allowFallback: true,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 8. Transient upstream 5xx & network errors: retry boundedly + allow fallback
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 504 ||
    rpcStatus === 'INTERNAL' ||
    rpcStatus === 'UNKNOWN' ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error/i.test(
      combinedText,
    )
  ) {
    return {
      kind: 'TRANSIENT_UPSTREAM',
      statusCode,
      rpcStatus,
      retryable: true,
      allowFallback: true,
      retryDelayMs,
      sanitizedMessage,
      quotaViolations,
    };
  }

  // 9. Unknown non-transient failure: do not loop or fallback blindly
  return {
    kind: 'INVALID_REQUEST',
    statusCode,
    rpcStatus,
    retryable: false,
    allowFallback: false,
    retryDelayMs,
    sanitizedMessage,
    quotaViolations,
  };
}

const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

export interface GeminiSafetyInspectableResponse {
  text?: string | undefined;
  promptFeedback?:
    | {
        blockReason?: string | undefined;
        blockReasonMessage?: string | undefined;
      }
    | undefined;
  candidates?:
    | Array<{
        finishReason?: string | undefined;
        finishMessage?: string | undefined;
      }>
    | undefined;
}

export function extractGeminiResponseReasons(response: GeminiSafetyInspectableResponse): {
  finishReason?: string | undefined;
  blockReason?: string | undefined;
} {
  const rawBlockReason = response.promptFeedback?.blockReason;
  const blockReason =
    rawBlockReason && rawBlockReason !== 'BLOCKED_REASON_UNSPECIFIED' ? rawBlockReason : undefined;
  const finishReason = response.candidates?.[0]?.finishReason;
  return {
    finishReason,
    blockReason,
  };
}

export function inspectGeminiResponseForBlock(
  response: GeminiSafetyInspectableResponse,
): { blocked: false } | { blocked: true; reason: string; message: string } {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason && blockReason !== 'BLOCKED_REASON_UNSPECIFIED') {
    const safeDetail = response.promptFeedback?.blockReasonMessage
      ? `: ${sanitizeGeminiErrorMessage(response.promptFeedback.blockReasonMessage)}`
      : '';
    return {
      blocked: true,
      reason: blockReason,
      message: `Gemini blocked request content (${blockReason})${safeDetail}`,
    };
  }

  const firstCandidate = response.candidates?.[0];
  const finishReason = firstCandidate?.finishReason;
  if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) {
    const safeDetail = firstCandidate?.finishMessage
      ? `: ${sanitizeGeminiErrorMessage(firstCandidate.finishMessage)}`
      : '';
    return {
      blocked: true,
      reason: finishReason,
      message: `Gemini stopped generation due to safety/policy filter (${finishReason})${safeDetail}`,
    };
  }

  return { blocked: false };
}

export function computeRetryDelayMs(options: {
  attempt: number;
  initialDelayMs: number;
  maxRetryDelayMs: number;
  retryAfterMs?: number | undefined;
  random?: (() => number) | undefined;
}): { delayMs: number; exceedsCap: boolean } {
  const safeInitial = Math.max(1, options.initialDelayMs);
  const safeMax = Math.max(safeInitial, options.maxRetryDelayMs);
  const randRaw = options.random ? options.random() : Math.random();
  const rand = Number.isFinite(randRaw) ? Math.min(1, Math.max(0, randRaw)) : 0.5;

  const exponentialBase = safeInitial * Math.pow(2, Math.max(0, options.attempt));
  const jittered = Math.round(exponentialBase * (0.5 + rand));

  if (options.retryAfterMs !== undefined && options.retryAfterMs > 0) {
    if (options.retryAfterMs > safeMax) {
      return { delayMs: safeMax, exceedsCap: true };
    }
    return {
      delayMs: Math.min(safeMax, Math.max(options.retryAfterMs, jittered)),
      exceedsCap: false,
    };
  }

  return {
    delayMs: Math.min(safeMax, Math.max(1, jittered)),
    exceedsCap: false,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExecuteGeminiWithResilienceOptions<
  TResponse extends GeminiSafetyInspectableResponse,
> {
  primaryModel: SupportedGeminiModel;
  fallbackModel: SupportedGeminiModel | null;
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  onAttempt?: ((event: GeminiAttemptDiagnosticEvent) => void) | undefined;
  onFallback?:
    | ((event: {
        fromModel: SupportedGeminiModel;
        toModel: SupportedGeminiModel;
        reasonKind: GeminiFailureKind;
        primaryAttempts: number;
      }) => void)
    | undefined;
  invokeModel: (model: SupportedGeminiModel) => Promise<TResponse>;
}

export async function executeGeminiWithResilience<
  TResponse extends GeminiSafetyInspectableResponse,
>(
  options: ExecuteGeminiWithResilienceOptions<TResponse>,
): Promise<{ response: TResponse; metadata: GeminiExecutionMetadata }> {
  const executionStartMs = Date.now();
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_GEMINI_MAX_RETRIES));
  const initialDelayMs = Math.max(
    1,
    Math.floor(options.initialDelayMs ?? DEFAULT_GEMINI_INITIAL_RETRY_DELAY_MS),
  );
  const maxRetryDelayMs = Math.max(
    initialDelayMs,
    Math.floor(options.maxRetryDelayMs ?? DEFAULT_GEMINI_MAX_RETRY_DELAY_MS),
  );
  const sleep = options.sleep ?? defaultSleep;

  const primaryModel = options.primaryModel;
  const effectiveFallback =
    options.fallbackModel && options.fallbackModel !== primaryModel ? options.fallbackModel : null;

  const attemptedModels: SupportedGeminiModel[] = [primaryModel];
  const attemptHistory: GeminiAttemptDiagnosticEvent[] = [];
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  let attemptsTotal = 0;
  let timeoutCount = 0;
  let lastClassification: GeminiClassifiedFailure | undefined;
  let lastFinishReason: string | undefined;
  let lastBlockReason: string | undefined;

  const buildErrorMetadata = (): Omit<GeminiExecutionMetadata, 'modelUsed'> => ({
    provider: 'gemini',
    primaryModel,
    fallbackModel: effectiveFallback,
    fallbackUsed: fallbackAttempts > 0,
    attemptedModels: [...attemptedModels],
    attemptsTotal,
    primaryAttempts,
    fallbackAttempts,
    totalDurationMs: Date.now() - executionStartMs,
    finishReason: lastFinishReason,
    blockReason: lastBlockReason,
    attemptHistory: [...attemptHistory],
    lastFailureClassification: lastClassification,
  });

  const makeContentSafetyClassification = (message: string): GeminiClassifiedFailure => ({
    kind: 'CONTENT_SAFETY',
    retryable: false,
    allowFallback: false,
    sanitizedMessage: sanitizeGeminiErrorMessage(message),
    quotaViolations: [],
  });

  const recordAttempt = (event: GeminiAttemptDiagnosticEvent): void => {
    attemptHistory.push(event);
    options.onAttempt?.(event);
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    primaryAttempts += 1;
    attemptsTotal += 1;
    const attemptNumber = attemptsTotal;
    const stage: GeminiExecutionStage = attempt === 0 ? 'primary' : 'retry';
    const attemptStartMs = Date.now();

    try {
      const response = await options.invokeModel(primaryModel);
      const durationMs = Date.now() - attemptStartMs;
      const reasons = extractGeminiResponseReasons(response);
      lastFinishReason = reasons.finishReason;
      lastBlockReason = reasons.blockReason;

      const safetyCheck = inspectGeminiResponseForBlock(response);
      if (safetyCheck.blocked) {
        lastClassification = makeContentSafetyClassification(safetyCheck.message);
        recordAttempt({
          model: primaryModel,
          attemptNumber,
          stage,
          durationMs,
          outcome: 'blocked',
          httpStatus: 200,
          classification: 'CONTENT_SAFETY',
          finishReason: reasons.finishReason,
          blockReason: reasons.blockReason ?? safetyCheck.reason,
          sanitizedErrorMessage: lastClassification.sanitizedMessage.slice(0, 300),
        });
        throw new GeminiExecutionError(lastClassification, buildErrorMetadata(), false);
      }

      recordAttempt({
        model: primaryModel,
        attemptNumber,
        stage,
        durationMs,
        outcome: 'success',
        httpStatus: 200,
        finishReason: reasons.finishReason,
        blockReason: reasons.blockReason,
      });

      return {
        response,
        metadata: {
          provider: 'gemini',
          primaryModel,
          fallbackModel: effectiveFallback,
          modelUsed: primaryModel,
          fallbackUsed: false,
          attemptedModels: [primaryModel],
          attemptsTotal,
          primaryAttempts,
          fallbackAttempts: 0,
          totalDurationMs: Date.now() - executionStartMs,
          finishReason: reasons.finishReason,
          blockReason: reasons.blockReason,
          attemptHistory: [...attemptHistory],
        },
      };
    } catch (err: unknown) {
      if (err instanceof GeminiExecutionError) {
        throw err;
      }

      const durationMs = Date.now() - attemptStartMs;
      const classified = classifyGeminiFailure(err);
      lastClassification = classified;
      lastFinishReason = undefined;
      lastBlockReason = undefined;
      if (classified.kind === 'TIMEOUT') {
        timeoutCount += 1;
      }

      recordAttempt({
        model: primaryModel,
        attemptNumber,
        stage,
        durationMs,
        outcome: 'error',
        httpStatus: classified.statusCode,
        providerErrorCode: classified.rpcStatus,
        classification: classified.kind,
        sanitizedErrorMessage: classified.sanitizedMessage.slice(0, 300),
      });

      if (!classified.retryable) {
        throw new GeminiExecutionError(
          classified,
          buildErrorMetadata(),
          timeoutCount === attemptsTotal && attemptsTotal > 0,
        );
      }

      if (attempt < maxRetries) {
        const delayPlan = computeRetryDelayMs({
          attempt,
          initialDelayMs,
          maxRetryDelayMs,
          retryAfterMs: classified.retryDelayMs,
          random: options.random,
        });

        if (delayPlan.exceedsCap) {
          // Avoid sleeping beyond the bounded cap if RetryInfo requests a longer backoff.
          break;
        }

        await sleep(delayPlan.delayMs);
        continue;
      }
    }
  }

  if (lastClassification && lastClassification.allowFallback && effectiveFallback !== null) {
    attemptedModels.push(effectiveFallback);
    fallbackAttempts = 1;
    attemptsTotal += 1;
    const attemptNumber = attemptsTotal;
    const attemptStartMs = Date.now();

    options.onFallback?.({
      fromModel: primaryModel,
      toModel: effectiveFallback,
      reasonKind: lastClassification.kind,
      primaryAttempts,
    });

    try {
      const fallbackResponse = await options.invokeModel(effectiveFallback);
      const durationMs = Date.now() - attemptStartMs;
      const reasons = extractGeminiResponseReasons(fallbackResponse);
      lastFinishReason = reasons.finishReason;
      lastBlockReason = reasons.blockReason;

      const safetyCheck = inspectGeminiResponseForBlock(fallbackResponse);
      if (safetyCheck.blocked) {
        lastClassification = makeContentSafetyClassification(safetyCheck.message);
        recordAttempt({
          model: effectiveFallback,
          attemptNumber,
          stage: 'fallback',
          durationMs,
          outcome: 'blocked',
          httpStatus: 200,
          classification: 'CONTENT_SAFETY',
          finishReason: reasons.finishReason,
          blockReason: reasons.blockReason ?? safetyCheck.reason,
          sanitizedErrorMessage: lastClassification.sanitizedMessage.slice(0, 300),
        });
        throw new GeminiExecutionError(lastClassification, buildErrorMetadata(), false);
      }

      recordAttempt({
        model: effectiveFallback,
        attemptNumber,
        stage: 'fallback',
        durationMs,
        outcome: 'success',
        httpStatus: 200,
        finishReason: reasons.finishReason,
        blockReason: reasons.blockReason,
      });

      return {
        response: fallbackResponse,
        metadata: {
          provider: 'gemini',
          primaryModel,
          fallbackModel: effectiveFallback,
          modelUsed: effectiveFallback,
          fallbackUsed: true,
          attemptedModels: [primaryModel, effectiveFallback],
          attemptsTotal,
          primaryAttempts,
          fallbackAttempts: 1,
          totalDurationMs: Date.now() - executionStartMs,
          finishReason: reasons.finishReason,
          blockReason: reasons.blockReason,
          attemptHistory: [...attemptHistory],
          lastFailureClassification: lastClassification,
        },
      };
    } catch (fallbackErr: unknown) {
      if (fallbackErr instanceof GeminiExecutionError) {
        throw fallbackErr;
      }

      const durationMs = Date.now() - attemptStartMs;
      const fbClassified = classifyGeminiFailure(fallbackErr);
      lastClassification = fbClassified;
      lastFinishReason = undefined;
      lastBlockReason = undefined;
      if (fbClassified.kind === 'TIMEOUT') {
        timeoutCount += 1;
      }

      recordAttempt({
        model: effectiveFallback,
        attemptNumber,
        stage: 'fallback',
        durationMs,
        outcome: 'error',
        httpStatus: fbClassified.statusCode,
        providerErrorCode: fbClassified.rpcStatus,
        classification: fbClassified.kind,
        sanitizedErrorMessage: fbClassified.sanitizedMessage.slice(0, 300),
      });

      throw new GeminiExecutionError(
        fbClassified,
        buildErrorMetadata(),
        timeoutCount === attemptsTotal && attemptsTotal > 0,
      );
    }
  }

  const finalClassification = lastClassification ?? {
    kind: 'INVALID_REQUEST' as const,
    retryable: false,
    allowFallback: false,
    sanitizedMessage: 'Gemini request failed without a response',
    quotaViolations: [],
  };

  throw new GeminiExecutionError(
    finalClassification,
    buildErrorMetadata(),
    timeoutCount === attemptsTotal && attemptsTotal > 0,
  );
}
