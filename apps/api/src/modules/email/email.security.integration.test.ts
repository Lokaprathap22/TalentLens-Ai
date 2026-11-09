import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';
import { PostgresEmailOutboxStore } from './email.outbox.js';
import {
  createEmailIdempotencyKey,
  decryptEmailPayload,
  encryptEmailPayload,
  initializeIdempotencySecret,
  initializeKeyRing,
  PayloadDecryptionError,
  setEncryptionKey,
} from './email.crypto.js';
import {
  WorkerEmailDispatcher,
  type EmailDispatcherProvider,
} from '../../../../worker/src/email-dispatcher.js';

const REQUIRED_DB_NAME = 'talentlens_scorecard_test';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

function assertSafeIntegrationDatabase(): string {
  const rawUrl = process.env['TALENTLENS_INTEGRATION_DATABASE_URL'];
  if (!rawUrl) {
    throw new Error(
      'TALENTLENS_INTEGRATION_DATABASE_URL must be set when running integration tests.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TALENTLENS_INTEGRATION_DATABASE_URL is not a valid URL.');
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Integration tests may only connect to localhost. Got: ${parsed.hostname}`);
  }

  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `Integration tests may ONLY connect to database "${REQUIRED_DB_NAME}". Got: "${dbName}".`,
    );
  }

  return rawUrl;
}

class MockDispatcherProvider implements EmailDispatcherProvider {
  public sentMessages: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];

  public async send(msg: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    this.sentMessages.push(msg);
    return {
      success: true,
      messageId: `msg-${Date.now()}-${randomUUID().slice(0, 6)}`,
    };
  }

  public clear(): void {
    this.sentMessages = [];
  }
}

const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

maybeDescribe('Email Security & Payload Encryption — Live PostgreSQL Integration Tests', () => {
  let prisma: PrismaClient;
  let outboxStore: PostgresEmailOutboxStore;
  let mockProvider: MockDispatcherProvider;
  let dispatcher: WorkerEmailDispatcher;
  let orgId: string;

  beforeAll(async () => {
    const connStr = assertSafeIntegrationDatabase();
    const adapter = new PrismaPg({ connectionString: connStr });
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();
    // Purge any stale records from previous test runs to ensure deterministic FIFO ordering
    await prisma.emailOutbox.deleteMany({});
    outboxStore = new PostgresEmailOutboxStore(prisma);
    mockProvider = new MockDispatcherProvider();
    dispatcher = new WorkerEmailDispatcher(prisma, {
      workerId: 'test-crypto-dispatcher',
      leaseDurationSeconds: 60,
      provider: mockProvider,
    });

    const org = await prisma.organization.create({
      data: {
        name: `Crypto Test Org ${randomUUID().slice(0, 8)}`,
        normalizedName: `crypto-test-${Date.now()}-${randomUUID().slice(0, 6)}`,
      },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.emailOutbox.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    await prisma.emailOutbox.deleteMany({});
    mockProvider.clear();
  });

  it('stores ZERO plaintext tokens or PII in raw PostgreSQL columns', async () => {
    const rawToken = 'secret-capability-token-xyz-987654321';
    const candidateEmail = 'confidential.candidate@example.org';
    const candidateName = 'Dr. Jane Confidential';
    const rawHtml = `<p>Welcome ${candidateName}. Click <a href="https://app.talentlens.ai/consent#token=${rawToken}">here</a> to consent.</p>`;
    const rawText = `Welcome ${candidateName}. Visit https://app.talentlens.ai/consent#token=${rawToken}`;
    const idempotencyKey = `sec-test-token-${Date.now()}-${randomUUID().slice(0, 6)}`;

    const { record } = await outboxStore.enqueue({
      organizationId: orgId,
      idempotencyKey,
      template: 'consent_invitation',
      recipientEmail: candidateEmail,
      recipientRole: 'CANDIDATE',
      subject: `Consent Invitation for ${candidateName}`,
      html: rawHtml,
      text: rawText,
      metadata: { candidateName, rawToken },
    });

    // Query raw database row directly bypassing outbox decryption
    const rawRow = await prisma.$queryRaw<
      Array<{
        id: string;
        recipient_email: string | null;
        subject: string | null;
        html: string | null;
        text: string | null;
        payload_json: unknown;
        encrypted_payload: string | null;
        key_id: string | null;
        status: string;
      }>
    >`
        SELECT id, recipient_email, subject, html, text, payload_json, encrypted_payload, key_id, status
        FROM email_outbox
        WHERE id = ${record.id}::uuid
      `;

    expect(rawRow).toHaveLength(1);
    const row = rawRow[0]!;

    // Verify all sensitive columns in postgres are strictly NULL
    expect(row.recipient_email).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.html).toBeNull();
    expect(row.text).toBeNull();
    expect(row.payload_json).toBeNull();

    // Verify encrypted payload and keyId are present
    expect(row.encrypted_payload).not.toBeNull();
    expect(row.encrypted_payload?.startsWith('v1:v1:')).toBe(true);
    expect(row.key_id).toBe('v1');

    // Verify that neither the raw token, email, nor candidate name appear as plaintext in the encrypted_payload string
    expect(row.encrypted_payload).not.toContain(rawToken);
    expect(row.encrypted_payload).not.toContain(candidateEmail);
    expect(row.encrypted_payload).not.toContain(candidateName);

    // Verify that outboxStore.getRecord decrypts transparently
    const fetched = await outboxStore.getRecord(record.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.recipientEmail).toBe(candidateEmail);
    expect(fetched?.subject).toContain(candidateName);
    expect(fetched?.html).toContain(rawToken);
    expect(fetched?.metadata).toEqual({ candidateName, rawToken });
  });

  it('erases sensitive payload (crypto-shredding) on successful delivery', async () => {
    const idempotencyKey = `sec-test-shred-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const { record } = await outboxStore.enqueue({
      organizationId: orgId,
      idempotencyKey,
      template: 'client_submission',
      recipientEmail: 'client.manager@company.com',
      recipientRole: 'CLIENT_HIRING_MANAGER',
      subject: 'Confidential Candidate Submission',
      html: '<p>Candidate ref: TL-9921</p>',
      text: 'Candidate ref: TL-9921',
    });

    // Verify encrypted payload exists initially
    const preSend = await prisma.emailOutbox.findUnique({ where: { id: record.id } });
    expect(preSend?.encryptedPayload).not.toBeNull();

    // Dispatch via worker
    mockProvider.clear();
    const processed = await dispatcher.processNextEmail();
    expect(processed).toBe(true);
    expect(mockProvider.sentMessages).toHaveLength(1);
    expect(mockProvider.sentMessages[0]?.to).toBe('client.manager@company.com');

    // Inspect PostgreSQL row post-delivery
    const postSend = await prisma.emailOutbox.findUnique({ where: { id: record.id } });
    expect(postSend?.status).toBe('SENT');
    expect(postSend?.sentAt).not.toBeNull();
    // Crypto-shredded:
    expect(postSend?.encryptedPayload).toBeNull();
    expect(postSend?.recipientEmail).toBeNull();
    expect(postSend?.subject).toBeNull();
    expect(postSend?.html).toBeNull();
    expect(postSend?.text).toBeNull();
  });

  it('detects tampering and aborts delivery without sending or leaking data', async () => {
    const idempotencyKey = `sec-test-tamper-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const { record } = await outboxStore.enqueue({
      organizationId: orgId,
      idempotencyKey,
      template: 'consent_invitation',
      recipientEmail: 'victim@example.com',
      recipientRole: 'CANDIDATE',
      subject: 'Tamper Test',
      html: '<p>Legitimate text</p>',
      text: 'Legitimate text',
    });

    // Fetch row and tamper with 1 byte in the ciphertext part
    const row = await prisma.emailOutbox.findUnique({ where: { id: record.id } });
    expect(row?.encryptedPayload).toBeDefined();

    const parts = row!.encryptedPayload!.split(':');
    // Format: v1:keyId:iv:tag:ciphertext
    const ciphertextB64 = parts[4]!;
    const ctBuf = Buffer.from(ciphertextB64, 'base64');
    // Flip the last bit of the last byte
    ctBuf[ctBuf.length - 1] = ctBuf[ctBuf.length - 1]! ^ 0x01;
    parts[4] = ctBuf.toString('base64');
    const tamperedEnvelope = parts.join(':');

    await prisma.emailOutbox.update({
      where: { id: record.id },
      data: { encryptedPayload: tamperedEnvelope },
    });

    // Dispatcher attempts to process
    mockProvider.clear();
    const processed = await dispatcher.processNextEmail();
    expect(processed).toBe(true);

    // Verify that provider was NEVER called
    expect(mockProvider.sentMessages).toHaveLength(0);

    // Verify job was marked FAILED with PAYLOAD_DECRYPTION_FAILED
    const updated = await prisma.emailOutbox.findUnique({ where: { id: record.id } });
    expect(updated?.status).toBe('FAILED');
    expect(updated?.lastErrorCode).toBe('PAYLOAD_DECRYPTION_FAILED');
  });

  it('prevents ciphertext transposition attacks via AAD binding', async () => {
    const idA = randomUUID();
    const keyA = `sec-trans-a-${Date.now()}`;
    const { encryptedPayload } = encryptEmailPayload(
      {
        recipientEmail: 'intended@example.com',
        subject: 'Confidential Letter',
        html: '<p>Targeted content</p>',
        text: 'Targeted content',
      },
      { recordId: idA, idempotencyKey: keyA },
    );

    // Attacker tries to decrypt payload using context of Record B
    const idB = randomUUID();
    const keyB = `sec-trans-b-${Date.now()}`;

    expect(() => {
      decryptEmailPayload(encryptedPayload, {
        recordId: idB,
        idempotencyKey: keyB,
      });
    }).toThrowError(PayloadDecryptionError);
  });

  it('rejects decryption when an unknown or rotated key is specified', async () => {
    const id = randomUUID();
    const key = `sec-key-test-${Date.now()}`;

    // Register key v2
    const fakeKey2 = Buffer.alloc(32, 0x42);
    setEncryptionKey('v2', fakeKey2);

    const { encryptedPayload } = encryptEmailPayload(
      {
        recipientEmail: 'test@v2.com',
        subject: 'V2 Test',
        html: '<p>v2</p>',
        text: 'v2',
      },
      { recordId: id, idempotencyKey: key, keyId: 'v2' },
    );

    expect(encryptedPayload.startsWith('v1:v2:')).toBe(true);

    // Attempt to decrypt with corrupted envelope specifying unknown key 'v999'
    const corruptedEnvelope = encryptedPayload.replace('v1:v2:', 'v1:v999:');
    expect(() => {
      decryptEmailPayload(corruptedEnvelope, { recordId: id, idempotencyKey: key });
    }).toThrowError(PayloadDecryptionError);
  });

  it('ensures idempotency key contains zero candidate email PII in raw PostgreSQL column', async () => {
    const rawCandidateEmail = 'confidential-executive@target-firm.com';
    const eventId = `invite-${randomUUID()}`;
    const safeKey = createEmailIdempotencyKey('consent_invitation', rawCandidateEmail, eventId);

    // Verify format: prefix:sha256_slice(0..32)
    expect(safeKey).toMatch(/^consent_invitation:[a-f0-9]{32}$/);
    expect(safeKey).not.toContain(rawCandidateEmail);
    expect(safeKey).not.toContain('target-firm');

    const { record } = await outboxStore.enqueue({
      organizationId: orgId,
      idempotencyKey: safeKey,
      template: 'consent_invitation',
      recipientEmail: rawCandidateEmail,
      recipientRole: 'CANDIDATE',
      subject: 'Confidential Invitation',
      html: '<p>Invitation</p>',
      text: 'Invitation',
    });

    const rawRows = await prisma.$queryRaw<Array<{ idempotency_key: string }>>`
      SELECT idempotency_key FROM email_outbox WHERE id = ${record.id}::uuid
    `;

    expect(rawRows).toHaveLength(1);
    const dbKey = rawRows[0]!.idempotency_key;
    expect(dbKey).toBe(safeKey);
    expect(dbKey).not.toContain(rawCandidateEmail);
    expect(dbKey).not.toContain('executive');
    expect(dbKey).not.toContain('target-firm');
  });

  it('fails closed in production or staging when EMAIL_OUTBOX_ENCRYPTION_KEY is missing or malformed', () => {
    // Missing key in production
    expect(() => {
      initializeKeyRing({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_ENCRYPTION_KEY: '',
      });
    }).toThrowError(/EMAIL_OUTBOX_ENCRYPTION_KEY is required in production and staging/);

    // Malformed key (not 32 bytes) in production
    expect(() => {
      initializeKeyRing({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_ENCRYPTION_KEY: 'too-short',
      });
    }).toThrowError(/must be exactly 32 bytes/);

    // Reset keyring back to development/test configuration
    initializeKeyRing({
      NODE_ENV: 'test',
    });
  });

  it('fails closed in production or staging when EMAIL_OUTBOX_IDEMPOTENCY_SECRET is missing or insufficient', () => {
    // Missing secret in production
    expect(() => {
      initializeIdempotencySecret({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
      });
    }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);

    // Missing secret in staging
    expect(() => {
      initializeIdempotencySecret({
        NODE_ENV: 'staging',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
      });
    }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);

    // Insufficient length (< 32 bytes)
    expect(() => {
      initializeIdempotencySecret({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'too-short-secret',
      });
    }).toThrowError(/must be at least 32 bytes/);

    // Valid secret succeeds in production
    expect(() => {
      initializeIdempotencySecret({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'c'.repeat(64),
      });
    }).not.toThrow();

    // Reset back to test configuration
    initializeIdempotencySecret({
      NODE_ENV: 'test',
    });
  });

  it('quarantines legacy unencrypted records and purges plaintext fields without sending', async () => {
    const legacyId = randomUUID();
    const legacyEmail = 'legacy-unencrypted@test.com';

    // Insert legacy unencrypted row with NULL encrypted_payload
    await prisma.$executeRaw`
      INSERT INTO email_outbox (
        id, organization_id, idempotency_key, message_type,
        recipient_email, recipient_role, subject, html, text,
        status, attempts, created_at, updated_at
      ) VALUES (
        ${legacyId}::uuid, ${orgId}::uuid, ${'legacy-key-' + randomUUID()}, 'consent_invitation',
        ${legacyEmail}, 'CANDIDATE', 'Legacy Plaintext Subject', '<p>Legacy HTML</p>', 'Legacy Text',
        'PENDING', 0, NOW(), NOW()
      )
    `;

    // Dispatcher attempts to process
    mockProvider.clear();
    const processed = await dispatcher.processNextEmail();
    expect(processed).toBe(true);

    // Provider was NOT called
    expect(mockProvider.sentMessages).toHaveLength(0);

    // Verify row was quarantined and fields wiped
    const quarantined = await prisma.emailOutbox.findUnique({ where: { id: legacyId } });
    expect(quarantined).not.toBeNull();
    expect(quarantined?.status).toBe('FAILED');
    expect(quarantined?.lastErrorCode).toBe('QUARANTINED_UNENCRYPTED_LEGACY');
    expect(quarantined?.recipientEmail).toBeNull();
    expect(quarantined?.subject).toBeNull();
    expect(quarantined?.html).toBe('[PURGED]');
    expect(quarantined?.text).toBe('[PURGED]');
  });
});
