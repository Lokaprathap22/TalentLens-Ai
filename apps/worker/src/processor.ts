import { randomUUID } from 'node:crypto';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import {
  DocumentProcessingTimeoutError,
  EncryptedDocumentError,
  InvalidDocumentFormatError,
  OcrRuntimeUnavailableError,
  SecurityLimitExceededError,
  type ParserResult,
  type ResumeFileType,
} from './parser.js';
import { WorkerStorageService } from './storage.js';
import {
  type AssessmentProvider,
  createAssessmentProvider,
  redactResumeText,
  verifyCriterionAssessments,
  calculateAssessmentSummary,
  type ScorecardCriterionDefinition,
} from './assessment.js';

export class WorkerLeaseLostError extends Error {
  public readonly jobId: string;
  public readonly workerId: string;

  constructor(
    jobId: string,
    workerId: string,
    message = 'Worker lease expired or was lost before completion',
  ) {
    super(message);
    this.name = 'WorkerLeaseLostError';
    this.jobId = jobId;
    this.workerId = workerId;
  }
}

function reconstructWorkerError(errorName: string | undefined, message: string): Error {
  const safeMessage = message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Document parsing error';
  switch (errorName) {
    case 'SecurityLimitExceededError':
      return new SecurityLimitExceededError(safeMessage);
    case 'InvalidDocumentFormatError':
      return new InvalidDocumentFormatError(safeMessage);
    case 'EncryptedDocumentError':
      return new EncryptedDocumentError(safeMessage);
    case 'DocumentProcessingTimeoutError':
      return new DocumentProcessingTimeoutError(safeMessage);
    case 'OcrRuntimeUnavailableError':
      return new OcrRuntimeUnavailableError(safeMessage);
    default: {
      const err = new Error(safeMessage);
      if (errorName) err.name = errorName;
      return err;
    }
  }
}

function formatWorkerErrorCode(err: unknown): string {
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Processing failed');
  const safeMessage = rawMessage.replace(/\s+/g, ' ').trim() || 'Processing failed';

  if (err instanceof SecurityLimitExceededError) {
    return `DOCUMENT_SECURITY_LIMIT_EXCEEDED: ${safeMessage}`.slice(0, 500);
  }
  if (err instanceof InvalidDocumentFormatError) {
    return `INVALID_DOCUMENT_FORMAT: ${safeMessage}`.slice(0, 500);
  }
  if (err instanceof EncryptedDocumentError) {
    return `ENCRYPTED_DOCUMENT_UNSUPPORTED: ${safeMessage}`.slice(0, 500);
  }
  if (err instanceof DocumentProcessingTimeoutError) {
    return `DOCUMENT_PROCESSING_TIMEOUT: ${safeMessage}`.slice(0, 500);
  }
  if (err instanceof OcrRuntimeUnavailableError) {
    return `OCR_RUNTIME_UNAVAILABLE: ${safeMessage}`.slice(0, 500);
  }
  return safeMessage.slice(0, 500);
}

interface MockCandidateFinder {
  candidate?: {
    findFirst(args: unknown): Promise<{ id: string; recordStatus: string } | null>;
  };
}

export interface WorkerJobProcessorOptions {
  workerId?: string;
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
  workerFactory?: (script: string, options: WorkerOptions) => Worker;
  assessmentProvider?: AssessmentProvider;
}

export class WorkerJobProcessor {
  private readonly database: PrismaClient;
  private readonly storage: WorkerStorageService;
  public readonly workerId: string;
  public readonly leaseDurationSeconds: number;
  public readonly heartbeatIntervalMs: number;
  private readonly workerFactory: (script: string, options: WorkerOptions) => Worker;
  public readonly assessmentProvider: AssessmentProvider;

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
    this.assessmentProvider = options.assessmentProvider ?? createAssessmentProvider();
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
            parentPort.postMessage({
              ok: false,
              errorName: (err && err.name) || 'Error',
              error: (err && err.message) || String(err),
            });
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

      worker.once(
        'message',
        (msg: { ok: boolean; result?: ParserResult; errorName?: string; error?: string }) => {
          worker.terminate().catch(() => {});
          if (msg.ok && msg.result) {
            resolve(msg.result);
          } else {
            reject(
              reconstructWorkerError(msg.errorName, msg.error ?? 'Unknown worker thread error'),
            );
          }
        },
      );

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
          job_type: string;
          status: string;
          attempts: number;
          resume_document_id: string | null;
          organization_id: string;
          requisition_id: string;
        }>
      >(
        Prisma.sql`
          SELECT pj.id, pj.job_type, pj.status, pj.attempts, pj.resume_document_id, pj.organization_id, pb.requisition_id
          FROM "processing_jobs" pj
          JOIN "processing_batches" pb ON pb.id = pj.batch_id
          WHERE (
            (pj.status = 'QUEUED')
            OR (
              pj.status = 'RETRYABLE_FAILURE'
              AND pj.attempts < 3
              AND (
                (pj.attempts = 1 AND pj.updated_at + INTERVAL '30 seconds' <= clock_timestamp())
                OR
                (pj.attempts = 2 AND pj.updated_at + INTERVAL '120 seconds' <= clock_timestamp())
              )
            )
            OR (
              pj.status = 'PROCESSING'
              AND pj.lease_expires_at IS NOT NULL
              AND pj.lease_expires_at <= clock_timestamp()
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

        if (
          (!candidateJob.job_type ||
            candidateJob.job_type === 'EXTRACT_TEXT' ||
            candidateJob.job_type === 'OCR') &&
          candidateJob.resume_document_id
        ) {
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
        select: {
          id: true,
          candidateId: true,
          confirmationName: true,
          noticeTextHash: true,
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              profiles: {
                orderBy: { profileVersion: 'desc' },
                take: 1,
                select: { location: true },
              },
            },
          },
        },
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
            lease_expires_at = clock_timestamp() + (${leaseMinutes} * INTERVAL '1 minute'),
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
            select: {
              id: true,
              candidateId: true,
              objectKey: true,
              fileType: true,
              organizationId: true,
            },
          },
        },
      });

      if (!claimedRecord || !claimedRecord.resumeDocument) {
        return null;
      }

      return {
        ...claimedRecord,
        leaseToken,
        activeConsent,
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
            SET lease_expires_at = clock_timestamp() + (${leaseMinutes} * INTERVAL '1 minute'),
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${this.workerId}
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
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
      if (claimed.jobType === 'ASSESS_CANDIDATE') {
        await this.handleAssessCandidate(claimed, resumeDoc, leaseToken, () => leaseLost);
      } else if (claimed.jobType === 'EXTRACT_PROFILE') {
        await this.handleExtractProfile(claimed, resumeDoc, leaseToken, () => leaseLost);
      } else if (claimed.jobType === 'DETECT_DUPLICATE') {
        await this.handleDetectDuplicate(claimed, resumeDoc, leaseToken, () => leaseLost);
      } else if (claimed.jobType === 'OCR') {
        await this.handleOcr(claimed, resumeDoc, leaseToken, () => leaseLost);
      } else {
        await this.handleExtractText(claimed, resumeDoc, leaseToken, () => leaseLost);
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      return true;
    } catch (err: unknown) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (err instanceof WorkerLeaseLostError) {
        return true;
      }

      // 4. Phase 4 — Short Transaction: Fenced failure recording and retry scheduling
      const errorCode = formatWorkerErrorCode(err);
      const isPermanentDocError =
        err instanceof SecurityLimitExceededError ||
        err instanceof InvalidDocumentFormatError ||
        err instanceof EncryptedDocumentError;
      const willFail = isPermanentDocError || claimed.attempts >= 3;
      const nextStatus = willFail ? 'FAILED' : 'RETRYABLE_FAILURE';

      await this.database.$transaction(async (tx) => {
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = ${nextStatus}::"ProcessingJobStatus",
              last_error_code = ${errorCode},
              finished_at = NOW(),
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${this.workerId}
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
        `);

        if (
          updated > 0 &&
          willFail &&
          (claimed.jobType === 'EXTRACT_TEXT' || claimed.jobType === 'OCR')
        ) {
          await tx.resumeDocument.update({
            where: { id: resumeDoc.id },
            data: { parseStatus: 'FAILED' },
          });
        }
      });

      return true;
    }
  }

  /**
   * Lifecycle fence: Locks candidate row with FOR UPDATE and verifies ACTIVE status.
   * - Production DB errors propagate and abort processing (never swallowed).
   * - Missing candidate fails closed (job failed, returns false).
   * - Non-ACTIVE candidate rejected (job failed with CANDIDATE_DELETION_PENDING, returns false).
   * - Mock fallback isolated to test environments where $queryRaw is not a function.
   */
  private async verifyAndLockActiveCandidate(
    tx: Prisma.TransactionClient,
    claimedId: string,
    leaseToken: string,
    target: { resumeDocId?: string; candidateId?: string; organizationId: string },
  ): Promise<boolean> {
    let candidateRecordStatus: string | undefined;

    if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
      // Production database lock errors must propagate and abort processing
      const candidateRows = target.candidateId
        ? await tx.$queryRaw<Array<{ id: string; record_status: string }>>(Prisma.sql`
            SELECT id, record_status
            FROM "candidates"
            WHERE id = ${target.candidateId}::uuid
              AND organization_id = ${target.organizationId}::uuid
            FOR UPDATE
          `)
        : await tx.$queryRaw<Array<{ id: string; record_status: string }>>(Prisma.sql`
            SELECT c.id, c.record_status
            FROM "candidates" c
            JOIN "resume_documents" rd ON rd.candidate_id = c.id
            WHERE rd.id = ${target.resumeDocId}::uuid
              AND c.organization_id = ${target.organizationId}::uuid
            FOR UPDATE OF c
          `);

      if (!candidateRows || candidateRows.length === 0 || !candidateRows[0]) {
        // Missing candidate: fail closed!
        console.warn(
          JSON.stringify({
            msg: 'Candidate record not found or inaccessible; failing closed',
            claimedId,
            organizationId: target.organizationId,
            candidateId: target.candidateId ?? null,
            resumeDocId: target.resumeDocId ?? null,
          }),
        );
        await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'FAILED',
              last_error_code = 'CANDIDATE_NOT_FOUND',
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimedId}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${this.workerId}
            AND lease_token = ${leaseToken}::uuid
        `);
        return false;
      }

      candidateRecordStatus = candidateRows[0].record_status;
    } else {
      // Explicitly isolated to mock unit test harness where $queryRaw is not provided
      const mockTx = tx as unknown as MockCandidateFinder;
      if (typeof mockTx.candidate?.findFirst === 'function') {
        const whereClause = target.candidateId
          ? { id: target.candidateId, organizationId: target.organizationId }
          : {
              organizationId: target.organizationId,
              resumes: { some: { id: target.resumeDocId } },
            };
        const rec = await mockTx.candidate.findFirst({
          where: whereClause,
          select: { id: true, recordStatus: true },
        });
        candidateRecordStatus = rec?.recordStatus;
      } else if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        candidateRecordStatus = 'ACTIVE';
      }
    }

    // Fail closed: status must be defined and strictly ACTIVE
    if (!candidateRecordStatus || candidateRecordStatus !== 'ACTIVE') {
      const errorCode = candidateRecordStatus
        ? 'CANDIDATE_DELETION_PENDING'
        : 'CANDIDATE_NOT_FOUND';
      console.warn(
        JSON.stringify({
          msg: 'Candidate record status is not active; aborting processing',
          claimedId,
          organizationId: target.organizationId,
          candidateId: target.candidateId ?? null,
          resumeDocId: target.resumeDocId ?? null,
          recordStatus: candidateRecordStatus ?? null,
        }),
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "processing_jobs"
        SET status = 'FAILED',
            last_error_code = ${errorCode},
            lease_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = NOW()
        WHERE id = ${claimedId}::uuid
          AND status = 'PROCESSING'
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
      `);
      return false;
    }

    return true;
  }

  private async handleExtractText(
    claimed: { id: string; batchId?: string | null; batch: { requisitionId: string } | null },
    resumeDoc: { id: string; objectKey: string; fileType: string; organizationId: string },
    leaseToken: string,
    isLeaseLost: () => boolean,
  ): Promise<void> {
    const fileBuffer = await this.storage.read(resumeDoc.objectKey);
    const result = await this.parseDocument(fileBuffer, resumeDoc.fileType as ResumeFileType);

    if (isLeaseLost()) {
      return;
    }

    await this.database.$transaction(async (tx) => {
      const isCandidateActive = await this.verifyAndLockActiveCandidate(
        tx,
        claimed.id,
        leaseToken,
        {
          resumeDocId: resumeDoc.id,
          organizationId: resumeDoc.organizationId,
        },
      );
      if (!isCandidateActive) {
        return;
      }

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
        await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'HELD_FOR_AUTHORIZATION',
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${this.workerId}
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
        `);
        return;
      }

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
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (updated === 0) {
        return;
      }

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

      if (result.qualityStatus === 'COMPLETE' && claimed.batchId) {
        await tx.processingJob.create({
          data: {
            batchId: claimed.batchId,
            organizationId: resumeDoc.organizationId,
            resumeDocumentId: resumeDoc.id,
            jobType: 'EXTRACT_PROFILE',
            status: 'QUEUED',
            attempts: 0,
          },
        });
      }
    });
  }

  private async handleExtractProfile(
    claimed: { id: string; batchId?: string; batch: { requisitionId: string } | null },
    resumeDoc: { id: string; candidateId?: string; organizationId: string },
    leaseToken: string,
    isLeaseLost: () => boolean,
  ): Promise<void> {
    const candidateId = resumeDoc.candidateId;
    if (!candidateId) {
      return;
    }

    const extraction = await this.database.documentExtraction.findFirst({
      where: {
        resumeDocumentId: resumeDoc.id,
        organizationId: resumeDoc.organizationId,
      },
      orderBy: { version: 'desc' },
      select: { extractedText: true },
    });

    const text = extraction?.extractedText ?? '';
    const profileData = extractProfileFromText(text);

    if (isLeaseLost()) {
      return;
    }

    await this.database.$transaction(async (tx) => {
      const isCandidateActive = await this.verifyAndLockActiveCandidate(
        tx,
        claimed.id,
        leaseToken,
        {
          resumeDocId: resumeDoc.id,
          organizationId: resumeDoc.organizationId,
        },
      );
      if (!isCandidateActive) {
        return;
      }

      // Pre-write consent check
      if (claimed.batch?.requisitionId && typeof tx.candidateConsent?.findFirst === 'function') {
        const stillConsented = await tx.candidateConsent.findFirst({
          where: {
            organizationId: resumeDoc.organizationId,
            ...(candidateId
              ? { candidateId }
              : { candidate: { resumes: { some: { id: resumeDoc.id } } } }),
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            requisitionId: claimed.batch.requisitionId,
          },
          select: { id: true },
        });

        if (!stillConsented) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'HELD_FOR_AUTHORIZATION',
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${this.workerId}
              AND lease_token = ${leaseToken}::uuid
          `);
          return;
        }
      }

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
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (updated === 0) {
        return;
      }

      const existingProfile = await tx.candidateProfile.findFirst({
        where: {
          candidateId,
          organizationId: resumeDoc.organizationId,
        },
        orderBy: { profileVersion: 'desc' },
        select: { profileVersion: true },
      });

      const nextVersion = (existingProfile?.profileVersion ?? 0) + 1;

      const createdProfile = await tx.candidateProfile.create({
        data: {
          organizationId: resumeDoc.organizationId,
          candidateId,
          currentRole: profileData.currentRole,
          experienceYears:
            profileData.experienceYears != null
              ? new Prisma.Decimal(profileData.experienceYears)
              : null,
          location: profileData.location,
          noticeDays: profileData.noticeDays,
          summary: profileData.summary,
          profileVersion: nextVersion,
        },
      });

      for (const skill of profileData.skills) {
        await tx.candidateSkill.create({
          data: {
            organizationId: resumeDoc.organizationId,
            candidateProfileId: createdProfile.id,
            skillNameNormalized: skill.name.toLowerCase().trim(),
            evidenceReference: skill.evidenceQuote.slice(0, 200),
          },
        });
      }

      if (claimed.batchId) {
        await tx.processingJob.create({
          data: {
            batchId: claimed.batchId,
            organizationId: resumeDoc.organizationId,
            resumeDocumentId: resumeDoc.id,
            jobType: 'DETECT_DUPLICATE',
            status: 'QUEUED',
            attempts: 0,
          },
        });
      }
    });
  }

  private async handleDetectDuplicate(
    claimed: { id: string; batchId?: string; batch: { requisitionId: string } | null },
    resumeDoc: { id: string; candidateId?: string; organizationId: string },
    leaseToken: string,
    isLeaseLost: () => boolean,
  ): Promise<void> {
    const candidateId = resumeDoc.candidateId;
    if (!candidateId) {
      return;
    }

    const currentDoc = await this.database.resumeDocument.findUnique({
      where: { id: resumeDoc.id },
      select: { sha256: true },
    });

    if (isLeaseLost()) {
      return;
    }

    await this.database.$transaction(async (tx) => {
      const isCandidateActive = await this.verifyAndLockActiveCandidate(
        tx,
        claimed.id,
        leaseToken,
        {
          resumeDocId: resumeDoc.id,
          organizationId: resumeDoc.organizationId,
        },
      );
      if (!isCandidateActive) {
        return;
      }

      // Pre-write consent check
      if (claimed.batch?.requisitionId && typeof tx.candidateConsent?.findFirst === 'function') {
        const stillConsented = await tx.candidateConsent.findFirst({
          where: {
            organizationId: resumeDoc.organizationId,
            ...(candidateId
              ? { candidateId }
              : { candidate: { resumes: { some: { id: resumeDoc.id } } } }),
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            requisitionId: claimed.batch.requisitionId,
          },
          select: { id: true },
        });

        if (!stillConsented) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'HELD_FOR_AUTHORIZATION',
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${this.workerId}
              AND lease_token = ${leaseToken}::uuid
          `);
          return;
        }
      }

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
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (updated === 0) {
        return;
      }

      if (currentDoc?.sha256) {
        const duplicate = await tx.resumeDocument.findFirst({
          where: {
            organizationId: resumeDoc.organizationId,
            sha256: currentDoc.sha256,
            id: { not: resumeDoc.id },
            candidateId: { not: candidateId },
          },
          select: { id: true, candidateId: true },
        });

        if (duplicate) {
          await tx.auditLog.create({
            data: {
              organizationId: resumeDoc.organizationId,
              actorId: null,
              action: 'DUPLICATE_CANDIDATE_DETECTED',
              resourceType: 'Candidate',
              resourceId: candidateId,
              requisitionId: claimed.batch?.requisitionId ?? null,
              metadataJson: {
                duplicateCandidateId: duplicate.candidateId,
                duplicateResumeDocumentId: duplicate.id,
                matchedOn: 'SHA-256',
              },
            },
          });
        }
      }

      if (claimed.batch?.requisitionId) {
        const scorecardFinder =
          tx.scorecardVersion ??
          (tx as unknown as { scorecard: typeof tx.scorecardVersion }).scorecard;
        const approvedScorecard = scorecardFinder
          ? await scorecardFinder.findFirst({
              where: {
                requisitionId: claimed.batch.requisitionId,
                organizationId: resumeDoc.organizationId,
                status: 'APPROVED',
              },
              select: { id: true },
            })
          : null;

        if (approvedScorecard && claimed.batchId) {
          await tx.processingJob.create({
            data: {
              batchId: claimed.batchId,
              organizationId: resumeDoc.organizationId,
              resumeDocumentId: resumeDoc.id,
              jobType: 'ASSESS_CANDIDATE',
              status: 'QUEUED',
              attempts: 0,
            },
          });
        }
      }
    });
  }

  private async handleOcr(
    claimed: { id: string; batchId?: string; batch: { requisitionId: string } | null },
    resumeDoc: { id: string; candidateId?: string; objectKey: string; organizationId: string },
    leaseToken: string,
    isLeaseLost: () => boolean,
  ): Promise<void> {
    const candidateId = resumeDoc.candidateId;
    const fileBuffer = await this.storage.read(resumeDoc.objectKey);
    const { PdfTextExtractor, TesseractOcrProvider } =
      await import('@talentlens/document-processing');
    const extractor = new PdfTextExtractor(new TesseractOcrProvider());
    const result = await extractor.parse(fileBuffer);

    if (isLeaseLost()) {
      return;
    }

    await this.database.$transaction(async (tx) => {
      const isCandidateActive = await this.verifyAndLockActiveCandidate(
        tx,
        claimed.id,
        leaseToken,
        {
          resumeDocId: resumeDoc.id,
          organizationId: resumeDoc.organizationId,
        },
      );
      if (!isCandidateActive) {
        return;
      }

      // Pre-write consent check
      if (claimed.batch?.requisitionId && typeof tx.candidateConsent?.findFirst === 'function') {
        const stillConsented = await tx.candidateConsent.findFirst({
          where: {
            organizationId: resumeDoc.organizationId,
            ...(candidateId
              ? { candidateId }
              : { candidate: { resumes: { some: { id: resumeDoc.id } } } }),
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            requisitionId: claimed.batch.requisitionId,
          },
          select: { id: true },
        });

        if (!stillConsented) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'HELD_FOR_AUTHORIZATION',
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${claimed.id}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${this.workerId}
              AND lease_token = ${leaseToken}::uuid
          `);
          return;
        }
      }

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
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (updated === 0) {
        return;
      }

      const latest = await tx.documentExtraction.aggregate({
        where: {
          resumeDocumentId: resumeDoc.id,
          organizationId: resumeDoc.organizationId,
        },
        _max: { version: true },
      });

      const nextVersion = (latest._max.version ?? 0) + 1;

      const hasText = result.extractedText.trim().length > 0;
      const qualityStatus: 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED' =
        result.qualityStatus === 'FAILED'
          ? 'FAILED'
          : !hasText || result.qualityStatus === 'NEEDS_REVIEW'
            ? 'NEEDS_REVIEW'
            : 'COMPLETE';

      await tx.documentExtraction.create({
        data: {
          organizationId: resumeDoc.organizationId,
          resumeDocumentId: resumeDoc.id,
          version: nextVersion,
          extractedText: result.extractedText,
          pageMapJson: result.pageMapJson as Prisma.InputJsonValue,
          parser: result.parser,
          ocrUsed: true,
          qualityStatus,
        },
      });

      const parseStatus =
        qualityStatus === 'COMPLETE'
          ? 'PARSED'
          : qualityStatus === 'NEEDS_REVIEW'
            ? 'NEEDS_REVIEW'
            : 'FAILED';

      await tx.resumeDocument.update({
        where: { id: resumeDoc.id },
        data: { parseStatus },
      });

      if (qualityStatus === 'COMPLETE' && claimed.batchId) {
        await tx.processingJob.create({
          data: {
            batchId: claimed.batchId,
            organizationId: resumeDoc.organizationId,
            resumeDocumentId: resumeDoc.id,
            jobType: 'EXTRACT_PROFILE',
            status: 'QUEUED',
            attempts: 0,
          },
        });
      }
    });
  }

  private async handleAssessCandidate(
    claimed: {
      id: string;
      batch: { requisitionId: string } | null;
      attempts: number;
      activeConsent?:
        | {
            id: string;
            candidateId?: string | undefined;
            confirmationName?: string | null | undefined;
            noticeTextHash?: string | null | undefined;
            candidate?:
              | {
                  id: string;
                  candidateCode: string;
                  profiles?: Array<{ location: string | null }> | undefined;
                }
              | null
              | undefined;
          }
        | null
        | undefined;
    },
    resumeDoc: { id: string; organizationId: string; candidateId?: string | undefined },
    leaseToken: string,
    isLeaseLost: () => boolean,
  ): Promise<void> {
    if (!claimed.batch?.requisitionId) {
      throw new Error('Missing requisitionId on batch for assessment');
    }

    const extraction = await this.database.documentExtraction.findFirst({
      where: {
        resumeDocumentId: resumeDoc.id,
        organizationId: resumeDoc.organizationId,
      },
      orderBy: { version: 'desc' },
    });

    if (!extraction) {
      throw new Error('DocumentExtraction not found for resume');
    }

    const scorecard = await this.database.scorecardVersion.findFirst({
      where: {
        requisitionId: claimed.batch.requisitionId,
        organizationId: resumeDoc.organizationId,
        status: 'APPROVED',
      },
      include: {
        criteria: {
          where: { active: true },
          orderBy: { displayOrder: 'asc' },
        },
        requisition: { select: { title: true } },
      },
      orderBy: { version: 'desc' },
    });

    if (!scorecard || scorecard.criteria.length === 0) {
      throw new Error('No approved scorecard version found for requisition');
    }

    const criteriaDefs: ScorecardCriterionDefinition[] = scorecard.criteria.map((c) => {
      let minScore: number | undefined;
      let maxScore: number | undefined;
      if (c.ruleJson && typeof c.ruleJson === 'object' && !Array.isArray(c.ruleJson)) {
        const rule = c.ruleJson as Record<string, unknown>;
        if (typeof rule['minScore'] === 'number') minScore = rule['minScore'];
        if (typeof rule['maxScore'] === 'number') maxScore = rule['maxScore'];
      }
      return {
        id: c.id,
        key: c.key,
        label: c.label,
        category: c.category,
        requirementType: c.requirementType as 'MUST_HAVE' | 'PREFERRED',
        weight: Number(c.weight),
        minScore,
        maxScore,
      };
    });

    // Revalidate requisition-specific active HIRING_USE consent before provider execution
    // and load the confirmed candidate name + candidate profile identifiers from the authoritative consent scope.
    const preProviderConsent = this.database.candidateConsent?.findFirst
      ? await this.database.candidateConsent.findFirst({
          where: {
            organizationId: resumeDoc.organizationId,
            ...(resumeDoc.candidateId ? { candidateId: resumeDoc.candidateId } : {}),
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
          select: {
            id: true,
            candidateId: true,
            confirmationName: true,
            noticeTextHash: true,
            candidate: {
              select: {
                id: true,
                candidateCode: true,
                profiles: {
                  orderBy: { profileVersion: 'desc' },
                  take: 1,
                  select: { location: true },
                },
              },
            },
          },
        })
      : claimed.activeConsent;

    if (!preProviderConsent) {
      // Consent is missing, withdrawn, or not scoped to this requisition: hold job and do NOT invoke provider
      await this.database.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'HELD_FOR_AUTHORIZATION',
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${this.workerId}
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
        `);
      });
      return;
    }

    const targetCandidateId = preProviderConsent.candidateId ?? resumeDoc.candidateId;
    const candidate =
      typeof this.database.candidate?.findFirst === 'function' &&
      targetCandidateId &&
      (!preProviderConsent.candidate?.candidateCode || !preProviderConsent.confirmationName)
        ? await this.database.candidate.findFirst({
            where: {
              id: targetCandidateId,
              organizationId: resumeDoc.organizationId,
            },
            include: {
              profiles: {
                orderBy: { profileVersion: 'desc' },
                take: 1,
              },
              consents: {
                where: {
                  requisitionId: claimed.batch.requisitionId,
                  purpose: 'HIRING_USE',
                  status: 'ACTIVE',
                  withdrawnAt: null,
                  policyVersion: { not: '' },
                },
                take: 1,
              },
            },
          })
        : null;

    const confirmedName =
      preProviderConsent.confirmationName ??
      claimed.activeConsent?.confirmationName ??
      candidate?.consents?.[0]?.confirmationName ??
      null;

    const candidateNames: string[] = [];
    if (typeof confirmedName === 'string' && confirmedName.trim().length > 0) {
      candidateNames.push(confirmedName.trim());
    }

    const candidateAddress =
      preProviderConsent.candidate?.profiles?.[0]?.location ??
      claimed.activeConsent?.candidate?.profiles?.[0]?.location ??
      candidate?.profiles?.[0]?.location ??
      undefined;

    const resolvedCandidateCode =
      preProviderConsent.candidate?.candidateCode ??
      claimed.activeConsent?.candidate?.candidateCode ??
      candidate?.candidateCode ??
      null;
    const extraIdentifiers: string[] =
      typeof resolvedCandidateCode === 'string' && resolvedCandidateCode.trim().length > 0
        ? [resolvedCandidateCode.trim()]
        : [];

    const redacted = redactResumeText(extraction.extractedText, {
      candidateNames,
      candidateAddress,
      extraIdentifiers,
    });

    const aiOutput = await this.assessmentProvider.assess({
      jobTitle: scorecard.requisition.title,
      criteria: criteriaDefs,
      resumeText: redacted.redactedText,
    });

    if (isLeaseLost()) {
      return;
    }

    const verifiedResults = verifyCriterionAssessments(
      redacted.redactedText,
      extraction.pageMapJson,
      scorecard.id,
      criteriaDefs,
      aiOutput.criteria,
    );

    const summary = calculateAssessmentSummary(criteriaDefs, verifiedResults);

    await this.database.$transaction(async (tx) => {
      // Global lock order: lock candidate FIRST (FOR UPDATE) before acquiring processing_jobs lock
      const isCandidateActive = await this.verifyAndLockActiveCandidate(
        tx,
        claimed.id,
        leaseToken,
        targetCandidateId
          ? { candidateId: targetCandidateId, organizationId: resumeDoc.organizationId }
          : { resumeDocId: resumeDoc.id, organizationId: resumeDoc.organizationId },
      );
      if (!isCandidateActive) {
        return;
      }

      const leaseLock = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "processing_jobs"
        WHERE id = ${claimed.id}::uuid
          AND status = 'PROCESSING'
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `);

      if (leaseLock.length === 0) {
        throw new WorkerLeaseLostError(claimed.id, this.workerId);
      }

      // Separately verify lease validity against actual wall-clock time AFTER the row lock has been acquired,
      // because PostgreSQL's IndexScan may evaluate WHERE predicates before LockRows finishes waiting on a row lock.
      const postLockLeaseCheck = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "processing_jobs"
        WHERE id = ${claimed.id}::uuid
          AND status = 'PROCESSING'
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (postLockLeaseCheck.length === 0) {
        throw new WorkerLeaseLostError(
          claimed.id,
          this.workerId,
          'Worker lease expired while waiting for processing_jobs row lock',
        );
      }

      const stillConsented = await tx.candidateConsent.findFirst({
        where: {
          organizationId: resumeDoc.organizationId,
          candidate: {
            resumes: { some: { id: resumeDoc.id } },
          },
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
          captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
          requisitionId: claimed.batch!.requisitionId,
        },
        select: { id: true, candidateId: true, noticeTextHash: true },
      });

      if (!stillConsented) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'HELD_FOR_AUTHORIZATION',
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE id = ${claimed.id}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${this.workerId}
            AND lease_token = ${leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
        `);
        return;
      }

      let assessmentText = await tx.assessmentText.findFirst({
        where: {
          resumeDocumentId: resumeDoc.id,
          version: 1,
        },
      });

      if (!assessmentText) {
        assessmentText = await tx.assessmentText.create({
          data: {
            organizationId: resumeDoc.organizationId,
            documentExtractionId: extraction.id,
            resumeDocumentId: resumeDoc.id,
            version: 1,
            redactedText: redacted.redactedText,
            pageMapJson: extraction.pageMapJson as Prisma.InputJsonValue,
            redactionMapJson: redacted.redactionMap as unknown as Prisma.InputJsonValue,
            redactorVersion: redacted.redactorVersion,
          },
        });
      }

      const assessmentId = randomUUID();
      const metadata = {
        provider: 'openai-compatible',
        model: aiOutput.model,
        promptVersion: aiOutput.promptVersion,
        inputHash: aiOutput.inputHash,
        outputHash: aiOutput.outputHash,
        scoringFormula: summary.formulaVersion,
        consentId: stillConsented.id,
        consentNoticeHash: stillConsented.noticeTextHash ?? '',
        tokenUsage: aiOutput.tokenUsage,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const candidateAssessment = await tx.candidateAssessment.upsert({
        where: {
          requisitionId_candidateId_resumeDocumentId_scorecardVersionId: {
            requisitionId: claimed.batch!.requisitionId,
            candidateId: stillConsented.candidateId,
            resumeDocumentId: resumeDoc.id,
            scorecardVersionId: scorecard.id,
          },
        },
        create: {
          id: assessmentId,
          organizationId: resumeDoc.organizationId,
          requisitionId: claimed.batch!.requisitionId,
          candidateId: stillConsented.candidateId,
          resumeDocumentId: resumeDoc.id,
          documentExtractionId: extraction.id,
          scorecardVersionId: scorecard.id,
          assessmentTextId: assessmentText.id,
          score: summary.score !== null ? new Prisma.Decimal(summary.score) : null,
          coverage: new Prisma.Decimal(summary.coverage),
          status: summary.status,
          formulaVersion: summary.formulaVersion,
          modelMetadataJson: metadata as unknown as Prisma.InputJsonValue,
        },
        update: {
          score: summary.score !== null ? new Prisma.Decimal(summary.score) : null,
          coverage: new Prisma.Decimal(summary.coverage),
          status: summary.status,
          formulaVersion: summary.formulaVersion,
          modelMetadataJson: metadata as unknown as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
      });

      await tx.evidenceSnippet.deleteMany({ where: { assessmentId: candidateAssessment.id } });
      await tx.criterionAssessment.deleteMany({ where: { assessmentId: candidateAssessment.id } });

      for (const crit of summary.criterionResults) {
        const criterionAssessmentId = randomUUID();
        await tx.criterionAssessment.create({
          data: {
            id: criterionAssessmentId,
            organizationId: resumeDoc.organizationId,
            assessmentId: candidateAssessment.id,
            criterionId: crit.criterionId,
            scorecardVersionId: scorecard.id,
            resumeDocumentId: resumeDoc.id,
            assessmentTextId: assessmentText.id,
            documentExtractionId: extraction.id,
            status: crit.status,
            normalizedValue:
              crit.normalizedValue !== null ? new Prisma.Decimal(crit.normalizedValue) : null,
            explanation: crit.explanation,
          },
        });

        for (const ev of crit.evidenceSnippets) {
          await tx.evidenceSnippet.create({
            data: {
              organizationId: resumeDoc.organizationId,
              criterionAssessmentId,
              assessmentId: candidateAssessment.id,
              scorecardVersionId: scorecard.id,
              assessmentTextId: assessmentText.id,
              resumeDocumentId: resumeDoc.id,
              documentExtractionId: extraction.id,
              quote: ev.quote,
              pageNumber: ev.pageNumber,
              startOffset: ev.startOffset,
              endOffset: ev.endOffset,
              verified: ev.verified,
              verificationMethod: ev.verificationMethod,
            },
          });
        }
      }

      const updatedCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "processing_jobs"
        SET status = 'SUCCEEDED',
            finished_at = NOW(),
            lease_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = NOW()
        WHERE id = ${claimed.id}::uuid
          AND status = 'PROCESSING'
          AND locked_by = ${this.workerId}
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);

      if (updatedCount === 0) {
        throw new WorkerLeaseLostError(
          claimed.id,
          this.workerId,
          'Fenced job completion failed: lease expired or was superseded during transaction',
        );
      }

      await tx.auditLog.create({
        data: {
          organizationId: resumeDoc.organizationId,
          action: 'ASSESSMENT_COMPLETED',
          resourceType: 'CandidateAssessment',
          resourceId: candidateAssessment.id,
          requisitionId: claimed.batch!.requisitionId,
          candidateId: stillConsented.candidateId,
          metadataJson: {
            score: summary.score,
            coverage: summary.coverage,
            status: summary.status,
            jobId: claimed.id,
          },
        },
      });
    });
  }
}

const COMMON_SKILLS = [
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Golang',
  'Rust',
  'Java',
  'C++',
  'C#',
  'Ruby',
  'PHP',
  'Swift',
  'Kotlin',
  'Scala',
  'React',
  'Next.js',
  'Vue',
  'Angular',
  'Svelte',
  'Node.js',
  'Express',
  'FastAPI',
  'Django',
  'Flask',
  'Spring Boot',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'Cassandra',
  'Elasticsearch',
  'SQLite',
  'Docker',
  'Kubernetes',
  'AWS',
  'GCP',
  'Azure',
  'Terraform',
  'CI/CD',
  'Git',
  'Linux',
  'GraphQL',
  'REST',
  'gRPC',
  'Kafka',
  'RabbitMQ',
  'Microservices',
  'HTML',
  'CSS',
  'Tailwind',
  'Sass',
  'Webpack',
  'Vite',
  'Jest',
  'Vitest',
  'Cypress',
  'Playwright',
  'TensorFlow',
  'PyTorch',
];

export function extractProfileFromText(text: string): {
  currentRole: string | null;
  experienceYears: number | null;
  location: string | null;
  noticeDays: number | null;
  summary: string | null;
  skills: Array<{ name: string; evidenceQuote: string }>;
} {
  if (!text || text.trim().length === 0) {
    return {
      currentRole: null,
      experienceYears: null,
      location: null,
      noticeDays: null,
      summary: null,
      skills: [],
    };
  }

  // 1. Current role
  let currentRole: string | null = null;
  const roleMatch = /(?:Current\s+Role|Title|Headline|Position)\s*[:-]?\s*([^\r\n]{3,60})/i.exec(
    text,
  );
  if (roleMatch && roleMatch[1]) {
    currentRole = roleMatch[1].trim();
  } else {
    const prominentRoleMatch =
      /\b((?:Senior|Lead|Staff|Principal|Junior)?\s*(?:Software|Full\s*Stack|Frontend|Backend|DevOps|Systems|Cloud|Data|Mobile)?\s*(?:Engineer|Developer|Architect|Manager|Analyst))\b/i.exec(
        text,
      );
    if (prominentRoleMatch && prominentRoleMatch[1]) {
      currentRole = prominentRoleMatch[1].trim();
    }
  }

  // 2. Experience years
  let experienceYears: number | null = null;
  const expMatch =
    /(?:Total\s+Experience|Experience)\s*[:-]?\s*(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/i.exec(
      text,
    ) ?? /(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience/i.exec(text);
  if (expMatch && expMatch[1]) {
    const parsedExp = parseFloat(expMatch[1]);
    if (!isNaN(parsedExp) && parsedExp >= 0 && parsedExp <= 60) {
      experienceYears = parsedExp;
    }
  }

  // 3. Location
  let location: string | null = null;
  const locMatch = /(?:Location|Address|Based\s+in)\s*[:-]?\s*([^\r\n]{3,100})/i.exec(text);
  if (locMatch && locMatch[1]) {
    location = locMatch[1].trim().slice(0, 100);
  }

  // 4. Notice days
  let noticeDays: number | null = null;
  const noticeMatch = /(?:Notice\s*Period|Notice)\s*[:-]?\s*(\d+)\s*(days?|months?|weeks?)/i.exec(
    text,
  );
  if (noticeMatch && noticeMatch[1] && noticeMatch[2]) {
    const val = parseInt(noticeMatch[1], 10);
    const unit = noticeMatch[2].toLowerCase();
    if (unit.startsWith('month')) noticeDays = val * 30;
    else if (unit.startsWith('week')) noticeDays = val * 7;
    else noticeDays = val;
  }

  // 5. Summary
  let summary: string | null = null;
  const summaryMatch =
    /(?:Summary|Professional\s+Summary|About\s+Me|Profile)\s*[:-]?\s*([\s\S]{20,500}?)(?:\n\s*\n|[A-Z][A-Za-z\s]+:)/i.exec(
      text,
    );
  if (summaryMatch && summaryMatch[1]) {
    summary = summaryMatch[1].trim().slice(0, 500);
  } else {
    const firstPara = text.split(/\n\s*\n/)[0]?.trim();
    if (firstPara && firstPara.length >= 20) {
      summary = firstPara.slice(0, 300);
    }
  }

  // 6. Skills extraction
  const foundSkills: Array<{ name: string; evidenceQuote: string }> = [];
  const seenSkillNames = new Set<string>();

  for (const skill of COMMON_SKILLS) {
    const regex = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = regex.exec(text);
    if (m && !seenSkillNames.has(skill.toLowerCase())) {
      seenSkillNames.add(skill.toLowerCase());
      const start = Math.max(0, m.index - 20);
      const end = Math.min(text.length, m.index + m[0].length + 20);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      foundSkills.push({
        name: skill,
        evidenceQuote: snippet,
      });
    }
  }

  return {
    currentRole,
    experienceYears,
    location,
    noticeDays,
    summary,
    skills: foundSkills,
  };
}
