import {
  getDatabaseClient,
  Prisma,
  type PrismaClient,
  type ProcessingBatchStatus,
} from '@talentlens/database';
import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { MultipartUploadError, TooManyFilesError } from './resume.multipart.js';
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
  requisitionIds?: string[] | undefined;
}

export interface FileToIngest {
  storageKey: string;
  fileName: string;
  fileType: ResumeFileType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  clientFileId?: string | undefined;
  candidateId?: string | undefined;
}

export interface ReusedResumeRecord {
  batchId: string;
  jobId: string;
  jobStatus: string;
  resumeDocumentId: string;
  candidateId: string;
  candidateCode: string;
  requisitionId: string;
  version: number;
  parseStatus: ResumeParseStatus;
  isExisting: boolean;
}

export interface CreatedBatchRecord {
  batchId: string;
  accepted: Array<{
    clientFileId?: string | undefined;
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
    existingBatchId?: string,
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

  recordResumeInspection(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    resumeId: string,
    candidateId: string,
  ): Promise<void>;

  reuseCandidateResumeForRequisition?(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    resumeDocumentId?: string,
  ): Promise<ReusedResumeRecord | null>;

  finalizeBatch?(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    batchId: string,
  ): Promise<{ id: string; status: string; isOpen: boolean }>;

  getBatchStatus?(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    batchId: string,
  ): Promise<{ id: string; status: string; isOpen: boolean } | null>;
}

function hasConsistentValidExtraction(
  resume: {
    id: string;
    organizationId: string;
    parseStatus: string;
    version: number;
  },
  latestExtraction:
    | {
        id: string;
        resumeDocumentId: string;
        organizationId: string;
        version: number;
        qualityStatus: string;
        extractedText: string;
      }
    | null
    | undefined,
): boolean {
  if (resume.parseStatus !== 'PARSED') return false;
  if (!Number.isInteger(resume.version) || resume.version < 1) return false;
  if (!latestExtraction) return false;
  if (latestExtraction.resumeDocumentId !== resume.id) return false;
  if (latestExtraction.organizationId !== resume.organizationId) return false;
  if (!Number.isInteger(latestExtraction.version) || latestExtraction.version < 1) return false;
  if (latestExtraction.qualityStatus !== 'COMPLETE') return false;
  if (
    typeof latestExtraction.extractedText !== 'string' ||
    latestExtraction.extractedText.trim().length === 0
  ) {
    return false;
  }
  return true;
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
      const record = await database.resumeDocument.findFirst({
        where: {
          organizationId,
          sha256,
        },
        orderBy: { uploadedAt: 'asc' },
        select: {
          id: true,
          sha256: true,
          candidateId: true,
          processingJobs: {
            select: {
              batch: {
                select: { requisitionId: true },
              },
            },
          },
        },
      });
      if (!record) return null;
      const requisitionIds = Array.from(
        new Set(record.processingJobs.map((j) => j.batch.requisitionId)),
      );
      return {
        id: record.id,
        sha256: record.sha256,
        candidateId: record.candidateId,
        requisitionIds,
      };
    },

    async createResumeBatch(
      principal,
      requisitionId,
      filesToIngest,
      auditSummary,
      existingBatchId,
    ) {
      return database.$transaction(async (tx) => {
        let batch: { id: string };

        if (existingBatchId) {
          // Transactional row lock: serializes concurrent chunk requests on the same batch
          let foundBatch: {
            id: string;
            totalFiles: number;
            status: string;
            organizationId: string;
            requisitionId: string;
            isOpen?: boolean;
          } | null = null;

          if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
            const lockedRows = await tx.$queryRaw<
              Array<{
                id: string;
                total_files: number;
                status: string;
                organization_id: string;
                requisition_id: string;
                is_open?: boolean;
              }>
            >(Prisma.sql`
              SELECT id, total_files, status, organization_id, requisition_id, is_open
              FROM "processing_batches"
              WHERE id = ${existingBatchId}::uuid
                AND organization_id = ${principal.organizationId}::uuid
                AND requisition_id = ${requisitionId}::uuid
              FOR UPDATE
            `);
            if (lockedRows && lockedRows.length > 0 && lockedRows[0]) {
              foundBatch = {
                id: lockedRows[0].id,
                totalFiles: lockedRows[0].total_files,
                status: lockedRows[0].status,
                organizationId: lockedRows[0].organization_id,
                requisitionId: lockedRows[0].requisition_id,
                isOpen: lockedRows[0].is_open ?? true,
              };
            }
          } else {
            // Mock test fallback
            const mockFound = await tx.processingBatch.findFirst({
              where: {
                id: existingBatchId,
                organizationId: principal.organizationId,
                requisitionId,
              },
              select: { id: true, totalFiles: true, status: true, isOpen: true },
            });
            if (mockFound) {
              foundBatch = {
                id: mockFound.id,
                totalFiles: mockFound.totalFiles,
                status: mockFound.status,
                organizationId: principal.organizationId,
                requisitionId,
                isOpen: (mockFound as { isOpen?: boolean }).isOpen ?? true,
              };
            }
          }

          if (!foundBatch) {
            throw new MultipartUploadError(
              'Batch not found or requisition/organization ownership mismatch',
              404,
            );
          }

          // Reject appends to finalized or otherwise closed batches
          if (
            foundBatch.isOpen === false ||
            foundBatch.status === 'COMPLETED' ||
            foundBatch.status === 'COMPLETED_WITH_ERRORS' ||
            foundBatch.status === 'FAILED'
          ) {
            throw new MultipartUploadError(
              'Batch is closed or finalized; cannot append additional files',
              409,
            );
          }

          const newTotalFiles = foundBatch.totalFiles + filesToIngest.length;
          if (newTotalFiles > 500) {
            throw new TooManyFilesError(500);
          }

          // Count each unique ResumeDocument only once when aggregating bytes
          let existingBytes = 0;
          if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
            const byteSumRows = await tx.$queryRaw<
              Array<{ total_bytes: string | number | bigint }>
            >(
              Prisma.sql`
                SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes
                FROM "resume_documents"
                WHERE id IN (
                  SELECT DISTINCT resume_document_id
                  FROM "processing_jobs"
                  WHERE batch_id = ${foundBatch.id}::uuid
                    AND organization_id = ${principal.organizationId}::uuid
                    AND resume_document_id IS NOT NULL
                )
              `,
            );
            existingBytes = Number(byteSumRows[0]?.total_bytes ?? 0);
          } else {
            const distinctDocJobs = await tx.processingJob.findMany({
              where: {
                batchId: foundBatch.id,
                organizationId: principal.organizationId,
              },
              select: {
                resumeDocumentId: true,
                resumeDocument: { select: { sizeBytes: true } },
              },
            });
            const seenDocIds = new Set<string>();
            for (const j of distinctDocJobs) {
              if (j.resumeDocumentId && !seenDocIds.has(j.resumeDocumentId)) {
                seenDocIds.add(j.resumeDocumentId);
                existingBytes += Number(j.resumeDocument?.sizeBytes ?? 0);
              }
            }
          }

          const incomingBytes = filesToIngest.reduce((sum, f) => sum + f.sizeBytes, 0);
          if (existingBytes + incomingBytes > 1024 * 1024 * 1024) {
            throw new MultipartUploadError(
              'Batch exceeds maximum allowed cumulative size of 1 GB',
              413,
            );
          }

          batch = foundBatch;
          await tx.processingBatch.update({
            where: { id: batch.id },
            data: {
              totalFiles: newTotalFiles,
              cumulativeBytes: BigInt(existingBytes + incomingBytes),
              status: 'PROCESSING',
              updatedAt: new Date(),
            },
          });
        } else {
          if (filesToIngest.length > 500) {
            throw new TooManyFilesError(500);
          }
          const incomingBytes = filesToIngest.reduce((sum, f) => sum + f.sizeBytes, 0);
          if (incomingBytes > 1024 * 1024 * 1024) {
            throw new MultipartUploadError(
              'Batch exceeds maximum allowed cumulative size of 1 GB',
              413,
            );
          }
          batch = await tx.processingBatch.create({
            data: {
              organizationId: principal.organizationId,
              requisitionId,
              createdById: principal.userId,
              totalFiles: filesToIngest.length,
              cumulativeBytes: BigInt(incomingBytes),
              isOpen: true,
              status: 'CREATED',
            },
          });
        }

        const accepted: CreatedBatchRecord['accepted'] = [];

        for (const file of filesToIngest) {
          let candidate: { id: string; candidateCode: string };
          let resume: { id: string; parseStatus: string };

          if (file.candidateId) {
            const existingCandidate = await tx.candidate.findFirst({
              where: {
                id: file.candidateId,
                organizationId: principal.organizationId,
              },
              include: {
                resumes: {
                  orderBy: { version: 'desc' },
                },
              },
            });

            if (!existingCandidate) {
              throw new Error('CANDIDATE_NOT_FOUND');
            }

            candidate = {
              id: existingCandidate.id,
              candidateCode: existingCandidate.candidateCode,
            };

            const existingSameHash = existingCandidate.resumes.find(
              (r) => r.sha256 === file.sha256,
            );

            if (existingSameHash) {
              resume = {
                id: existingSameHash.id,
                parseStatus: existingSameHash.parseStatus,
              };
            } else {
              const nextVersion = (existingCandidate.resumes[0]?.version ?? 0) + 1;
              const createdResume = await tx.resumeDocument.create({
                data: {
                  organizationId: principal.organizationId,
                  candidateId: candidate.id,
                  objectKey: file.storageKey,
                  sha256: file.sha256,
                  mimeType: file.mimeType,
                  fileType: file.fileType,
                  sizeBytes: BigInt(file.sizeBytes),
                  version: nextVersion,
                  parseStatus: 'PENDING',
                  uploadedById: principal.userId,
                },
              });
              resume = {
                id: createdResume.id,
                parseStatus: createdResume.parseStatus,
              };
            }
          } else {
            // 1. Create a distinct candidate placeholder for this document
            const candidateCode = `CAN-${randomUUID().slice(0, 8).toUpperCase()}`;
            candidate = await tx.candidate.create({
              data: {
                organizationId: principal.organizationId,
                candidateCode,
                recordStatus: 'ACTIVE',
              },
            });

            // 2. Create the ResumeDocument
            const createdResume = await tx.resumeDocument.create({
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
            resume = {
              id: createdResume.id,
              parseStatus: createdResume.parseStatus,
            };
          }

          // 3. Create the ProcessingJob (held for authorization unless genuine active consent exists)
          const activeConsent = await tx.candidateConsent.findFirst({
            where: {
              organizationId: principal.organizationId,
              candidateId: candidate.id,
              purpose: 'HIRING_USE',
              status: 'ACTIVE',
              withdrawnAt: null,
              policyVersion: { not: '' },
              requisitionId,
            },
            select: { id: true },
          });

          const initialJobStatus = activeConsent
            ? resume.parseStatus === 'PARSED'
              ? 'SUCCEEDED'
              : 'QUEUED'
            : 'HELD_FOR_AUTHORIZATION';

          await tx.processingJob.create({
            data: {
              batchId: batch.id,
              organizationId: principal.organizationId,
              resumeDocumentId: resume.id,
              jobType: 'EXTRACT_TEXT',
              status: initialJobStatus,
              attempts: 0,
              ...(initialJobStatus === 'SUCCEEDED' ? { finishedAt: new Date() } : {}),
            },
          });

          accepted.push({
            clientFileId: file.clientFileId,
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
            requisitionId: candidateJob.requisition_id,
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
              lease_expires_at = clock_timestamp() + (${leaseDurationMinutes} * INTERVAL '1 minute'),
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
        SET lease_expires_at = clock_timestamp() + (${extensionMinutes} * INTERVAL '1 minute'),
            updated_at = NOW()
        WHERE id = ${jobId}::uuid
          AND status = 'PROCESSING'
          AND lease_token = ${leaseToken}::uuid
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > clock_timestamp()
      `);
      return updated > 0;
    },

    async completeProcessingJob(jobId, resumeDocumentId, organizationId, result, leaseToken) {
      return database.$transaction(async (tx) => {
        // Global lock order: lock candidate FIRST (FOR UPDATE OF c) before reading/locking processing_jobs
        if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
            Prisma.sql`
              SELECT c.id, c.record_status
              FROM "candidates" c
              JOIN "resume_documents" rd ON rd.candidate_id = c.id
              WHERE rd.id = ${resumeDocumentId}::uuid
                AND c.organization_id = ${organizationId}::uuid
              FOR UPDATE OF c
            `,
          );
          const candidateRow = candidateRows[0];
          if (!candidateRow || candidateRow.record_status !== 'ACTIVE') {
            if (leaseToken) {
              const errorCode = candidateRow ? 'CANDIDATE_DELETION_PENDING' : 'CANDIDATE_NOT_FOUND';
              await tx.$executeRaw(Prisma.sql`
                UPDATE "processing_jobs"
                SET status = 'FAILED',
                    last_error_code = ${errorCode},
                    lease_expires_at = NULL,
                    locked_by = NULL,
                    lease_token = NULL,
                    updated_at = NOW()
                WHERE id = ${jobId}::uuid
                  AND status = 'PROCESSING'
                  AND lease_token = ${leaseToken}::uuid
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at > clock_timestamp()
              `);
            }
            return false;
          }
        }

        // 1. Re-verify active authorization
        const job = await tx.processingJob.findUnique({
          where: { id: jobId },
          select: { batchId: true, batch: { select: { requisitionId: true } } },
        });

        if (!job?.batch?.requisitionId) {
          return false;
        }

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
            requisitionId: job.batch.requisitionId,
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
                AND status = 'PROCESSING'
                AND lease_token = ${leaseToken}::uuid
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at > clock_timestamp()
            `);
          }
          return false;
        }

        // 2. Fenced update conditional on current lease owner and unexpired lease
        let updatedCount: number;
        if (leaseToken) {
          const leaseLock = await tx.$executeRaw(Prisma.sql`
            SELECT id FROM "processing_jobs"
            WHERE id = ${jobId}::uuid
              AND status = 'PROCESSING'
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
            FOR UPDATE
          `);
          if (leaseLock === 0) {
            return false;
          }

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
              AND lease_expires_at > clock_timestamp()
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

        // 3. Check whether a consistent valid extraction already exists for this document
        const existingDoc = await tx.resumeDocument.findFirst({
          where: { id: resumeDocumentId, organizationId },
          select: {
            id: true,
            organizationId: true,
            parseStatus: true,
            version: true,
            extractions: {
              where: { organizationId },
              orderBy: { version: 'desc' },
              take: 1,
              select: {
                id: true,
                resumeDocumentId: true,
                organizationId: true,
                version: true,
                qualityStatus: true,
                extractedText: true,
              },
            },
          },
        });

        const alreadyValidlyParsed = existingDoc
          ? hasConsistentValidExtraction(existingDoc, existingDoc.extractions[0])
          : false;

        if (!alreadyValidlyParsed) {
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
        }

        if (job.batchId) {
          const pendingInBatch = await tx.processingJob.count({
            where: {
              batchId: job.batchId,
              organizationId,
              status: {
                in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'],
              },
            },
          });
          if (pendingInBatch === 0) {
            const batchRows =
              typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function'
                ? await tx.$queryRaw<Array<{ is_open: boolean }>>(Prisma.sql`
                    SELECT is_open
                    FROM "processing_batches"
                    WHERE id = ${job.batchId}::uuid
                      AND organization_id = ${organizationId}::uuid
                    FOR UPDATE
                  `)
                : await tx.processingBatch
                    .findUnique({
                      where: { id: job.batchId },
                      select: { isOpen: true },
                    })
                    .then((b) => (b ? [{ is_open: b.isOpen }] : []));
            // An early chunk finishing must not mark an intake-open batch permanently completed
            if (batchRows[0]?.is_open === false) {
              const recheckedPending = await tx.processingJob.count({
                where: {
                  batchId: job.batchId,
                  organizationId,
                  status: {
                    in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'],
                  },
                },
              });
              if (recheckedPending === 0) {
                const failedCount = await tx.processingJob.count({
                  where: {
                    batchId: job.batchId,
                    organizationId,
                    status: { in: ['FAILED', 'CANCELLED'] },
                  },
                });
                const finalStatus = failedCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
                await tx.processingBatch.updateMany({
                  where: {
                    id: job.batchId,
                    organizationId,
                    status: { notIn: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] },
                  },
                  data: { status: finalStatus },
                });
              }
            }
          }
        }

        return true;
      });
    },

    async failProcessingJob(jobId, resumeDocumentId, errorMessage, isPermanent, leaseToken) {
      return database.$transaction(async (tx) => {
        // Global lock order: lock candidate FIRST (if still present) before updating processing_jobs
        let candidateIsActive = true;
        if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
          if (resumeDocumentId) {
            const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
              Prisma.sql`
                SELECT c.id, c.record_status
                FROM "candidates" c
                JOIN "resume_documents" rd ON rd.candidate_id = c.id
                WHERE rd.id = ${resumeDocumentId}::uuid
                FOR UPDATE OF c
              `,
            );
            candidateIsActive = candidateRows[0]?.record_status === 'ACTIVE';
          } else {
            candidateIsActive = false;
          }
        }

        const current = await tx.processingJob.findUnique({
          where: { id: jobId },
          select: { attempts: true },
        });

        const attempts = current?.attempts ?? 1;
        const willFail = isPermanent || attempts >= 3;
        const nextStatus = willFail ? 'FAILED' : 'RETRYABLE_FAILURE';

        let updatedCount: number;
        if (leaseToken) {
          const leaseLock = await tx.$executeRaw(Prisma.sql`
            SELECT id FROM "processing_jobs"
            WHERE id = ${jobId}::uuid
              AND status = 'PROCESSING'
              AND lease_token = ${leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
            FOR UPDATE
          `);
          if (leaseLock === 0) {
            return false;
          }

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
              AND lease_expires_at > clock_timestamp()
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
          if (candidateIsActive && resumeDocumentId) {
            await tx.resumeDocument.update({
              where: { id: resumeDocumentId },
              data: { parseStatus: 'FAILED' },
            });
          }

          const failedJob = await tx.processingJob.findUnique({
            where: { id: jobId },
            select: { batchId: true, organizationId: true },
          });
          if (failedJob?.batchId) {
            const pendingInBatch = await tx.processingJob.count({
              where: {
                batchId: failedJob.batchId,
                organizationId: failedJob.organizationId,
                status: {
                  in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'],
                },
              },
            });
            if (pendingInBatch === 0) {
              const batchRows =
                typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function'
                  ? await tx.$queryRaw<Array<{ is_open: boolean }>>(Prisma.sql`
                      SELECT is_open
                      FROM "processing_batches"
                      WHERE id = ${failedJob.batchId}::uuid
                        AND organization_id = ${failedJob.organizationId}::uuid
                      FOR UPDATE
                    `)
                  : await tx.processingBatch
                      .findUnique({
                        where: { id: failedJob.batchId },
                        select: { isOpen: true },
                      })
                      .then((b) => (b ? [{ is_open: b.isOpen }] : []));
              if (batchRows[0]?.is_open === false) {
                const recheckedPending = await tx.processingJob.count({
                  where: {
                    batchId: failedJob.batchId,
                    organizationId: failedJob.organizationId,
                    status: {
                      in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'],
                    },
                  },
                });
                if (recheckedPending === 0) {
                  const successCount = await tx.processingJob.count({
                    where: {
                      batchId: failedJob.batchId,
                      organizationId: failedJob.organizationId,
                      status: 'SUCCEEDED',
                    },
                  });
                  const finalStatus = successCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'FAILED';
                  await tx.processingBatch.updateMany({
                    where: {
                      id: failedJob.batchId,
                      organizationId: failedJob.organizationId,
                      status: { notIn: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] },
                    },
                    data: { status: finalStatus },
                  });
                }
              }
            }
          }
        }

        return updatedCount > 0;
      });
    },

    async releaseHeldProcessingJobs(organizationId, candidateId, recruiterId, requisitionId) {
      return database.$transaction(async (tx) => {
        let candidateStatus: string | undefined;
        if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
            Prisma.sql`
              SELECT id, record_status
              FROM "candidates"
              WHERE id = ${candidateId}::uuid
                AND organization_id = ${organizationId}::uuid
              FOR UPDATE
            `,
          );
          candidateStatus = candidateRows[0]?.record_status;
        } else {
          const candidate = await tx.candidate.findFirst({
            where: { id: candidateId, organizationId },
            select: { id: true, recordStatus: true },
          });
          candidateStatus = candidate?.recordStatus ?? (candidate ? 'ACTIVE' : undefined);
        }

        if (!candidateStatus) {
          return { releasedCount: 0, reason: 'CANDIDATE_NOT_FOUND' };
        }

        if (candidateStatus !== 'ACTIVE') {
          return { releasedCount: 0, reason: 'CANDIDATE_NOT_ACTIVE' };
        }

        const activeConsents = await tx.candidateConsent.findMany({
          where: {
            organizationId,
            candidateId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
            captureMethod: { in: ['RECRUITER_RECORDED', 'CANDIDATE_PORTAL', 'IMPORTED'] },
            requisitionId: requisitionId ? requisitionId : { not: null },
          },
          select: { id: true, requisitionId: true },
        });

        if (activeConsents.length === 0) {
          return { releasedCount: 0, reason: 'NO_ACTIVE_VALID_CONSENT' };
        }

        const consentedRequisitionIds = activeConsents
          .map((c) => c.requisitionId)
          .filter((id): id is string => typeof id === 'string');

        // Find candidate's held jobs in this organization strictly matching consented requisitions
        const heldJobs = await tx.processingJob.findMany({
          where: {
            organizationId,
            status: 'HELD_FOR_AUTHORIZATION',
            resumeDocument: {
              candidateId,
              organizationId,
            },
            batch: {
              requisitionId: { in: consentedRequisitionIds },
            },
          },
          include: {
            batch: {
              select: { id: true, requisitionId: true },
            },
            resumeDocument: {
              select: {
                id: true,
                organizationId: true,
                parseStatus: true,
                version: true,
                extractions: {
                  where: { organizationId },
                  orderBy: { version: 'desc' },
                  take: 1,
                  select: {
                    id: true,
                    resumeDocumentId: true,
                    organizationId: true,
                    version: true,
                    qualityStatus: true,
                    extractedText: true,
                  },
                },
              },
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

        const authorizedSet = new Set(authorizedRequisitionIds);
        const authorizedHeldJobs = heldJobs.filter((j) => authorizedSet.has(j.batch.requisitionId));

        const alreadyParsedJobIds: string[] = [];
        const alreadyParsedBatchIds = new Set<string>();
        const jobsToQueueIds: string[] = [];
        const inconsistentResumeIds = new Set<string>();

        for (const job of authorizedHeldJobs) {
          if (job.jobType === 'EXTRACT_TEXT' && job.resumeDocument) {
            const latestExtraction = job.resumeDocument.extractions[0];
            const isValid = hasConsistentValidExtraction(job.resumeDocument, latestExtraction);
            if (isValid) {
              alreadyParsedJobIds.push(job.id);
              alreadyParsedBatchIds.add(job.batchId);
            } else {
              if (job.resumeDocument.parseStatus === 'PARSED') {
                inconsistentResumeIds.add(job.resumeDocument.id);
              }
              jobsToQueueIds.push(job.id);
            }
          } else {
            jobsToQueueIds.push(job.id);
          }
        }

        if (inconsistentResumeIds.size > 0) {
          await tx.resumeDocument.updateMany({
            where: {
              id: { in: Array.from(inconsistentResumeIds) },
              organizationId,
            },
            data: {
              parseStatus: 'PENDING',
            },
          });
        }

        let totalReleasedCount = 0;

        if (alreadyParsedJobIds.length > 0) {
          const completedRes = await tx.processingJob.updateMany({
            where: {
              id: { in: alreadyParsedJobIds },
              organizationId,
              status: 'HELD_FOR_AUTHORIZATION',
            },
            data: {
              status: 'SUCCEEDED',
              finishedAt: new Date(),
              leaseExpiresAt: null,
              lockedBy: null,
              leaseToken: null,
            },
          });
          totalReleasedCount += completedRes.count;

          for (const batchId of Array.from(alreadyParsedBatchIds).sort()) {
            let batchIsOpen = false;
            let batchStatus = '';
            if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
              const lockedBatches = await tx.$queryRaw<
                Array<{ is_open: boolean; status: string }>
              >(Prisma.sql`
                SELECT is_open, status::text AS status
                FROM "processing_batches"
                WHERE id = ${batchId}::uuid
                  AND organization_id = ${organizationId}::uuid
                FOR UPDATE
              `);
              if (!lockedBatches[0]) continue;
              batchIsOpen = lockedBatches[0].is_open;
              batchStatus = lockedBatches[0].status;
            } else {
              const batch = await tx.processingBatch.findFirst({
                where: { id: batchId, organizationId },
                select: { isOpen: true, status: true },
              });
              if (!batch) continue;
              batchIsOpen = batch.isOpen;
              batchStatus = batch.status;
            }

            if (
              batchIsOpen ||
              batchStatus === 'COMPLETED' ||
              batchStatus === 'COMPLETED_WITH_ERRORS' ||
              batchStatus === 'FAILED'
            ) {
              continue;
            }

            const remainingPending = await tx.processingJob.count({
              where: {
                batchId,
                organizationId,
                status: {
                  in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'],
                },
              },
            });
            if (remainingPending === 0) {
              const failedCount = await tx.processingJob.count({
                where: {
                  batchId,
                  organizationId,
                  status: { in: ['FAILED', 'CANCELLED'] },
                },
              });
              const targetStatus = failedCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
              await tx.processingBatch.updateMany({
                where: {
                  id: batchId,
                  organizationId,
                  status: { notIn: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] },
                },
                data: { status: targetStatus },
              });
            }
          }
        }

        if (jobsToQueueIds.length > 0) {
          const queuedRes = await tx.processingJob.updateMany({
            where: {
              id: { in: jobsToQueueIds },
              organizationId,
              status: 'HELD_FOR_AUTHORIZATION',
            },
            data: {
              status: 'QUEUED',
              leaseExpiresAt: null,
              lockedBy: null,
              leaseToken: null,
            },
          });
          totalReleasedCount += queuedRes.count;
        }

        if (totalReleasedCount > 0) {
          await tx.auditLog.create({
            data: {
              organizationId,
              action: 'PROCESSING_JOBS_RELEASED_FOR_AUTHORIZATION',
              resourceType: 'Candidate',
              resourceId: candidateId,
              metadataJson: {
                releasedCount: totalReleasedCount,
                reusedCompletedCount: alreadyParsedJobIds.length,
                queuedCount: jobsToQueueIds.length,
                consentIds: activeConsents.map((c) => c.id),
                requisitionIds: authorizedRequisitionIds,
                recruiterId: recruiterId ?? null,
              },
            },
          });
        }

        return { releasedCount: totalReleasedCount };
      });
    },

    async holdProcessingJobsForRevokedConsent(organizationId, candidateId) {
      return database.$transaction(async (tx) => {
        // Global lock order: lock candidate FIRST before updating processing_jobs
        if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM "candidates"
            WHERE id = ${candidateId}::uuid
              AND organization_id = ${organizationId}::uuid
            FOR UPDATE
          `);
        }

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

    async recordResumeInspection(
      organizationId,
      recruiterId,
      requisitionId,
      resumeId,
      candidateId,
    ) {
      await database.auditLog.create({
        data: {
          organizationId,
          actorId: recruiterId,
          action: 'ORIGINAL_RESUME_INSPECTED',
          resourceType: 'ResumeDocument',
          resourceId: resumeId,
          requisitionId,
          candidateId,
          metadataJson: {
            resumeDocumentId: resumeId,
            inspectedAt: new Date().toISOString(),
          },
        },
      });
    },

    async reuseCandidateResumeForRequisition(
      principal,
      requisitionId,
      candidateId,
      resumeDocumentId,
    ) {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await database.$transaction(async (tx) => {
            const req = await tx.requisition.findFirst({
              where: {
                id: requisitionId,
                organizationId: principal.organizationId,
                assignedRecruiterId: principal.userId,
              },
              select: { id: true },
            });
            if (!req) return null;

            // Global lock order: lock candidate FIRST (FOR UPDATE), verify ACTIVE, THEN lock target ResumeDocument
            const candidateRows = await tx.$queryRaw<
              Array<{ id: string; candidate_code: string; record_status: string }>
            >(Prisma.sql`
              SELECT id, candidate_code, record_status
              FROM "candidates"
              WHERE id = ${candidateId}::uuid
                AND organization_id = ${principal.organizationId}::uuid
              FOR UPDATE
            `);
            const lockedCandidate = candidateRows[0];
            if (!lockedCandidate || lockedCandidate.record_status !== 'ACTIVE') {
              return null;
            }

            const lockedDocs = resumeDocumentId
              ? await tx.$queryRaw<
                  Array<{
                    id: string;
                    organization_id: string;
                    candidate_id: string;
                    version: number;
                    parse_status: string;
                  }>
                >(Prisma.sql`
                  SELECT
                    id,
                    organization_id,
                    candidate_id,
                    version,
                    parse_status::text AS parse_status
                  FROM "resume_documents"
                  WHERE id = ${resumeDocumentId}::uuid
                    AND candidate_id = ${candidateId}::uuid
                    AND organization_id = ${principal.organizationId}::uuid
                  LIMIT 1
                  FOR UPDATE
                `)
              : await tx.$queryRaw<
                  Array<{
                    id: string;
                    organization_id: string;
                    candidate_id: string;
                    version: number;
                    parse_status: string;
                  }>
                >(Prisma.sql`
                  SELECT
                    id,
                    organization_id,
                    candidate_id,
                    version,
                    parse_status::text AS parse_status
                  FROM "resume_documents"
                  WHERE candidate_id = ${candidateId}::uuid
                    AND organization_id = ${principal.organizationId}::uuid
                  ORDER BY version DESC
                  LIMIT 1
                  FOR UPDATE
                `);

            const locked = lockedDocs[0];
            if (!locked) return null;

            const candidate = {
              id: lockedCandidate.id,
              candidateCode: lockedCandidate.candidate_code,
            };
            const resume = {
              id: locked.id,
              organizationId: locked.organization_id,
              version: Number(locked.version),
              parseStatus: locked.parse_status as ResumeParseStatus,
            };

            const latestExtraction = await tx.documentExtraction.findFirst({
              where: {
                resumeDocumentId: resume.id,
                organizationId: principal.organizationId,
              },
              orderBy: { version: 'desc' },
              select: {
                id: true,
                resumeDocumentId: true,
                organizationId: true,
                version: true,
                qualityStatus: true,
                extractedText: true,
              },
            });

            const isValidlyParsed = hasConsistentValidExtraction(resume, latestExtraction);
            let effectiveParseStatus = resume.parseStatus;

            if (!isValidlyParsed && resume.parseStatus === 'PARSED') {
              await tx.resumeDocument.update({
                where: { id: resume.id },
                data: { parseStatus: 'PENDING' },
              });
              effectiveParseStatus = 'PENDING';
            }

            const existingJob = await tx.processingJob.findFirst({
              where: {
                organizationId: principal.organizationId,
                resumeDocumentId: resume.id,
                batch: {
                  requisitionId,
                  organizationId: principal.organizationId,
                },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true, batchId: true, status: true },
            });

            if (existingJob) {
              return {
                batchId: existingJob.batchId,
                jobId: existingJob.id,
                jobStatus: existingJob.status,
                resumeDocumentId: resume.id,
                candidateId: candidate.id,
                candidateCode: candidate.candidateCode,
                requisitionId,
                version: resume.version,
                parseStatus: effectiveParseStatus,
                isExisting: true,
              };
            }

            const activeConsent = await tx.candidateConsent.findFirst({
              where: {
                organizationId: principal.organizationId,
                candidateId: candidate.id,
                requisitionId,
                purpose: 'HIRING_USE',
                status: 'ACTIVE',
                withdrawnAt: null,
                policyVersion: { not: '' },
              },
              select: { id: true },
            });

            const initialJobStatus = activeConsent
              ? isValidlyParsed
                ? 'SUCCEEDED'
                : 'QUEUED'
              : 'HELD_FOR_AUTHORIZATION';

            const batch = await tx.processingBatch.create({
              data: {
                organizationId: principal.organizationId,
                requisitionId,
                createdById: principal.userId,
                totalFiles: 1,
                isOpen: false,
                status: initialJobStatus === 'SUCCEEDED' ? 'COMPLETED' : 'CREATED',
              },
            });

            const job = await tx.processingJob.create({
              data: {
                batchId: batch.id,
                organizationId: principal.organizationId,
                resumeDocumentId: resume.id,
                jobType: 'EXTRACT_TEXT',
                status: initialJobStatus,
                attempts: 0,
                ...(initialJobStatus === 'SUCCEEDED' ? { finishedAt: new Date() } : {}),
              },
            });

            await tx.auditLog.create({
              data: {
                organizationId: principal.organizationId,
                actorId: principal.userId,
                action: 'CANDIDATE_RESUME_REUSED_FOR_REQUISITION',
                resourceType: 'ResumeDocument',
                resourceId: resume.id,
                requisitionId,
                candidateId: candidate.id,
                metadataJson: {
                  resumeDocumentId: resume.id,
                  version: resume.version,
                  batchId: batch.id,
                  jobId: job.id,
                  jobStatus: job.status,
                },
              },
            });

            return {
              batchId: batch.id,
              jobId: job.id,
              jobStatus: job.status,
              resumeDocumentId: resume.id,
              candidateId: candidate.id,
              candidateCode: candidate.candidateCode,
              requisitionId,
              version: resume.version,
              parseStatus: effectiveParseStatus,
              isExisting: false,
            };
          });
        } catch (err: unknown) {
          const isSerializationConflict =
            (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') ||
            (err instanceof Error &&
              (err.message.includes('40001') ||
                err.message.includes('40P01') ||
                err.message.includes('could not serialize access')));
          if (isSerializationConflict && attempt < maxAttempts) {
            continue;
          }
          throw err;
        }
      }
      return null;
    },

    async finalizeBatch(principal, requisitionId, batchId) {
      return database.$transaction(async (tx) => {
        // Lock processing_batches row FOR UPDATE to serialize against concurrent chunk appends
        let batch: { id: string; status: ProcessingBatchStatus; isOpen: boolean } | null = null;
        if (typeof (tx as unknown as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const lockedRows = await tx.$queryRaw<
            Array<{ id: string; status: ProcessingBatchStatus; is_open: boolean }>
          >(Prisma.sql`
            SELECT id, status::text AS status, is_open
            FROM "processing_batches"
            WHERE id = ${batchId}::uuid
              AND organization_id = ${principal.organizationId}::uuid
              AND requisition_id = ${requisitionId}::uuid
            FOR UPDATE
          `);
          const first = lockedRows[0];
          if (first) {
            batch = { id: first.id, status: first.status, isOpen: first.is_open };
          }
        } else {
          const found = await tx.processingBatch.findFirst({
            where: {
              id: batchId,
              organizationId: principal.organizationId,
              requisitionId,
            },
            select: { id: true, status: true, isOpen: true },
          });
          if (found) {
            batch = { id: found.id, status: found.status, isOpen: found.isOpen };
          }
        }

        if (!batch) {
          throw new MultipartUploadError('Batch not found or ownership mismatch', 404);
        }

        if (
          !batch.isOpen &&
          (batch.status === 'COMPLETED' ||
            batch.status === 'COMPLETED_WITH_ERRORS' ||
            batch.status === 'FAILED')
        ) {
          return {
            id: batch.id,
            status: batch.status,
            isOpen: false,
          };
        }

        const remaining = await tx.processingJob.count({
          where: {
            batchId,
            organizationId: principal.organizationId,
            status: { in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'] },
          },
        });

        let newStatus: ProcessingBatchStatus = batch.status;
        if (remaining === 0) {
          const failedCount = await tx.processingJob.count({
            where: {
              batchId,
              organizationId: principal.organizationId,
              status: { in: ['FAILED', 'CANCELLED'] },
            },
          });
          newStatus = failedCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
        }

        const updated = await tx.processingBatch.update({
          where: { id: batchId },
          data: {
            isOpen: false,
            status: newStatus,
            updatedAt: new Date(),
          },
          select: { id: true, status: true, isOpen: true },
        });

        return updated;
      });
    },

    async getBatchStatus(principal, requisitionId, batchId) {
      const batch = await database.processingBatch.findFirst({
        where: {
          id: batchId,
          organizationId: principal.organizationId,
          requisitionId,
        },
        select: {
          id: true,
          status: true,
          isOpen: true,
        },
      });
      return batch ? { id: batch.id, status: batch.status, isOpen: batch.isOpen } : null;
    },
  };
}
