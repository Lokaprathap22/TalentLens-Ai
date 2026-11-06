import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export class PayloadDecryptionError extends Error {
  public readonly code: string;

  constructor(message = 'Decryption or authentication tag verification failed') {
    super(message);
    this.name = 'PayloadDecryptionError';
    this.code = 'PAYLOAD_DECRYPTION_FAILED';
  }
}

export interface SensitiveEmailPayload {
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface EncryptionContext {
  recordId: string;
  idempotencyKey: string;
  keyId?: string | undefined;
}

const DEFAULT_DEV_KEY = createHash('sha256')
  .update('talentlens-default-dev-outbox-key-do-not-use-in-prod-v1')
  .digest();

const DEV_TEST_IDEMPOTENCY_SECRET = createHash('sha256')
  .update('talentlens-dedicated-dev-test-idempotency-secret-do-not-use-in-prod-v1')
  .digest();

const KEY_RING = new Map<string, Buffer>();

let IDEMPOTENCY_SECRET: Buffer = DEV_TEST_IDEMPOTENCY_SECRET;

export const VALID_NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type ValidNodeEnv = (typeof VALID_NODE_ENVS)[number];

export function resolveValidNodeEnv(env: NodeJS.ProcessEnv = process.env): ValidNodeEnv {
  const rawNodeEnv = env['NODE_ENV']?.trim();
  if (!rawNodeEnv) {
    throw new Error(
      'NODE_ENV is required and must be explicitly set to "development", "test", "staging", or "production". Failing closed.',
    );
  }
  if (!VALID_NODE_ENVS.includes(rawNodeEnv as ValidNodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV "${rawNodeEnv}". Must be explicitly set to "development", "test", "staging", or "production". Failing closed.`,
    );
  }
  return rawNodeEnv as ValidNodeEnv;
}

/**
 * Initializes and validates the dedicated HMAC secret for outbox idempotency key generation.
 * In production and staging, EMAIL_OUTBOX_IDEMPOTENCY_SECRET is mandatory and must
 * be at least 32 bytes (64 hex characters or 32 raw bytes). Fails closed immediately
 * if missing or insufficient.
 *
 * It is completely independent of the AES-256-GCM email payload encryption keyring
 * and NEVER falls back to an encryption key or development default in production or staging.
 */
export function initializeIdempotencySecret(env: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = resolveValidNodeEnv(env);
  const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';
  const rawSecret = env['EMAIL_OUTBOX_IDEMPOTENCY_SECRET'];

  if (rawSecret && rawSecret.trim().length > 0) {
    const trimmed = rawSecret.trim();
    const secretBuf =
      trimmed.length === 64 ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'utf8');

    if (secretBuf.length >= 32) {
      IDEMPOTENCY_SECRET = secretBuf;
      return;
    }

    if (isProductionOrStaging) {
      throw new Error(
        'EMAIL_OUTBOX_IDEMPOTENCY_SECRET must be at least 32 bytes (64 hex characters or 32 raw bytes). Failing closed.',
      );
    }
  }

  if (isProductionOrStaging) {
    throw new Error(
      'EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging environments. Failing closed.',
    );
  }

  // Development and test fallback only (strictly isolated from production and staging)
  IDEMPOTENCY_SECRET = DEV_TEST_IDEMPOTENCY_SECRET;
}

/**
 * Returns the active HMAC secret used for idempotency keys.
 */
export function getIdempotencyHmacKey(): Buffer {
  return IDEMPOTENCY_SECRET;
}

/**
 * Explicitly sets the HMAC secret for test suites.
 */
export function setIdempotencySecret(secret: Buffer | string): void {
  const secretBuf =
    typeof secret === 'string'
      ? secret.length === 64
        ? Buffer.from(secret, 'hex')
        : Buffer.from(secret, 'utf8')
      : secret;

  if (secretBuf.length < 32) {
    throw new Error('Idempotency HMAC secret must be at least 32 bytes (256 bits).');
  }
  IDEMPOTENCY_SECRET = secretBuf;
}

/**
 * Computes a privacy-preserving deterministic idempotency key for outbox records.
 * Uses a keyed HMAC-SHA-256 digest of normalized recipient email and event identity so no raw
 * email addresses or candidate PII appear in plaintext in the database or logs, while
 * preventing offline rainbow-table or precomputed dictionary attacks.
 */
export function createEmailIdempotencyKey(
  prefix: string,
  recipientEmail: string,
  eventIdentity: string,
  hmacKey?: Buffer,
): string {
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  const key = hmacKey ?? getIdempotencyHmacKey();
  const digest = createHmac('sha256', key)
    .update(`${normalizedEmail}:${eventIdentity}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

export function initializeKeyRing(env: NodeJS.ProcessEnv = process.env): void {
  KEY_RING.clear();
  const nodeEnv = resolveValidNodeEnv(env);
  const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

  const envKey = env['EMAIL_OUTBOX_ENCRYPTION_KEY'];
  const previousKeys = env['EMAIL_OUTBOX_PREVIOUS_KEYS'];

  if (envKey && envKey.trim().length > 0) {
    const raw = envKey.trim();
    const keyBuf =
      raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8').subarray(0, 32);
    if (keyBuf.length === 32) {
      KEY_RING.set('v1', keyBuf);
    } else if (isProductionOrStaging) {
      throw new Error(
        'EMAIL_OUTBOX_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters or 32 raw bytes). Failing closed.',
      );
    } else {
      KEY_RING.set('v1', DEFAULT_DEV_KEY);
    }
  } else if (isProductionOrStaging) {
    throw new Error(
      'EMAIL_OUTBOX_ENCRYPTION_KEY is required in production and staging environments. Failing closed.',
    );
  } else {
    KEY_RING.set('v1', DEFAULT_DEV_KEY);
  }

  // Load previous/rotated keys into keyring if provided
  if (previousKeys && previousKeys.trim().length > 0) {
    const entries = previousKeys.split(',');
    for (const entry of entries) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx > 0) {
        const keyId = entry.slice(0, colonIdx).trim();
        const keyVal = entry.slice(colonIdx + 1).trim();
        const buf =
          keyVal.length === 64
            ? Buffer.from(keyVal, 'hex')
            : Buffer.from(keyVal, 'utf8').subarray(0, 32);
        if (buf.length === 32) {
          KEY_RING.set(keyId, buf);
        }
      }
    }
  }
}

initializeIdempotencySecret();
initializeKeyRing();

export function setEncryptionKey(keyId: string, key: Buffer | string): void {
  const keyBuf =
    typeof key === 'string'
      ? key.length === 64
        ? Buffer.from(key, 'hex')
        : Buffer.from(key, 'utf8').subarray(0, 32)
      : key;

  if (keyBuf.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits).');
  }
  KEY_RING.set(keyId, keyBuf);
}

export function getActiveKeyId(): string {
  return 'v1';
}

function computeAad(context: { recordId: string; idempotencyKey: string }): Buffer {
  return Buffer.from(`${context.recordId}:${context.idempotencyKey}`, 'utf8');
}

/**
 * Encrypts sensitive email payload at rest using AES-256-GCM with unique IV and AAD binding.
 */
export function encryptEmailPayload(
  payload: SensitiveEmailPayload,
  context: EncryptionContext,
): { encryptedPayload: string; keyId: string } {
  const keyId = context.keyId ?? getActiveKeyId();
  const key = KEY_RING.get(keyId);
  if (!key) {
    throw new PayloadDecryptionError(`Unknown encryption keyId: "${keyId}"`);
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const aad = computeAad(context);
  cipher.setAAD(aad);

  const serialized = JSON.stringify(payload);
  const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = `v1:${keyId}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;

  return {
    encryptedPayload: envelope,
    keyId,
  };
}

/**
 * Decrypts authenticated email payload, verifying auth tag and AAD binding.
 * Throws PayloadDecryptionError on tamper, key mismatch, or corruption without leaking data.
 */
export function decryptEmailPayload(
  envelope: string,
  context: { recordId: string; idempotencyKey: string },
): SensitiveEmailPayload {
  if (!envelope || !envelope.startsWith('v1:')) {
    throw new PayloadDecryptionError('Invalid or unsupported envelope format.');
  }

  const parts = envelope.split(':');
  if (parts.length !== 5) {
    throw new PayloadDecryptionError('Malformed encrypted payload format.');
  }

  const [, keyId, ivB64, tagB64, ciphertextB64] = parts;

  if (!keyId || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new PayloadDecryptionError('Missing fields in encrypted envelope.');
  }

  const key = KEY_RING.get(keyId);
  if (!key) {
    throw new PayloadDecryptionError(`Missing encryption key for keyId: "${keyId}"`);
  }

  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    if (iv.length !== 12 || tag.length !== 16) {
      throw new PayloadDecryptionError('Invalid IV or authentication tag length.');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const aad = computeAad(context);
    decipher.setAAD(aad);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8')) as SensitiveEmailPayload;

    return parsed;
  } catch (err: unknown) {
    if (err instanceof PayloadDecryptionError) {
      throw err;
    }
    throw new PayloadDecryptionError();
  }
}
