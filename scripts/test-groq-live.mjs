#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const envPath = path.resolve(rootDir, '.env');

if (fs.existsSync(envPath)) {
  config({ path: envPath, quiet: true });
}

const CANONICAL_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_TIMEOUT_MS = 90_000;

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

function sanitizeMessage(message) {
  return String(message ?? '')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/gsk_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/(x-(?:goog-)?api-key\s*[:=]\s*|groq-api-key\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED]');
}

function sha256Short(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const rawApiKey = process.env.GROQ_API_KEY?.trim() || '';
const rawModel = (process.env.GROQ_MODEL || CANONICAL_GROQ_MODEL).trim();
const rawBaseUrl = (process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim();
const rawTimeout =
  process.env.GROQ_TIMEOUT_MS ||
  process.env.AI_TIMEOUT_MS ||
  process.env.GEMINI_TIMEOUT_MS ||
  String(DEFAULT_GROQ_TIMEOUT_MS);
const timeoutMs = Number(rawTimeout);

console.log('================================================================================');
console.log('TALENTLENS AI — GROQ CLOUD STRUCTURED OUTPUT LIVE SMOKE CHECK');
console.log('================================================================================');

if (isPlaceholderKey(rawApiKey)) {
  console.log('Status: UNVERIFIED (Awaiting real user key)');
  console.log('\nNo live GROQ_API_KEY detected (opt-in check skipped cleanly).');
  console.log('To run this live smoke check against Groq Cloud:');
  console.log('  1. Enable Zero Data Retention (ZDR) / disable data logging in Groq Console.');
  console.log('  2. Add your key to ./.env:');
  console.log('     GROQ_API_KEY=gsk_...');
  console.log(`     GROQ_MODEL=${CANONICAL_GROQ_MODEL}`);
  console.log(`     GROQ_BASE_URL=${DEFAULT_GROQ_BASE_URL}`);
  console.log(`     GROQ_TIMEOUT_MS=${DEFAULT_GROQ_TIMEOUT_MS}`);
  console.log('  3. Or run with inline variable in PowerShell:');
  console.log('     $env:GROQ_API_KEY="gsk_..."; npm run test:groq');
  console.log(`\nConfigured Model:    ${rawModel}`);
  console.log(`Configured Base URL: ${rawBaseUrl}`);
  console.log(`Configured Timeout:  ${rawTimeout}ms`);
  console.log('================================================================================');
  process.exit(0);
}

const engineDistPath = path.resolve(rootDir, 'packages/assessment-engine/dist/index.js');
if (!fs.existsSync(engineDistPath)) {
  console.error(
    '[FAIL] Compiled @talentlens/assessment-engine module not found. Run: npm run build --workspace @talentlens/shared && npm run build --workspace @talentlens/assessment-engine',
  );
  console.log('================================================================================');
  process.exit(1);
}

const {
  GroqExecutionError,
  executeGroqStructuredCompletion,
  getAssessmentStrictJsonSchema,
  validateGroqBaseUrl,
  validateGroqModelId,
} = await import(pathToFileURL(engineDistPath).href);

const modelValidation = validateGroqModelId(rawModel);
if (!modelValidation.valid) {
  console.error(`[FAIL] Invalid GROQ_MODEL: ${modelValidation.reason}`);
  console.log('================================================================================');
  process.exit(1);
}

const allowInsecure = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const urlValidation = validateGroqBaseUrl(rawBaseUrl, { allowInsecureHttp: allowInsecure });
if (!urlValidation.valid) {
  console.error(`[FAIL] Invalid GROQ_BASE_URL: ${urlValidation.reason}`);
  console.log('================================================================================');
  process.exit(1);
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
  console.error(`[FAIL] Invalid GROQ_TIMEOUT_MS (${rawTimeout}). Expected integer 1000..120000.`);
  console.log('================================================================================');
  process.exit(1);
}

console.log('Provider:            Groq Cloud (OpenAI-Compatible Chat Completions)');
console.log(`Model:               ${modelValidation.model}`);
console.log(`Base URL:            ${urlValidation.baseUrl}`);
console.log(`Request Timeout:     ${timeoutMs}ms`);

const syntheticCriterionId = '00000000-0000-4000-8000-000000000001';
const syntheticSystemPrompt =
  'You are an evidence-grounded AI assessment engine. Return ONLY valid JSON matching the schema.';
const syntheticUserPrompt = JSON.stringify({
  instruction:
    'Evaluate this minimal synthetic resume (zero PII) against the single PostgreSQL criterion using an exact verbatim quote.',
  criteria: [
    {
      criterionId: syntheticCriterionId,
      label: 'PostgreSQL experience',
      requirementType: 'MUST_HAVE',
      weight: 100,
    },
  ],
  resumeText:
    'Backend engineer with 3 years of PostgreSQL database design and query tuning experience.',
});

const strictSchema = getAssessmentStrictJsonSchema();
const startMs = Date.now();

try {
  const result = await executeGroqStructuredCompletion({
    apiKey: rawApiKey,
    model: modelValidation.model,
    baseUrl: urlValidation.baseUrl,
    systemPrompt: syntheticSystemPrompt,
    userPrompt: syntheticUserPrompt,
    schemaName: 'talentlens_assessment_live_smoke',
    strictSchema,
    timeoutMs,
    maxRetries: 1,
    maxValidationRetries: 1,
    parseAndValidate: (_rawText, payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Groq returned a non-object JSON payload');
      }
      const criteria = payload.criteria;
      if (!Array.isArray(criteria) || criteria.length !== 1) {
        throw new Error(
          `Expected exactly 1 criterion entry, got ${Array.isArray(criteria) ? criteria.length : 'non-array'}`,
        );
      }
      const first = criteria[0];
      if (
        !first ||
        first.criterionId !== syntheticCriterionId ||
        !['MATCH', 'PARTIAL', 'NOT_FOUND', 'UNCERTAIN'].includes(first.status) ||
        typeof first.explanation !== 'string' ||
        first.explanation.trim().length === 0 ||
        !Array.isArray(first.evidenceQuotes)
      ) {
        throw new Error('Criterion payload did not satisfy strict schema shape');
      }
      return payload;
    },
  });

  const durationMs = Date.now() - startMs;
  const { metadata, tokenUsage } = result;
  console.log('\n--- Structured Output Probe Result ---');
  console.log(`[PASS] Groq responded HTTP 200 OK`);
  console.log(`  * Latency:          ${durationMs}ms`);
  console.log(
    `  * Schema Mode Used: ${metadata.responseFormatMode}${metadata.fallbackUsed ? ' (fallback)' : ' (strict=true)'}`,
  );
  console.log(`  * Finish Reason:    ${metadata.finishReason ?? 'N/A'}`);
  console.log(`  * Prompt SHA-256:   ${sha256Short(syntheticUserPrompt)}...`);
  console.log(`  * Output Criteria:  ${result.data.criteria.length}`);
  console.log(
    `  * Token Usage:      Prompt=${tokenUsage?.promptTokens ?? 'N/A'}, Completion=${tokenUsage?.completionTokens ?? 'N/A'}, Total=${tokenUsage?.totalTokens ?? 'N/A'}`,
  );
  console.log('  * Privacy Check:    Zero candidate PII; synthetic non-PII check.');
  console.log('\nOVERALL SMOKE VERDICT: [PASS] Groq Cloud structured output verified live.');
  console.log('================================================================================');
  process.exit(0);
} catch (err) {
  const durationMs = Date.now() - startMs;
  console.error(`\n[FAIL] Groq live probe failed (${durationMs}ms)`);
  if (err instanceof GroqExecutionError) {
    console.error(`  * Classification:   ${err.classification.kind}`);
    console.error(`  * HTTP Status:      ${err.classification.statusCode ?? 'N/A'}`);
    console.error(`  * Attempts Total:   ${err.metadata.attemptsTotal}`);
    console.error(
      `  * Safe Error Note:  ${sanitizeMessage(err.classification.sanitizedMessage).slice(0, 220)}`,
    );
  } else {
    console.error(
      `  * Safe Error Note:  ${sanitizeMessage(err instanceof Error ? err.message : String(err)).slice(0, 220)}`,
    );
  }
  console.error('\nOVERALL SMOKE VERDICT: [FAIL] Groq Cloud structured output live probe failed.');
  console.log('================================================================================');
  process.exit(1);
}
