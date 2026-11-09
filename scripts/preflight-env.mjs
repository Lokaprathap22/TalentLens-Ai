#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const customEnv = process.argv[2] || process.env.ENV_PATH;
const envPath = customEnv ? path.resolve(process.cwd(), customEnv) : path.resolve(rootDir, '.env');

console.log('================================================================================');
console.log('TALENTLENS AI — PRODUCTION PREFLIGHT ENVIRONMENT VALIDATOR');
console.log('================================================================================');
console.log(`Checking configuration file: ${envPath}\n`);

if (!fs.existsSync(envPath)) {
  console.error('[FAIL] Target environment file does not exist: ' + envPath);
  console.error('Create a valid configuration from .env.example:');
  console.error('  cp .env.example .env && npm run generate:secrets -- --write');
  console.log('================================================================================');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const env = dotenv.parse(envContent);

const failures = [];
const warnings = [];

function check(category, name, condition, failureMessage, isWarning = false) {
  if (condition) {
    console.log(`  [PASS] ${category}: ${name}`);
  } else {
    if (isWarning) {
      console.log(`  [WARN] ${category}: ${name} — ${failureMessage}`);
      warnings.push(`${category}: ${name} — ${failureMessage}`);
    } else {
      console.log(`  [FAIL] ${category}: ${name} — ${failureMessage}`);
      failures.push(`${category}: ${name} — ${failureMessage}`);
    }
  }
}

// 1. Core Environment & Runtime
console.log('--- 1. Node & Application Runtime ---');
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
console.log('\n--- 2. PostgreSQL 17 Database ---');
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
check('Database', 'POSTGRES_DB', Boolean(env.POSTGRES_DB?.trim()), 'POSTGRES_DB must not be empty');
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

// 3. Google Gemini AI Engine
console.log('\n--- 3. Google Gemini AI Engine ---');
const geminiKey = env.GEMINI_API_KEY || env.AI_API_KEY;
check(
  'Gemini',
  'GEMINI_API_KEY',
  Boolean(
    geminiKey &&
    geminiKey.trim().length >= 20 &&
    !geminiKey.includes('placeholder') &&
    !geminiKey.includes('your_'),
  ),
  'GEMINI_API_KEY must be a valid non-empty Google Gemini API key',
);
const geminiModel = env.GEMINI_MODEL || env.AI_MODEL || 'gemini-3.8-flash';
check(
  'Gemini',
  'GEMINI_MODEL',
  Boolean(geminiModel && (geminiModel.startsWith('gemini-') || geminiModel === 'gemini-3.8-flash')),
  'GEMINI_MODEL must be a valid Gemini model (canonical: gemini-3.8-flash)',
);
check(
  'Gemini',
  'ASSESSMENT_PROVIDER',
  env.ASSESSMENT_PROVIDER === 'gemini' || !env.ASSESSMENT_PROVIDER,
  'ASSESSMENT_PROVIDER must be "gemini" in production; fake provider is strictly forbidden',
);

// 4. Object Storage (OCI S3-Compatible)
console.log('\n--- 4. Object Storage (OCI S3-Compatible) ---');
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
console.log('\n--- 5. Antivirus Daemon (ClamAV) ---');
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
console.log('\n--- 6. Cryptographic Security Secrets ---');
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
  Boolean(env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET && env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET.length >= 32),
  'Must be at least 32 characters (HMAC secret, generate via npm run generate:secrets)',
);

// 7. Email Dispatcher (SMTP)
console.log('\n--- 7. Transactional Email (SMTP) ---');
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
console.log('\n--- 8. Candidate Consent Governance ---');
check(
  'Consent',
  'CONSENT_APPROVED_POLICY_VERSIONS',
  Boolean(env.CONSENT_APPROVED_POLICY_VERSIONS?.trim()),
  'Must specify approved policy versions (e.g. 2026-11-v1)',
);

console.log('\n================================================================================');
if (failures.length === 0) {
  console.log('PREFLIGHT VERDICT: [PASS] All production environment configuration checks passed.');
  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    warnings.forEach((w) => console.log('  - ' + w));
  }
  console.log('The configuration is verified and safe for production release.');
  console.log('================================================================================');
  process.exit(0);
} else {
  console.error(`PREFLIGHT VERDICT: [FAIL] Found ${failures.length} configuration violation(s):`);
  failures.forEach((f) => console.error('  * ' + f));
  console.error('\nFix the above issues before deploying to production.');
  console.log('================================================================================');
  process.exit(1);
}
