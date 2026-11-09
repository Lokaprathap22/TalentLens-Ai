import { randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { decryptEmailPayload, encryptEmailPayload } from './email.crypto.js';
import type {
  EmailTemplateType,
  EnqueueEmailInput,
  OutboxRecord,
  OutboxStatus,
  RecipientRole,
} from './email.types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmailOutboxStore {
  enqueue(
    input: EnqueueEmailInput,
    tx?: Prisma.TransactionClient | unknown,
  ): Promise<{ record: OutboxRecord; isDuplicate: boolean }>;
  getNextPending(limit?: number): Promise<OutboxRecord[]>;
  claimForDispatch?(
    workerId: string,
    limit?: number,
    leaseDurationSeconds?: number,
  ): Promise<OutboxRecord[]>;
  markSending(id: string, workerId?: string, leaseDurationSeconds?: number): Promise<boolean>;
  markSent(id: string, messageId?: string, leaseToken?: string): Promise<void>;
  markFailed(
    id: string,
    error: string,
    isPermanentFailure?: boolean,
    leaseToken?: string,
  ): Promise<void>;
  getRecord(id: string): Promise<OutboxRecord | null>;
  getRecordByIdempotencyKey(key: string): Promise<OutboxRecord | null>;
  listRecords(filter?: {
    status?: OutboxStatus | undefined;
    recipient?: string | undefined;
    organizationId?: string | undefined;
  }): Promise<OutboxRecord[]>;
  manualRetry(id: string): Promise<OutboxRecord | null>;
  clear(): Promise<void>;
}

export class InMemoryEmailOutboxStore implements EmailOutboxStore {
  private records = new Map<string, OutboxRecord>();
  private idempotencyIndex = new Map<string, string>();

  public async enqueue(
    input: EnqueueEmailInput,
  ): Promise<{ record: OutboxRecord; isDuplicate: boolean }> {
    const existingId = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) {
        return { record: existing, isDuplicate: true };
      }
    }

    const id = `outbox-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const record: OutboxRecord = {
      id,
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      template: input.template,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      recipientRole: input.recipientRole,
      subject: input.subject,
      html: input.html,
      text: input.text,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };

    this.records.set(id, record);
    this.idempotencyIndex.set(input.idempotencyKey, id);

    return { record, isDuplicate: false };
  }

  public async getNextPending(limit = 10): Promise<OutboxRecord[]> {
    const now = Date.now();
    const pending: OutboxRecord[] = [];

    for (const record of this.records.values()) {
      if (record.status !== 'PENDING') {
        continue;
      }
      if (
        record.lastErrorCode === 'CANDIDATE_DELETION_PENDING' ||
        record.metadata?.['erased'] === true
      ) {
        continue;
      }
      if (record.nextAttemptAt && new Date(record.nextAttemptAt).getTime() > now) {
        continue;
      }
      pending.push(record);
      if (pending.length >= limit) {
        break;
      }
    }

    return pending;
  }

  public async claimForDispatch(
    workerId: string,
    limit = 10,
    leaseDurationSeconds = 120,
  ): Promise<OutboxRecord[]> {
    const eligible = await this.getNextPending(limit);
    const claimed: OutboxRecord[] = [];

    for (const record of eligible) {
      const leaseToken = randomUUID();
      record.status = 'SENDING';
      record.attempts += 1;
      record.lastAttemptAt = new Date().toISOString();
      record.leaseToken = leaseToken;
      record.leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000).toISOString();
      record.lockedBy = workerId;
      claimed.push({ ...record });
    }

    return claimed;
  }

  public async markSending(
    id: string,
    workerId?: string,
    leaseDurationSeconds = 120,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (
      !record ||
      record.status === 'SENT' ||
      record.status === 'PERMANENTLY_REJECTED' ||
      record.lastErrorCode === 'CANDIDATE_DELETION_PENDING' ||
      record.metadata?.['erased'] === true ||
      (!record.recipientEmail && record.status === 'FAILED')
    ) {
      return false;
    }

    record.status = 'SENDING';
    record.attempts += 1;
    record.lastAttemptAt = new Date().toISOString();
    record.leaseToken = randomUUID();
    record.leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000).toISOString();
    if (workerId) {
      record.lockedBy = workerId;
    }
    return true;
  }

  public async markSent(id: string, messageId?: string, leaseToken?: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (record.status !== 'SENDING') return;
    if (
      record.lastErrorCode === 'CANDIDATE_DELETION_PENDING' ||
      record.metadata?.['erased'] === true
    ) {
      return;
    }

    if (leaseToken && record.leaseToken && record.leaseToken !== leaseToken) {
      return; // Fenced stale worker
    }

    if (record.leaseExpiresAt && new Date(record.leaseExpiresAt).getTime() <= Date.now()) {
      return; // Expired lease
    }

    record.status = 'SENT';
    record.sentAt = new Date().toISOString();
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    record.lockedBy = null;
    record.lastError = undefined;
    if (messageId) {
      record.metadata = { ...(record.metadata ?? {}), messageId };
    }
  }

  public async markFailed(
    id: string,
    error: string,
    isPermanentFailure = false,
    leaseToken?: string,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (
      record.status !== 'SENDING' ||
      record.lastErrorCode === 'CANDIDATE_DELETION_PENDING' ||
      record.metadata?.['erased'] === true
    ) {
      return;
    }

    if (leaseToken && record.leaseToken && record.leaseToken !== leaseToken) {
      return; // Fenced stale worker
    }

    record.lastError = error;

    if (isPermanentFailure || record.attempts >= record.maxAttempts) {
      record.status = isPermanentFailure ? 'PERMANENTLY_REJECTED' : 'FAILED';
      record.nextAttemptAt = undefined;
    } else {
      // Exponential backoff: 1s, 2s, 4s, up to 60s max
      const backoffMs = Math.min(60000, 1000 * Math.pow(2, record.attempts - 1));
      record.status = 'PENDING';
      record.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
    }
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    record.lockedBy = null;
  }

  public async getRecord(id: string): Promise<OutboxRecord | null> {
    return this.records.get(id) ?? null;
  }

  public async getRecordByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    const id = this.idempotencyIndex.get(key);
    return id ? (this.records.get(id) ?? null) : null;
  }

  public async listRecords(filter?: {
    status?: OutboxStatus | undefined;
    recipient?: string | undefined;
    organizationId?: string | undefined;
  }): Promise<OutboxRecord[]> {
    let list = Array.from(this.records.values());

    if (filter?.status) {
      list = list.filter((r) => r.status === filter.status);
    }
    if (filter?.recipient) {
      const target = filter.recipient.trim().toLowerCase();
      list = list.filter((r) => r.recipientEmail.includes(target));
    }
    if (filter?.organizationId) {
      list = list.filter((r) => r.organizationId === filter.organizationId);
    }

    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public async manualRetry(id: string): Promise<OutboxRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;

    if (
      record.status === 'SENT' ||
      record.status === 'PERMANENTLY_REJECTED' ||
      record.status === 'SENDING' ||
      record.lastErrorCode === 'CANDIDATE_DELETION_PENDING' ||
      record.metadata?.['erased'] === true ||
      !record.recipientEmail
    ) {
      return null;
    }

    record.status = 'PENDING';
    record.attempts = 0;
    record.lastError = undefined;
    record.nextAttemptAt = undefined;
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    record.lockedBy = null;
    return record;
  }

  public async clear(): Promise<void> {
    this.records.clear();
    this.idempotencyIndex.clear();
  }
}

/**
 * PostgreSQL-backed durable transactional outbox store.
 * Survives API/worker restarts, multiple instances, and temporary SMTP outages.
 */
export class PostgresEmailOutboxStore implements EmailOutboxStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient = getDatabaseClient()) {
    this.database = database;
  }

  private mapPrismaRecord(row: {
    id: string;
    organizationId: string | null;
    idempotencyKey: string;
    messageType: string;
    recipientEmail: string | null;
    recipientRole: string;
    subject: string | null;
    html: string | null;
    text: string | null;
    payloadJson: Prisma.JsonValue | null;
    encryptedPayload?: string | null;
    keyId?: string | null;
    status: string;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: Date | null;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
    lockedBy: string | null;
    lastError: string | null;
    lastErrorCode: string | null;
    sentAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): OutboxRecord {
    let recipientEmail = row.recipientEmail ?? '';
    let subject = row.subject ?? '';
    let html = row.html ?? '';
    let text = row.text ?? '';
    let metadata = (row.payloadJson as Record<string, unknown>) ?? undefined;

    if (row.encryptedPayload) {
      try {
        const decrypted = decryptEmailPayload(row.encryptedPayload, {
          recordId: row.id,
          idempotencyKey: row.idempotencyKey,
        });
        recipientEmail = decrypted.recipientEmail;
        subject = decrypted.subject;
        html = decrypted.html;
        text = decrypted.text;
        metadata = decrypted.metadata ?? metadata;
      } catch {
        // If decryption fails, leave fields as fallback
      }
    }

    return {
      id: row.id,
      organizationId: row.organizationId,
      idempotencyKey: row.idempotencyKey,
      template: row.messageType as EmailTemplateType,
      recipientEmail,
      recipientRole: row.recipientRole as RecipientRole,
      subject,
      html,
      text,
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : undefined,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : undefined,
      lockedBy: row.lockedBy,
      lastError: row.lastError ?? undefined,
      lastErrorCode: row.lastErrorCode ?? undefined,
      sentAt: row.sentAt ? row.sentAt.toISOString() : undefined,
      createdAt: row.createdAt.toISOString(),
      metadata,
    };
  }

  public async enqueue(
    input: EnqueueEmailInput,
    tx?: Prisma.TransactionClient | unknown,
  ): Promise<{ record: OutboxRecord; isDuplicate: boolean }> {
    const client = (tx as Prisma.TransactionClient) ?? this.database;

    // Fast check for duplicate idempotency key
    const existing = await client.emailOutbox.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return { record: this.mapPrismaRecord(existing), isDuplicate: true };
    }

    const id = randomUUID();
    const { encryptedPayload, keyId } = encryptEmailPayload(
      {
        recipientEmail: input.recipientEmail.trim().toLowerCase(),
        subject: input.subject,
        html: input.html,
        text: input.text,
        metadata: input.metadata,
      },
      { recordId: id, idempotencyKey: input.idempotencyKey },
    );

    const rawCandidateId = input.metadata?.['candidateId'];
    const candidateId =
      typeof rawCandidateId === 'string' && rawCandidateId.trim().length > 0
        ? rawCandidateId.trim()
        : undefined;

    try {
      const created = await client.emailOutbox.create({
        data: {
          id,
          organizationId: input.organizationId ?? null,
          idempotencyKey: input.idempotencyKey,
          messageType: input.template,
          recipientEmail: null,
          recipientRole: input.recipientRole,
          subject: null,
          html: null,
          text: null,
          payloadJson: candidateId ? ({ candidateId } as Prisma.InputJsonValue) : Prisma.DbNull,
          encryptedPayload,
          keyId,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
        },
      });

      return { record: this.mapPrismaRecord(created), isDuplicate: false };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const raceExisting = await client.emailOutbox.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (raceExisting) {
          return { record: this.mapPrismaRecord(raceExisting), isDuplicate: true };
        }
      }
      throw err;
    }
  }

  public async getNextPending(limit = 10): Promise<OutboxRecord[]> {
    const rows = await this.database.emailOutbox.findMany({
      where: {
        status: 'PENDING',
        encryptedPayload: { not: null },
        OR: [{ lastErrorCode: null }, { lastErrorCode: { not: 'CANDIDATE_DELETION_PENDING' } }],
        AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return rows
      .filter((r) => {
        const pj = r.payloadJson as Record<string, unknown> | null;
        return pj?.['erased'] !== true;
      })
      .map((r) => this.mapPrismaRecord(r));
  }

  /**
   * Atomically claims eligible pending records or expired leases using
   * Global Lock Order: candidates FOR UPDATE -> email_outbox FOR UPDATE SKIP LOCKED.
   */
  public async claimForDispatch(
    workerId: string,
    limit = 10,
    leaseDurationSeconds = 120,
  ): Promise<OutboxRecord[]> {
    const claimed: OutboxRecord[] = [];
    const skippedIds: string[] = [];
    const maxIterations = Math.max(limit * 10, 100);

    for (let iter = 0; iter < maxIterations && claimed.length < limit; iter += 1) {
      const step = await this.database.$transaction(async (tx) => {
        const excludeClause =
          skippedIds.length > 0
            ? Prisma.sql`AND id NOT IN (${Prisma.join(skippedIds.map((id) => Prisma.sql`${id}::uuid`))})`
            : Prisma.empty;

        // Peek unlocked row first so candidate lock can always be acquired BEFORE email_outbox lock
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
          AND encrypted_payload IS NOT NULL
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
            const candRows = await tx.$queryRaw<Array<{ record_status: string }>>(Prisma.sql`
              SELECT record_status
              FROM "candidates"
              WHERE id = ${peek.candidate_id}::uuid
              FOR UPDATE
            `);
            isCandidateActive = candRows[0]?.record_status === 'ACTIVE';
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
                AND encrypted_payload IS NOT NULL
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
            }
            return { kind: 'skip' as const, id: peek.id };
          }
        }

        const lockedRows = await tx.$queryRaw<
          Array<{ id: string; attempts: number; max_attempts: number }>
        >(Prisma.sql`
          SELECT id, attempts, max_attempts
          FROM email_outbox
          WHERE id = ${peek.id}::uuid
            AND (
              (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
              OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
            )
            AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
            AND COALESCE((payload_json->>'erased')::boolean, false) = false
            AND encrypted_payload IS NOT NULL
          FOR UPDATE SKIP LOCKED
        `);

        const job = lockedRows[0];
        if (!job) {
          return { kind: 'skip' as const, id: peek.id };
        }

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
        const leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);
        const updated = await tx.emailOutbox.update({
          where: { id: job.id },
          data: {
            status: 'SENDING',
            attempts: { increment: 1 },
            leaseToken,
            leaseExpiresAt,
            lockedBy: workerId,
          },
        });

        return { kind: 'claimed' as const, record: this.mapPrismaRecord(updated) };
      });

      if (step.kind === 'empty') {
        break;
      }
      if (step.kind === 'skip') {
        skippedIds.push(step.id);
        continue;
      }
      claimed.push(step.record);
    }

    return claimed;
  }

  public async markSending(
    id: string,
    workerId?: string,
    leaseDurationSeconds = 120,
  ): Promise<boolean> {
    if (!UUID_REGEX.test(id)) {
      return false;
    }

    return this.database.$transaction(async (tx) => {
      const peekRows = await tx.$queryRaw<
        Array<{ id: string; candidate_id: string | null; is_erased: boolean }>
      >(Prisma.sql`
        SELECT
          id,
          payload_json->>'candidateId' AS candidate_id,
          COALESCE((payload_json->>'erased')::boolean, false) AS is_erased
        FROM email_outbox
        WHERE id = ${id}::uuid
      `);

      const peek = peekRows[0];
      if (!peek || peek.is_erased) {
        return false;
      }

      if (peek.candidate_id) {
        let isCandidateActive = false;
        if (UUID_REGEX.test(peek.candidate_id)) {
          const candRows = await tx.$queryRaw<Array<{ record_status: string }>>(Prisma.sql`
            SELECT record_status
            FROM "candidates"
            WHERE id = ${peek.candidate_id}::uuid
            FOR UPDATE
          `);
          isCandidateActive = candRows[0]?.record_status === 'ACTIVE';
        }

        if (!isCandidateActive) {
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
            WHERE id = ${id}::uuid
              AND status IN ('PENDING', 'FAILED', 'SENDING')
              AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          `);
          return false;
        }
      }

      const leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);
      const leaseToken = randomUUID();

      const updatedCount = await tx.$executeRaw(Prisma.sql`
        UPDATE email_outbox
        SET status = 'SENDING',
            attempts = attempts + 1,
            lease_token = ${leaseToken}::uuid,
            lease_expires_at = ${leaseExpiresAt},
            locked_by = ${workerId ?? null},
            updated_at = NOW()
        WHERE id = ${id}::uuid
          AND status IN ('PENDING', 'FAILED')
          AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          AND COALESCE((payload_json->>'erased')::boolean, false) = false
          AND encrypted_payload IS NOT NULL
      `);

      return updatedCount > 0;
    });
  }

  public async markSent(id: string, messageId?: string, leaseToken?: string): Promise<void> {
    if (!UUID_REGEX.test(id)) {
      return;
    }
    if (leaseToken && !UUID_REGEX.test(leaseToken)) {
      return;
    }

    const leaseFilter = leaseToken
      ? Prisma.sql`AND lease_token = ${leaseToken}::uuid AND lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()`
      : Prisma.empty;

    // Atomic conditional update matching active lease token, SENDING status, non-cancelled/non-erased state,
    // and preserving existing payload_json keys (such as candidateId) while merging optional messageId.
    await this.database.$executeRaw(Prisma.sql`
      UPDATE "email_outbox"
      SET status = 'SENT',
          sent_at = clock_timestamp(),
          encrypted_payload = NULL,
          key_id = NULL,
          recipient_email = NULL,
          subject = NULL,
          html = NULL,
          text = NULL,
          payload_json = CASE
            WHEN ${messageId ?? null}::text IS NOT NULL
              THEN COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object('messageId', ${messageId ?? null}::text)
            ELSE payload_json
          END,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          last_error_code = NULL,
          updated_at = NOW()
      WHERE id = ${id}::uuid
        AND status = 'SENDING'
        AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
        AND COALESCE((payload_json->>'erased')::boolean, false) = false
        ${leaseFilter}
    `);
  }

  public async markFailed(
    id: string,
    error: string,
    isPermanentFailure = false,
    leaseToken?: string,
  ): Promise<void> {
    if (!UUID_REGEX.test(id)) {
      return;
    }
    if (leaseToken && !UUID_REGEX.test(leaseToken)) {
      return;
    }

    const leaseFilter = leaseToken
      ? Prisma.sql`AND lease_token = ${leaseToken}::uuid`
      : Prisma.empty;

    await this.database.$executeRaw(Prisma.sql`
      UPDATE "email_outbox"
      SET status = CASE
            WHEN ${isPermanentFailure}::boolean THEN 'PERMANENTLY_REJECTED'::"EmailDeliveryStatus"
            WHEN attempts >= max_attempts THEN 'FAILED'::"EmailDeliveryStatus"
            ELSE 'PENDING'::"EmailDeliveryStatus"
          END,
          last_error = ${error},
          last_error_code = CASE
            WHEN ${isPermanentFailure}::boolean THEN 'PERMANENT_REJECTION'
            WHEN attempts >= max_attempts THEN 'MAX_ATTEMPTS_EXHAUSTED'
            ELSE 'TRANSIENT_FAILURE'
          END,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_by = NULL,
          next_attempt_at = CASE
            WHEN ${isPermanentFailure}::boolean OR attempts >= max_attempts THEN NULL
            ELSE clock_timestamp() + (
              LEAST(60000, 1000 * POWER(2, GREATEST(attempts - 1, 0))) * INTERVAL '1 millisecond'
            )
          END,
          updated_at = NOW()
      WHERE id = ${id}::uuid
        AND status = 'SENDING'
        AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
        AND COALESCE((payload_json->>'erased')::boolean, false) = false
        ${leaseFilter}
    `);
  }

  public async getRecord(id: string): Promise<OutboxRecord | null> {
    const row = await this.database.emailOutbox.findUnique({ where: { id } });
    return row ? this.mapPrismaRecord(row) : null;
  }

  public async getRecordByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    const row = await this.database.emailOutbox.findUnique({ where: { idempotencyKey: key } });
    return row ? this.mapPrismaRecord(row) : null;
  }

  public async listRecords(filter?: {
    status?: OutboxStatus | undefined;
    recipient?: string | undefined;
    organizationId?: string | undefined;
  }): Promise<OutboxRecord[]> {
    const where: Prisma.EmailOutboxWhereInput = {};

    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.recipient) {
      where.recipientEmail = { contains: filter.recipient.trim().toLowerCase() };
    }
    if (filter?.organizationId) {
      where.organizationId = filter.organizationId;
    }

    const rows = await this.database.emailOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((r) => this.mapPrismaRecord(r));
  }

  public async manualRetry(id: string): Promise<OutboxRecord | null> {
    if (!UUID_REGEX.test(id)) {
      return null;
    }

    return this.database.$transaction(async (tx) => {
      const peekRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          last_error_code: string | null;
          encrypted_payload: string | null;
          candidate_id: string | null;
          is_erased: boolean;
        }>
      >(Prisma.sql`
        SELECT
          id,
          status::text AS status,
          last_error_code,
          encrypted_payload,
          payload_json->>'candidateId' AS candidate_id,
          COALESCE((payload_json->>'erased')::boolean, false) AS is_erased
        FROM "email_outbox"
        WHERE id = ${id}::uuid
      `);

      const peek = peekRows[0];
      if (!peek || peek.is_erased) {
        return null;
      }

      if (peek.candidate_id) {
        let isCandidateActive = false;
        if (UUID_REGEX.test(peek.candidate_id)) {
          const candRows = await tx.$queryRaw<Array<{ record_status: string }>>(Prisma.sql`
            SELECT record_status
            FROM "candidates"
            WHERE id = ${peek.candidate_id}::uuid
            FOR UPDATE
          `);
          isCandidateActive = candRows[0]?.record_status === 'ACTIVE';
        }

        if (!isCandidateActive) {
          const erasedAtIso = new Date().toISOString();
          await tx.$executeRaw(Prisma.sql`
            UPDATE "email_outbox"
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
            WHERE id = ${id}::uuid
              AND status != 'SENT'
              AND (last_error_code IS NULL OR last_error_code != 'CANDIDATE_DELETION_PENDING')
          `);
          return null;
        }
      }

      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          last_error_code: string | null;
          encrypted_payload: string | null;
          is_erased: boolean;
        }>
      >(Prisma.sql`
        SELECT
          id,
          status::text AS status,
          last_error_code,
          encrypted_payload,
          COALESCE((payload_json->>'erased')::boolean, false) AS is_erased
        FROM "email_outbox"
        WHERE id = ${id}::uuid
        FOR UPDATE
      `);

      const record = lockedRows[0];
      if (
        !record ||
        record.status === 'SENT' ||
        record.status === 'PERMANENTLY_REJECTED' ||
        record.status === 'SENDING' ||
        record.last_error_code === 'CANDIDATE_DELETION_PENDING' ||
        record.is_erased ||
        !record.encrypted_payload
      ) {
        return null;
      }

      const updated = await tx.emailOutbox.update({
        where: { id },
        data: {
          status: 'PENDING',
          attempts: 0,
          lastError: null,
          lastErrorCode: null,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lockedBy: null,
        },
      });

      return this.mapPrismaRecord(updated);
    });
  }

  public async clear(): Promise<void> {
    await this.database.emailOutbox.deleteMany();
  }
}
