#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
}

export function parseDotEnvContent(rawText) {
  const result = {};
  const text = String(rawText ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  let idx = 0;
  const len = text.length;

  while (idx < len) {
    while (idx < len && (text[idx] === '\n' || text[idx] === ' ' || text[idx] === '\t')) {
      idx += 1;
    }
    if (idx >= len) break;

    if (text[idx] === '#') {
      const nl = text.indexOf('\n', idx);
      idx = nl === -1 ? len : nl + 1;
      continue;
    }

    const eqIdx = text.indexOf('=', idx);
    const nlIdx = text.indexOf('\n', idx);
    if (eqIdx === -1 || (nlIdx !== -1 && nlIdx < eqIdx)) {
      idx = nlIdx === -1 ? len : nlIdx + 1;
      continue;
    }

    const rawKey = text
      .slice(idx, eqIdx)
      .replace(/^\s*(?:export\s+)?/, '')
      .trim();
    idx = eqIdx + 1;

    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawKey)) {
      idx = nlIdx === -1 ? len : nlIdx + 1;
      continue;
    }

    while (idx < len && (text[idx] === ' ' || text[idx] === '\t')) {
      idx += 1;
    }

    if (idx >= len || text[idx] === '\n') {
      result[rawKey] = '';
      if (idx < len && text[idx] === '\n') idx += 1;
      continue;
    }

    const quote = text[idx];
    if (quote === '"' || quote === "'" || quote === '`') {
      idx += 1;
      let val = '';
      while (idx < len) {
        const ch = text[idx];
        if (quote === '"' && ch === '\\' && idx + 1 < len) {
          const next = text[idx + 1];
          if (next === 'n') val += '\n';
          else if (next === 'r') val += '\r';
          else if (next === 't') val += '\t';
          else val += next;
          idx += 2;
          continue;
        }
        if (ch === quote) {
          idx += 1;
          break;
        }
        val += ch;
        idx += 1;
      }
      result[rawKey] = val;
      const restNl = text.indexOf('\n', idx);
      idx = restNl === -1 ? len : restNl + 1;
      continue;
    }

    const lineEnd = nlIdx === -1 ? len : nlIdx;
    const rawSegment = text.slice(idx, lineEnd);
    const commentMatch = /(?:^|\s)#/.exec(rawSegment);
    const valuePart = commentMatch ? rawSegment.slice(0, commentMatch.index) : rawSegment;
    result[rawKey] = valuePart.trim();
    idx = nlIdx === -1 ? len : nlIdx + 1;
  }

  return result;
}

export function runPreflightEnv(argv = process.argv.slice(2), deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const rootDir = deps.rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
  const fsImpl = deps.fsImpl ?? fs;
  const platform = deps.platform ?? process.platform;
  const envProcess = deps.processEnv ?? process.env;
  const log = deps.stdout ?? ((msg) => console.log(msg));
  const logErr = deps.stderr ?? ((msg) => console.error(msg));

  let strictPerms = false;
  let customEnv = '';
  for (const arg of argv) {
    if (arg === '--strict-perms') {
      strictPerms = true;
    } else if (!arg.startsWith('-') && !customEnv) {
      customEnv = arg;
    }
  }
  if (!customEnv && envProcess.ENV_PATH) {
    customEnv = envProcess.ENV_PATH;
  }
  const envPath = customEnv ? path.resolve(cwd, customEnv) : path.resolve(rootDir, '.env');

  log('================================================================================');
  log('TALENTLENS AI — PRODUCTION PREFLIGHT ENVIRONMENT VALIDATOR');
  log('================================================================================');
  log(`Checking configuration file: ${envPath}\n`);

  if (!fsImpl.existsSync(envPath)) {
    logErr('[FAIL] Target environment file does not exist: ' + envPath);
    logErr('Create a valid configuration from .env.example:');
    logErr('  cp .env.example .env && npm run generate:secrets -- --write');
    log('================================================================================');
    return 1;
  }

  const lstat = fsImpl.lstatSync(envPath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    logErr('[FAIL] Target environment path must be a regular non-symlink file: ' + envPath);
    log('================================================================================');
    return 1;
  }

  const envContent = fsImpl.readFileSync(envPath, 'utf8');
  const env = parseDotEnvContent(envContent);

  const failures = [];
  const warnings = [];

  function check(category, name, condition, failureMessage, isWarning = false) {
    if (condition) {
      log(`  [PASS] ${category}: ${name}`);
    } else if (isWarning) {
      log(`  [WARN] ${category}: ${name} — ${failureMessage}`);
      warnings.push(`${category}: ${name} — ${failureMessage}`);
    } else {
      log(`  [FAIL] ${category}: ${name} — ${failureMessage}`);
      failures.push(`${category}: ${name} — ${failureMessage}`);
    }
  }

  if (platform !== 'win32') {
    const modeBits = lstat.mode & 0o777;
    const isOwnerOnly = (modeBits & 0o077) === 0;
    check(
      'Security',
      'ENV_FILE_PERMISSIONS',
      isOwnerOnly,
      `Permissions are ${modeBits.toString(8).padStart(4, '0')}; restrict group/other access via chmod 600 ${envPath}`,
      !strictPerms,
    );
  }

  // 1. Core Environment & Runtime
  log('--- 1. Node & Application Runtime ---');
  check(
    'Runtime',
    'NODE_ENV',
    env.NODE_ENV === 'production',
    'Must be explicitly set to "production"',
  );
  check(
    'Runtime',
    'APP_ORIGIN',
    Boolean(env.APP_ORIGIN && /^https:\/\/[^/]+$/.test(env.APP_ORIGIN)),
    'Must be a valid HTTPS origin (e.g. https://talentlens.yourdomain.com, no path or trailing slash)',
  );
  check(
    'Runtime',
    'TRUSTED_PROXY_IPS',
    Boolean(env.TRUSTED_PROXY_IPS?.trim()),
    'Must specify trusted reverse proxy IPs (e.g. 172.28.0.10,172.28.0.1,127.0.0.1)',
  );
  check(
    'Runtime',
    'Ports',
    Boolean(env.PORT || env.API_PORT || env.WEB_PORT),
    'Must define standard application ports',
  );

  // 2. PostgreSQL 17 Database
  log('\n--- 2. PostgreSQL 17 Database ---');
  check(
    'Database',
    'POSTGRES_USER',
    Boolean(env.POSTGRES_USER?.trim()),
    'POSTGRES_USER must not be empty',
  );
  check(
    'Database',
    'POSTGRES_PASSWORD',
    Boolean(
      env.POSTGRES_PASSWORD &&
      env.POSTGRES_PASSWORD.length >= 16 &&
      !env.POSTGRES_PASSWORD.includes('change_this'),
    ),
    'POSTGRES_PASSWORD must be at least 16 characters and not default placeholder',
  );
  check(
    'Database',
    'POSTGRES_DB',
    Boolean(env.POSTGRES_DB?.trim()),
    'POSTGRES_DB must not be empty',
  );
  check(
    'Database',
    'DATABASE_URL',
    Boolean(env.DATABASE_URL && /^(postgresql|postgres):\/\/.+/.test(env.DATABASE_URL)),
    'DATABASE_URL must be a valid postgresql:// URI',
  );

  let dbPasswordMatches = false;
  if (env.DATABASE_URL && env.POSTGRES_PASSWORD) {
    try {
      const parsedDbUrl = new URL(env.DATABASE_URL);
      dbPasswordMatches = parsedDbUrl.password === env.POSTGRES_PASSWORD;
    } catch {
      dbPasswordMatches = false;
    }
  }
  check(
    'Database',
    'DATABASE_URL_CREDENTIAL_SYNC',
    dbPasswordMatches,
    'DATABASE_URL password must match POSTGRES_PASSWORD exactly',
  );

  // 3. Multi-Provider AI Engine (Google Gemini + Groq Failover)
  log('\n--- 3. Multi-Provider AI Engine (Gemini & Groq) ---');
  const CANONICAL_GEMINI_MODEL = 'gemini-3.6-flash';
  const CANONICAL_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';
  const SUPPORTED_GEMINI_MODELS = [CANONICAL_GEMINI_MODEL, CANONICAL_GEMINI_FALLBACK_MODEL];
  const CANONICAL_GROQ_MODEL = 'openai/gpt-oss-120b';
  const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
  const SUPPORTED_AI_PROVIDERS = ['gemini', 'groq'];

  function normalizeGeminiModel(value) {
    return String(value ?? '')
      .trim()
      .replace(/^models\//i, '')
      .toLowerCase();
  }

  function isDisallowedFlashLiteModel(normalizedModel) {
    return normalizedModel.includes('flash-lite') || /(?:^|-)lite$/.test(normalizedModel);
  }

  function isPlaceholderAiSecret(value) {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    return (
      !normalized ||
      normalized.includes('placeholder') ||
      normalized.includes('your_') ||
      normalized.includes('change_this') ||
      normalized.includes('aizasysynthetic') ||
      normalized.includes('replace_with') ||
      normalized.includes('insert_') ||
      normalized.startsWith('<') ||
      normalized === 'none' ||
      normalized === 'null' ||
      normalized === 'undefined'
    );
  }

  const rawAssessmentProvider = env.ASSESSMENT_PROVIDER?.trim().toLowerCase() ?? '';
  const assessmentProviderValid =
    rawAssessmentProvider === '' ||
    rawAssessmentProvider === 'gemini' ||
    rawAssessmentProvider === 'groq' ||
    rawAssessmentProvider === 'auto';
  check(
    'AI',
    'ASSESSMENT_PROVIDER',
    assessmentProviderValid,
    'ASSESSMENT_PROVIDER must be "gemini", "groq", or "auto" in production; "fake" is strictly forbidden',
  );

  const rawOrderValue = env.AI_PROVIDER_ORDER?.trim();
  const effectiveOrderInput =
    rawOrderValue && rawOrderValue.length > 0
      ? rawOrderValue
      : rawAssessmentProvider === 'groq'
        ? 'groq'
        : 'gemini,groq';
  const rawOrderSegments = effectiveOrderInput.split(',').map((s) => s.trim().toLowerCase());
  const hasEmptyOrderToken = rawOrderSegments.some((s) => s === '');
  const unsupportedOrderTokens = rawOrderSegments.filter(
    (s) => s !== '' && !SUPPORTED_AI_PROVIDERS.includes(s),
  );
  const aiProviderOrder = [];
  for (const segment of rawOrderSegments) {
    if (SUPPORTED_AI_PROVIDERS.includes(segment) && !aiProviderOrder.includes(segment)) {
      aiProviderOrder.push(segment);
    }
  }
  const aiOrderValid =
    !hasEmptyOrderToken && unsupportedOrderTokens.length === 0 && aiProviderOrder.length > 0;
  check(
    'AI',
    'AI_PROVIDER_ORDER',
    aiOrderValid,
    `AI_PROVIDER_ORDER must be a non-empty comma-separated list from: ${SUPPORTED_AI_PROVIDERS.join(', ')}`,
  );

  const geminiKey = (env.GEMINI_API_KEY || env.AI_API_KEY || '').trim();
  const hasGeminiKey = Boolean(
    geminiKey && geminiKey.length >= 20 && !isPlaceholderAiSecret(geminiKey),
  );
  if (geminiKey) {
    check(
      'Gemini',
      'GEMINI_API_KEY',
      hasGeminiKey,
      'GEMINI_API_KEY appears invalid or uses a placeholder value',
    );
  }

  const rawPrimaryModel = env.GEMINI_MODEL ?? env.AI_MODEL;
  const effectivePrimaryModel =
    rawPrimaryModel !== undefined ? rawPrimaryModel : CANONICAL_GEMINI_MODEL;
  const normalizedPrimaryModel = normalizeGeminiModel(effectivePrimaryModel);
  const primaryValid =
    effectivePrimaryModel.trim().length > 0 &&
    !isDisallowedFlashLiteModel(normalizedPrimaryModel) &&
    SUPPORTED_GEMINI_MODELS.includes(normalizedPrimaryModel);
  check(
    'Gemini',
    'GEMINI_MODEL',
    primaryValid,
    `GEMINI_MODEL must be a supported Free-Tier model (${SUPPORTED_GEMINI_MODELS.join(' or ')}); Flash-Lite and gemini-3.8-flash are disallowed`,
  );

  const rawFallbackModel = env.GEMINI_FALLBACK_MODEL ?? env.AI_FALLBACK_MODEL;
  const effectiveFallbackModel =
    rawFallbackModel !== undefined ? rawFallbackModel : CANONICAL_GEMINI_FALLBACK_MODEL;
  const normalizedFallbackModel = normalizeGeminiModel(effectiveFallbackModel);
  const fallbackValid =
    effectiveFallbackModel.trim().length > 0 &&
    !isDisallowedFlashLiteModel(normalizedFallbackModel) &&
    SUPPORTED_GEMINI_MODELS.includes(normalizedFallbackModel);
  check(
    'Gemini',
    'GEMINI_FALLBACK_MODEL',
    fallbackValid,
    `GEMINI_FALLBACK_MODEL must be a supported Free-Tier model (${SUPPORTED_GEMINI_MODELS.join(' or ')}); Flash-Lite and gemini-3.8-flash are disallowed`,
  );

  if (primaryValid && fallbackValid) {
    check(
      'Gemini',
      'GEMINI_FALLBACK_DISTINCT',
      normalizedPrimaryModel !== normalizedFallbackModel,
      `Primary (${normalizedPrimaryModel}) and fallback (${normalizedFallbackModel}) normalize to the same model; bounded fallback will be disabled`,
      true,
    );
  }

  const rawGeminiTimeout =
    env.GEMINI_TIMEOUT_MS || env.AI_TIMEOUT_MS || env.ASSESSMENT_TIMEOUT_MS || '90000';
  const parsedGeminiTimeout = /^\d+$/.test(String(rawGeminiTimeout).trim())
    ? Number.parseInt(String(rawGeminiTimeout).trim(), 10)
    : Number.NaN;
  check(
    'Gemini',
    'GEMINI_TIMEOUT_MS',
    Number.isFinite(parsedGeminiTimeout) &&
      parsedGeminiTimeout >= 1_000 &&
      parsedGeminiTimeout <= 120_000,
    'GEMINI_TIMEOUT_MS must be an integer between 1000 and 120000 (canonical default: 90000)',
  );

  const groqKey = (env.GROQ_API_KEY || '').trim();
  const hasGroqKey = Boolean(groqKey && groqKey.length >= 10 && !isPlaceholderAiSecret(groqKey));
  if (groqKey) {
    check(
      'Groq',
      'GROQ_API_KEY',
      hasGroqKey,
      'GROQ_API_KEY appears invalid or uses a placeholder value',
    );
  }

  const effectiveGroqModel = (env.GROQ_MODEL ?? CANONICAL_GROQ_MODEL).trim();
  const groqModelValid = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(effectiveGroqModel);
  check(
    'Groq',
    'GROQ_MODEL',
    groqModelValid,
    `GROQ_MODEL must be a valid Groq model ID (canonical default: ${CANONICAL_GROQ_MODEL})`,
  );

  const effectiveGroqBaseUrl = (env.GROQ_BASE_URL ?? DEFAULT_GROQ_BASE_URL).trim();
  let groqUrlValid = false;
  try {
    const parsedGroqUrl = new URL(effectiveGroqBaseUrl);
    groqUrlValid =
      parsedGroqUrl.protocol === 'https:' && !parsedGroqUrl.username && !parsedGroqUrl.password;
  } catch {
    groqUrlValid = false;
  }
  check(
    'Groq',
    'GROQ_BASE_URL',
    groqUrlValid,
    `GROQ_BASE_URL must be a valid https:// URL without embedded credentials (default: ${DEFAULT_GROQ_BASE_URL})`,
  );

  const rawGroqTimeout =
    env.GROQ_TIMEOUT_MS || env.AI_TIMEOUT_MS || env.GEMINI_TIMEOUT_MS || '90000';
  const parsedGroqTimeout = /^\d+$/.test(String(rawGroqTimeout).trim())
    ? Number.parseInt(String(rawGroqTimeout).trim(), 10)
    : Number.NaN;
  check(
    'Groq',
    'GROQ_TIMEOUT_MS',
    Number.isFinite(parsedGroqTimeout) &&
      parsedGroqTimeout >= 1_000 &&
      parsedGroqTimeout <= 120_000,
    'GROQ_TIMEOUT_MS must be an integer between 1000 and 120000 (canonical default: 90000)',
  );

  const configuredProvidersInOrder = aiProviderOrder.filter((id) =>
    id === 'gemini' ? hasGeminiKey : hasGroqKey,
  );
  check(
    'AI',
    'AI_PROVIDER_CREDENTIALS',
    configuredProvidersInOrder.length > 0,
    'At least one enabled AI provider (GEMINI_API_KEY or GROQ_API_KEY) must have a valid non-placeholder API key',
  );

  if (configuredProvidersInOrder.length > 0) {
    if (aiProviderOrder.includes('gemini') && !hasGeminiKey && !geminiKey) {
      check(
        'AI',
        'GEMINI_PRIMARY_CONFIGURED',
        false,
        'GEMINI_API_KEY is unset; traffic will fall back directly to configured secondary provider(s)',
        true,
      );
    }
    if (aiProviderOrder.includes('groq') && !hasGroqKey && !groqKey) {
      check(
        'AI',
        'GROQ_FAILOVER_CONFIGURED',
        false,
        'GROQ_API_KEY is unset; automatic Gemini -> Groq failover is disabled in this environment',
        true,
      );
    }
  }

  // 4. Object Storage (OCI S3-Compatible)
  log('\n--- 4. Object Storage (OCI S3-Compatible) ---');
  check(
    'Storage',
    'STORAGE_DRIVER',
    env.STORAGE_DRIVER === 's3',
    'STORAGE_DRIVER must be strictly "s3" in production',
  );
  check(
    'Storage',
    'ALLOW_LOCAL_STORAGE_IN_PRODUCTION',
    env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== 'true',
    'Local storage is strictly forbidden in production; ALLOW_LOCAL_STORAGE_IN_PRODUCTION must be false',
  );
  check('Storage', 'S3_BUCKET', Boolean(env.S3_BUCKET?.trim()), 'S3_BUCKET must be specified');
  check(
    'Storage',
    'S3_REGION',
    Boolean(env.S3_REGION?.trim()),
    'S3_REGION must be specified (canonical default: ap-hyderabad-1)',
  );
  check(
    'Storage',
    'S3_ACCESS_KEY_ID',
    Boolean(env.S3_ACCESS_KEY_ID?.trim()),
    'S3_ACCESS_KEY_ID must not be empty',
  );
  check(
    'Storage',
    'S3_SECRET_ACCESS_KEY',
    Boolean(env.S3_SECRET_ACCESS_KEY?.trim() && env.S3_SECRET_ACCESS_KEY.length >= 16),
    'S3_SECRET_ACCESS_KEY must be present',
  );
  if (env.S3_ENDPOINT) {
    check(
      'Storage',
      'S3_ENDPOINT',
      /^https?:\/\/.+/.test(env.S3_ENDPOINT),
      'S3_ENDPOINT must be a valid URL (recommended: dedicated https://<ns>.compat.objectstorage.ap-hyderabad-1.oci.customer-oci.com)',
    );
  }

  // 5. Antivirus Scanner (ClamAV)
  log('\n--- 5. Antivirus Daemon (ClamAV) ---');
  check(
    'Antivirus',
    'SCANNER_DRIVER',
    env.SCANNER_DRIVER === 'clamav',
    'SCANNER_DRIVER must be "clamav" in production',
  );
  check(
    'Antivirus',
    'CLAMAV_HOST',
    Boolean(env.CLAMAV_HOST?.trim()),
    'CLAMAV_HOST must be specified (e.g. "clamav")',
  );
  check(
    'Antivirus',
    'SCANNER_FAIL_CLOSED',
    env.SCANNER_FAIL_CLOSED !== 'false',
    'SCANNER_FAIL_CLOSED must remain true in production',
  );

  // 6. Security Secrets & Keys
  log('\n--- 6. Cryptographic Security Secrets ---');
  check(
    'Security',
    'EMAIL_OUTBOX_ENCRYPTION_KEY',
    Boolean(
      env.EMAIL_OUTBOX_ENCRYPTION_KEY && /^[0-9a-fA-F]{64}$/.test(env.EMAIL_OUTBOX_ENCRYPTION_KEY),
    ),
    'Must be exactly 64 hex characters (32-byte AES-256 key, generate via npm run generate:secrets)',
  );
  check(
    'Security',
    'EMAIL_OUTBOX_IDEMPOTENCY_SECRET',
    Boolean(
      env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET && env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET.length >= 32,
    ),
    'Must be at least 32 characters (HMAC secret, generate via npm run generate:secrets)',
  );

  // 7. Email Dispatcher (SMTP)
  log('\n--- 7. Transactional Email (SMTP) ---');
  check('Email', 'SMTP_HOST', Boolean(env.SMTP_HOST?.trim()), 'SMTP_HOST must be specified');
  check(
    'Email',
    'SMTP_PORT',
    Boolean(env.SMTP_PORT && /^\d+$/.test(env.SMTP_PORT)),
    'SMTP_PORT must be an integer (e.g. 587)',
  );
  check(
    'Email',
    'EMAIL_FROM',
    Boolean(env.EMAIL_FROM && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.EMAIL_FROM)),
    'EMAIL_FROM must be a valid email address',
  );

  // 8. Consent Policy
  log('\n--- 8. Candidate Consent Governance ---');
  check(
    'Consent',
    'CONSENT_APPROVED_POLICY_VERSIONS',
    Boolean(env.CONSENT_APPROVED_POLICY_VERSIONS?.trim()),
    'Must specify approved policy versions (e.g. 2026-11-v1)',
  );

  log('\n================================================================================');
  if (failures.length === 0) {
    log('PREFLIGHT VERDICT: [PASS] All production environment configuration checks passed.');
    if (warnings.length > 0) {
      log(`Warnings (${warnings.length}):`);
      warnings.forEach((w) => log('  - ' + w));
    }
    log('The configuration is verified and safe for production release.');
    log('================================================================================');
    return 0;
  } else {
    logErr(`PREFLIGHT VERDICT: [FAIL] Found ${failures.length} configuration violation(s):`);
    failures.forEach((f) => logErr('  * ' + f));
    logErr('\nFix the above issues before deploying to production.');
    log('================================================================================');
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(runPreflightEnv());
}
