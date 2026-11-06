import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';
import { PostgresEmailOutboxStore } from './email.outbox.js';
import { InMemoryEmailProvider } from './email.provider.js';
import { TransactionalEmailService } from './email.service.js';

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

const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

maybeDescribe(
  'PostgresEmailOutboxStore & Transactional Dispatch — Live PostgreSQL Integration Tests',
  () => {
    let prisma: PrismaClient;
    let outboxStore: PostgresEmailOutboxStore;
    let orgId: string;

    beforeAll(async () => {
      const connStr = assertSafeIntegrationDatabase();
      const adapter = new PrismaPg({ connectionString: connStr });
      prisma = new PrismaClient({ adapter });
      await prisma.$connect();
      // Purge stale outbox records from previous interrupted runs to guarantee deterministic queue state
      await prisma.emailOutbox.deleteMany({});
      outboxStore = new PostgresEmailOutboxStore(prisma);

      // Create unique test organization
      const org = await prisma.organization.create({
        data: {
          name: `Outbox Test Org ${randomUUID().slice(0, 8)}`,
          normalizedName: `outbox-test-${Date.now()}-${randomUUID().slice(0, 6)}`,
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

    it('persists outbox records durably in PostgreSQL', async () => {
      const key = `test-persist-${Date.now()}`;
      const result = await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key,
        template: 'consent_invitation',
        recipientEmail: 'candidate@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Consent Request',
        html: '<p>Please consent</p>',
        text: 'Please consent',
        metadata: { role: 'Engineer' },
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.record.id).toBeDefined();

      const fetched = await outboxStore.getRecord(result.record.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.status).toBe('PENDING');
      expect(fetched?.recipientEmail).toBe('candidate@example.com');
    });

    it('guarantees transaction rollback aborts both business entity and outbox record', async () => {
      const key = `test-rollback-${Date.now()}`;

      const rollbackError = new Error('SIMULATED_TRANSACTION_ROLLBACK');
      await expect(
        prisma.$transaction(async (tx) => {
          // Enqueue inside transaction
          await outboxStore.enqueue(
            {
              organizationId: orgId,
              idempotencyKey: key,
              template: 'client_submission',
              recipientEmail: 'manager@client.com',
              recipientRole: 'CLIENT_HIRING_MANAGER',
              subject: 'New Candidate',
              html: '<p>Candidate</p>',
              text: 'Candidate',
            },
            tx,
          );

          // Intentionally throw to trigger transaction rollback
          throw rollbackError;
        }),
      ).rejects.toThrow('SIMULATED_TRANSACTION_ROLLBACK');

      // Verify outbox record was NOT persisted
      const record = await outboxStore.getRecordByIdempotencyKey(key);
      expect(record).toBeNull();
    });

    it('enforces idempotency preventing duplicate outbox inserts', async () => {
      const key = `test-idempotent-${Date.now()}`;
      const input = {
        organizationId: orgId,
        idempotencyKey: key,
        template: 'client_feedback' as const,
        recipientEmail: 'recruiter@talentlens.ai',
        recipientRole: 'RECRUITER' as const,
        subject: 'Feedback recorded',
        html: '<p>Shortlisted</p>',
        text: 'Shortlisted',
      };

      const first = await outboxStore.enqueue(input);
      expect(first.isDuplicate).toBe(false);

      const second = await outboxStore.enqueue(input);
      expect(second.isDuplicate).toBe(true);
      expect(second.record.id).toBe(first.record.id);

      const count = await prisma.emailOutbox.count({ where: { idempotencyKey: key } });
      expect(count).toBe(1);
    });

    it('supports atomic job claiming with SELECT ... FOR UPDATE SKIP LOCKED without duplicates across concurrent workers', async () => {
      const key1 = `test-concurrent-1-${Date.now()}`;
      const key2 = `test-concurrent-2-${Date.now()}`;

      await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key1,
        template: 'consent_invitation',
        recipientEmail: 'cand1@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Sub 1',
        html: 'Sub 1',
        text: 'Sub 1',
      });

      await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key2,
        template: 'consent_invitation',
        recipientEmail: 'cand2@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Sub 2',
        html: 'Sub 2',
        text: 'Sub 2',
      });

      // Simulate two concurrent workers claiming simultaneously
      const [workerAClaimed, workerBClaimed] = await Promise.all([
        outboxStore.claimForDispatch('worker-A', 1),
        outboxStore.claimForDispatch('worker-B', 1),
      ]);

      expect(workerAClaimed).toHaveLength(1);
      expect(workerBClaimed).toHaveLength(1);

      // Guaranteed distinct jobs claimed
      expect(workerAClaimed[0]?.id).not.toBe(workerBClaimed[0]?.id);
      expect(workerAClaimed[0]?.leaseToken).toBeDefined();
      expect(workerBClaimed[0]?.leaseToken).toBeDefined();
    });

    it('recovers expired leases from simulated worker crashes', async () => {
      const key = `test-stale-lease-${Date.now()}`;
      const { record } = await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key,
        template: 'consent_invitation',
        recipientEmail: 'crashed@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Crashed worker test',
        html: 'Test',
        text: 'Test',
      });

      // Worker 1 claims job with a lease that immediately expired in the past
      await prisma.emailOutbox.update({
        where: { id: record.id },
        data: {
          status: 'SENDING',
          attempts: 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() - 5000), // expired 5 seconds ago
          lockedBy: 'dead-worker-1',
        },
      });

      // Worker 2 claims for dispatch — must recover the expired lease
      const recovered = await outboxStore.claimForDispatch('worker-2', 10);
      const recoveredRecord = recovered.find((r) => r.id === record.id);

      expect(recoveredRecord).toBeDefined();
      expect(recoveredRecord?.lockedBy).toBe('worker-2');
      expect(recoveredRecord?.attempts).toBe(2);
    });

    it('fences stale workers whose lease expired from overwriting reclaimed jobs', async () => {
      const key = `test-fencing-${Date.now()}`;
      const { record } = await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key,
        template: 'consent_invitation',
        recipientEmail: 'fencing@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Fencing test',
        html: 'Test',
        text: 'Test',
      });

      const oldLeaseToken = randomUUID();
      const newLeaseToken = randomUUID();

      // Reclaimed by a new worker
      await prisma.emailOutbox.update({
        where: { id: record.id },
        data: {
          status: 'SENDING',
          leaseToken: newLeaseToken,
          lockedBy: 'worker-new',
        },
      });

      // Old slow worker attempts to markSent using stale lease token
      await outboxStore.markSent(record.id, 'msg-1', oldLeaseToken);

      // Record must NOT be marked SENT by the old stale worker
      const check = await outboxStore.getRecord(record.id);
      expect(check?.status).toBe('SENDING');
      expect(check?.leaseToken).toBe(newLeaseToken);
    });

    it('schedules exponential backoff on transient failure and exhausts to FAILED on max attempts', async () => {
      const key = `test-backoff-${Date.now()}`;
      const { record } = await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key,
        template: 'consent_invitation',
        recipientEmail: 'backoff@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Backoff test',
        html: 'Test',
        text: 'Test',
        maxAttempts: 2,
      });

      // Attempt 1: Transient failure
      await outboxStore.markSending(record.id);
      const rec1 = await outboxStore.getRecord(record.id);
      await outboxStore.markFailed(record.id, 'SMTP 421', false, rec1?.leaseToken ?? undefined);

      const afterFirst = await outboxStore.getRecord(record.id);
      expect(afterFirst?.status).toBe('PENDING');
      expect(afterFirst?.nextAttemptAt).toBeDefined();

      // Attempt 2: Second failure reaches maxAttempts=2
      await outboxStore.markSending(record.id);
      const rec2 = await outboxStore.getRecord(record.id);
      await outboxStore.markFailed(record.id, 'SMTP 421', false, rec2?.leaseToken ?? undefined);

      const afterSecond = await outboxStore.getRecord(record.id);
      expect(afterSecond?.status).toBe('FAILED');
      expect(afterSecond?.lastErrorCode).toBe('MAX_ATTEMPTS_EXHAUSTED');
    });

    it('marks PERMANENTLY_REJECTED immediately without retry on fatal provider rejection', async () => {
      const key = `test-perm-reject-${Date.now()}`;
      const { record } = await outboxStore.enqueue({
        organizationId: orgId,
        idempotencyKey: key,
        template: 'consent_invitation',
        recipientEmail: 'bad-address@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Permanent reject test',
        html: 'Test',
        text: 'Test',
      });

      await outboxStore.markSending(record.id);
      const rec = await outboxStore.getRecord(record.id);
      await outboxStore.markFailed(
        record.id,
        '550 5.1.1 No such user',
        true, // isPermanentFailure = true
        rec?.leaseToken ?? undefined,
      );

      const afterFail = await outboxStore.getRecord(record.id);
      expect(afterFail?.status).toBe('PERMANENTLY_REJECTED');
      expect(afterFail?.lastErrorCode).toBe('PERMANENT_REJECTION');
    });

    it('verifies full transactional email service dispatch and successful sent status', async () => {
      const provider = new InMemoryEmailProvider();
      const service = new TransactionalEmailService({
        provider,
        outboxStore,
        immediateDispatch: true,
      });

      const key = `test-dispatch-service-${Date.now()}`;
      const result = await service.sendClientSubmission({
        to: 'manager@example.com',
        clientName: 'Acme Client',
        requisitionTitle: 'Senior Distributed Engineer',
        candidateRef: 'CAND-7712',
        portalUrl: 'https://app.talentlens.ai/portal/submissions/sub-1',
        idempotencyKey: key,
        organizationId: orgId,
        advisoryScore: 92,
      });

      expect(result.delivered).toBe(true);

      const record = await outboxStore.getRecordByIdempotencyKey(key);
      expect(record?.status).toBe('SENT');
      expect(record?.sentAt).toBeDefined();
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.to).toBe('manager@example.com');
    });
  },
);
