#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const envPath = path.resolve(rootDir, '.env');

if (fs.existsSync(envPath)) {
  config({ path: envPath });
}

const CANONICAL_GEMINI_MODEL = 'gemini-3.6-flash';
const CANONICAL_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';
const DEFAULT_GEMINI_TIMEOUT_MS = 90_000;
const SUPPORTED_GEMINI_MODELS = [CANONICAL_GEMINI_MODEL, CANONICAL_GEMINI_FALLBACK_MODEL];

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sanitizeErrorMessage(message) {
  return String(message ?? '')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/([?&](?:api_?key|key|token|access_token)=)[^&\s"'`]+/gi, '$1[REDACTED]')
    .replace(/(x-goog-api-key\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED_API_KEY]');
}

function normalizeGeminiModelId(model) {
  return String(model ?? '')
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

function isDisallowedFlashLiteModel(model) {
  const normalized = normalizeGeminiModelId(model);
  return normalized.includes('flash-lite') || /(?:^|-)lite$/.test(normalized);
}

function isSupportedGeminiModel(model) {
  return SUPPORTED_GEMINI_MODELS.includes(normalizeGeminiModelId(model));
}

function isPlaceholderKey(apiKey) {
  const normalized = String(apiKey ?? '')
    .trim()
    .toLowerCase();
  return (
    normalized === '' ||
    normalized.includes('placeholder') ||
    normalized.includes('your_') ||
    normalized.includes('change_this') ||
    normalized.includes('replace_with') ||
    normalized.includes('insert_') ||
    normalized.includes('aizasysynthetic') ||
    normalized.startsWith('<') ||
    normalized === 'none' ||
    normalized === 'null' ||
    normalized === 'undefined'
  );
}

function tryParseEmbeddedJson(message) {
  const first = message.indexOf('{');
  const last = message.lastIndexOf('}');
  if (first === -1 || last <= first) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function classifyLiveError(err) {
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const safeErrMsg = sanitizeErrorMessage(rawMessage);
  const lowerMsg = safeErrMsg.toLowerCase();
  const embeddedJson = tryParseEmbeddedJson(rawMessage);
  const embeddedError =
    embeddedJson?.error && typeof embeddedJson.error === 'object'
      ? embeddedJson.error
      : embeddedJson;
  const statusCode =
    typeof err?.status === 'number'
      ? err.status
      : typeof err?.statusCode === 'number'
        ? err.statusCode
        : typeof embeddedError?.code === 'number'
          ? embeddedError.code
          : undefined;
  const rpcStatus =
    typeof embeddedError?.status === 'string' ? embeddedError.status.toUpperCase() : undefined;
  const details = Array.isArray(embeddedError?.details) ? embeddedError.details : [];

  let retryDelayText;
  const quotaHints = [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    if (typeof detail.retryDelay === 'string') {
      retryDelayText = detail.retryDelay;
    }
    if (Array.isArray(detail.violations)) {
      for (const v of detail.violations) {
        if (!v || typeof v !== 'object') continue;
        const parts = [
          v.quotaId,
          v.quotaMetric,
          v.quotaValue !== undefined ? `limit=${v.quotaValue}` : null,
        ]
          .filter(Boolean)
          .join(' ');
        if (parts) quotaHints.push(parts);
      }
    }
  }

  let category = 'UPSTREAM_API_ERROR';
  let fatalConfig = false;

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    safeErrMsg.includes('API_KEY_INVALID') ||
    rpcStatus === 'UNAUTHENTICATED' ||
    rpcStatus === 'PERMISSION_DENIED' ||
    lowerMsg.includes('api key not valid')
  ) {
    category = 'AUTH_ERROR (Invalid or unauthorized Gemini API key)';
    fatalConfig = true;
  } else if (
    statusCode === 404 ||
    rpcStatus === 'NOT_FOUND' ||
    lowerMsg.includes('is not found for api version')
  ) {
    category = 'MODEL_NOT_FOUND (Model ID does not exist or is unavailable for this key)';
    fatalConfig = true;
  } else if (statusCode === 400 || rpcStatus === 'INVALID_ARGUMENT') {
    category = 'INVALID_REQUEST_400 (Malformed request or schema)';
    fatalConfig = true;
  } else if (
    statusCode === 503 ||
    rpcStatus === 'UNAVAILABLE' ||
    lowerMsg.includes('high demand') ||
    lowerMsg.includes('service unavailable')
  ) {
    category = 'SERVICE_UNAVAILABLE_503 (High demand / temporary capacity outage)';
  } else if (
    statusCode === 429 ||
    rpcStatus === 'RESOURCE_EXHAUSTED' ||
    lowerMsg.includes('quota')
  ) {
    const joinedHints = quotaHints.join(' ').toLowerCase();
    if (
      joinedHints.includes('perday') ||
      joinedHints.includes('limit=0') ||
      lowerMsg.includes('billing')
    ) {
      category = 'RATE_LIMIT_PROJECT_QUOTA (Project daily/free-tier quota or billing exhausted)';
    } else if (joinedHints.includes('perminute') || joinedHints.includes('permodel')) {
      category = 'RATE_LIMIT_MODEL_SCOPED (Per-model RPM/TPM limit reached; fallback eligible)';
    } else {
      category = 'RATE_LIMIT_GENERIC (429 RESOURCE_EXHAUSTED)';
    }
  } else if (
    safeErrMsg.includes('ETIMEDOUT') ||
    safeErrMsg.includes('TIMED_OUT') ||
    safeErrMsg.includes('AbortError') ||
    lowerMsg.includes('deadline') ||
    lowerMsg.includes('timeout')
  ) {
    category = 'TIMEOUT (Request exceeded configured timeout threshold)';
  }

  return {
    category,
    fatalConfig,
    statusCode,
    rpcStatus,
    retryDelayText,
    quotaHints,
    safeErrMsg: safeErrMsg.replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
const rawPrimaryModel = (
  process.env.GEMINI_MODEL ||
  process.env.AI_MODEL ||
  CANONICAL_GEMINI_MODEL
).trim();
const rawFallbackModel = (
  process.env.GEMINI_FALLBACK_MODEL ??
  process.env.AI_FALLBACK_MODEL ??
  CANONICAL_GEMINI_FALLBACK_MODEL
).trim();
const primaryModel = normalizeGeminiModelId(rawPrimaryModel);
const fallbackModel = rawFallbackModel ? normalizeGeminiModelId(rawFallbackModel) : '';
const rawTimeout =
  process.env.GEMINI_TIMEOUT_MS ||
  process.env.ASSESSMENT_TIMEOUT_MS ||
  process.env.AI_TIMEOUT_MS ||
  String(DEFAULT_GEMINI_TIMEOUT_MS);
const timeoutMs = Number(rawTimeout);

console.log('================================================================================');
console.log('TALENTLENS AI — GOOGLE GEMINI FREE-TIER LIVE SMOKE CHECK');
console.log('================================================================================');

if (isPlaceholderKey(apiKey)) {
  console.log('Status: UNVERIFIED (Awaiting real user key)');
  console.log('\nNo live GEMINI_API_KEY detected (opt-in check skipped cleanly).');
  console.log('To run this live smoke check against Google Gemini API:');
  console.log('  1. Add your key to ./.env:');
  console.log('     GEMINI_API_KEY=AIzaSy...');
  console.log(`     GEMINI_MODEL=${CANONICAL_GEMINI_MODEL}`);
  console.log(`     GEMINI_FALLBACK_MODEL=${CANONICAL_GEMINI_FALLBACK_MODEL}`);
  console.log(`     GEMINI_TIMEOUT_MS=${DEFAULT_GEMINI_TIMEOUT_MS}`);
  console.log('  2. Or run with inline variable:');
  console.log('     $env:GEMINI_API_KEY="AIzaSy..."; npm run test:gemini');
  console.log(`\nConfigured Primary:  ${primaryModel || '(empty)'}`);
  console.log(`Configured Fallback: ${fallbackModel || '(disabled)'}`);
  console.log(`Configured Timeout:  ${rawTimeout}ms`);
  console.log('================================================================================');
  process.exit(0);
}

if (
  !rawPrimaryModel ||
  isDisallowedFlashLiteModel(primaryModel) ||
  !isSupportedGeminiModel(primaryModel)
) {
  console.error('\n[FAIL] Invalid or disallowed primary Gemini model configured:');
  console.error(`  * Configured Primary: ${rawPrimaryModel || '(empty)'}`);
  console.error(`  * Allowed Models:     ${SUPPORTED_GEMINI_MODELS.join(', ')}`);
  console.log('================================================================================');
  process.exit(1);
}

if (
  !rawFallbackModel ||
  isDisallowedFlashLiteModel(fallbackModel) ||
  !isSupportedGeminiModel(fallbackModel)
) {
  console.error('\n[FAIL] Invalid or disallowed fallback Gemini model configured:');
  console.error(`  * Configured Fallback: ${rawFallbackModel || '(empty)'}`);
  console.error(`  * Allowed Models:      ${SUPPORTED_GEMINI_MODELS.join(', ')}`);
  console.log('================================================================================');
  process.exit(1);
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
  console.error('\n[FAIL] Invalid GEMINI_TIMEOUT_MS configured (must be integer 1000..120000):');
  console.error(`  * Configured Timeout: ${rawTimeout}`);
  console.log('================================================================================');
  process.exit(1);
}

const modelsToProbe =
  fallbackModel && fallbackModel !== primaryModel ? [primaryModel, fallbackModel] : [primaryModel];

console.log('Provider:            Google Gemini (@google/genai)');
console.log(`Primary Model:       ${primaryModel}`);
console.log(
  `Fallback Model:      ${fallbackModel === primaryModel ? `${fallbackModel} (deduplicated -> disabled)` : fallbackModel}`,
);
console.log(
  `Request Timeout:     ${timeoutMs}ms (1 single probe per distinct model, SDK retries disabled)`,
);

const { GoogleGenAI, ThinkingLevel, Type } = await import('@google/genai');
const ai = new GoogleGenAI({
  apiKey: apiKey.trim(),
  httpOptions: {
    timeout: timeoutMs,
    retryOptions: { attempts: 1 },
  },
});

const syntheticPrompt =
  'Synthetic check (no PII): Return status="OK" and the single required skill "PostgreSQL" from text "Requires PostgreSQL experience."';

async function probeModel(targetModel, roleLabel) {
  console.log(`\n--- Probing ${roleLabel}: ${targetModel} ---`);
  const startMs = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: targetModel,
      contents: syntheticPrompt,
      config: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            status: { type: Type.STRING, enum: ['OK'] },
            skill: { type: Type.STRING },
          },
          required: ['status', 'skill'],
        },
      },
    });

    const durationMs = Date.now() - startMs;
    const blockReason = response.promptFeedback?.blockReason;
    const finishReason = response.candidates?.[0]?.finishReason;
    if (
      blockReason ||
      (finishReason &&
        ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(
          String(finishReason),
        ))
    ) {
      return {
        model: targetModel,
        roleLabel,
        ok: false,
        fatalConfig: false,
        latencyMs: durationMs,
        category: `CONTENT_SAFETY_BLOCK (${blockReason ?? finishReason})`,
        safeErrMsg: 'Blocked by Gemini safety filter',
      };
    }

    const outputText = response.text ?? '';
    if (!outputText || outputText.trim().length === 0) {
      return {
        model: targetModel,
        roleLabel,
        ok: false,
        fatalConfig: false,
        latencyMs: durationMs,
        category: 'EMPTY_RESPONSE',
        safeErrMsg: 'Empty output text returned by Gemini API',
      };
    }

    const parsed = JSON.parse(outputText);
    if (!parsed || typeof parsed !== 'object' || parsed.status !== 'OK' || !parsed.skill) {
      return {
        model: targetModel,
        roleLabel,
        ok: false,
        fatalConfig: false,
        latencyMs: durationMs,
        category: 'INVALID_JSON_SCHEMA',
        safeErrMsg: 'Structured JSON response missed required synthetic fields',
      };
    }

    console.log(`[PASS] ${targetModel} responded HTTP 200 OK`);
    console.log(`  * Latency:          ${durationMs}ms`);
    console.log(`  * Output Non-Empty: true (${outputText.length} chars)`);
    console.log(`  * Prompt SHA-256:   ${sha256Hex(syntheticPrompt).slice(0, 16)}...`);
    console.log(`  * Output SHA-256:   ${sha256Hex(outputText).slice(0, 16)}...`);
    console.log(
      `  * Token Usage:      Prompt=${response.usageMetadata?.promptTokenCount ?? 'N/A'}, Candidate=${response.usageMetadata?.candidatesTokenCount ?? 'N/A'}`,
    );

    return {
      model: targetModel,
      roleLabel,
      ok: true,
      fatalConfig: false,
      latencyMs: durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const classified = classifyLiveError(err);
    console.log(`[FAIL] ${targetModel} probe failed (${durationMs}ms)`);
    console.log(`  * Classification:   ${classified.category}`);
    if (classified.statusCode !== undefined) {
      console.log(
        `  * HTTP / RPC:       ${classified.statusCode}${classified.rpcStatus ? ` ${classified.rpcStatus}` : ''}`,
      );
    }
    if (classified.retryDelayText) {
      console.log(`  * RetryInfo Delay:  ${classified.retryDelayText}`);
    }
    if (classified.quotaHints.length > 0) {
      console.log(`  * Quota Details:    ${classified.quotaHints.join('; ')}`);
    }
    console.log(`  * Safe Error Note:  ${classified.safeErrMsg}`);
    return {
      model: targetModel,
      roleLabel,
      ok: false,
      latencyMs: durationMs,
      ...classified,
    };
  }
}

const results = [];
for (let i = 0; i < modelsToProbe.length; i += 1) {
  const m = modelsToProbe[i];
  const roleLabel = i === 0 ? 'Primary Model' : 'Fallback Model';
  results.push(await probeModel(m, roleLabel));
}

const primaryResult = results[0];
const fallbackResult = results[1];
const anyFatalConfig = results.some((r) => r.fatalConfig);
const anySucceeded = results.some((r) => r.ok);

console.log('\n--- Fallback Readiness Summary ---');
console.log(
  `  * Primary (${primaryResult.model}):  ${primaryResult.ok ? `PASS (${primaryResult.latencyMs}ms)` : `FAIL (${primaryResult.category})`}`,
);
if (fallbackResult) {
  console.log(
    `  * Fallback (${fallbackResult.model}): ${fallbackResult.ok ? `PASS (${fallbackResult.latencyMs}ms)` : `FAIL (${fallbackResult.category})`}`,
  );
} else {
  console.log('  * Fallback:          Disabled (same as primary)');
}
console.log('  * Privacy Check:     Zero candidate PII; minimal synthetic quota footprint.');

if (anyFatalConfig) {
  console.error(
    '\nOVERALL SMOKE VERDICT: [FAIL] Fatal auth, invalid request, or unsupported model error encountered.',
  );
  console.log('================================================================================');
  process.exit(1);
}

if (!anySucceeded) {
  console.error(
    '\nOVERALL SMOKE VERDICT: [FAIL] All configured Gemini models failed the live smoke probe.',
  );
  console.log('================================================================================');
  process.exit(1);
}

if (primaryResult.ok && (!fallbackResult || fallbackResult.ok)) {
  console.log(
    '\nOVERALL SMOKE VERDICT: [PASS] Configured Free-Tier Gemini model pair verified live.',
  );
  console.log('================================================================================');
  process.exit(0);
}

if (!primaryResult.ok && fallbackResult?.ok) {
  console.log(
    '\nOVERALL SMOKE VERDICT: [WARN] Primary model returned a transient error while fallback model succeeded; bounded fallback readiness verified.',
  );
  console.log('================================================================================');
  process.exit(0);
}

console.log(
  '\nOVERALL SMOKE VERDICT: [WARN] Primary model succeeded while fallback model returned a transient error.',
);
console.log('================================================================================');
process.exit(0);
