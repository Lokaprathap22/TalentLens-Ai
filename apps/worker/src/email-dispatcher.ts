import { randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { decryptEmailPayload } from './email-crypto.js';
import { SmtpClient } from './smtp-client.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  private async cancelAndRedactLeasedRecord(
    id: string,
    leaseToken: string,
    errorReason: string,
    eraseMetadata = false,
  ): Promise<void> {
    if (eraseMetadata) {
      const erasedAtIso = new Date().toISOString();
      await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'FAILED',
            last_error = ${errorReason},
            last_error_code = 'CANDIDATE_DELETION_PENDING',
            idempotency_key = 'erased:' || id::text,
            encrypted_payload = NULL,
            key_id = NULL,
            recipient_email = NULL,
            subject = NULL,
            html = NULL,
            text = NULL,
            payload_json = jsonb_build_object('erased', true, 'erasedAt', ${erasedAtIso}::text),
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            next_attempt_at = NULL,
            updated_at = NOW()
        WHERE id = ${id}::uuid
          AND lease_token = ${leaseToken}::uuid
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
      `);
      return;
    }

    await this.database.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'FAILED',
          last_error = ${errorReason},
          last_error_code = 'CANDIDATE_DELETION_PENDING',
          encrypted_payload = NULL,
          key_id = NULL,
          recipient_email = NULL,
          subject = NULL,
          html = NULL,
          text = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_by = NULL,
          next_attempt_at = NULL,
          updated_at = NOW()
      WHERE id = ${id}::uuid
        AND lease_token = ${leaseToken}::uuid
        AND status = 'SENDING'
        AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
    `);
  }

  private async verifyPreTransmissionState(
    claimedId: string,
    leaseToken: string,
    candidateIdFromPayload?: string,
  ): Promise<{ allow: boolean; handled: boolean }> {
    if (candidateIdFromPayload) {
      let isCandidateActive = false;
      let candidateLookupFailed = false;

      if (!UUID_REGEX.test(candidateIdFromPayload)) {
        isCandidateActive = false;
      } else {
        try {
          const candidateRows = await this.database.$queryRaw<
            Array<{ record_status: string }>
          >(Prisma.sql`
            SELECT record_status FROM "candidates" WHERE id = ${candidateIdFromPayload}::uuid
          `);
          isCandidateActive =
            candidateRows.length > 0 && candidateRows[0]?.record_status === 'ACTIVE';
        } catch {
          // Database status lookup error: FAIL CLOSED
          candidateLookupFailed = true;
        }
      }

      if (candidateLookupFailed || !isCandidateActive) {
        const errorReason = candidateLookupFailed
          ? 'Database candidate status lookup failed; failing closed to prevent unauthorized email dispatch'
          : 'Candidate does not exist or is not active (deletion in progress or completed); email cancelled and erased to protect candidate privacy';
        await this.cancelAndRedactLeasedRecord(
          claimedId,
          leaseToken,
          errorReason,
          !candidateLookupFailed,
        );
        return { allow: false, handled: true };
      }
    }

    try {
      const outboxRows = await this.database.$queryRaw<
        Array<{
          status: string;
          lease_token: string | null;
          last_error_code: string | null;
          lease_valid: boolean;
          is_erased: boolean;
        }>
      >(Prisma.sql`
        SELECT
          status::text AS status,
          lease_token::text AS lease_token,
          last_error_code,
          (lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()) AS lease_valid,
          COALESCE((payload_json->>'erased')::boolean, false) AS is_erased
        FROM email_outbox
        WHERE id = ${claimedId}::uuid
      `);

      const current = outboxRows[0];
      if (
        !current ||
        current.status !== 'SENDING' ||
        current.lease_token !== leaseToken ||
        current.last_error_code === 'CANDIDATE_DELETION_PENDING' ||
        current.is_erased ||
        !current.lease_valid
      ) {
        return { allow: false, handled: false };
      }
    } catch {
      return { allow: false, handled: false };
    }

    return { allow: true, handled: false };
  }

  /**
   * Atomically claims and processes the next eligible pending email or expired lease.
   * Returns true if a job was processed or retired; false if the outbox queue was empty or fenced.
   */
  public async processNextEmail(): Promise<boolean> {
    interface ClaimedOutboxJob {
      id: string;
      attempts: number;
      maxAttempts: number;
      recipientEmail: string | null;
      subject: string | null;
      html: string | null;
      text: string | null;
      idempotencyKey: string;
      encryptedPayload: string | null;
      keyId: string | null;
      payloadJson: Prisma.JsonValue | null;
      leaseToken: string;
    }

    // Phase 1: Atomically claim 1 job enforcing Global Lock Order:
    // candidates FOR UPDATE -> email_outbox FOR UPDATE SKIP LOCKED
    const skippedIds: string[] = [];
    const maxIterations = 100;
    let claimed: ClaimedOutboxJob | null = null;
    let cancelledInClaimPhase = false;

    for (let iter = 0; iter < maxIterations; iter += 1) {
      const step = await this.database.$transaction(async (tx) => {
        const excludeClause =
          skippedIds.length > 0
            ? Prisma.sql`AND id NOT IN (${Prisma.join(skippedIds.map((id) => Prisma.sql`${id}::uuid`))})`
            : Prisma.empty;

        const peekRows = await tx.$queryRaw<
          Array<{ id: string; candidate_id: string | null }>
        >(Prisma.sql`
          SELECT id, payload_json->>'candidateId' AS candidate_id
          FROM email_outbox
          WHERE (
            (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
            OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
          )
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
          ${excludeClause}
          ORDER BY created_at ASC
          LIMIT 1
        `);

        const peek = peekRows[0];
        if (!peek) {
          return { kind: 'empty' as const };
        }

        if (peek.candidate_id) {
          let isCandidateActive = false;
          if (UUID_REGEX.test(peek.candidate_id)) {
            const candidateRows = await tx.$queryRaw<Array<{ record_status: string }>>(Prisma.sql`
              SELECT record_status
              FROM "candidates"
              WHERE id = ${peek.candidate_id}::uuid
              FOR UPDATE
            `);
            isCandidateActive = candidateRows[0]?.record_status === 'ACTIVE';
          }

          if (!isCandidateActive) {
            const lockedForCancel = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              SELECT id
              FROM email_outbox
              WHERE id = ${peek.id}::uuid
                AND (
                  (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                  OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
                )
                AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
                AND COALESCE((payload_json->>'erased')::boolean, false) = false
              FOR UPDATE SKIP LOCKED
            `);

            if (lockedForCancel.length > 0) {
              const erasedAtIso = new Date().toISOString();
              await tx.$executeRaw(Prisma.sql`
                UPDATE email_outbox
                SET status = 'FAILED',
                    last_error = 'Candidate does not exist or is not active (deletion in progress or completed); email cancelled and erased to protect candidate privacy',
                    last_error_code = 'CANDIDATE_DELETION_PENDING',
                    idempotency_key = 'erased:' || id::text,
                    encrypted_payload = NULL,
                    key_id = NULL,
                    recipient_email = NULL,
                    subject = NULL,
                    html = NULL,
                    text = NULL,
                    payload_json = jsonb_build_object('erased', true, 'erasedAt', ${erasedAtIso}::text),
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    locked_by = NULL,
                    next_attempt_at = NULL,
                    updated_at = NOW()
                WHERE id = ${peek.id}::uuid
              `);
              return { kind: 'cancelled' as const };
            }

            return { kind: 'skip' as const, id: peek.id };
          }
        }

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
            payload_json: Prisma.JsonValue | null;
          }>
        >(Prisma.sql`
          SELECT id, attempts, max_attempts, status, recipient_email, subject, html, text, idempotency_key, message_type, encrypted_payload, key_id, payload_json
          FROM email_outbox
          WHERE id = ${peek.id}::uuid
            AND (
              (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
              OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
            )
            AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
            AND COALESCE((payload_json->>'erased')::boolean, false) = false
          FOR UPDATE SKIP LOCKED
        `);

        const job = rows[0];
        if (!job) {
          return { kind: 'skip' as const, id: peek.id };
        }

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
          return { kind: 'skip' as const, id: peek.id };
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
          kind: 'claimed' as const,
          claimed: {
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
            payloadJson: job.payload_json,
            leaseToken,
          },
        };
      });

      if (step.kind === 'empty') {
        break;
      }
      if (step.kind === 'cancelled') {
        cancelledInClaimPhase = true;
        break;
      }
      if (step.kind === 'skip') {
        skippedIds.push(step.id);
        continue;
      }
      claimed = step.claimed;
      break;
    }

    if (cancelledInClaimPhase) {
      return true;
    }

    if (!claimed) {
      return false;
    }

    let candidateIdFromPayload: string | undefined;
    if (claimed.payloadJson && typeof claimed.payloadJson === 'object') {
      const payloadObj = claimed.payloadJson as Record<string, unknown>;
      if (typeof payloadObj['candidateId'] === 'string' && payloadObj['candidateId'].trim()) {
        candidateIdFromPayload = payloadObj['candidateId'].trim();
      }
    }

    // Non-locking pre-decrypt verification of candidate lifecycle and outbox lease state
    const preDecrypt = await this.verifyPreTransmissionState(
      claimed.id,
      claimed.leaseToken,
      candidateIdFromPayload,
    );
    if (!preDecrypt.allow) {
      return preDecrypt.handled;
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
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
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
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
      return true;
    }

    // Final non-locking pre-send check immediately prior to external SMTP handoff
    const preSend = await this.verifyPreTransmissionState(
      claimed.id,
      claimed.leaseToken,
      candidateIdFromPayload,
    );
    if (!preSend.allow) {
      return preSend.handled;
    }

    // Phase 3: Send outside database transaction to prevent locking connections during network I/O.
    // EXTERNAL IRREVERSIBLE BOUNDARY: Once handed to SMTP / external transport here, transmitted
    // emails cannot be recalled if deletion begins during network transit; Phase 4 remains fenced
    // so deletion cancellation state is never overwritten.
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

    // Phase 4: Update completion status with fencing against expired leases and candidate deletion
    if (sendResult.success) {
      const updateCount = await this.database.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'SENT',
            sent_at = clock_timestamp(),
            encrypted_payload = NULL,
            key_id = NULL,
            recipient_email = NULL,
            subject = NULL,
            html = NULL,
            text = NULL,
            payload_json = CASE
              WHEN ${sendResult.messageId ?? null}::text IS NOT NULL
                THEN COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object('messageId', ${sendResult.messageId ?? null}::text)
              ELSE payload_json
            END,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            last_error = NULL,
            last_error_code = NULL
        WHERE id = ${claimed.id}::uuid
          AND lease_token = ${claimed.leaseToken}::uuid
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      // If updateCount is 0, this worker's lease expired or was fenced by deletion
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
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
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
          AND status = 'SENDING'
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
          AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
      `);
    }

    return true;
  }
}
