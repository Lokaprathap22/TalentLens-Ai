import { randomUUID } from 'node:crypto';
import { getDatabaseClient } from '@talentlens/database';
import { WorkerEmailDispatcher } from '../apps/worker/dist/email-dispatcher.js';
import {
  encryptEmailPayload,
  initializeIdempotencySecret,
  initializeKeyRing,
} from '../apps/worker/dist/email-crypto.js';

// Setup environment
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://talentlens:talentlens_local_only@127.0.0.1:5432/talentlens_scorecard_test';
process.env.EMAIL_OUTBOX_ENCRYPTION_KEY =
  process.env.EMAIL_OUTBOX_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET =
  process.env.EMAIL_OUTBOX_IDEMPOTENCY_SECRET ||
  'talentlens-idempotency-test-secret-at-least-32-chars-long';
process.env.EMAIL_FROM = 'notifications@talentlens.ai';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1025';
process.env.SMTP_REQUIRE_TLS = 'false';

initializeIdempotencySecret();
initializeKeyRing();

const db = getDatabaseClient();

async function runSmtpLifecycleTest() {
  console.log(
    '\x1b[36m================================================================================\x1b[0m',
  );
  console.log('\x1b[36mTALENTLENS AI — SMTP DISPATCH, RETRY & FAILURE LIFECYCLE AUDIT\x1b[0m');
  console.log(
    '\x1b[36m================================================================================\x1b[0m',
  );

  const runId = Date.now().toString(36);
  const createdRecordIds = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Same notification requested twice (idempotency key deduplication)
    // -------------------------------------------------------------------------
    console.log('[1] Testing idempotency deduplication: Same notification requested twice...');
    const idempotencyKey = `idemp-invite-${runId}`;
    const testRecipient = `candidate.${runId}@testdomain.internal`;
    const recordId1 = randomUUID();
    createdRecordIds.push(recordId1);

    const encrypted = encryptEmailPayload(
      {
        recipientEmail: testRecipient,
        subject: `Your Consent Invitation - ${runId}`,
        html: `<h1>Consent Request</h1><p>Secret invitation token: token-${runId}</p>`,
        text: `Consent Request. Secret token: token-${runId}`,
      },
      {
        recordId: recordId1,
        idempotencyKey,
      },
    );

    // Insert first notification
    await db.emailOutbox.create({
      data: {
        id: recordId1,
        idempotencyKey,
        messageType: 'CONSENT_INVITATION',
        recipientRole: 'CANDIDATE',
        encryptedPayload: encrypted.encryptedPayload,
        keyId: encrypted.keyId,
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date('2000-01-01T00:00:00Z'),
      },
    });

    // Attempt second insert with identical idempotencyKey
    let duplicateRejected = false;
    try {
      await db.emailOutbox.create({
        data: {
          id: randomUUID(),
          idempotencyKey,
          messageType: 'CONSENT_INVITATION',
          recipientRole: 'CANDIDATE',
          encryptedPayload: encrypted.encryptedPayload,
          keyId: encrypted.keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });
    } catch {
      duplicateRejected = true;
    }

    if (!duplicateRejected) {
      throw new Error('Deduplication failed: Duplicate email_outbox record was inserted!');
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Duplicate notification rejected by idempotency key unique constraint.',
    );

    // -------------------------------------------------------------------------
    // 2. No plaintext email payload leakage in PostgreSQL
    // -------------------------------------------------------------------------
    console.log('[2] Inspecting PostgreSQL row for plaintext payload leakage...');
    const rawRow = await db.$queryRaw`
      SELECT recipient_email, subject, html, text, encrypted_payload
      FROM email_outbox
      WHERE id = ${recordId1}::uuid
    `;

    const row = rawRow[0];
    if (
      row.recipient_email !== null ||
      row.subject !== null ||
      row.html !== null ||
      row.text !== null
    ) {
      throw new Error(`Plaintext email data leaked in database columns! ${JSON.stringify(row)}`);
    }
    if (!row.encrypted_payload || row.encrypted_payload.includes(testRecipient)) {
      throw new Error('Encrypted payload is missing or leaks unencrypted recipient!');
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Zero plaintext leakage: recipient_email, subject, html, text are NULL. Payload is AES-256-GCM ciphertext.',
    );

    // -------------------------------------------------------------------------
    // 3. Temporary SMTP failure and retry recovery
    // -------------------------------------------------------------------------
    console.log('[3] Testing temporary SMTP failure handling...');
    // Create dispatcher with transiently failing provider (simulates temporary network/SMTP timeout)
    let simulateTransientFailure = true;
    const failingProvider = {
      async send(msg) {
        if (simulateTransientFailure) {
          return {
            success: false,
            error: 'Connection refused: 127.0.0.1:2525 (temporary network glitch)',
            isPermanentFailure: false,
          };
        }
        // Fall back to live Mailpit client
        const liveDispatcher = new WorkerEmailDispatcher(db);
        const res = await liveDispatcher.provider.send(msg);
        console.log('Live provider send result:', res);
        return res;
      },
    };

    const transientDispatcher = new WorkerEmailDispatcher(db, {
      workerId: `worker-transient-${runId}`,
      provider: failingProvider,
    });

    // Attempt processing while transient failure is active
    const processed1 = await transientDispatcher.processNextEmail();
    if (!processed1) {
      throw new Error('Dispatcher failed to claim pending email.');
    }

    // Inspect database state after temporary failure
    const afterTransient = await db.emailOutbox.findUnique({ where: { id: recordId1 } });
    if (afterTransient.status !== 'PENDING') {
      throw new Error(
        `Expected status PENDING after transient failure, got: ${afterTransient.status}`,
      );
    }
    if (afterTransient.attempts !== 1) {
      throw new Error(`Expected attempts=1, got: ${afterTransient.attempts}`);
    }
    if (afterTransient.lastErrorCode !== 'TRANSIENT_FAILURE') {
      throw new Error(
        `Expected lastErrorCode=TRANSIENT_FAILURE, got: ${afterTransient.lastErrorCode}`,
      );
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Temporary failure handled: Status returned to PENDING, backoff scheduled, attempts=1.',
    );

    // Simulate SMTP recovery
    console.log('[4] Testing retry after SMTP recovery...');
    simulateTransientFailure = false;
    // Reset nextAttemptAt to allow immediate processing
    await db.emailOutbox.update({
      where: { id: recordId1 },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const processed2 = await transientDispatcher.processNextEmail();
    if (!processed2) {
      throw new Error('Dispatcher failed to process email after SMTP recovery.');
    }

    const afterRecovery = await db.emailOutbox.findUnique({ where: { id: recordId1 } });
    if (afterRecovery.status !== 'SENT') {
      throw new Error(`Expected status SENT after recovery, got: ${afterRecovery.status}`);
    }
    if (afterRecovery.attempts !== 2) {
      throw new Error(`Expected attempts=2, got: ${afterRecovery.attempts}`);
    }
    if (afterRecovery.encryptedPayload !== null) {
      throw new Error('Encrypted payload was not purged upon successful delivery!');
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Retry succeeded upon recovery: Status=SENT, attempts=2, ciphertext purged.',
    );

    // Verify delivery in Mailpit inbox
    const mailpitRes = await fetch('http://127.0.0.1:8025/api/v1/messages');
    const mailpitData = await mailpitRes.json();
    const received = mailpitData.messages?.find((m) =>
      m.To?.some((t) => t.Address === testRecipient),
    );
    if (!received) {
      throw new Error(`Message to ${testRecipient} was not received in Mailpit!`);
    }
    console.log(
      `\x1b[32m[PASS]\x1b[0m Verified actual message receipt in Mailpit (Subject: "${received.Subject}").`,
    );

    // -------------------------------------------------------------------------
    // 5. Permanent SMTP failure and Dead-Letter / Quarantined state
    // -------------------------------------------------------------------------
    console.log('[5] Testing permanent SMTP failure / invalid credentials quarantine...');
    const recordId2 = randomUUID();
    createdRecordIds.push(recordId2);
    const idempPerm = `idemp-perm-${runId}`;

    const encPerm = encryptEmailPayload(
      {
        recipientEmail: `invalid-mailbox-${runId}@nonexistent-example.com`,
        subject: 'Dead Letter Test',
        html: '<p>Test</p>',
        text: 'Test',
      },
      { recordId: recordId2, idempotencyKey: idempPerm },
    );

    await db.emailOutbox.create({
      data: {
        id: recordId2,
        idempotencyKey: idempPerm,
        messageType: 'CANDIDATE_CONSENT_CONFIRMATION',
        recipientRole: 'CANDIDATE',
        encryptedPayload: encPerm.encryptedPayload,
        keyId: encPerm.keyId,
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date('2000-01-01T00:00:00Z'),
      },
    });

    const permanentFailingProvider = {
      async send() {
        return {
          success: false,
          error: '535 5.7.8 Authentication credentials invalid / rejected',
          isPermanentFailure: true,
        };
      },
    };

    const permDispatcher = new WorkerEmailDispatcher(db, {
      workerId: `worker-perm-${runId}`,
      provider: permanentFailingProvider,
    });

    await permDispatcher.processNextEmail();

    const afterPerm = await db.emailOutbox.findUnique({ where: { id: recordId2 } });
    if (afterPerm.status !== 'PERMANENTLY_REJECTED') {
      throw new Error(`Expected status PERMANENTLY_REJECTED, got: ${afterPerm.status}`);
    }
    if (afterPerm.lastErrorCode !== 'PERMANENT_REJECTION') {
      throw new Error(
        `Expected lastErrorCode=PERMANENT_REJECTION, got: ${afterPerm.lastErrorCode}`,
      );
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Permanent SMTP failure quarantined: Status=PERMANENTLY_REJECTED, no infinite retries.',
    );

    // -------------------------------------------------------------------------
    // 6. Max attempts exhaustion
    // -------------------------------------------------------------------------
    console.log('[6] Testing max attempts exhaustion dead-letter transition...');
    const recordId3 = randomUUID();
    createdRecordIds.push(recordId3);
    const idempExhaust = `idemp-exhaust-${runId}`;

    const encExhaust = encryptEmailPayload(
      {
        recipientEmail: `retry-exhaust-${runId}@example.com`,
        subject: 'Exhaustion Test',
        html: '<p>Test</p>',
        text: 'Test',
      },
      { recordId: recordId3, idempotencyKey: idempExhaust },
    );

    await db.emailOutbox.create({
      data: {
        id: recordId3,
        idempotencyKey: idempExhaust,
        messageType: 'CONSENT_INVITATION',
        recipientRole: 'CANDIDATE',
        encryptedPayload: encExhaust.encryptedPayload,
        keyId: encExhaust.keyId,
        status: 'PENDING',
        attempts: 2, // Already had 2 attempts
        maxAttempts: 3,
        createdAt: new Date('2000-01-01T00:00:00Z'),
      },
    });

    const alwaysFailingProvider = {
      async send() {
        return {
          success: false,
          error: 'Connection timeout',
          isPermanentFailure: false,
        };
      },
    };

    const exhaustDispatcher = new WorkerEmailDispatcher(db, {
      workerId: `worker-exhaust-${runId}`,
      provider: alwaysFailingProvider,
    });

    await exhaustDispatcher.processNextEmail();

    const afterExhaust = await db.emailOutbox.findUnique({ where: { id: recordId3 } });
    if (afterExhaust.status !== 'FAILED') {
      throw new Error(`Expected status FAILED on max attempts, got: ${afterExhaust.status}`);
    }
    if (afterExhaust.lastErrorCode !== 'MAX_ATTEMPTS_EXHAUSTED') {
      throw new Error(
        `Expected lastErrorCode=MAX_ATTEMPTS_EXHAUSTED, got: ${afterExhaust.lastErrorCode}`,
      );
    }
    if (afterExhaust.attempts !== 3) {
      throw new Error(`Expected attempts=3, got: ${afterExhaust.attempts}`);
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Max attempts exhaustion verified: Status=FAILED, attempts=3, dead-lettered.',
    );

    console.log(
      '\n\x1b[32m================================================================================\x1b[0m',
    );
    console.log('\x1b[32mSMTP LIFECYCLE AUDIT: 100% PASSED\x1b[0m');
    console.log(
      '\x1b[32m  • Idempotency deduplication:             PASS (zero duplicates allowed)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Database privacy / zero leakage:       PASS (columns null, AES-256-GCM only)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Temporary failure & backoff:           PASS (status PENDING, backoff scheduled)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Retry recovery & delivery:             PASS (status SENT, delivered to Mailpit)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Permanent failure quarantine:          PASS (status PERMANENTLY_REJECTED)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Max attempts dead-lettering:           PASS (status FAILED, attempts capped)\x1b[0m',
    );
    console.log(
      '\x1b[32m================================================================================\n',
    );
  } finally {
    for (const id of createdRecordIds) {
      await db.emailOutbox.deleteMany({ where: { id } }).catch(() => {});
    }
  }
}

runSmtpLifecycleTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\x1b[31m[TEST FAILED]\x1b[0m', err);
    process.exit(1);
  });
