#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const envPath = path.resolve(rootDir, '.env');

if (fs.existsSync(envPath)) {
  config({ path: envPath, quiet: true });
}

const providerDistPath = path.resolve(
  rootDir,
  'apps/api/dist/modules/scorecards/jd-extraction.provider.js',
);
const metadataDistPath = path.resolve(
  rootDir,
  'apps/api/dist/modules/scorecards/scorecard.metadata.js',
);
const requestContextDistPath = path.resolve(rootDir, 'apps/api/dist/middleware/request-context.js');

if (
  !fs.existsSync(providerDistPath) ||
  !fs.existsSync(metadataDistPath) ||
  !fs.existsSync(requestContextDistPath)
) {
  console.error(
    '[FAIL] Compiled API provider modules not found. Run: npm run build --workspace @talentlens/assessment-engine && npm run build --workspace @talentlens/api',
  );
  process.exit(1);
}

const {
  CANONICAL_GEMINI_FALLBACK_MODEL,
  CANONICAL_GEMINI_MODEL,
  CANONICAL_GROQ_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DEFAULT_GROQ_BASE_URL,
  SUPPORTED_GEMINI_MODELS,
  createGeminiJdExtractionProvider,
  createGroqJdExtractionProvider,
  createMultiProviderJdExtractionProvider,
  isDisallowedFlashLiteModel,
  isSupportedGeminiModel,
  normalizeGeminiModelId,
  sanitizeProviderErrorMessage,
} = await import(pathToFileURL(providerDistPath).href);
const { scorecardMetadataSchema } = await import(pathToFileURL(metadataDistPath).href);
const { runWithRequestContext } = await import(pathToFileURL(requestContextDistPath).href);

const engineDistPath = path.resolve(rootDir, 'packages/assessment-engine/dist/index.js');
const {
  classifyGeminiFailure,
  isPlaceholderAiKey,
  isPlaceholderGeminiKey,
  parseAiProviderOrder,
  validateGroqBaseUrl,
  validateGroqModelId,
} = await import(pathToFileURL(engineDistPath).href);

function sha256Short(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function resolveRequestedProviderMode(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--provider=')) {
      return arg.slice('--provider='.length).trim().toLowerCase();
    }
    if (arg === '--provider' && argv[i + 1]) {
      return String(argv[i + 1])
        .trim()
        .toLowerCase();
    }
  }
  return 'auto';
}

const providerMode = resolveRequestedProviderMode(process.argv.slice(2));
if (!['auto', 'gemini', 'groq'].includes(providerMode)) {
  console.error(
    `[FAIL] Unsupported --provider mode "${providerMode}". Expected: auto | gemini | groq.`,
  );
  process.exit(1);
}

const rawApiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
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

const rawGroqKey = (process.env.GROQ_API_KEY || '').trim();
const rawGroqModel = (process.env.GROQ_MODEL || CANONICAL_GROQ_MODEL).trim();
const rawGroqBaseUrl = (process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim();
const rawGroqTimeout =
  process.env.GROQ_TIMEOUT_MS ||
  process.env.AI_TIMEOUT_MS ||
  process.env.GEMINI_TIMEOUT_MS ||
  String(DEFAULT_GEMINI_TIMEOUT_MS);
const groqTimeoutMs = Number(rawGroqTimeout);

const hasLiveGeminiKey = Boolean(rawApiKey?.trim() && !isPlaceholderGeminiKey(rawApiKey));
const hasLiveGroqKey = Boolean(rawGroqKey && !isPlaceholderAiKey(rawGroqKey));

console.log('================================================================================');
console.log('TALENTLENS AI — REAL JD EXTRACTION PROVIDER DIAGNOSTIC');
console.log('================================================================================');
console.log(`Diagnostic Mode:     --provider=${providerMode}`);

if (providerMode === 'gemini' && !hasLiveGeminiKey) {
  console.log('Status: UNVERIFIED (No non-placeholder GEMINI_API_KEY detected)');
  console.log(
    'Set a real GEMINI_API_KEY in ./.env or environment to execute this live Gemini diagnostic.',
  );
  console.log('================================================================================');
  process.exit(0);
}

if (providerMode === 'groq' && !hasLiveGroqKey) {
  console.log('Status: UNVERIFIED (No non-placeholder GROQ_API_KEY detected)');
  console.log(
    'Set a real GROQ_API_KEY in ./.env or environment to execute this live Groq diagnostic.',
  );
  console.log('================================================================================');
  process.exit(0);
}

if (providerMode === 'auto' && !hasLiveGeminiKey && !hasLiveGroqKey) {
  console.log('Status: UNVERIFIED (No non-placeholder GEMINI_API_KEY or GROQ_API_KEY detected)');
  console.log(
    'Set GEMINI_API_KEY and/or GROQ_API_KEY in ./.env or environment to execute this live diagnostic.',
  );
  console.log('================================================================================');
  process.exit(0);
}

const orderCheck = parseAiProviderOrder(process.env.AI_PROVIDER_ORDER);
if (!orderCheck.ok) {
  console.error(`[FAIL] ${orderCheck.reason}`);
  process.exit(1);
}

if (providerMode !== 'groq') {
  if (
    !rawPrimaryModel ||
    isDisallowedFlashLiteModel(primaryModel) ||
    !isSupportedGeminiModel(primaryModel)
  ) {
    console.error(
      `[FAIL] Invalid or disallowed GEMINI_MODEL (${rawPrimaryModel || 'empty'}). Allowed: ${SUPPORTED_GEMINI_MODELS.join(', ')}`,
    );
    process.exit(1);
  }

  if (
    rawFallbackModel &&
    (isDisallowedFlashLiteModel(fallbackModel) || !isSupportedGeminiModel(fallbackModel))
  ) {
    console.error(
      `[FAIL] Invalid or disallowed GEMINI_FALLBACK_MODEL (${rawFallbackModel}). Allowed: ${SUPPORTED_GEMINI_MODELS.join(', ')}`,
    );
    process.exit(1);
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    console.error(
      `[FAIL] Invalid GEMINI_TIMEOUT_MS (${rawTimeout}). Expected integer 1000..120000.`,
    );
    process.exit(1);
  }
}

if (providerMode === 'groq' || hasLiveGroqKey) {
  const groqModelCheck = validateGroqModelId(rawGroqModel);
  if (!groqModelCheck.valid) {
    console.error(`[FAIL] ${groqModelCheck.reason}`);
    process.exit(1);
  }
  const allowInsecure = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const groqUrlCheck = validateGroqBaseUrl(rawGroqBaseUrl, { allowInsecureHttp: allowInsecure });
  if (!groqUrlCheck.valid) {
    console.error(`[FAIL] ${groqUrlCheck.reason}`);
    process.exit(1);
  }
  if (!Number.isInteger(groqTimeoutMs) || groqTimeoutMs < 1_000 || groqTimeoutMs > 120_000) {
    console.error(
      `[FAIL] Invalid GROQ_TIMEOUT_MS (${rawGroqTimeout}). Expected integer 1000..120000.`,
    );
    process.exit(1);
  }
}

const syntheticJdInput = {
  jobTitle: 'Junior Backend Software Engineer',
  jdText: `Junior Backend Software Engineer
Experience: 1 to 2 years of backend development experience.
Location: Bengaluru (Hybrid).
Compensation: INR 800000 - 1200000 per year.
Notice Period: 30 days preferred.

Required Skills:
- Strong proficiency in TypeScript and Node.js backend services.
- Solid understanding of PostgreSQL relational schema design and SQL queries.
- Experience building RESTful HTTP APIs and writing automated unit tests.

Preferred Skills:
- Familiarity with Docker containers and CI/CD pipelines.
- Exposure to Prisma ORM or message queues.

Education:
- Bachelor degree in Computer Science or equivalent practical experience.`,
};

if (providerMode !== 'groq') {
  console.log(`Gemini Primary:      ${primaryModel}`);
  console.log(`Gemini Fallback:     ${fallbackModel || '(disabled)'}`);
  console.log(`Gemini Timeout:      ${timeoutMs}ms`);
}
if (providerMode === 'groq' || hasLiveGroqKey || providerMode === 'auto') {
  console.log(`AI Provider Order:   ${orderCheck.order.join(' -> ')}`);
  console.log(`Groq Model:          ${rawGroqModel}`);
  console.log(`Groq Base URL:       ${rawGroqBaseUrl}`);
  console.log(`Groq Timeout:        ${groqTimeoutMs}ms`);
}
console.log(`Synthetic JD SHA256: ${sha256Short(syntheticJdInput.jdText)} (0 PII, synthetic)`);

function summarizeSafeResponseShape(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    return {
      jsonValid: false,
      parseError: sanitizeProviderErrorMessage(
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      ),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      jsonValid: true,
      topLevelType: Array.isArray(parsed) ? 'array' : typeof parsed,
    };
  }
  const summary = {
    jsonValid: true,
    topLevelKeys: Object.keys(parsed),
    criteriaCount: Array.isArray(parsed.criteria) ? parsed.criteria.length : null,
    requiredSkillsCount: Array.isArray(parsed.requiredSkills) ? parsed.requiredSkills.length : null,
    preferredSkillsCount: Array.isArray(parsed.preferredSkills)
      ? parsed.preferredSkills.length
      : null,
    jobTitleType: parsed.jobTitle === null ? 'null' : typeof parsed.jobTitle,
    jobTitleKeys:
      parsed.jobTitle && typeof parsed.jobTitle === 'object' ? Object.keys(parsed.jobTitle) : null,
    experienceRequirementType:
      parsed.experienceRequirement === null ? 'null' : typeof parsed.experienceRequirement,
    compensationType: parsed.compensation === null ? 'null' : typeof parsed.compensation,
    noticePeriodType: parsed.noticePeriod === null ? 'null' : typeof parsed.noticePeriod,
    firstCriterionSampleShape:
      Array.isArray(parsed.criteria) && parsed.criteria[0] && typeof parsed.criteria[0] === 'object'
        ? {
            keys: Object.keys(parsed.criteria[0]),
            category:
              typeof parsed.criteria[0].category === 'string' ? parsed.criteria[0].category : null,
            requirementType:
              typeof parsed.criteria[0].requirementType === 'string'
                ? parsed.criteria[0].requirementType
                : null,
            weightType: typeof parsed.criteria[0].weight,
            evidenceType:
              parsed.criteria[0].evidence === null ? 'null' : typeof parsed.criteria[0].evidence,
            evidenceKeys:
              parsed.criteria[0].evidence && typeof parsed.criteria[0].evidence === 'object'
                ? Object.keys(parsed.criteria[0].evidence)
                : null,
            verificationStatus:
              parsed.criteria[0].evidence &&
              typeof parsed.criteria[0].evidence.verificationStatus === 'string'
                ? parsed.criteria[0].evidence.verificationStatus
                : null,
          }
        : null,
  };
  return summary;
}

function createObservedClient() {
  if (!hasLiveGeminiKey) {
    return {
      wrappedClient: undefined,
      observedAttempts: [],
      getLastRequestConfig: () => null,
    };
  }
  const realClient = new GoogleGenAI({
    apiKey: rawApiKey.trim(),
    httpOptions: {
      timeout: timeoutMs,
      retryOptions: { attempts: 1 },
    },
  });

  const observedAttempts = [];
  let lastRequestConfig = null;

  const wrappedClient = {
    models: {
      generateContent: async (params) => {
        lastRequestConfig = {
          model: params.model,
          hasSystemInstruction: Boolean(params.config?.systemInstruction),
          responseMimeType: params.config?.responseMimeType,
          hasResponseSchema: Boolean(params.config?.responseSchema),
          thinkingConfig: params.config?.thinkingConfig,
        };
        const attemptNum = observedAttempts.length + 1;
        const startMs = Date.now();
        try {
          const response = await realClient.models.generateContent(params);
          const durationMs = Date.now() - startMs;
          const finishReason = response?.candidates?.[0]?.finishReason;
          const finishMessage = response?.candidates?.[0]?.finishMessage
            ? sanitizeProviderErrorMessage(response.candidates[0].finishMessage)
            : undefined;
          const blockReason = response?.promptFeedback?.blockReason;
          const usageMetadata = response?.usageMetadata;
          let responseText = '';
          let textGetterError = null;
          try {
            responseText = response?.text ?? '';
          } catch (err) {
            textGetterError = sanitizeProviderErrorMessage(
              err instanceof Error ? err.message : String(err),
            );
          }

          observedAttempts.push({
            attemptNum,
            model: params.model,
            durationMs,
            ok: true,
            finishReason,
            finishMessage,
            blockReason,
            responseTextLength: responseText.length,
            textGetterError,
            usageMetadata: usageMetadata
              ? {
                  promptTokenCount: usageMetadata.promptTokenCount,
                  candidatesTokenCount: usageMetadata.candidatesTokenCount,
                  thoughtsTokenCount: usageMetadata.thoughtsTokenCount,
                  totalTokenCount: usageMetadata.totalTokenCount,
                }
              : undefined,
            shapeSummary: responseText ? summarizeSafeResponseShape(responseText) : null,
          });
          return response;
        } catch (err) {
          const durationMs = Date.now() - startMs;
          const classified = classifyGeminiFailure(err);
          const errRec = err && typeof err === 'object' ? err : {};
          observedAttempts.push({
            attemptNum,
            model: params.model,
            durationMs,
            ok: false,
            errorName: err instanceof Error ? err.name : typeof err,
            classificationKind: classified.kind,
            statusCode: classified.statusCode,
            rpcStatus: classified.rpcStatus,
            retryable: classified.retryable,
            allowFallback: classified.allowFallback,
            rawErrStatus: errRec.status ?? errRec.statusCode,
            sanitizedMessage: sanitizeProviderErrorMessage(classified.sanitizedMessage).slice(
              0,
              600,
            ),
          });
          throw err;
        }
      },
    },
  };

  return {
    wrappedClient,
    observedAttempts,
    getLastRequestConfig: () => lastRequestConfig,
  };
}

async function runProviderCheck(label, correlationId, mode = providerMode, overrideOptions = {}) {
  console.log(`\n--- ${label} ---`);
  const { wrappedClient, observedAttempts, getLastRequestConfig } = createObservedClient();
  let executionMetadata = null;
  const fallbackEvents = [];
  const failoverEvents = [];
  const groqAttempts = [];
  const diagnosticLogs = [];

  let provider;
  if (mode === 'groq') {
    provider = createGroqJdExtractionProvider({
      apiKey: rawGroqKey,
      model: rawGroqModel,
      baseUrl: rawGroqBaseUrl,
      timeoutMs: groqTimeoutMs,
      onAttempt: (evt) => groqAttempts.push(evt),
      onDiagnosticLog: (entry) => diagnosticLogs.push(entry),
      ...overrideOptions,
    });
  } else if (mode === 'gemini') {
    provider = createGeminiJdExtractionProvider({
      apiKey: rawApiKey,
      model: primaryModel,
      fallbackModel: fallbackModel || null,
      timeoutMs,
      client: wrappedClient,
      onFallback: (evt) => fallbackEvents.push(evt),
      onExecutionMetadata: (meta) => {
        executionMetadata = meta;
      },
      onDiagnosticLog: (entry) => diagnosticLogs.push(entry),
      ...overrideOptions,
    });
  } else {
    provider = createMultiProviderJdExtractionProvider({
      providerOrder: orderCheck.order,
      geminiApiKey: hasLiveGeminiKey ? rawApiKey : undefined,
      geminiModel: primaryModel,
      geminiFallbackModel: fallbackModel || null,
      geminiTimeoutMs: timeoutMs,
      geminiClient: wrappedClient,
      groqApiKey: hasLiveGroqKey ? rawGroqKey : undefined,
      groqModel: rawGroqModel,
      groqBaseUrl: rawGroqBaseUrl,
      groqTimeoutMs,
      onGeminiFallback: (evt) => fallbackEvents.push(evt),
      onGeminiExecutionMetadata: (meta) => {
        executionMetadata = meta;
      },
      onGroqAttempt: (evt) => groqAttempts.push(evt),
      onProviderFailover: (evt) => failoverEvents.push(evt),
      onDiagnosticLog: (entry) => diagnosticLogs.push(entry),
      ...overrideOptions,
    });
  }

  const startMs = Date.now();
  try {
    const result = await runWithRequestContext(correlationId, () =>
      provider.extract(syntheticJdInput),
    );
    const totalMs = Date.now() - startMs;
    const metadataCheck = scorecardMetadataSchema.safeParse({
      contractVersion: 1,
      extractionSchemaVersion: 'jd-extraction-v2',
      jobTitle: result.jobTitle,
      requiredSkills: result.requiredSkills,
      preferredSkills: result.preferredSkills,
      educationRequirements: result.educationRequirements,
      certifications: result.certifications,
      domainExperience: result.domainExperience,
      experience: {
        minimumYears: result.minimumExperienceYears,
        maximumYears: result.maximumExperienceYears,
        requirement: result.experienceRequirement,
      },
      compensation: result.compensation,
      notice: result.noticePeriod,
      otherRequirements: result.otherRequirements,
      warnings: result.warnings,
    });

    if (!metadataCheck.success) {
      throw new Error(
        `scorecardMetadataSchema validation failed: ${metadataCheck.error.issues.map((i) => `${i.path.join('.')}:${i.code}`).join(', ')}`,
      );
    }

    console.log(
      `[PASS] Provider extract succeeded in ${totalMs}ms (correlationId=${correlationId})`,
    );
    if (getLastRequestConfig()) {
      console.log('  Gemini Request Config:', JSON.stringify(getLastRequestConfig()));
      console.log('  Gemini Attempts:', JSON.stringify(observedAttempts, null, 2));
    }
    if (groqAttempts.length > 0) {
      console.log('  Groq Attempts:', JSON.stringify(groqAttempts, null, 2));
    }
    if (fallbackEvents.length > 0) {
      console.log('  Gemini Fallback Events:', JSON.stringify(fallbackEvents));
    }
    if (failoverEvents.length > 0) {
      console.log('  Provider Failover Events:', JSON.stringify(failoverEvents));
    }
    if (diagnosticLogs.length > 0) {
      console.log('  Diagnostic Logs:', JSON.stringify(diagnosticLogs, null, 2));
    }
    if (executionMetadata) {
      console.log('  Gemini Execution Metadata:', JSON.stringify(executionMetadata));
    }
    console.log(
      '  Validated Output Summary:',
      JSON.stringify({
        metadataSchemaValid: metadataCheck.success,
        hasJobTitle: result.jobTitle !== null,
        minimumExperienceYears: result.minimumExperienceYears,
        maximumExperienceYears: result.maximumExperienceYears,
        compensationPresent: result.compensation !== null,
        compensationHasMinimum: result.compensation ? result.compensation.minimum !== null : null,
        compensationHasMaximum: result.compensation ? result.compensation.maximum !== null : null,
        noticePresent: result.noticePeriod !== null,
        noticeHasNormalizedDays: result.noticePeriod
          ? result.noticePeriod.normalizedDays !== null
          : null,
        requiredSkillsCount: result.requiredSkills.length,
        preferredSkillsCount: result.preferredSkills.length,
        educationRequirementsCount: result.educationRequirements.length,
        criteriaCount: result.criteria.length,
        warningsCount: result.warnings.length,
      }),
    );
    return { ok: true };
  } catch (err) {
    const totalMs = Date.now() - startMs;
    console.error(
      `[FAIL] Provider extract failed in ${totalMs}ms (correlationId=${correlationId})`,
    );
    console.error(
      '  Thrown Error:',
      JSON.stringify({
        name: err instanceof Error ? err.name : typeof err,
        message: sanitizeProviderErrorMessage(err instanceof Error ? err.message : String(err)),
        diagnostics:
          err && typeof err === 'object' && 'diagnostics' in err ? err.diagnostics : undefined,
      }),
    );
    if (getLastRequestConfig()) {
      console.error('  Gemini Request Config:', JSON.stringify(getLastRequestConfig()));
      console.error('  Gemini Attempts:', JSON.stringify(observedAttempts, null, 2));
    }
    if (groqAttempts.length > 0) {
      console.error('  Groq Attempts:', JSON.stringify(groqAttempts, null, 2));
    }
    if (diagnosticLogs.length > 0) {
      console.error('  Diagnostic Logs:', JSON.stringify(diagnosticLogs, null, 2));
    }
    if (fallbackEvents.length > 0) {
      console.error('  Gemini Fallback Events:', JSON.stringify(fallbackEvents));
    }
    if (failoverEvents.length > 0) {
      console.error('  Provider Failover Events:', JSON.stringify(failoverEvents));
    }
    return { ok: false, error: err };
  }
}

const primaryFlowResult = await runProviderCheck(
  providerMode === 'groq'
    ? `1. Direct Groq JD Extraction Flow (${rawGroqModel})`
    : providerMode === 'gemini'
      ? `1. Real Gemini API Flow (${primaryModel}${fallbackModel ? ` -> ${fallbackModel}` : ''})`
      : `1. Multi-Provider Failover JD Extraction Flow (${orderCheck.order.join(' -> ')})`,
  'diag-jd-primary-flow',
  providerMode,
);

let fallbackDirectResult = { ok: true };
if (providerMode === 'gemini' && fallbackModel && fallbackModel !== primaryModel) {
  fallbackDirectResult = await runProviderCheck(
    `2. Direct Fallback Model Real JD Extraction Probe (${fallbackModel})`,
    'diag-jd-fallback-direct',
    'gemini',
    {
      model: fallbackModel,
      fallbackModel: null,
      maxRetries: 0,
    },
  );
}

console.log('\n================================================================================');
if (primaryFlowResult.ok && fallbackDirectResult.ok) {
  console.log(
    'DIAGNOSTIC VERDICT: [PASS] Real JD extraction succeeded on active provider path(s).',
  );
  console.log('================================================================================');
  process.exit(0);
} else {
  console.error('DIAGNOSTIC VERDICT: [FAIL] Real JD extraction failure reproduced above.');
  console.log('================================================================================');
  process.exit(1);
}
