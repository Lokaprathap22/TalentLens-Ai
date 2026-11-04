import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  ExtractionQualityStatus,
  ParserResult,
  ResumeDocumentDto,
  ResumeFileType,
  ResumeParseStatus,
} from './resume.types.js';

export interface AuthorizedRequisition {
  id: string;
  title: string;
  organizationId: string;
}

export interface ExistingResumeLookup {
  id: string;
  sha256: string;
  candidateId: string;
}

export interface FileToIngest {
  storageKey: string;
  fileName: string;
  fileType: ResumeFileType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreatedBatchRecord {
  batchId: string;
  accepted: Array<{
    resumeDocumentId: string;
    candidateId: string;
    candidateCode: string;
    fileName: string;
    fileType: ResumeFileType;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface ClaimedJob {
  id: string;
  batchId: string;
  organizationId: string;
  resumeDocumentId: string;
  jobType: string;
  attempts: number;
  leaseToken: string;
  lockedBy: string;
  leaseExpiresAt: Date;
  resumeDocument: {
    id: string;
    objectKey: string;
    fileType: ResumeFileType;
    organizationId: string;
  };
}

export interface ResumeRepository {
  findAuthorizedRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<AuthorizedRequisition | null>;

  findExistingResumeBySha256(
    organizationId: string,
    sha256: string,
  ): Promise<ExistingResumeLookup | null>;

  createResumeBatch(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    filesToIngest: FileToIngest[],
    auditSummary: { totalUploaded: number; duplicates: number; rejected: number },
  ): Promise<CreatedBatchRecord>;

  listResumesForRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    limit?: number,
    offset?: number,
  ): Promise<ResumeDocumentDto[]>;

  findResumeDetails(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    resumeId: string,
  ): Promise<(ResumeDocumentDto & { objectKey: string }) | null>;

  findLatestExtraction(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    resumeId: string,
  ): Promise<{
    id: string;
    resumeDocumentId: string;
    version: number;
    extractedText: string;
    pageMap: Record<string, unknown>;
    parser: string;
    ocrUsed: boolean;
    qualityStatus: ExtractionQualityStatus;
    createdAt: Date;
  } | null>;

  claimNextProcessingJob(
    workerId?: string,
    leaseDurationMinutes?: number,
  ): Promise<ClaimedJob | null>;

  renewJobLease(jobId: string, leaseToken: string, extensionMinutes?: number): Promise<boolean>;

  completeProcessingJob(
    jobId: string,
    resumeDocumentId: string,
    organizationId: string,
    result: ParserResult,
    leaseToken?: string,
  ): Promise<boolean>;

  failProcessingJob(
    jobId: string,
    resumeDocumentId: string,
    errorMessage: string,
    isPermanent: boolean,
    leaseToken?: string,
  ): Promise<boolean>;

  releaseHeldProcessingJobs(
    organizationId: string,
    candidateId: string,
    recruiterId?: string,
    requisitionId?: string,
  ): Promise<{ releasedCount: number; reason?: string }>;

  holdProcessingJobsForRevokedConsent(
    organizationId: string,
    candidateId: string,
  ): Promise<{ heldCount: number }>;
}

export function createResumeRepository(
  database: PrismaClient = getDatabaseClient(),
): ResumeRepository {
  return {
    async findAuthorizedRequisition(organizationId, recruiterId, requisitionId) {
      const record = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: { id: true, title: true, organizationId: true },
      });
      return record;
    },

    async findExistingResumeBySha256(organizationId, sha256) {
      const record = await database.resumeDocument.findUnique({
        where: {
          organizationId_sha256: {
            organizationId,
            sha256,
          },
        },
        select: { id: true, sha256: true, candidateId: true },
      });
      return record;
    },

    async createResumeBatch(principal, requisitionId, filesToIngest, auditSummary) {
      return database.$transaction(async (tx) => {
        const batch = await tx.processingBatch.create({
          data: {
            organizationId: principal.organizationId,
            requisitionId,
            createdById: principal.userId,
            totalFiles: filesToIngest.length,
            status: 'CREATED',
          },
        });

        const accepted: CreatedBatchRecord['accepted'] = [];

        for (const file of filesToIngest) {
          // 1. Create a distinct candidate placeholder for this document
          const candidateCode = `CAN-${randomUUID().slice(0, 8).toUpperCase()}`;
          const candidate = await tx.candidate.create({
            data: {
              organizationId: principal.organizationId,
              candidateCode,
              recordStatus: 'ACTIVE',
            },
          });

          // 2. Create the ResumeDocument
          const resume = await tx.resumeDocument.create({
            data: {
              organizationId: principal.organizationId,
              candidateId: candidate.id,
              objectKey: file.storageKey,
              sha256: file.sha256,
              mimeType: file.mimeType,
              fileType: file.fileType,
              sizeBytes: BigInt(file.sizeBytes),
              version: 1,
              parseStatus: 'PENDING',
              uploadedById: principal.userId,
            },
          });

          // 3. Create the ProcessingJob (held for authorization unless genuine active consent exists)
          const activeConsent = await tx.candidateConsent.findFirst({
            where: {
              organizationId: principal.organizationId,
              candidateId: candidate.id,
              purpose: 'HIRING_USE',
              status: 'ACTIVE',
              withdrawnAt: null,
              policyVersion: { not: '' },
            },
            select: { id: true },
          });

          const initialJobStatus = activeConsent ? 'QUEUED' : 'HELD_FOR_AUTHORIZATION';

          await tx.processingJob.create({
            data: {
              batchId: batch.id,
              organizationId: principal.organizationId,
              resumeDocumentId: resume.id,
              jobType: 'EXTRACT_TEXT',
              status: initialJobStatus,
              attempts: 0,
            },
          });

          accepted.push({
            resumeDocumentId: resume.id,
            candidateId: candidate.id,
            candidateCode: candidate.candidateCode,
            fileName: file.fileName,
            fileType: file.fileType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          });
        }

        // 4. Audit Log
        await tx.auditLog.create({
          data: {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            action: 'RESUME_BATCH_UPLOADED',
            resourceType: 'ProcessingBatch',
            resourceId: batch.id,
            requisitionId,
            metadataJson: {
              totalUploaded: auditSummary.totalUploaded,
              acceptedCount: accepted.length,
              duplicateCount: auditSummary.duplicates,
              rejectedCount: auditSummary.rejected,
            },
          },
        });

        return {
          batchId: batch.id,
          accepted,
        };
      });
    },

    async listResumesForRequisition(
      organizationId,
      recruiterId,
      requisitionId,
      limit = 50,
      offset = 0,
    ) {
      // Confirm recruiter has access to requisition
      const req = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: { id: true },
      });
      if (!req) return [];

      const records = await database.resumeDocument.findMany({
        where: {
          organizationId,
          processingJobs: {
            some: {
              batch: {
                requisitionId,
              },
            },
          },
        },
        include: {
          candidate: {
            select: { id: true, candidateCode: true },
          },
        },
        orderBy: { uploadedAt: 'desc' },
        take: limit,
        skip: offset,
      });

      return records.map((r) => ({
        id: r.id,
        candidateId: r.candidate.id,
        candidateCode: r.candidate.candidateCode,
        fileName: r.objectKey.split('/').pop() ?? 'resume',
        fileType: r.fileType as ResumeFileType,
        sizeBytes: Number(r.sizeBytes),
        sha256: r.sha256,
        parseStatus: r.parseStatus as ResumeParseStatus,
        uploadedAt: r.uploadedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },

    async findResumeDetails(organizationId, recruiterId, requisitionId, resumeId) {
      // Must be authorized for requisition AND resume belongs to this requisition and organization
      const record = await database.resumeDocument.findFirst({
        where: {
          id: resumeId,
          organizationId,
          processingJobs: {
            some: {
              batch: {
                requisitionId,
                requisition: {
                  assignedRecruiterId: recruiterId,
                },
              },
            },
          },
        },
        include: {
          candidate: {
            select: { id: true, candidateCode: true },
          },
        },
      });

      if (!record) return null;

      return {
        id: record.id,
        candidateId: record.candidate.id,
        candidateCode: record.candidate.candidateCode,
        fileName: record.objectKey.split('/').pop() ?? 'resume',
        fileType: record.fileType as ResumeFileType,
        sizeBytes: Number(record.sizeBytes),
        sha256: record.sha256,
        parseStatus: record.parseStatus as ResumeParseStatus,
        objectKey: record.objectKey,
        uploadedAt: record.uploadedAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    },

    async findLatestExtraction(organizationId, recruiterId, requisitionId, resumeId) {
      // Verify scope
      const resume = await database.resumeDocument.findFirst({
        where: {
          id: resumeId,
          organizationId,
          processingJobs: {
            some: {
              batch: {
                requisitionId,
                requisition: {
                  assignedRecruiterId: recruiterId,
                },
              },
            },
          },
        },
        select: { id: true },
      });

      if (!resume) return null;

      const extraction = await database.documentExtraction.findFirst({
        where: {
          resumeDocumentId: resumeId,
          organizationId,
        },
        orderBy: { version: 'desc' },
      });

      if (!extraction) return null;

      return {
        id: extraction.id,
        resumeDocumentId: extraction.resumeDocumentId,
        version: extraction.version,
        extractedText: extraction.extractedText,
        pageMap:
          typeof extraction.pageMapJson === 'object' && extraction.pageMapJson !== null
            ? (extraction.pageMapJson as Record<string, unknown>)
            : {},
        parser: extraction.parser,
        ocrUsed: extraction.ocrUsed,
        qualityStatus: extraction.qualityStatus as ExtractionQualityStatus,
        createdAt: extraction.createdAt,
      };
    },

    async claimNextProcessingJob(workerId = `worker-${randomUUID()}`, leaseDurationMinutes = 5) {
      return database.$transaction(async (tx) => {
        // Atomic skip-locked claim with database-clock retry backoff and stale-job lease recovery
        const jobs = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            attempts: number;
            resume_document_id: string | null;
            organization_id: string;
          }>
        >(
          Prisma.sql`
            SELECT pj.id, pj.status, pj.attempts, pj.resume_document_id, pj.organization_id
            FROM "processing_jobs" pj
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

        // 1. Stale-job exhaustion check: if already at or over 3 attempts, mark FAILED permanently
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

        // 2. Authorization verification: ensure candidate has active HIRING_USE consent
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
          },
          select: { id: true },
        });

        if (!activeConsent) {
          // Authorization not present or revoked: transition job to HELD_FOR_AUTHORIZATION
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

        // 3. Atomically grant lease with fresh UUID token and database clock
        const leaseToken = randomUUID();

        await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'PROCESSING',
              attempts = attempts + 1,
              locked_by = ${workerId},
              lease_token = ${leaseToken}::uuid,
              lease_expires_at = NOW() + (${leaseDurationMinutes} * INTERVAL '1 minute'),
              started_at = NOW(),
              updated_at = NOW()
          WHERE id = ${candidateJob.id}::uuid
        `);

        const claimedRecord = await tx.processingJob.findUnique({
          where: { id: candidateJob.id },
          include: {
            resumeDocument: {
              select: {
                id: true,
                objectKey: true,
                fileType: true,
                organizationId: true,
              },
            },
          },
        });

        if (!claimedRecord || !claimedRecord.resumeDocument) {
          await tx.processingJob.update({
            where: { id: candidateJob.id },
            data: { status: 'FAILED', lastErrorCode: 'MISSING_RESUME_DOCUMENT' },
          });
          return null;
        }

        return {
          id: claimedRecord.id,
          batchId: claimedRecord.batchId,
          organizationId: claimedRecord.organizationId,
          resumeDocumentId: claimedRecord.resumeDocument.id,
          jobType: claimedRecord.jobType,
          attempts: claimedRecord.attempts,
          leaseToken,
          lockedBy: workerId,
          leaseExpiresAt: claimedRecord.leaseExpiresAt ?? new Date(),
          resumeDocument: {
            id: claimedRecord.resumeDocument.id,
            objectKey: claimedRecord.resumeDocument.objectKey,
            fileType: claimedRecord.resumeDocument.fileType as ResumeFileType,
            organizationId: claimedRecord.resumeDocument.organizationId,
          },
        };
      });
    },

    async renewJobLease(jobId, leaseToken, extensionMinutes = 5) {
      const updated = await database.$executeRaw(Prisma.sql`
        UPDATE "processing_jobs"
        SET lease_expires_at = NOW() + (${extensionMinutes} * INTERVAL '1 minute'),
            updated_at = NOW()
        WHERE id = ${jobId}::uuid
          AND status = 'PROCESSING'
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > NOW()
      `);
      return updated > 0;
    },

    async completeProcessingJob(jobId, resumeDocumentId, organizationId, result, leaseToken) {
      return database.$transaction(async (tx) => {
        // 1. Re-verify active authorization
        const activeConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidate: {
              resumes: {
                some: { id: resumeDocumentId },
              },
            },
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
            captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
          },
          select: { id: true },
        });

        if (!activeConsent) {
          // Authorization revoked during processing: hold job, clear lease, do not persist extraction
          if (leaseToken) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE "processing_jobs"
              SET status = 'HELD_FOR_AUTHORIZATION',
                  lease_expires_at = NULL,
                  locked_by = NULL,
                  lease_token = NULL,
                  updated_at = NOW()
              WHERE id = ${jobId}::uuid
                AND lease_token = ${leaseToken}::uuid
            `);
          }
          return false;
        }

        // 2. Fenced update conditional on current lease owner and unexpired lease
        let updatedCount: number;
        if (leaseToken) {
          updatedCount = await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'SUCCEEDED',
                finished_at = NOW(),
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${jobId}::uuid
              AND status = 'PROCESSING'
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > NOW()
          `);
        } else {
          const existingJob = await tx.processingJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });
          if (existingJob?.status === 'SUCCEEDED') return true;
          const res = await tx.processingJob.updateMany({
            where: {
              id: jobId,
              status: 'PROCESSING',
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } }],
            },
            data: { status: 'SUCCEEDED', finishedAt: new Date() },
          });
          updatedCount = res.count;
        }

        if (updatedCount === 0) {
          // Fenced out! Another worker took the job or lease was lost
          return false;
        }

        // 3. Persist extraction and update resume parseStatus
        const latest = await tx.documentExtraction.aggregate({
          where: { resumeDocumentId, organizationId },
          _max: { version: true },
        });

        const nextVersion = (latest._max.version ?? 0) + 1;

        await tx.documentExtraction.create({
          data: {
            organizationId,
            resumeDocumentId,
            version: nextVersion,
            extractedText: result.extractedText,
            pageMapJson: result.pageMapJson as Prisma.InputJsonValue,
            parser: result.parser,
            ocrUsed: result.ocrUsed,
            qualityStatus: result.qualityStatus,
          },
        });

        const targetParseStatus: ResumeParseStatus =
          result.qualityStatus === 'COMPLETE'
            ? 'PARSED'
            : result.qualityStatus === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'FAILED';

        await tx.resumeDocument.update({
          where: { id: resumeDocumentId },
          data: { parseStatus: targetParseStatus },
        });

        return true;
      });
    },

    async failProcessingJob(jobId, resumeDocumentId, errorMessage, isPermanent, leaseToken) {
      return database.$transaction(async (tx) => {
        const current = await tx.processingJob.findUnique({
          where: { id: jobId },
          select: { attempts: true },
        });

        const attempts = current?.attempts ?? 1;
        const willFail = isPermanent || attempts >= 3;
        const nextStatus = willFail ? 'FAILED' : 'RETRYABLE_FAILURE';

        let updatedCount: number;
        if (leaseToken) {
          updatedCount = await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = ${nextStatus}::"ProcessingJobStatus",
                last_error_code = ${errorMessage.slice(0, 500)},
                finished_at = NOW(),
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${jobId}::uuid
              AND status = 'PROCESSING'
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > NOW()
          `);
        } else {
          const res = await tx.processingJob.updateMany({
            where: {
              id: jobId,
              status: 'PROCESSING',
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } }],
            },
            data: {
              status: nextStatus,
              lastErrorCode: errorMessage.slice(0, 500),
              finishedAt: new Date(),
            },
          });
          updatedCount = res.count;
        }

        if (updatedCount > 0 && willFail) {
          await tx.resumeDocument.update({
            where: { id: resumeDocumentId },
            data: { parseStatus: 'FAILED' },
          });
        }

        return updatedCount > 0;
      });
    },

    async releaseHeldProcessingJobs(organizationId, candidateId, recruiterId, requisitionId) {
      return database.$transaction(async (tx) => {
        const candidate = await tx.candidate.findFirst({
          where: { id: candidateId, organizationId },
          select: { id: true },
        });

        if (!candidate) {
          return { releasedCount: 0, reason: 'CANDIDATE_NOT_FOUND' };
        }

        const validConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidateId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
            captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
          },
          select: { id: true },
        });

        if (!validConsent) {
          return { releasedCount: 0, reason: 'NO_ACTIVE_VALID_CONSENT' };
        }

        // Find candidate's held jobs in this organization
        const heldJobs = await tx.processingJob.findMany({
          where: {
            organizationId,
            status: 'HELD_FOR_AUTHORIZATION',
            resumeDocument: {
              candidateId,
              organizationId,
            },
            ...(requisitionId ? { batch: { requisitionId } } : {}),
          },
          include: {
            batch: {
              select: { requisitionId: true },
            },
          },
        });

        if (heldJobs.length === 0) {
          return { releasedCount: 0, reason: 'NO_HELD_JOBS_FOUND' };
        }

        // Verify recruiter assignment to the requisition(s)
        const targetRequisitionIds = Array.from(
          new Set(heldJobs.map((j) => j.batch.requisitionId)),
        );
        let authorizedRequisitionIds = targetRequisitionIds;

        if (recruiterId) {
          const accessibleRequisitions = await tx.requisition.findMany({
            where: {
              id: { in: targetRequisitionIds },
              organizationId,
              assignedRecruiterId: recruiterId,
            },
            select: { id: true },
          });

          authorizedRequisitionIds = accessibleRequisitions.map((r) => r.id);
          if (authorizedRequisitionIds.length === 0) {
            return { releasedCount: 0, reason: 'UNAUTHORIZED_REQUISITION' };
          }
        }

        const updated = await tx.processingJob.updateMany({
          where: {
            organizationId,
            status: 'HELD_FOR_AUTHORIZATION',
            batch: {
              requisitionId: { in: authorizedRequisitionIds },
            },
            resumeDocument: {
              candidateId,
              organizationId,
            },
          },
          data: {
            status: 'QUEUED',
          },
        });

        if (updated.count > 0) {
          await tx.auditLog.create({
            data: {
              organizationId,
              action: 'PROCESSING_JOBS_RELEASED_FOR_AUTHORIZATION',
              resourceType: 'Candidate',
              resourceId: candidateId,
              metadataJson: {
                releasedCount: updated.count,
                consentId: validConsent.id,
                requisitionIds: authorizedRequisitionIds,
                recruiterId: recruiterId ?? null,
              },
            },
          });
        }

        return { releasedCount: updated.count };
      });
    },

    async holdProcessingJobsForRevokedConsent(organizationId, candidateId) {
      return database.$transaction(async (tx) => {
        const updated = await tx.processingJob.updateMany({
          where: {
            organizationId,
            status: { in: ['QUEUED', 'PROCESSING'] },
            resumeDocument: {
              candidateId,
              organizationId,
            },
          },
          data: {
            status: 'HELD_FOR_AUTHORIZATION',
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
          },
        });

        return { heldCount: updated.count };
      });
    },
  };
}
