import { describe, expect, it } from 'vitest';
import {
  createEmailIdempotencyKey as workerCreateEmailIdempotencyKey,
  initializeIdempotencySecret as workerInitializeIdempotencySecret,
} from '../../../../worker/src/email-crypto.js';
import {
  createEmailIdempotencyKey,
  getIdempotencyHmacKey,
  initializeIdempotencySecret,
  setIdempotencySecret,
  setEncryptionKey,
} from './email.crypto.js';
import { InMemoryEmailOutboxStore } from './email.outbox.js';
import { InMemoryEmailProvider, NullEmailProvider, SmtpEmailProvider } from './email.provider.js';
import { TransactionalEmailService } from './email.service.js';
import { escapeHtml } from './email.templates.js';

describe('TransactionalEmailService & Outbox Subsystem', () => {
  describe('HTML Escaping & Sanitization', () => {
    it('escapes dangerous HTML characters in untrusted input', () => {
      const malicious = '<script>alert("XSS")</script>&\'"';
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;&amp;&#039;&quot;');
      expect(escaped).not.toContain('<script>');
    });
  });

  describe('Idempotency Key Privacy & HMAC Security', () => {
    it('generates privacy-preserving HMAC-SHA-256 keys without leaking PII', () => {
      const email = 'Candidate.Confidential@Example.COM';
      const eventId = 'req-7782-invite-1';
      const key1 = createEmailIdempotencyKey('consent_invitation', email, eventId);
      const key2 = createEmailIdempotencyKey(
        'consent_invitation',
        'candidate.confidential@example.com',
        eventId,
      );

      expect(key1).toMatch(/^consent_invitation:[a-f0-9]{32}$/);
      expect(key1).not.toContain('Candidate');
      expect(key1).not.toContain('Example');
      expect(key1).not.toContain('confidential');
      // Case-insensitive normalization yields identical key
      expect(key1).toBe(key2);
    });

    it('produces distinct digests under different HMAC secrets (keyed defense)', () => {
      const email = 'candidate@domain.com';
      const eventId = 'event-101';
      const keyA = createEmailIdempotencyKey(
        'interview',
        email,
        eventId,
        Buffer.from('secret-key-aaaa-1111-2222-3333', 'utf8'),
      );
      const keyB = createEmailIdempotencyKey(
        'interview',
        email,
        eventId,
        Buffer.from('secret-key-bbbb-4444-5555-6666', 'utf8'),
      );

      expect(keyA).not.toBe(keyB);
      expect(keyA.split(':')[0]).toBe('interview');
      expect(keyB.split(':')[0]).toBe('interview');
    });

    it('fails closed when NODE_ENV is missing at startup', () => {
      expect(() => {
        initializeIdempotencySecret({});
      }).toThrowError(/NODE_ENV is required and must be explicitly set/);
    });

    it('fails closed when NODE_ENV is invalid at startup', () => {
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'invalid_env' as unknown as NodeJS.ProcessEnv['NODE_ENV'],
        });
      }).toThrowError(/Invalid NODE_ENV "invalid_env"/);
    });

    it('fails closed in production when EMAIL_OUTBOX_IDEMPOTENCY_SECRET is missing', () => {
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
        });
      }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);
    });

    it('fails closed in staging when EMAIL_OUTBOX_IDEMPOTENCY_SECRET is missing', () => {
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'staging',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: '',
        });
      }).toThrowError(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET is required in production and staging/);
    });

    it('fails closed in production or staging when secret has insufficient entropy/length (< 32 bytes)', () => {
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'short-insecure-secret',
        });
      }).toThrowError(/must be at least 32 bytes/);

      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'staging',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'short-insecure-secret',
        });
      }).toThrowError(/must be at least 32 bytes/);
    });

    it('succeeds in production when valid dedicated secret is configured', () => {
      const validHexSecret = 'a'.repeat(64); // 32 bytes in hex
      expect(() => {
        initializeIdempotencySecret({
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: validHexSecret,
        });
      }).not.toThrow();

      expect(getIdempotencyHmacKey().toString('hex')).toBe(validHexSecret);
    });

    it('ensures development and test behavior is explicitly isolated and deterministic', () => {
      initializeIdempotencySecret({ NODE_ENV: 'development' });
      const devKey = getIdempotencyHmacKey();

      initializeIdempotencySecret({ NODE_ENV: 'test' });
      const testKey = getIdempotencyHmacKey();

      expect(devKey.length).toBe(32);
      expect(testKey.length).toBe(32);
      expect(devKey).toEqual(testKey);
    });

    it('guarantees HMAC key generation is stable for identical inputs and distinct for different inputs', () => {
      const email = 'candidate@domain.com';
      const key1 = createEmailIdempotencyKey('invite', email, 'event-1');
      const key2 = createEmailIdempotencyKey('invite', email, 'event-1');
      const keyDiffEvent = createEmailIdempotencyKey('invite', email, 'event-2');
      const keyDiffEmail = createEmailIdempotencyKey('invite', 'other@domain.com', 'event-1');

      expect(key1).toBe(key2);
      expect(key1).not.toBe(keyDiffEvent);
      expect(key1).not.toBe(keyDiffEmail);
    });

    it('proves changing the HMAC secret changes the generated idempotency key', () => {
      const secretA = Buffer.from('1'.repeat(32), 'utf8');
      const secretB = Buffer.from('2'.repeat(32), 'utf8');
      const keyA = createEmailIdempotencyKey('invite', 'candidate@domain.com', 'event-1', secretA);
      const keyB = createEmailIdempotencyKey('invite', 'candidate@domain.com', 'event-1', secretB);

      expect(keyA).not.toBe(keyB);
    });

    it('ensures HMAC behavior is independent of AES payload encryption key rotation (no fallback to encryption keyring)', () => {
      const fixedSecret = Buffer.from('my-stable-idempotency-secret-32b', 'utf8');
      setIdempotencySecret(fixedSecret);

      const beforeRotation = createEmailIdempotencyKey('invite', 'cand@domain.com', 'event-1');

      // Rotate/change AES payload encryption key in keyring
      const newAesKey = Buffer.from('9'.repeat(32), 'utf8');
      setEncryptionKey('v2', newAesKey);

      const afterRotation = createEmailIdempotencyKey('invite', 'cand@domain.com', 'event-1');
      expect(afterRotation).toBe(beforeRotation);

      // Reset back to test configuration
      initializeIdempotencySecret({ NODE_ENV: 'test' });
    });

    it('maintains strict parity between API and worker idempotency key generation', () => {
      const secretHex = 'f'.repeat(64);
      initializeIdempotencySecret({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: secretHex,
      });
      workerInitializeIdempotencySecret({
        NODE_ENV: 'production',
        EMAIL_OUTBOX_IDEMPOTENCY_SECRET: secretHex,
      });

      const testCases = [
        { prefix: 'consent_invitation', email: 'User.One@TalentLens.AI', event: 'event-uuid-123' },
        { prefix: 'consent_withdrawal', email: 'Candidate@Company.com', event: 'req-456-cand-789' },
        { prefix: 'interview_invitation', email: 'interviewer@client.org', event: 'slot-1' },
      ];

      for (const { prefix, email, event } of testCases) {
        const apiKey = createEmailIdempotencyKey(prefix, email, event);
        const workerKey = workerCreateEmailIdempotencyKey(prefix, email, event);
        expect(apiKey).toBe(workerKey);
        expect(apiKey).toMatch(new RegExp(`^${prefix}:[a-f0-9]{32}$`));
      }

      // Reset back to test configuration
      initializeIdempotencySecret({ NODE_ENV: 'test' });
      workerInitializeIdempotencySecret({ NODE_ENV: 'test' });
    });
  });

  describe('Email Providers', () => {
    it('NullEmailProvider returns controlled EMAIL_DELIVERY_NOT_CONFIGURED error without throwing', async () => {
      const provider = new NullEmailProvider();
      const result = await provider.send();

      expect(result.success).toBe(false);
      expect(result.error).toBe('EMAIL_DELIVERY_NOT_CONFIGURED');
      expect(result.isPermanentFailure).toBe(false);
    });

    it('InMemoryEmailProvider collects sent messages', async () => {
      const provider = new InMemoryEmailProvider();
      const result = await provider.send({
        to: 'candidate@example.com',
        subject: 'Consent Request',
        html: '<p>Consent</p>',
        text: 'Consent',
        idempotencyKey: 'key-1',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]?.to).toBe('candidate@example.com');
    });

    it('InMemoryEmailProvider handles simulated failures and permanent rejections', async () => {
      const provider = new InMemoryEmailProvider();
      provider.shouldFail = true;
      provider.isPermanentFailure = true;
      provider.failureErrorMessage = '550 User unknown';

      const result = await provider.send({
        to: 'invalid@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('550 User unknown');
      expect(result.isPermanentFailure).toBe(true);
    });

    it('InMemoryEmailProvider handles provider timeouts', async () => {
      const provider = new InMemoryEmailProvider();
      provider.shouldTimeout = true;
      provider.timeoutMs = 10;

      const result = await provider.send({
        to: 'candidate@example.com',
        subject: 'Timeout Test',
        html: '<p>Test</p>',
        text: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('PROVIDER_TIMEOUT');
    });

    it('SmtpEmailProvider reports missing configuration gracefully', async () => {
      const provider = new SmtpEmailProvider({
        host: '',
        port: 587,
        fromAddress: 'no-reply@talentlens.ai',
      });

      const result = await provider.send({
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('EMAIL_DELIVERY_NOT_CONFIGURED');
      expect(result.isPermanentFailure).toBe(true);
    });
  });

  describe('TransactionalEmailService Delivery & Outbox', () => {
    it('dispatches consent invitation and marks outbox record SENT when provider succeeds', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const expiry = new Date(Date.now() + 86400000);
      const result = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        candidateName: 'Jane <Dev> Doe',
        organizationName: 'Acme & Co.',
        requisitionTitle: 'Senior Platform Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=mock-secret-raw-token',
        expiresAt: expiry,
      });

      expect(result.delivered).toBe(true);
      expect(provider.sentMessages).toHaveLength(1);

      const sentMsg = provider.sentMessages[0]!;
      expect(sentMsg.to).toBe('candidate@example.com');
      expect(sentMsg.subject).toContain('Senior Platform Engineer');
      expect(sentMsg.html).toContain('Jane &lt;Dev&gt; Doe');
      expect(sentMsg.html).toContain('Acme &amp; Co.');
      expect(sentMsg.html).toContain(
        'https://app.talentlens.ai/consent#token=mock-secret-raw-token',
      );

      const records = await outboxStore.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('SENT');
      expect(records[0]?.attempts).toBe(1);
      expect(records[0]?.sentAt).toBeDefined();
    });

    it('dispatches existing outbox record directly without creating duplicate outbox entry when outboxRecordId is provided', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      // Simulate repository already enqueued record inside business transaction
      const { record: preEnqueued } = await outboxStore.enqueue({
        idempotencyKey: 'idemp-pre-enqueued-1',
        template: 'consent_invitation',
        recipientEmail: 'candidate@example.com',
        recipientRole: 'CANDIDATE',
        subject: 'Pre-enqueued invitation',
        html: '<p>Invitation</p>',
        text: 'Invitation',
      });

      expect(await outboxStore.listRecords()).toHaveLength(1);

      // Now service is called with outboxRecordId
      const result = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        organizationName: 'Acme',
        requisitionTitle: 'Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=tok',
        expiresAt: new Date(Date.now() + 86400000),
        outboxRecordId: preEnqueued.id,
      });

      expect(result.delivered).toBe(true);
      // Still exactly 1 outbox record — no duplicate enqueue!
      const records = await outboxStore.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.id).toBe(preEnqueued.id);
      expect(records[0]?.status).toBe('SENT');
      expect(provider.sentMessages).toHaveLength(1);
    });

    it('records FAILED status and schedules exponential retry on provider failure', async () => {
      const provider = new InMemoryEmailProvider();
      provider.shouldFail = true;
      provider.failureErrorMessage = 'SMTP 421 Service unavailable, try again later';

      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const result = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=tok1',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('SMTP 421');

      const records = await outboxStore.listRecords();
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.status).toBe('PENDING'); // scheduled for retry
      expect(record.attempts).toBe(1);
      expect(record.lastError).toBe('SMTP 421 Service unavailable, try again later');
      expect(record.nextAttemptAt).toBeDefined();

      const nextAttemptTime = new Date(record.nextAttemptAt!).getTime();
      const expectedMinTime = Date.now() + 900; // ~1s backoff for attempt 1
      expect(nextAttemptTime).toBeGreaterThanOrEqual(expectedMinTime);
    });

    it('marks record PERMANENTLY_REJECTED immediately on permanent rejection without scheduling retry', async () => {
      const provider = new InMemoryEmailProvider();
      provider.shouldFail = true;
      provider.isPermanentFailure = true;
      provider.failureErrorMessage = '550 5.1.1 Recipient address rejected';

      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const result = await service.sendConsentInvitation({
        to: 'invalid@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=tok2',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);

      const records = await outboxStore.listRecords();
      expect(records[0]?.status).toBe('PERMANENTLY_REJECTED');
      expect(records[0]?.nextAttemptAt).toBeUndefined();
    });

    it('enforces idempotency preventing duplicate email enqueues', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const payload = {
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=identical-token',
        expiresAt: new Date(Date.now() + 86400000),
      };

      await service.sendConsentInvitation(payload);
      await service.sendConsentInvitation(payload);

      const records = await outboxStore.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.attempts).toBe(1);
    });

    it('dispatches client submission notifications with demographic privacy protection', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const result = await service.sendClientSubmission({
        to: 'hiring-manager@client.com',
        clientName: 'FinTech Alpha',
        requisitionTitle: 'Senior Backend Engineer',
        candidateRef: 'CAND-9921',
        portalUrl: 'https://app.talentlens.ai/portal/submissions/sub-1',
        advisoryScore: 88,
      });

      expect(result.delivered).toBe(true);
      expect(provider.sentMessages).toHaveLength(1);

      const msg = provider.sentMessages[0]!;
      expect(msg.subject).toBe('New Candidate Submitted: CAND-9921 for Senior Backend Engineer');
      expect(msg.html).toContain('Protected demographic details are masked');
      expect(msg.html).toContain('Advisory Match Score:');
      expect(msg.html).toContain('88%');
    });

    it('dispatches client feedback notifications to recruiters', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      const result = await service.sendClientFeedback({
        to: 'recruiter@talentlens.ai',
        recruiterName: 'Alex Recruiter',
        requisitionTitle: 'Senior Platform Engineer',
        candidateCode: 'CAND-4412',
        decision: 'SHORTLIST',
        reason: 'Strong distributed systems background and excellent communication.',
        dashboardUrl: 'https://app.talentlens.ai/requisitions/req-1/candidates/cand-1',
      });

      expect(result.delivered).toBe(true);
      expect(provider.sentMessages).toHaveLength(1);

      const msg = provider.sentMessages[0]!;
      expect(msg.subject).toContain('Client Feedback Received: CAND-4412 (Shortlisted)');
      expect(msg.html).toContain('Alex Recruiter');
      expect(msg.html).toContain('Strong distributed systems background');
    });

    it('processes batch dispatch for pending items', async () => {
      const provider = new InMemoryEmailProvider();
      const outboxStore = new InMemoryEmailOutboxStore();
      // create service with immediateDispatch = false to queue in outbox
      const service = new TransactionalEmailService({
        provider,
        outboxStore,
        immediateDispatch: false,
      });

      await service.sendConsentInvitation({
        to: 'batch1@example.com',
        organizationName: 'Acme',
        requisitionTitle: 'Req 1',
        invitationUrl: 'https://app.talentlens.ai/consent#token=batch1',
        expiresAt: new Date(Date.now() + 86400000),
      });

      await service.sendConsentInvitation({
        to: 'batch2@example.com',
        organizationName: 'Acme',
        requisitionTitle: 'Req 2',
        invitationUrl: 'https://app.talentlens.ai/consent#token=batch2',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(provider.sentMessages).toHaveLength(0);

      const batchResult = await service.dispatchNextBatch(10);
      expect(batchResult.processed).toBe(2);
      expect(batchResult.succeeded).toBe(2);
      expect(provider.sentMessages).toHaveLength(2);
    });

    it('supports manual retry for failed records', async () => {
      const provider = new InMemoryEmailProvider();
      provider.shouldFail = true;
      const outboxStore = new InMemoryEmailOutboxStore();
      const service = new TransactionalEmailService({ provider, outboxStore });

      await service.sendConsentInvitation({
        to: 'retry@example.com',
        organizationName: 'Acme',
        requisitionTitle: 'Req 1',
        invitationUrl: 'https://app.talentlens.ai/consent#token=retry1',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const records = await outboxStore.listRecords();
      expect(records[0]?.attempts).toBe(1);

      // Now fix provider and perform manual retry
      provider.shouldFail = false;
      const retryResult = await service.retryEmail(records[0]!.id);

      expect(retryResult.delivered).toBe(true);
      const updated = await outboxStore.getRecord(records[0]!.id);
      expect(updated?.status).toBe('SENT');
    });
  });
});
