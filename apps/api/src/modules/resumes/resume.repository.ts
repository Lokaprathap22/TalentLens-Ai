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

  claimNextProcessingJob(): Promise<ClaimedJob | null>;

  completeProcessingJob(
    jobId: string,
    resumeDocumentId: string,
    organizationId: string,
    result: ParserResult,
  ): Promise<void>;

  failProcessingJob(
    jobId: string,
    resumeDocumentId: string,
    errorMessage: string,
    isPermanent: boolean,
  ): Promise<void>;
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

          // 3. Create the ProcessingJob
          await tx.processingJob.create({
            data: {
              batchId: batch.id,
              organizationId: principal.organizationId,
              resumeDocumentId: resume.id,
              jobType: 'EXTRACT_TEXT',
              status: 'QUEUED',
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

    async claimNextProcessingJob() {
      return database.$transaction(async (tx) => {
        // Atomic skip-locked claim with database-backed exponential backoff on retryable failures
        const jobs = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            SELECT id FROM "processing_jobs"
            WHERE (status = 'QUEUED')
               OR (
                 status = 'RETRYABLE_FAILURE'
                 AND attempts < 3
                 AND (
                   (attempts = 1 AND updated_at + INTERVAL '30 seconds' <= NOW())
                   OR
                   (attempts = 2 AND updated_at + INTERVAL '120 seconds' <= NOW())
                 )
               )
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `,
        );

        if (!jobs || jobs.length === 0 || !jobs[0]) {
          return null;
        }

        const jobId = jobs[0].id;

        const claimed = await tx.processingJob.update({
          where: { id: jobId },
          data: {
            status: 'PROCESSING',
            startedAt: new Date(),
            attempts: { increment: 1 },
          },
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

        if (!claimed.resumeDocument) {
          // Corrupt job record without resume
          await tx.processingJob.update({
            where: { id: jobId },
            data: { status: 'FAILED', lastErrorCode: 'MISSING_RESUME_DOCUMENT' },
          });
          return null;
        }

        return {
          id: claimed.id,
          batchId: claimed.batchId,
          organizationId: claimed.organizationId,
          resumeDocumentId: claimed.resumeDocument.id,
          jobType: claimed.jobType,
          attempts: claimed.attempts,
          resumeDocument: {
            id: claimed.resumeDocument.id,
            objectKey: claimed.resumeDocument.objectKey,
            fileType: claimed.resumeDocument.fileType as ResumeFileType,
            organizationId: claimed.resumeDocument.organizationId,
          },
        };
      });
    },

    async completeProcessingJob(jobId, resumeDocumentId, organizationId, result) {
      await database.$transaction(async (tx) => {
        // Idempotency: skip if job has already succeeded
        const existingJob = await tx.processingJob.findUnique({
          where: { id: jobId },
          select: { status: true },
        });

        if (existingJob?.status === 'SUCCEEDED') {
          return;
        }

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

        await tx.processingJob.update({
          where: { id: jobId },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
          },
        });
      });
    },

    async failProcessingJob(jobId, resumeDocumentId, errorMessage, isPermanent) {
      await database.$transaction(async (tx) => {
        const current = await tx.processingJob.findUnique({
          where: { id: jobId },
          select: { attempts: true },
        });

        const attempts = current?.attempts ?? 1;
        const willFail = isPermanent || attempts >= 3;

        await tx.processingJob.update({
          where: { id: jobId },
          data: {
            status: willFail ? 'FAILED' : 'RETRYABLE_FAILURE',
            lastErrorCode: errorMessage.slice(0, 500),
            finishedAt: new Date(),
          },
        });

        if (willFail) {
          await tx.resumeDocument.update({
            where: { id: resumeDocumentId },
            data: { parseStatus: 'FAILED' },
          });
        }
      });
    },
  };
}
