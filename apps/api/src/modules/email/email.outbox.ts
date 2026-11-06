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
    if (!record || record.status === 'SENT' || record.status === 'PERMANENTLY_REJECTED') {
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

    if (leaseToken && record.leaseToken && record.leaseToken !== leaseToken) {
      return; // Fenced stale worker
    }

    record.status = 'SENT';
    record.sentAt = new Date().toISOString();
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    record.lockedBy = null;
    record.lastError = undefined;
    if (messageId && record.metadata) {
      record.metadata['messageId'] = messageId;
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

    if (record.status === 'SENT') {
      return record;
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
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return rows.map((r) => this.mapPrismaRecord(r));
  }

  /**
   * Atomically claims eligible pending records or expired leases using SELECT ... FOR UPDATE SKIP LOCKED.
   */
  public async claimForDispatch(
    workerId: string,
    limit = 10,
    leaseDurationSeconds = 120,
  ): Promise<OutboxRecord[]> {
    return this.database.$transaction(async (tx) => {
      const eligible = await tx.$queryRaw<
        Array<{ id: string; attempts: number; max_attempts: number; status: string }>
      >(
        Prisma.sql`
          SELECT id, attempts, max_attempts, status
          FROM email_outbox
          WHERE (
            (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
            OR (status = 'SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
          )
          ORDER BY created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!eligible || eligible.length === 0) {
        return [];
      }

      const claimed: OutboxRecord[] = [];
      const leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);

      for (const row of eligible) {
        if (row.attempts >= row.max_attempts) {
          await tx.emailOutbox.update({
            where: { id: row.id },
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
          continue;
        }

        const leaseToken = randomUUID();
        const updated = await tx.emailOutbox.update({
          where: { id: row.id },
          data: {
            status: 'SENDING',
            attempts: { increment: 1 },
            leaseToken,
            leaseExpiresAt,
            lockedBy: workerId,
          },
        });

        claimed.push(this.mapPrismaRecord(updated));
      }

      return claimed;
    });
  }

  public async markSending(
    id: string,
    workerId?: string,
    leaseDurationSeconds = 120,
  ): Promise<boolean> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);
    const leaseToken = randomUUID();

    const result = await this.database.emailOutbox.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
        lockedBy: workerId ?? null,
      },
    });

    return result.count > 0;
  }

  public async markSent(id: string, messageId?: string, leaseToken?: string): Promise<void> {
    const whereClause: Prisma.EmailOutboxWhereInput = { id };
    if (leaseToken) {
      whereClause.leaseToken = leaseToken;
    }

    const record = await this.database.emailOutbox.findFirst({ where: whereClause });
    if (!record) {
      return; // Fenced out or non-existent
    }

    const payload = (record.payloadJson as Record<string, unknown>) ?? {};
    if (messageId) {
      payload['messageId'] = messageId;
    }

    // Post-delivery erasure: crypto-shred sensitive payload, bodies, recipient, and subject
    await this.database.emailOutbox.update({
      where: { id: record.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        encryptedPayload: null,
        recipientEmail: null,
        subject: null,
        html: null,
        text: null,
        payloadJson: messageId ? ({ messageId } as Prisma.InputJsonValue) : Prisma.DbNull,
        leaseToken: null,
        leaseExpiresAt: null,
        lockedBy: null,
        lastError: null,
        lastErrorCode: null,
      },
    });
  }

  public async markFailed(
    id: string,
    error: string,
    isPermanentFailure = false,
    leaseToken?: string,
  ): Promise<void> {
    const whereClause: Prisma.EmailOutboxWhereInput = { id };
    if (leaseToken) {
      whereClause.leaseToken = leaseToken;
    }

    const record = await this.database.emailOutbox.findFirst({ where: whereClause });
    if (!record) {
      return; // Fenced out or non-existent
    }

    const isExhausted = record.attempts >= record.maxAttempts;

    if (isPermanentFailure || isExhausted) {
      await this.database.emailOutbox.update({
        where: { id: record.id },
        data: {
          status: isPermanentFailure ? 'PERMANENTLY_REJECTED' : 'FAILED',
          lastError: error,
          lastErrorCode: isPermanentFailure ? 'PERMANENT_REJECTION' : 'MAX_ATTEMPTS_EXHAUSTED',
          leaseToken: null,
          leaseExpiresAt: null,
          lockedBy: null,
          nextAttemptAt: null,
        },
      });
    } else {
      const backoffMs = Math.min(60000, 1000 * Math.pow(2, record.attempts - 1));
      await this.database.emailOutbox.update({
        where: { id: record.id },
        data: {
          status: 'PENDING',
          lastError: error,
          lastErrorCode: 'TRANSIENT_FAILURE',
          leaseToken: null,
          leaseExpiresAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
        },
      });
    }
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
    const record = await this.database.emailOutbox.findUnique({ where: { id } });
    if (!record) return null;

    if (record.status === 'SENT') {
      return this.mapPrismaRecord(record);
    }

    const updated = await this.database.emailOutbox.update({
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
  }

  public async clear(): Promise<void> {
    await this.database.emailOutbox.deleteMany();
  }
}
