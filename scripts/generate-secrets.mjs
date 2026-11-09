#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const examplePath = path.resolve(rootDir, '.env.example');

// Parse CLI flags: --write, --target <path>
const args = process.argv.slice(2);
const shouldWrite = args.includes('--write');
const targetArgIndex = args.indexOf('--target');
let targetPath = path.resolve(rootDir, '.env');

if (targetArgIndex !== -1 && args[targetArgIndex + 1]) {
  targetPath = path.resolve(process.cwd(), args[targetArgIndex + 1]);
} else if (process.env.TARGET_ENV) {
  targetPath = path.resolve(process.cwd(), process.env.TARGET_ENV);
}

console.log('================================================================================');
console.log('TALENTLENS AI — PRODUCTION CRYPTOGRAPHIC SECRETS GENERATOR');
console.log('================================================================================');
console.log(`Target configuration: ${targetPath}`);
console.log(
  `Execution mode:       ${shouldWrite ? 'LIVE WRITE (--write)' : 'DRY RUN (preview only)'}\n`,
);

// Secret validation helpers
function isValidHexKey(val, expectedByteLength = 32) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  const hexRegex = new RegExp(`^[0-9a-fA-F]{${expectedByteLength * 2}}$`);
  return hexRegex.test(trimmed);
}

function isValidIdempotencySecret(val) {
  if (!val || typeof val !== 'string') return false;
  return val.trim().length >= 32;
}

function isValidPassword(val) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  return (
    trimmed.length >= 16 && !trimmed.includes('change_this') && !trimmed.includes('placeholder')
  );
}

// Read existing content if present
let existingContent = '';
const fileExists = fs.existsSync(targetPath);

if (fileExists) {
  existingContent = fs.readFileSync(targetPath, 'utf8');
} else if (fs.existsSync(examplePath)) {
  existingContent = fs.readFileSync(examplePath, 'utf8');
}

function extractVar(content, varName) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === varName) {
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1).trim();
      }
      return val === '' ? null : val;
    }
  }
  return null;
}

// Replace or append variable helper preserving line structure
function setOrAppendVar(content, varName, value) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#') && trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === varName) {
        found = true;
        return `${varName}=${value}`;
      }
    }
    return line;
  });
  if (!found) {
    newLines.push(`${varName}=${value}`);
  }
  return newLines.join(eol);
}

// Check existing values
const existingKey = extractVar(existingContent, 'EMAIL_OUTBOX_ENCRYPTION_KEY');
const existingSecret = extractVar(existingContent, 'EMAIL_OUTBOX_IDEMPOTENCY_SECRET');
const existingDbPass = extractVar(existingContent, 'POSTGRES_PASSWORD');
const existingDbUrl = extractVar(existingContent, 'DATABASE_URL');

// 1. EMAIL_OUTBOX_ENCRYPTION_KEY (AES-256: 64 hex characters)
let finalKey;
let keyAction;
if (isValidHexKey(existingKey)) {
  finalKey = existingKey;
  keyAction = '[PRESERVED] Valid 256-bit AES hex key already configured';
} else {
  finalKey = crypto.randomBytes(32).toString('hex');
  keyAction = '[GENERATED] New 256-bit AES encryption key (64 hex characters)';
}

// 2. EMAIL_OUTBOX_IDEMPOTENCY_SECRET (HMAC secret: 64 hex characters)
let finalSecret;
let secretAction;
if (isValidIdempotencySecret(existingSecret)) {
  finalSecret = existingSecret;
  secretAction = '[PRESERVED] Valid HMAC idempotency secret already configured';
} else {
  finalSecret = crypto.randomBytes(32).toString('hex');
  secretAction = '[GENERATED] New 256-bit HMAC idempotency secret (64 hex characters)';
}

// 3. POSTGRES_PASSWORD (24 bytes base64url = 32 URL-safe characters, 192 bits entropy)
let finalDbPass;
let dbPassAction;
if (isValidPassword(existingDbPass)) {
  finalDbPass = existingDbPass;
  dbPassAction = '[PRESERVED] Valid PostgreSQL password already configured';
} else {
  finalDbPass = crypto.randomBytes(24).toString('base64url');
  dbPassAction = '[GENERATED] New 192-bit URL-safe database password (32 chars base64url)';
}

console.log('Secrets Plan:');
console.log(`  * EMAIL_OUTBOX_ENCRYPTION_KEY:   ${keyAction}`);
console.log(`  * EMAIL_OUTBOX_IDEMPOTENCY_SECRET: ${secretAction}`);
console.log(`  * POSTGRES_PASSWORD:             ${dbPassAction}`);

// Build updated content
let updatedContent = existingContent;

updatedContent = setOrAppendVar(updatedContent, 'EMAIL_OUTBOX_ENCRYPTION_KEY', finalKey);
updatedContent = setOrAppendVar(updatedContent, 'EMAIL_OUTBOX_IDEMPOTENCY_SECRET', finalSecret);
updatedContent = setOrAppendVar(updatedContent, 'POSTGRES_PASSWORD', finalDbPass);

// Synchronize DATABASE_URL password safely
const dbUser = extractVar(updatedContent, 'POSTGRES_USER') || 'talentlens';
const dbName = extractVar(updatedContent, 'POSTGRES_DB') || 'talentlens';
const encodedPass = encodeURIComponent(finalDbPass);

if (
  existingDbUrl &&
  (existingDbUrl.startsWith('postgresql://') || existingDbUrl.startsWith('postgres://'))
) {
  try {
    const parsedUrl = new URL(existingDbUrl);
    parsedUrl.username = dbUser;
    parsedUrl.password = finalDbPass;
    updatedContent = setOrAppendVar(updatedContent, 'DATABASE_URL', parsedUrl.toString());
    console.log(
      '  * DATABASE_URL:                  [SYNCED] Connection string password synchronized',
    );
  } catch {
    const fallbackUrl = `postgresql://${dbUser}:${encodedPass}@postgres:5432/${dbName}?schema=public`;
    updatedContent = setOrAppendVar(updatedContent, 'DATABASE_URL', fallbackUrl);
    console.log('  * DATABASE_URL:                  [SYNCED] Standard container URL constructed');
  }
} else {
  const defaultUrl = `postgresql://${dbUser}:${encodedPass}@postgres:5432/${dbName}?schema=public`;
  updatedContent = setOrAppendVar(updatedContent, 'DATABASE_URL', defaultUrl);
  console.log(
    '  * DATABASE_URL:                  [GENERATED] Default PostgreSQL connection string',
  );
}

if (shouldWrite) {
  // Write securely
  fs.writeFileSync(targetPath, updatedContent, 'utf8');

  // Restrict file permissions on POSIX systems (chmod 600: read/write owner only)
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // Windows ACLs or non-posix filesystems ignore chmod
  }

  console.log('\n[SUCCESS] Configuration securely updated at: ' + targetPath);
  console.log('File permissions set to 0600 (owner read/write only where supported).');
  console.log('No secrets printed to output. Sensitive values preserved.');
} else {
  console.log('\n[DRY RUN COMPLETE] No files were modified.');
  console.log('To apply these changes, run with the --write flag:');
  console.log('  npm run generate:secrets -- --write');
  if (targetArgIndex !== -1) {
    console.log(`  node scripts/generate-secrets.mjs --target "${targetPath}" --write`);
  }
}

console.log('================================================================================');
