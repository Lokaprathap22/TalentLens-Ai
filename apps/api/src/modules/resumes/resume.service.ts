import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  DocumentExtractionDto,
  DocumentStorageService,
  ResumeBatchUploadResult,
  ResumeDocumentDto,
  ResumeFileType,
} from './resume.types.js';
import {
  createResumeRepository,
  type FileToIngest,
  type ResumeRepository,
} from './resume.repository.js';
import { createDocumentStorageService, LocalDocumentStorageService } from './resume.storage.js';
import { createResumeScanner, type ResumeScanner } from './resume.scanner.js';
import { parseMultipartUpload, type ParsedUploadedFile } from './resume.multipart.js';
import {
  DocxTextExtractor,
  InvalidDocumentFormatError,
  SecurityLimitExceededError,
} from './resume.parser.js';
import type { IncomingMessage } from 'node:http';

function isSha256DuplicateConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const prismaErr = error as { code?: string; meta?: { target?: unknown } };
  if (prismaErr.code === 'P2002') {
    const target = prismaErr.meta?.target;
    if (Array.isArray(target) && target.includes('sha256') && target.includes('organizationId')) {
      return true;
    }
    if (
      typeof target === 'string' &&
      (target.includes('sha256') || target.includes('organization_id_sha256'))
    ) {
      return true;
    }
  }
  return false;
}

export class ResumeRoleError extends Error {
  constructor() {
    super('Recruiter role required');
    this.name = 'ResumeRoleError';
  }
}

export class RequisitionNotFoundError extends Error {
  constructor() {
    super('Requisition not found or not assigned to recruiter');
    this.name = 'RequisitionNotFoundError';
  }
}

export class ResumeNotFoundError extends Error {
  constructor() {
    super('Resume not found for requisition');
    this.name = 'ResumeNotFoundError';
  }
}

export class ExtractionNotFoundError extends Error {
  constructor() {
    super('Extraction result not found for resume');
    this.name = 'ExtractionNotFoundError';
  }
}

export interface ResumeServiceDependencies {
  repository?: ResumeRepository;
  storageService?: DocumentStorageService;
  scanner?: ResumeScanner;
}

export function createResumeService(dependencies: ResumeServiceDependencies = {}) {
  const repository = dependencies.repository ?? createResumeRepository();
  const storageService = dependencies.storageService ?? createDocumentStorageService();
  const scanner = dependencies.scanner ?? createResumeScanner();
  const docxExtractor = new DocxTextExtractor();

  function requireRecruiter(principal: AuthenticatedPrincipal): void {
    if (principal.role !== 'RECRUITER') {
      throw new ResumeRoleError();
    }
  }

  function getMimeType(fileType: ResumeFileType): string {
    return fileType === 'PDF'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  return {
    async uploadResumes(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      req: IncomingMessage,
    ): Promise<ResumeBatchUploadResult> {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );

      if (!requisition) {
        throw new RequisitionNotFoundError();
      }

      // Stream incoming multipart files to temporary directory
      const uploadedFiles: ParsedUploadedFile[] = await parseMultipartUpload(req);

      const acceptedFiles: FileToIngest[] = [];
      const duplicates: ResumeBatchUploadResult['duplicates'] = [];
      const rejected: ResumeBatchUploadResult['rejected'] = [];
      const savedStorageKeys: string[] = [];

      try {
        for (const file of uploadedFiles) {
          let fileBuffer: Buffer;

          // 1. Structure & format pre-validation
          try {
            fileBuffer = await (async () => {
              const fs = await import('node:fs/promises');
              return fs.readFile(file.tempPath);
            })();

            if (file.fileType === 'PDF') {
              if (!fileBuffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
                rejected.push({
                  fileName: file.sanitizedFileName,
                  reason: 'Invalid PDF signature',
                  status: 'REJECTED',
                });
                continue;
              }
            } else if (file.fileType === 'DOCX') {
              if (fileBuffer.length < 4 || fileBuffer.readUInt32LE(0) !== 0x04034b50) {
                rejected.push({
                  fileName: file.sanitizedFileName,
                  reason: 'Invalid DOCX/ZIP signature',
                  status: 'REJECTED',
                });
                continue;
              }

              // Verify docx structure has word/document.xml and is safe from zip bombs
              try {
                // Quick check through extractor
                await docxExtractor.parse(fileBuffer);
              } catch (err: unknown) {
                const message =
                  err instanceof SecurityLimitExceededError ||
                  err instanceof InvalidDocumentFormatError
                    ? err.message
                    : 'Corrupt or malformed DOCX archive structure';
                rejected.push({
                  fileName: file.sanitizedFileName,
                  reason: message,
                  status: 'REJECTED',
                });
                continue;
              }
            }
          } catch {
            rejected.push({
              fileName: file.sanitizedFileName,
              reason: 'Failed to inspect file structure',
              status: 'REJECTED',
            });
            continue;
          }

          // 1b. Antivirus malware scan boundary
          try {
            const scanResult = await scanner.scan(fileBuffer, file.sanitizedFileName);
            if (scanResult.status === 'INFECTED') {
              rejected.push({
                fileName: file.sanitizedFileName,
                reason: `Malware detected: ${scanResult.threatName ?? 'Malicious content'}`,
                status: 'REJECTED',
              });
              continue;
            }
            if (scanResult.status === 'ERROR') {
              const nodeEnv = process.env['NODE_ENV'];
              const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';
              const failClosed =
                process.env['SCANNER_FAIL_CLOSED'] !== 'false' || isProductionOrStaging;

              if (failClosed) {
                rejected.push({
                  fileName: file.sanitizedFileName,
                  reason: `Antivirus scanner unavailable: ${scanResult.errorMessage ?? 'Scanner error'}; upload quarantined`,
                  status: 'REJECTED',
                });
                continue;
              }
            }
          } catch (scanErr: unknown) {
            rejected.push({
              fileName: file.sanitizedFileName,
              reason: `Antivirus scanning exception: ${(scanErr as Error)?.message ?? 'Scanner error'}; upload quarantined`,
              status: 'REJECTED',
            });
            continue;
          }

          // 2. Duplicate detection within requisition (or organization when requisitionIds is omitted)
          const existing = await repository.findExistingResumeBySha256(
            principal.organizationId,
            file.sha256,
          );

          const isSameRequisitionDuplicate =
            existing &&
            (!existing.requisitionIds || existing.requisitionIds.includes(requisitionId));

          if (isSameRequisitionDuplicate) {
            duplicates.push({
              fileName: file.sanitizedFileName,
              sha256: file.sha256,
              resumeDocumentId: existing.id,
              status: 'DUPLICATE',
              message: 'An identical resume document already exists in this organization',
            });
            continue;
          }

          // 3. Move from temp into safe permanent storage
          const ext = file.fileType === 'PDF' ? 'pdf' : 'docx';
          const storageKey =
            storageService instanceof LocalDocumentStorageService
              ? storageService.generateKey(ext)
              : `${principal.organizationId}/${file.sha256}.${ext}`;

          await storageService.saveFromPath(storageKey, file.tempPath);
          savedStorageKeys.push(storageKey);

          acceptedFiles.push({
            storageKey,
            fileName: file.sanitizedFileName,
            fileType: file.fileType,
            mimeType: getMimeType(file.fileType),
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          });
        }

        // 4. Create database records in a transaction
        let batchId: string | null = null;
        let createdAccepted: ResumeBatchUploadResult['accepted'] = [];

        if (acceptedFiles.length > 0) {
          try {
            const createdBatch = await repository.createResumeBatch(
              principal,
              requisitionId,
              acceptedFiles,
              {
                totalUploaded: uploadedFiles.length,
                duplicates: duplicates.length,
                rejected: rejected.length,
              },
            );

            batchId = createdBatch.batchId;
            createdAccepted = createdBatch.accepted.map((item) => ({
              resumeDocumentId: item.resumeDocumentId,
              candidateId: item.candidateId,
              candidateCode: item.candidateCode,
              fileName: item.fileName,
              fileType: item.fileType,
              sizeBytes: item.sizeBytes,
              sha256: item.sha256,
              status: 'ACCEPTED',
            }));
          } catch (batchErr: unknown) {
            // Concurrent race check: if P2002 on organizationId_sha256 occurred,
            // re-query and classify conflicting files as duplicates gracefully.
            if (isSha256DuplicateConstraintError(batchErr)) {
              const remainingFilesToIngest: FileToIngest[] = [];
              for (const file of acceptedFiles) {
                const existing = await repository.findExistingResumeBySha256(
                  principal.organizationId,
                  file.sha256,
                );
                if (existing) {
                  duplicates.push({
                    fileName: file.fileName,
                    sha256: file.sha256,
                    resumeDocumentId: existing.id,
                    status: 'DUPLICATE',
                    message: 'An identical resume document already exists in this organization',
                  });
                  // Clean up storage file for the duplicate
                  await storageService.delete(file.storageKey).catch(() => {});
                  const idx = savedStorageKeys.indexOf(file.storageKey);
                  if (idx !== -1) savedStorageKeys.splice(idx, 1);
                } else {
                  remainingFilesToIngest.push(file);
                }
              }

              if (remainingFilesToIngest.length > 0) {
                const retriedBatch = await repository.createResumeBatch(
                  principal,
                  requisitionId,
                  remainingFilesToIngest,
                  {
                    totalUploaded: uploadedFiles.length,
                    duplicates: duplicates.length,
                    rejected: rejected.length,
                  },
                );
                batchId = retriedBatch.batchId;
                createdAccepted = retriedBatch.accepted.map((item) => ({
                  resumeDocumentId: item.resumeDocumentId,
                  candidateId: item.candidateId,
                  candidateCode: item.candidateCode,
                  fileName: item.fileName,
                  fileType: item.fileType,
                  sizeBytes: item.sizeBytes,
                  sha256: item.sha256,
                  status: 'ACCEPTED',
                }));
              }
            } else {
              throw batchErr;
            }
          }
        }

        return {
          batchId,
          totalFiles: uploadedFiles.length,
          acceptedCount: createdAccepted.length,
          duplicateCount: duplicates.length,
          rejectedCount: rejected.length,
          accepted: createdAccepted,
          duplicates,
          rejected,
        };
      } catch (err) {
        // Compensation on failure: clean up files written to permanent storage
        for (const key of savedStorageKeys) {
          await storageService.delete(key).catch(() => {});
        }
        throw err;
      } finally {
        // Clean up all temporary upload files
        for (const file of uploadedFiles) {
          await file.cleanup().catch(() => {});
        }
      }
    },

    async listResumes(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      limit = 50,
      offset = 0,
    ): Promise<ResumeDocumentDto[]> {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );

      if (!requisition) {
        throw new RequisitionNotFoundError();
      }

      return repository.listResumesForRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
        limit,
        offset,
      );
    },

    async getResumeDetails(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      resumeId: string,
    ): Promise<ResumeDocumentDto> {
      requireRecruiter(principal);

      const details = await repository.findResumeDetails(
        principal.organizationId,
        principal.userId,
        requisitionId,
        resumeId,
      );

      if (!details) {
        throw new ResumeNotFoundError();
      }

      return {
        id: details.id,
        candidateId: details.candidateId,
        candidateCode: details.candidateCode,
        fileName: details.fileName,
        fileType: details.fileType,
        sizeBytes: details.sizeBytes,
        sha256: details.sha256,
        parseStatus: details.parseStatus,
        uploadedAt: details.uploadedAt,
        updatedAt: details.updatedAt,
      };
    },

    async getExtraction(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      resumeId: string,
    ): Promise<DocumentExtractionDto> {
      requireRecruiter(principal);

      const extraction = await repository.findLatestExtraction(
        principal.organizationId,
        principal.userId,
        requisitionId,
        resumeId,
      );

      if (!extraction) {
        throw new ExtractionNotFoundError();
      }

      return {
        id: extraction.id,
        resumeDocumentId: extraction.resumeDocumentId,
        version: extraction.version,
        extractedText: extraction.extractedText,
        pageMap: extraction.pageMap,
        parser: extraction.parser,
        ocrUsed: extraction.ocrUsed,
        qualityStatus: extraction.qualityStatus,
        createdAt: extraction.createdAt.toISOString(),
      };
    },

    async getResumeFile(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      resumeId: string,
    ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
      requireRecruiter(principal);

      const details = await repository.findResumeDetails(
        principal.organizationId,
        principal.userId,
        requisitionId,
        resumeId,
      );

      if (!details) {
        throw new ResumeNotFoundError();
      }

      const buffer = await storageService.read(details.objectKey);

      if (typeof repository.recordResumeInspection === 'function') {
        await repository.recordResumeInspection(
          principal.organizationId,
          principal.userId,
          requisitionId,
          resumeId,
          details.candidateId,
        );
      }

      return {
        buffer,
        mimeType: getMimeType(details.fileType),
        fileName: details.fileName,
      };
    },

    async releaseHeldProcessingJobs(
      principal: AuthenticatedPrincipal,
      candidateId: string,
      requisitionId?: string,
    ): Promise<{ releasedCount: number; reason?: string }> {
      requireRecruiter(principal);
      return repository.releaseHeldProcessingJobs(
        principal.organizationId,
        candidateId,
        principal.userId,
        requisitionId,
      );
    },

    async reuseCandidateResumeForRequisition(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      candidateId: string,
      resumeDocumentId?: string,
    ) {
      requireRecruiter(principal);

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) {
        throw new RequisitionNotFoundError();
      }

      if (typeof repository.reuseCandidateResumeForRequisition !== 'function') {
        throw new ResumeNotFoundError();
      }

      const reused = await repository.reuseCandidateResumeForRequisition(
        principal,
        requisitionId,
        candidateId,
        resumeDocumentId,
      );
      if (!reused) {
        throw new ResumeNotFoundError();
      }

      return reused;
    },
  };
}

export type ResumeService = ReturnType<typeof createResumeService>;
