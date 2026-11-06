import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../packages/database/dist/generated/prisma/client.js';
import { WorkerEmailDispatcher, type EmailDispatcherProvider } from './email-dispatcher.js';
import {
  createEmailIdempotencyKey,
  encryptEmailPayload,
  initializeIdempotencySecret,
} from './email-crypto.js';

const REQUIRED_DB_NAME = 'talentlens_scorecard_test';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

function assertSafeIntegrationDatabase(): string {
  const connStr = process.env['TALENTLENS_INTEGRATION_DATABASE_URL'];
  if (!connStr) {
    throw new Error(
      'TALENTLENS_INTEGRATION_DATABASE_URL must be set when running integration tests.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(connStr);
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

  return connStr;
}

class TestEmailProvider implements EmailDispatcherProvider {
  public sentMessages: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
  public shouldFail = false;
  public shouldPermanentFail = false;
  public errorMessage = 'Simulated SMTP connection error';

  public async send(msg: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string;
  }): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    isPermanentFailure?: boolean;
  }> {
    if (this.shouldPermanentFail) {
      return {
        success: false,
        error: '550 User unknown',
        isPermanentFailure: true,
      };
    }

    if (this.shouldFail) {
      return {
        success: false,
        error: this.errorMessage,
        isPermanentFailure: false,
      };
    }

    this.sentMessages.push(msg);
    return {
      success: true,
      messageId: `msg-${Date.now()}-${randomUUID().slice(0, 6)}`,
    };
  }

  public clear(): void {
    this.sentMessages = [];
    this.shouldFail = false;
    this.shouldPermanentFail = false;
  }
}

const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

maybeDescribe(
  'WorkerEmailDispatcher — Live PostgreSQL Job Processing & Lease Fencing Tests',
  () => {
    let prisma: PrismaClient;
    let provider: TestEmailProvider;
    let dispatcher: WorkerEmailDispatcher;

    beforeAll(async () => {
      const connStr = assertSafeIntegrationDatabase();
      const adapter = new PrismaPg({ connectionString: connStr });
      prisma = new PrismaClient({ adapter });
      await prisma.$connect();

      provider = new TestEmailProvider();
      await prisma.emailOutbox.deleteMany({});
      dispatcher = new WorkerEmailDispatcher(prisma, {
        workerId: 'test-dispatcher-worker',
        leaseDurationSeconds: 60,
        provider,
      });
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.$disconnect();
      }
    });

    it('returns false when outbox queue has no pending jobs', async () => {
      provider.clear();
      // Claim when no eligible jobs exist
      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(false);
    });

    it('claims pending email, dispatches via provider, and marks SENT with lease release', async () => {
      provider.clear();
      const id = randomUUID();
      const key = `worker-dispatch-sent-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'cand-dispatch@example.com',
          subject: 'Consent Dispatch',
          html: '<p>Consent</p>',
          text: 'Consent',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'PENDING',
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('SENT');
      expect(updated?.sentAt).not.toBeNull();
      expect(updated?.leaseToken).toBeNull();
      expect(updated?.lockedBy).toBeNull();
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.to).toBe('cand-dispatch@example.com');
    });

    it('recovers expired lease from crashed worker and retries delivery', async () => {
      provider.clear();
      const id = randomUUID();
      const key = `worker-recover-stale-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'manager-stale@client.com',
          subject: 'Stale Submission',
          html: '<p>Sub</p>',
          text: 'Sub',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'client_submission',
          recipientEmail: null,
          recipientRole: 'CLIENT_HIRING_MANAGER',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'SENDING',
          attempts: 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
          lockedBy: 'crashed-dead-worker',
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('SENT');
      expect(updated?.attempts).toBe(2);
      expect(updated?.leaseToken).toBeNull();
    });

    it('clock-skew immunity: fences out worker completion when PostgreSQL clock_timestamp() exceeds lease deadline', async () => {
      provider.clear();
      const id = randomUUID();
      const key = `worker-clockskew-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'skew@example.com',
          subject: 'Clock skew test',
          html: '<p>Skew</p>',
          text: 'Skew',
        },
        { recordId: id, idempotencyKey: key },
      );

      // Create record with lease already expired according to PostgreSQL clock_timestamp()
      const leaseToken = randomUUID();
      await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'SENDING',
          attempts: 1,
          leaseToken,
          lockedBy: 'stale-worker',
        },
      });

      // Set lease_expires_at strictly relative to database clock_timestamp()
      await prisma.$executeRaw`
        UPDATE email_outbox
        SET lease_expires_at = clock_timestamp() - INTERVAL '5 seconds'
        WHERE id = ${id}::uuid
      `;

      // Dispatcher reclaims expired job via clock_timestamp() authority
      const recovered = await dispatcher.processNextEmail();
      expect(recovered).toBe(true);

      const finalRecord = await prisma.emailOutbox.findUnique({ where: { id } });
      expect(finalRecord?.status).toBe('SENT');
      expect(finalRecord?.attempts).toBe(2);
      expect(finalRecord?.lockedBy).toBeNull();
      expect(finalRecord?.leaseToken).toBeNull();
    });

    it('schedules exponential backoff on transient transmission error', async () => {
      provider.clear();
      provider.shouldFail = true;
      provider.errorMessage = 'SMTP 421 Service unavailable';

      const id = randomUUID();
      const key = `worker-backoff-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'retry-worker@example.com',
          subject: 'Backoff worker test',
          html: '<p>Test</p>',
          text: 'Test',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('PENDING'); // Scheduled for retry
      expect(updated?.attempts).toBe(1);
      expect(updated?.lastError).toContain('SMTP 421');
      expect(updated?.lastErrorCode).toBe('TRANSIENT_FAILURE');
      expect(updated?.nextAttemptAt).not.toBeNull();
      expect(updated?.leaseToken).toBeNull();
    });

    it('exhausts to FAILED when max attempts are reached', async () => {
      provider.clear();
      provider.shouldFail = true;

      const id = randomUUID();
      const key = `worker-exhaust-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'exhaust@example.com',
          subject: 'Exhaust worker test',
          html: '<p>Test</p>',
          text: 'Test',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'PENDING',
          attempts: 2,
          maxAttempts: 3,
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('FAILED');
      expect(updated?.attempts).toBe(3);
      expect(updated?.lastErrorCode).toBe('MAX_ATTEMPTS_EXHAUSTED');
      expect(updated?.nextAttemptAt).toBeNull();
    });

    it('transitions immediately to PERMANENTLY_REJECTED on fatal 550 error without retry', async () => {
      provider.clear();
      provider.shouldPermanentFail = true;

      const id = randomUUID();
      const key = `worker-perm-reject-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'fatal-user@example.com',
          subject: 'Fatal rejection',
          html: '<p>Test</p>',
          text: 'Test',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('PERMANENTLY_REJECTED');
      expect(updated?.lastErrorCode).toBe('PERMANENT_REJECTION');
      expect(updated?.nextAttemptAt).toBeNull();
    });

    it('claims encrypted payload, decrypts, sends, and crypto-shreds on delivery', async () => {
      provider.clear();
      const id = randomUUID();
      const key = `worker-crypto-dispatch-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'crypto-recipient@client.com',
          subject: 'Encrypted Dispatch Test',
          html: '<p>Secret content</p>',
          text: 'Secret content',
        },
        { recordId: id, idempotencyKey: key },
      );

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload,
          keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('SENT');
      expect(updated?.sentAt).not.toBeNull();
      // Payload crypto-shredded:
      expect(updated?.encryptedPayload).toBeNull();
      expect(updated?.recipientEmail).toBeNull();
      expect(updated?.subject).toBeNull();
      expect(updated?.html).toBeNull();
      expect(updated?.text).toBeNull();

      // Provider received decrypted values:
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.to).toBe('crypto-recipient@client.com');
      expect(provider.sentMessages[0]?.subject).toBe('Encrypted Dispatch Test');
    });

    it('aborts and transitions to FAILED with PAYLOAD_DECRYPTION_FAILED if ciphertext is corrupted', async () => {
      provider.clear();
      const id = randomUUID();
      const key = `worker-crypto-corrupt-${Date.now()}`;
      const { encryptedPayload, keyId } = encryptEmailPayload(
        {
          recipientEmail: 'corrupt-recipient@client.com',
          subject: 'Corrupted Dispatch Test',
          html: '<p>Content</p>',
          text: 'Content',
        },
        { recordId: id, idempotencyKey: key },
      );

      // Corrupt the ciphertext
      const parts = encryptedPayload.split(':');
      parts[4] = Buffer.from('corrupted-data').toString('base64');
      const corrupted = parts.join(':');

      const job = await prisma.emailOutbox.create({
        data: {
          id,
          idempotencyKey: key,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          subject: null,
          html: null,
          text: null,
          encryptedPayload: corrupted,
          keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const processed = await dispatcher.processNextEmail();
      expect(processed).toBe(true);

      const updated = await prisma.emailOutbox.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('FAILED');
      expect(updated?.lastErrorCode).toBe('PAYLOAD_DECRYPTION_FAILED');
      expect(provider.sentMessages).toHaveLength(0);
    });

    it('Worker crypto: fails closed in production or staging when EMAIL_OUTBOX_IDEMPOTENCY_SECRET is missing or insufficient', () => {
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
        });
      }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);

      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'staging',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
        });
      }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);

      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'short-insecure-secret',
        });
      }).toThrowError(/must be at least 32 bytes/);

      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'd'.repeat(64),
        });
      }).not.toThrow();

      // Reset to test environment
      initializeIdempotencySecret({ NODE_ENV: 'test' });
    });

    it('Worker crypto: produces deterministic idempotency keys identical to API given identical input', () => {
      const email = 'shared-identity@talentlens.ai';
      const event = 'interview-scheduled-1001';
      const key1 = createEmailIdempotencyKey('interview', email, event);
      const key2 = createEmailIdempotencyKey('interview', 'SHARED-IDENTITY@TALENTLENS.AI', event);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^interview:[a-f0-9]{32}$/);
      expect(key1).not.toContain('shared-identity');
    });
  },
);
