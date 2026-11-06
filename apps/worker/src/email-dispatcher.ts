import { randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { decryptEmailPayload } from './email-crypto.js';
import { SmtpClient } from './smtp-client.js';

export interface EmailDispatcherProvider {
  send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
  }): Promise<{
    success: boolean;
    messageId?: string | undefined;
    error?: string | undefined;
    isPermanentFailure?: boolean | undefined;
  }>;
}

export class DefaultWorkerEmailProvider implements EmailDispatcherProvider {
  private readonly client: SmtpClient | null = null;
  private readonly fromAddress: string;
  private readonly isConfigured: boolean;

  constructor(options?: { client?: SmtpClient }) {
    this.fromAddress = process.env['EMAIL_FROM'] ?? 'no-reply@talentlens.ai';
    const host = process.env['SMTP_HOST'];
    const portStr = process.env['SMTP_PORT'] ?? '587';
    const user = process.env['SMTP_USER'];
    const pass = process.env['SMTP_PASS'];

    if (options?.client) {
      this.client = options.client;
      this.isConfigured = true;
    } else if (host && host.trim().length > 0) {
      const port = parseInt(portStr, 10) || 587;
      const secure = process.env['SMTP_SECURE'] === 'true' || port === 465;
      const requireTls = process.env['SMTP_REQUIRE_TLS'] !== 'false';
      this.client = new SmtpClient({
        host,
        port,
        secure,
        requireTls,
        auth: user && pass ? { user, pass } : undefined,
      });
      this.isConfigured = true;
    } else {
      this.isConfigured = false;
    }
  }

  public async send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
  }): Promise<{
    success: boolean;
    messageId?: string | undefined;
    error?: string | undefined;
    isPermanentFailure?: boolean | undefined;
  }> {
    const nodeEnv = process.env['NODE_ENV'];
    const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

    if (!this.isConfigured || !this.client) {
      if (isProductionOrStaging) {
        return {
          success: false,
          error: 'EMAIL_DELIVERY_NOT_CONFIGURED: Missing required SMTP_HOST in production/staging',
          isPermanentFailure: true,
        };
      }
      return {
        success: false,
        error: 'EMAIL_DELIVERY_NOT_CONFIGURED',
        isPermanentFailure: false,
      };
    }

    return this.client.send({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      idempotencyKey: message.idempotencyKey,
    });
  }
}

export interface WorkerEmailDispatcherOptions {
  workerId?: string;
  leaseDurationSeconds?: number;
  provider?: EmailDispatcherProvider;
}

export class WorkerEmailDispatcher {
  private readonly database: PrismaClient;
  public readonly workerId: string;
  public readonly leaseDurationSeconds: number;
  public readonly provider: EmailDispatcherProvider;

  constructor(
    database: PrismaClient = getDatabaseClient(),
    options: WorkerEmailDispatcherOptions = {},
  ) {
    this.database = database;
    this.workerId = options.workerId ?? `email-worker-${randomUUID()}`;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 120; // 2 minutes default lease
    this.provider = options.provider ?? new DefaultWorkerEmailProvider();
  }

  /**
   * Atomically claims and processes the next eligible pending email or expired lease.
   * Returns true if a job was processed; false if the outbox queue was empty.
   */
  public async processNextEmail(): Promise<boolean> {
    // Phase 1: Atomically claim 1 job with SELECT ... FOR UPDATE SKIP LOCKED
    const claimed = await this.database.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          attempts: number;
          max_attempts: number;
          status: string;
          recipient_email: string | null;
          subject: string | null;
          html: string | null;
          text: string | null;
          idempotency_key: string;
          message_type: string;
          encrypted_payload: string | null;
          key_id: string | null;
        }>
      >(Prisma.sql`
        SELECT id, attempts, max_attempts, status, recipient_email, subject, html, text, idempotency_key, message_type, encrypted_payload, key_id
        FROM email_outbox
        WHERE (
          (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
          OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
        )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      if (!rows || rows.length === 0 || !rows[0]) {
        return null;
      }

      const job = rows[0];

      // Recovery: If stale record already exhausted max_attempts, fail it
      if (job.attempts >= job.max_attempts) {
        await tx.emailOutbox.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            lastErrorCode: 'STALE_LEASE_EXPIRED_MAX_ATTEMPTS_EXHAUSTED',
            lastError: 'Lease expired after maximum attempts exhausted',
            leaseToken: null,
            leaseExpiresAt: null,
            lockedBy: null,
            nextAttemptAt: null,
          },
        });
        return null;
      }

      const leaseToken = randomUUID();

      await tx.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'SENDING',
            attempts = attempts + 1,
            lease_token = ${leaseToken}::uuid,
            lease_expires_at = clock_timestamp() + (${this.leaseDurationSeconds} * INTERVAL '1 second'),
            locked_by = ${this.workerId}
        WHERE id = ${job.id}::uuid
      `);

      return {
        id: job.id,
        attempts: job.attempts + 1,
        maxAttempts: job.max_attempts,
        recipientEmail: job.recipient_email,
        subject: job.subject,
        html: job.html,
        text: job.text,
        idempotencyKey: job.idempotency_key,
        encryptedPayload: job.encrypted_payload,
        keyId: job.key_id,
        leaseToken,
      };
    });

    if (!claimed) {
      return false;
    }

    // Phase 2: Decrypt payload outside database transaction
    let recipientEmail = '';
    let subject = '';
    let html = '';
    let text = '';

    if (!claimed.encryptedPayload) {
      // Quarantine legacy unencrypted record immediately without transmitting message
      await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'FAILED',
            last_error = 'Legacy unencrypted record quarantined to prevent raw token exposure',
            last_error_code = 'QUARANTINED_UNENCRYPTED_LEGACY',
            html = '[PURGED]',
            text = '[PURGED]',
            recipient_email = NULL,
            subject = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            next_attempt_at = NULL
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
      return true;
    }

    try {
      const decrypted = decryptEmailPayload(claimed.encryptedPayload, {
        recordId: claimed.id,
        idempotencyKey: claimed.idempotencyKey,
      });
      recipientEmail = decrypted.recipientEmail;
      subject = decrypted.subject;
      html = decrypted.html;
      text = decrypted.text;
    } catch {
      // Tamper or key mismatch detected: fail immediately without transmitting message
      await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'FAILED',
            last_error = 'Payload decryption or authentication tag verification failed',
            last_error_code = 'PAYLOAD_DECRYPTION_FAILED',
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            next_attempt_at = NULL
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
      return true;
    }

    // Phase 3: Send outside database transaction to prevent locking connections during network I/O
    let sendResult: {
      success: boolean;
      messageId?: string | undefined;
      error?: string | undefined;
      isPermanentFailure?: boolean | undefined;
    };

    try {
      sendResult = await this.provider.send({
        to: recipientEmail,
        subject,
        html,
        text,
        idempotencyKey: claimed.idempotencyKey,
      });
    } catch (err) {
      sendResult = {
        success: false,
        error: (err as Error)?.message ?? 'Unexpected transmission exception',
        isPermanentFailure: false,
      };
    }

    // Phase 4: Update completion status with fencing against expired leases
    if (sendResult.success) {
      const payloadJsonValue = sendResult.messageId
        ? JSON.stringify({ messageId: sendResult.messageId })
        : null;

      const updateCount = await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'SENT',
            sent_at = clock_timestamp(),
            encrypted_payload = NULL,
            recipient_email = NULL,
            subject = NULL,
            html = NULL,
            text = NULL,
            payload_json = ${payloadJsonValue}::jsonb,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            last_error = NULL,
            last_error_code = NULL
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      // If updateCount is 0, this worker's lease expired and was reclaimed by another worker
      return updateCount > 0;
    }

    // Failure path
    const isExhausted = claimed.attempts >= claimed.maxAttempts;
    const isPermanent = Boolean(sendResult.isPermanentFailure);

    if (isPermanent || isExhausted) {
      const finalStatus = isPermanent ? 'PERMANENTLY_REJECTED' : 'FAILED';
      const finalErrorCode = isPermanent ? 'PERMANENT_REJECTION' : 'MAX_ATTEMPTS_EXHAUSTED';
      const errorMsg = sendResult.error ?? 'Email delivery failed';

      await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = ${finalStatus},
            last_error = ${errorMsg},
            last_error_code = ${finalErrorCode},
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            next_attempt_at = NULL
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, up to 60s max
      const backoffSeconds = Math.min(60, Math.pow(2, claimed.attempts - 1));
      const errorMsg = sendResult.error ?? 'Transient transmission failure';

      await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'PENDING',
            last_error = ${errorMsg},
            last_error_code = 'TRANSIENT_FAILURE',
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            next_attempt_at = clock_timestamp() + (${backoffSeconds} * INTERVAL '1 second')
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
    }

    return true;
  }
}
