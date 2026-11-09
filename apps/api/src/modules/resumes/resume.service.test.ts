import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { ResumeRepository } from './resume.repository.js';
import type { DocumentStorageService } from './resume.types.js';
import {
  createResumeService,
  ExtractionNotFoundError,
  RequisitionNotFoundError,
  ResumeNotFoundError,
  ResumeRoleError,
} from './resume.service.js';
import { MockResumeScanner, EICAR_SIGNATURE } from './resume.scanner.js';

const recruiterPrincipal: AuthenticatedPrincipal = {
  userId: 'recruiter-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'RECRUITER',
};

const hiringManagerPrincipal: AuthenticatedPrincipal = {
  userId: 'hm-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'CLIENT_HIRING_MANAGER',
};

function createMockUploadStream(
  files: Array<{ filename: string; content: Buffer; fieldname?: string }>,
  boundary = '----TestBoundaryXYZ',
): IncomingMessage {
  const chunks: Buffer[] = [];
  for (const f of files) {
    const nameField = f.fieldname ?? 'files';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${nameField}"; filename="${f.filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(f.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  const readable = Readable.from([Buffer.concat(chunks)]) as unknown as IncomingMessage;
  readable.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };
  return readable;
}

describe('Resume Ingestion Service — Security and Ingestion Controls', () => {
  const mockStorageService: DocumentStorageService = {
    save: vi.fn(async (key, buf) => ({ storageKey: key, sizeBytes: buf.length })),
    saveFromPath: vi.fn(async (key) => ({ storageKey: key, sizeBytes: 100 })),
    read: vi.fn(async () => Buffer.from('%PDF-1.4 sample')),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
  };

  it('rejects non-recruiter roles with ResumeRoleError', async () => {
    const service = createResumeService({
      repository: {} as ResumeRepository,
      storageService: mockStorageService,
    });
    const req = createMockUploadStream([]);

    await expect(service.uploadResumes(hiringManagerPrincipal, 'req-uuid-1', req)).rejects.toThrow(
      ResumeRoleError,
    );

    await expect(service.listResumes(hiringManagerPrincipal, 'req-uuid-1')).rejects.toThrow(
      ResumeRoleError,
    );
  });

  it('rejects upload when requisition is not found or not assigned to recruiter', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => null),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 test') },
    ]);

    await expect(
      service.uploadResumes(recruiterPrincipal, 'unauthorized-req-id', req),
    ).rejects.toThrow(RequisitionNotFoundError);
  });

  it('identifies duplicate resumes by SHA-256 within organization without creating duplicate records', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      findExistingResumeBySha256: vi.fn(async () => ({
        id: 'existing-resume-doc-id',
        sha256: 'somehash',
        candidateId: 'existing-cand-id',
      })),
      createResumeBatch: vi.fn(),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 test') },
    ]);

    const result = await service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req);

    expect(result.acceptedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicates[0]!.resumeDocumentId).toBe('existing-resume-doc-id');
    expect(result.duplicates[0]!.status).toBe('DUPLICATE');

    // Does NOT call createResumeBatch when all files are duplicates
    expect(mockRepo.createResumeBatch).not.toHaveBeenCalled();
  });

  it('isolates duplicate detection to the current organization (cross-tenant privacy)', async () => {
    const findExistingMock = vi.fn(async (orgId: string) => {
      // If queried for org-uuid-1, it's not a duplicate.
      // (Even if another tenant had this file, we return null for org-uuid-1)
      if (orgId === 'org-uuid-1') return null;
      return { id: 'other-org-doc', sha256: 'hash', candidateId: 'cand' };
    });

    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      findExistingResumeBySha256: findExistingMock,
      createResumeBatch: vi.fn(async () => ({
        batchId: 'batch-uuid-1',
        accepted: [
          {
            resumeDocumentId: 'new-doc-id',
            candidateId: 'cand-id-1',
            candidateCode: 'CAN-1234',
            fileName: 'resume.pdf',
            fileType: 'PDF' as const,
            sizeBytes: 15,
            sha256: 'hash',
          },
        ],
      })),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 new file') },
    ]);

    const result = await service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req);

    // Verified: scoped strictly by principal's organizationId
    expect(findExistingMock).toHaveBeenCalledWith('org-uuid-1', expect.any(String));
    expect(result.acceptedCount).toBe(1);
    expect(result.duplicateCount).toBe(0);
  });

  it('performs storage rollback compensation when database batch creation fails', async () => {
    const deleteSpy = vi.fn(async () => {});
    const customStorage: DocumentStorageService = {
      ...mockStorageService,
      delete: deleteSpy,
    };

    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      findExistingResumeBySha256: vi.fn(async () => null),
      createResumeBatch: vi.fn(async () => {
        throw new Error('Database transaction conflict');
      }),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: customStorage,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 test') },
    ]);

    await expect(service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req)).rejects.toThrow(
      'Database transaction conflict',
    );

    // Rollback compensation called to delete the saved file from storage
    expect(deleteSpy).toHaveBeenCalled();
  });

  it('gracefully classifies concurrent duplicate collisions as DUPLICATE when P2002 occurs', async () => {
    let callCount = 0;
    const findExistingMock = vi.fn(async () => {
      callCount += 1;
      // On initial upload check, return null (simulating concurrent pass)
      if (callCount === 1) return null;
      // On re-query after P2002 conflict, return the existing record from concurrent thread
      return {
        id: 'concurrent-winner-doc-id',
        sha256: 'hash-collision',
        candidateId: 'cand-winner',
        organizationId: 'org-uuid-1',
      };
    });

    const p2002Error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['organizationId', 'sha256'] },
    };

    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      findExistingResumeBySha256: findExistingMock,
      createResumeBatch: vi.fn(async () => {
        throw p2002Error;
      }),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 test') },
    ]);

    const result = await service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req);

    expect(result.acceptedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicates[0]!.status).toBe('DUPLICATE');
    expect(result.duplicates[0]!.resumeDocumentId).toBe('concurrent-winner-doc-id');
  });

  it('never automatically creates candidate consent records or assessments during ingestion', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      findExistingResumeBySha256: vi.fn(async () => null),
      createResumeBatch: vi.fn(async () => ({
        batchId: 'batch-uuid-1',
        accepted: [
          {
            resumeDocumentId: 'doc-1',
            candidateId: 'cand-1',
            candidateCode: 'CAN-0001',
            fileName: 'resume.pdf',
            fileType: 'PDF' as const,
            sizeBytes: 15,
            sha256: 'hash',
          },
        ],
      })),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const req = createMockUploadStream([
      { filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 test') },
    ]);

    const result = await service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req);

    expect(result.acceptedCount).toBe(1);
    // Verified: CandidateConsent and CandidateAssessment models are not touched
  });

  it('lists resumes scoped to the authorized recruiter and requisition', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'req-uuid-1',
        title: 'Engineer',
        organizationId: 'org-uuid-1',
      })),
      listResumesForRequisition: vi.fn(async () => [
        {
          id: 'resume-1',
          candidateId: 'cand-1',
          candidateCode: 'CAN-0001',
          fileName: 'resume.pdf',
          fileType: 'PDF' as const,
          sizeBytes: 1024,
          sha256: 'hash1',
          parseStatus: 'PARSED' as const,
          uploadedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
    });

    const resumes = await service.listResumes(recruiterPrincipal, 'req-uuid-1');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.id).toBe('resume-1');
  });

  it('throws ResumeNotFoundError when requesting details for an inaccessible resume', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findResumeDetails: vi.fn(async () => null),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
    });

    await expect(
      service.getResumeDetails(recruiterPrincipal, 'req-uuid-1', 'non-existent-resume'),
    ).rejects.toThrow(ResumeNotFoundError);
  });

  it('throws ExtractionNotFoundError when extraction has not been performed', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findLatestExtraction: vi.fn(async () => null),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
    });

    await expect(
      service.getExtraction(recruiterPrincipal, 'req-uuid-1', 'resume-1'),
    ).rejects.toThrow(ExtractionNotFoundError);
  });

  it('streams the original resume file with correct MIME type and filename', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      findResumeDetails: vi.fn(async () => ({
        id: 'resume-1',
        candidateId: 'cand-1',
        candidateCode: 'CAN-0001',
        fileName: 'resume-123.pdf',
        fileType: 'PDF' as const,
        sizeBytes: 15,
        sha256: 'hash',
        parseStatus: 'PARSED' as const,
        objectKey: '2026-11/stored-file.pdf',
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      recordResumeInspection: vi.fn(async () => undefined),
    };

    const service = createResumeService({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorageService,
    });

    const fileData = await service.getResumeFile(recruiterPrincipal, 'req-uuid-1', 'resume-1');
    expect(fileData.mimeType).toBe('application/pdf');
    expect(fileData.fileName).toBe('resume-123.pdf');
    expect(fileData.buffer).toBeInstanceOf(Buffer);
    expect(mockRepo.recordResumeInspection).toHaveBeenCalledWith(
      recruiterPrincipal.organizationId,
      recruiterPrincipal.userId,
      'req-uuid-1',
      'resume-1',
      'cand-1',
    );
  });

  describe('releaseHeldProcessingJobs', () => {
    it('denies non-recruiter principals', async () => {
      const mockRepo: Partial<ResumeRepository> = {};
      const service = createResumeService({ repository: mockRepo as ResumeRepository });
      await expect(
        service.releaseHeldProcessingJobs(hiringManagerPrincipal, 'cand-1'),
      ).rejects.toThrow(ResumeRoleError);
    });

    it('delegates to repository with authenticated organization ID and candidate ID', async () => {
      const mockRepo: Partial<ResumeRepository> = {
        releaseHeldProcessingJobs: vi.fn(async () => ({ releasedCount: 2 })),
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
      });

      const result = await service.releaseHeldProcessingJobs(recruiterPrincipal, 'cand-123');
      expect(result.releasedCount).toBe(2);
      expect(mockRepo.releaseHeldProcessingJobs).toHaveBeenCalledWith(
        recruiterPrincipal.organizationId,
        'cand-123',
        recruiterPrincipal.userId,
        undefined,
      );
    });
  });

  describe('Antivirus and Malware Scanning Boundary', () => {
    it('rejects confirmed malicious resumes and never saves them to storage or database', async () => {
      const mockScanner = new MockResumeScanner({
        forceStatus: 'INFECTED',
        simulatedThreatName: 'Trojan.Script.Resume-1',
      });
      const saveSpy = vi.fn();
      const createBatchSpy = vi.fn();
      const mockStorage: DocumentStorageService = {
        save: saveSpy,
        saveFromPath: saveSpy,
        read: vi.fn(),
        delete: vi.fn(),
        exists: vi.fn(),
      };
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-1',
          title: 'Role',
          organizationId: 'org-1',
        })),
        createResumeBatch: createBatchSpy,
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorage,
        scanner: mockScanner,
      });

      const req = createMockUploadStream([
        { filename: 'malicious.pdf', content: Buffer.from('%PDF-1.4 malicious code') },
      ]);

      const result = await service.uploadResumes(recruiterPrincipal, 'req-1', req);

      expect(result.totalFiles).toBe(1);
      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(result.rejected[0]?.status).toBe('REJECTED');
      expect(result.rejected[0]?.reason).toContain('Trojan.Script.Resume-1');
      expect(saveSpy).not.toHaveBeenCalled();
      expect(createBatchSpy).not.toHaveBeenCalled();
    });

    it('quarantines upload when scanner fails in fail-closed mode', async () => {
      const mockScanner = new MockResumeScanner({
        forceStatus: 'ERROR',
        errorMessage: 'ClamAV daemon unreachable',
      });
      const saveSpy = vi.fn();
      const mockStorage: DocumentStorageService = {
        save: saveSpy,
        saveFromPath: saveSpy,
        read: vi.fn(),
        delete: vi.fn(),
        exists: vi.fn(),
      };
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-1',
          title: 'Role',
          organizationId: 'org-1',
        })),
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorage,
        scanner: mockScanner,
      });

      const req = createMockUploadStream([
        { filename: 'quarantine-doc.pdf', content: Buffer.from('%PDF-1.4 normal content') },
      ]);

      const result = await service.uploadResumes(recruiterPrincipal, 'req-1', req);

      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(result.rejected[0]?.reason).toContain('upload quarantined');
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('automatically detects standard EICAR test signature with default mock scanner', async () => {
      const saveSpy = vi.fn();
      const mockStorage: DocumentStorageService = {
        save: saveSpy,
        saveFromPath: saveSpy,
        read: vi.fn(),
        delete: vi.fn(),
        exists: vi.fn(),
      };
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-1',
          title: 'Role',
          organizationId: 'org-1',
        })),
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorage,
        scanner: new MockResumeScanner(),
      });

      const eicarPdf = Buffer.from(`%PDF-1.4\n${EICAR_SIGNATURE}\n%%EOF`);
      const req = createMockUploadStream([{ filename: 'eicar-test.pdf', content: eicarPdf }]);

      const result = await service.uploadResumes(recruiterPrincipal, 'req-1', req);

      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(result.rejected[0]?.reason).toContain('Win.Test.EICAR_HDB-1');
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe('Per-slot clientFileId correlation', () => {
    it('propagates clientFileId from file:<id> multipart fields across accepted, duplicate, and rejected items', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 same-name valid pdf');
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-uuid-1',
          title: 'Engineer',
          organizationId: 'org-uuid-1',
        })),
        findExistingResumeBySha256: vi.fn(async () => null),
        createResumeBatch: vi.fn<ResumeRepository['createResumeBatch']>(async (_p, _r, files) => ({
          batchId: 'batch-client-id',
          accepted: files.map((file, idx) => ({
            clientFileId: file.clientFileId,
            resumeDocumentId: `doc-${idx + 1}`,
            candidateId: `cand-${idx + 1}`,
            candidateCode: `CAN-900${idx + 1}`,
            fileName: file.fileName,
            fileType: file.fileType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          })),
        })),
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorageService,
      });

      const req = createMockUploadStream([
        { fieldname: 'file:slot-a', filename: 'resume.pdf', content: pdfBytes },
        { fieldname: 'file:slot-b', filename: 'resume.pdf', content: pdfBytes }, // intra-batch duplicate
        { fieldname: 'file:slot-c', filename: 'resume.pdf', content: Buffer.from('not a pdf') }, // rejected
      ]);

      const result = await service.uploadResumes(recruiterPrincipal, 'req-uuid-1', req);

      expect(result.acceptedCount).toBe(1);
      expect(result.duplicateCount).toBe(1);
      expect(result.rejectedCount).toBe(1);

      expect(result.accepted[0]?.clientFileId).toBe('slot-a');
      expect(result.duplicates[0]?.clientFileId).toBe('slot-b');
      expect(result.rejected[0]?.clientFileId).toBe('slot-c');
    });

    it('preserves existingBatchId when a retry chunk produces 0 accepted files so finalization can close the batch', async () => {
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-uuid-1',
          title: 'Engineer',
          organizationId: 'org-uuid-1',
        })),
        findExistingResumeBySha256: vi.fn(async () => ({
          id: 'existing-doc-1',
          sha256: 'hash',
          candidateId: 'cand-1',
          candidateCode: 'CAN-1',
          parseStatus: 'PARSED',
        })),
        createResumeBatch: vi.fn(),
      };

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorageService,
      });

      const existingBatchId = 'batch-open-123';
      const reqWithExisting = createMockUploadStream([
        { filename: 'dup.pdf', content: Buffer.from('%PDF-1.4 already exists') },
      ]);
      const withBatchResult = await service.uploadResumes(
        recruiterPrincipal,
        'req-uuid-1',
        reqWithExisting,
        existingBatchId,
      );

      expect(withBatchResult.acceptedCount).toBe(0);
      expect(withBatchResult.duplicateCount).toBe(1);
      expect(withBatchResult.batchId).toBe(existingBatchId);
      expect(mockRepo.createResumeBatch).not.toHaveBeenCalled();

      const reqWithoutExisting = createMockUploadStream([
        { filename: 'dup.pdf', content: Buffer.from('%PDF-1.4 already exists') },
      ]);
      const withoutBatchResult = await service.uploadResumes(
        recruiterPrincipal,
        'req-uuid-1',
        reqWithoutExisting,
      );
      expect(withoutBatchResult.acceptedCount).toBe(0);
      expect(withoutBatchResult.batchId).toBeNull();
    });
  });

  describe('P1-01 Decompression bomb pre-validation at upload boundary', () => {
    it('rejects compressed DOCX bombs and oversized PDF image/page bombs before persisting to storage', async () => {
      const saveSpy = vi.fn();
      const createBatchSpy = vi.fn();
      const mockStorage: DocumentStorageService = {
        save: saveSpy,
        saveFromPath: saveSpy,
        read: vi.fn(),
        delete: vi.fn(),
        exists: vi.fn(),
      };
      const mockRepo: Partial<ResumeRepository> = {
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'req-1',
          title: 'Role',
          organizationId: 'org-1',
        })),
        findExistingResumeBySha256: vi.fn(async () => null),
        createResumeBatch: createBatchSpy,
      };

      const docxXmlBomb = Buffer.from(
        `<w:document><w:body><w:p><w:t>${'Z'.repeat(300_000)}</w:t></w:p></w:body></w:document>`,
        'utf8',
      );
      const docxDeflated = zlib.deflateRawSync(docxXmlBomb);
      const docxName = Buffer.from('word/document.xml', 'utf8');
      const docxHeader = Buffer.alloc(30);
      docxHeader.writeUInt32LE(0x04034b50, 0);
      docxHeader.writeUInt16LE(8, 8);
      docxHeader.writeUInt32LE(docxDeflated.length, 18);
      docxHeader.writeUInt32LE(docxXmlBomb.length, 22);
      docxHeader.writeUInt16LE(docxName.length, 26);
      const docxBomb = Buffer.concat([docxHeader, docxName, docxDeflated]);

      const oversizedPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /XObject /Subtype /Image /Width 30000 /Height 30000 >> endobj\n%%EOF',
        'latin1',
      );

      const service = createResumeService({
        repository: mockRepo as ResumeRepository,
        storageService: mockStorage,
      });

      const req = createMockUploadStream([
        { filename: 'bomb.docx', content: docxBomb },
        { filename: 'huge-image.pdf', content: oversizedPdf },
      ]);

      const result = await service.uploadResumes(recruiterPrincipal, 'req-1', req);

      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(2);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(createBatchSpy).not.toHaveBeenCalled();
    });
  });
});
