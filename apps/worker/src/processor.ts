import { randomUUID } from 'node:crypto';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { type ParserResult, type ResumeFileType } from './parser.js';
import { WorkerStorageService } from './storage.js';

export interface WorkerJobProcessorOptions {
  workerId?: string;
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
  workerFactory?: (script: string, options: WorkerOptions) => Worker;
}

export class WorkerJobProcessor {
  private readonly database: PrismaClient;
  private readonly storage: WorkerStorageService;
  public readonly workerId: string;
  public readonly leaseDurationSeconds: number;
  public readonly heartbeatIntervalMs: number;
  private readonly workerFactory: (script: string, options: WorkerOptions) => Worker;

  constructor(
    database: PrismaClient = getDatabaseClient(),
    storage = new WorkerStorageService(),
    options: WorkerJobProcessorOptions = {},
  ) {
    this.database = database;
    this.storage = storage;
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 300; // 5 minutes default
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60000; // 60 seconds default
    this.workerFactory = options.workerFactory ?? ((script, opts) => new Worker(script, opts));
  }

  private async parseInWorkerThread(
    buffer: Buffer,
    fileType: ResumeFileType,
  ): Promise<ParserResult> {
    return new Promise((resolve, reject) => {
      const workerScript = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', async ({ bufferData, fileType }) => {
          try {
            const { createResumeParsingService } = await import('@talentlens/document-processing');
            const parser = createResumeParsingService();
            const result = await parser.parse(Buffer.from(bufferData), fileType);
            parentPort.postMessage({ ok: true, result });
          } catch (err) {
            parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) });
          }
        });
      `;

      let worker: Worker;
      try {
        worker = this.workerFactory(workerScript, { eval: true });
      } catch (err: unknown) {
        reject(
          new Error(
            `Failed to initialize document parsing worker thread: ${(err as Error).message}`,
          ),
        );
        return;
      }

      worker.once('message', (msg: { ok: boolean; result?: ParserResult; error?: string }) => {
        worker.terminate().catch(() => {});
        if (msg.ok && msg.result) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error ?? 'Unknown worker thread error'));
        }
      });

      worker.once('error', (err) => {
        worker.terminate().catch(() => {});
        reject(err);
      });

      worker.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker thread stopped with exit code ${code}`));
        }
      });

      worker.postMessage({ bufferData: buffer, fileType });
    });
  }

  public async parseDocument(buffer: Buffer, fileType: ResumeFileType): Promise<ParserResult> {
    // Pure worker-thread execution: NO synchronous main-thread fallback in production
    return this.parseInWorkerThread(buffer, fileType);
  }

  public async processNextJob(): Promise<boolean> {
    const leaseMinutes = Math.max(1, Math.round(this.leaseDurationSeconds / 60));

    // 1. Phase 1 — Short Transaction: Atomically claim eligible job and establish lease
    const claimed = await this.database.$transaction(async (tx) => {
      const jobs = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          attempts: number;
          resume_document_id: string | null;
          organization_id: string;
          requisition_id: string;
        }>
      >(
        Prisma.sql`
          SELECT pj.id, pj.status, pj.attempts, pj.resume_document_id, pj.organization_id, pb.requisition_id
          FROM "processing_jobs" pj
          JOIN "processing_batches" pb ON pb.id = pj.batch_id
          WHERE (
            (pj.status = 'QUEUED')
            OR (
              pj.status = 'RETRYABLE_FAILURE'
              AND pj.attempts < 3
              AND (
                (pj.attempts = 1 AND pj.updated_at + INTERVAL '30 seconds' <= NOW())
                OR
                (pj.attempts = 2 AND pj.updated_at + INTERVAL '120 seconds' <= NOW())
              )
            )
            OR (
              pj.status = 'PROCESSING'
              AND pj.lease_expires_at IS NOT NULL
              AND pj.lease_expires_at <= NOW()
            )
          )
          ORDER BY pj.created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!jobs || jobs.length === 0 || !jobs[0]) {
        return null;
      }

      const candidateJob = jobs[0];

      // A. Exhausted stale job recovery check
      if (candidateJob.status === 'PROCESSING' && candidateJob.attempts >= 3) {
        await tx.processingJob.update({
          where: { id: candidateJob.id },
          data: {
            status: 'FAILED',
            lastErrorCode: 'STALE_LEASE_EXPIRED_MAX_ATTEMPTS_EXHAUSTED',
            finishedAt: new Date(),
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
          },
        });

        if (candidateJob.resume_document_id) {
          await tx.resumeDocument.update({
            where: { id: candidateJob.resume_document_id },
            data: { parseStatus: 'FAILED' },
          });
        }
        return null;
      }

      // B. Missing resume document guard
      if (!candidateJob.resume_document_id) {
        await tx.processingJob.update({
          where: { id: candidateJob.id },
          data: {
            status: 'FAILED',
            lastErrorCode: 'MISSING_RESUME_DOCUMENT',
            finishedAt: new Date(),
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
          },
        });
        return null;
      }

      // C. Active processing authorization / consent gate
      const activeConsent = await tx.candidateConsent.findFirst({
        where: {
          organizationId: candidateJob.organization_id,
          candidate: {
            resumes: {
              some: { id: candidateJob.resume_document_id },
            },
          },
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
          captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
          requisitionId: candidateJob.requisition_id,
        },
        select: { id: true },
      });

      if (!activeConsent) {
        await tx.processingJob.update({
          where: { id: candidateJob.id },
          data: {
            status: 'HELD_FOR_AUTHORIZATION',
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
          },
        });
        return null;
      }

      // D. Grant lease with fresh token using PostgreSQL database clock
      const leaseToken = randomUUID();

      await tx.$executeRaw(Prisma.sql`
        UPDATE "processing_jobs"
        SET status = 'PROCESSING',
            attempts = attempts + 1,
            locked_by = ${this.workerId},
            lease_token = ${leaseToken}::uuid,
            lease_expires_at = NOW() + (${leaseMinutes} * INTERVAL '1 minute'),
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = ${candidateJob.id}::uuid
      `);

      const claimedRecord = await tx.processingJob.findUnique({
        where: { id: candidateJob.id },
        include: {
          batch: {
            select: { requisitionId: true },
          },
          resumeDocument: {
            select: { id: true, objectKey: true, fileType: true, organizationId: true },
          },
        },
      });

      if (!claimedRecord || !claimedRecord.resumeDocument) {
        return null;
      }

      return {
        ...claimedRecord,
        leaseToken,
      };
    });

    if (!claimed || !claimed.resumeDocument) {
      return false;
    }

    const resumeDoc = claimed.resumeDocument;
    const leaseToken = claimed.leaseToken;

    // 2. Phase 2 — Outside Transaction: Read, parse, and maintain heartbeat
    let leaseLost = false;
    let isHeartbeatRunning = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    if (this.heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(async () => {
        if (isHeartbeatRunning || leaseLost) return;
        isHeartbeatRunning = true;
        try {
          const renewed = await this.database.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET lease_expires_at = NOW() + (${leaseMinutes} * INTERVAL '1 minute'),
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND status = 'PROCESSING'
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > NOW()
          `);

          if (renewed === 0) {
            leaseLost = true;
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
          }
        } catch {
          // Transient DB network error; subsequent heartbeat or completion will verify token
        } finally {
          isHeartbeatRunning = false;
        }
      }, this.heartbeatIntervalMs);
    }

    try {
      const fileBuffer = await this.storage.read(resumeDoc.objectKey);
      const result = await this.parseDocument(fileBuffer, resumeDoc.fileType as ResumeFileType);

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (leaseLost) {
        // Ownership was lost during processing; abort to prevent split-brain writes
        return true;
      }

      // 3. Phase 3 — Short Transaction: Fenced idempotent completion with authorization recheck
      await this.database.$transaction(async (tx) => {
        // A. Recheck authorization before committing extraction
        const stillConsented = claimed.batch?.requisitionId
          ? await tx.candidateConsent.findFirst({
              where: {
                organizationId: resumeDoc.organizationId,
                candidate: {
                  resumes: {
                    some: { id: resumeDoc.id },
                  },
                },
                purpose: 'HIRING_USE',
                status: 'ACTIVE',
                withdrawnAt: null,
                policyVersion: { not: '' },
                captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
                requisitionId: claimed.batch.requisitionId,
              },
              select: { id: true },
            })
          : null;

        if (!stillConsented) {
          // Consent revoked during processing: hold job, clear lease, do not persist extraction
          await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'HELD_FOR_AUTHORIZATION',
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND lease_token = ${leaseToken}::uuid
          `);
          return;
        }

        // B. Conditional update with lease token fencing and unexpired lease check
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'SUCCEEDED',
              finished_at = NOW(),
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `);

        if (updated === 0) {
          // Fenced out! Another worker took over the expired lease; discard stale extraction
          return;
        }

        // C. Persist extraction and update resume parseStatus
        const latest = await tx.documentExtraction.aggregate({
          where: {
            resumeDocumentId: resumeDoc.id,
            organizationId: resumeDoc.organizationId,
          },
          _max: { version: true },
        });

        const nextVersion = (latest._max.version ?? 0) + 1;

        await tx.documentExtraction.create({
          data: {
            organizationId: resumeDoc.organizationId,
            resumeDocumentId: resumeDoc.id,
            version: nextVersion,
            extractedText: result.extractedText,
            pageMapJson: result.pageMapJson as Prisma.InputJsonValue,
            parser: result.parser,
            ocrUsed: result.ocrUsed,
            qualityStatus: result.qualityStatus,
          },
        });

        const parseStatus =
          result.qualityStatus === 'COMPLETE'
            ? 'PARSED'
            : result.qualityStatus === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'FAILED';

        await tx.resumeDocument.update({
          where: { id: resumeDoc.id },
          data: { parseStatus },
        });
      });

      return true;
    } catch (err: unknown) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // 4. Phase 4 — Short Transaction: Fenced failure recording and retry scheduling
      const errorMessage = (err as Error).message || 'Parsing failed';
      const willFail = claimed.attempts >= 3;
      const nextStatus = willFail ? 'FAILED' : 'RETRYABLE_FAILURE';

      await this.database.$transaction(async (tx) => {
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = ${nextStatus}::"ProcessingJobStatus",
              last_error_code = ${errorMessage.slice(0, 500)},
              finished_at = NOW(),
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `);

        if (updated > 0 && willFail) {
          await tx.resumeDocument.update({
            where: { id: resumeDoc.id },
            data: { parseStatus: 'FAILED' },
          });
        }
      });

      return true;
    }
  }
}
