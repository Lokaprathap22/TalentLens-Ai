import { describe, expect, it, vi } from 'vitest';

import type { ResumeRepository } from './resume.repository.js';
import type { DocumentStorageService } from './resume.types.js';
import { ResumeWorkerProcessor } from './resume.worker.js';
import type { ResumeParsingService } from './resume.parser.js';

describe('Resume Background Worker Processor', () => {
  const samplePdfBuffer = Buffer.from('%PDF-1.4\nTest Resume Content');

  const mockStorage: DocumentStorageService = {
    save: vi.fn(),
    saveFromPath: vi.fn(),
    read: vi.fn(async () => samplePdfBuffer),
    delete: vi.fn(),
    exists: vi.fn(async () => true),
  };

  const mockParser: Partial<ResumeParsingService> = {
    parse: vi.fn(async () => ({
      extractedText: 'Parsed candidate text',
      pageMapJson: {
        pages: [{ pageNumber: 1, startOffset: 0, endOffset: 21, text: 'Parsed candidate text' }],
      },
      parser: 'talentlens-pdf-v1',
      ocrUsed: false,
      qualityStatus: 'COMPLETE' as const,
    })),
  };

  it('returns false when no jobs are queued', async () => {
    const mockRepo: Partial<ResumeRepository> = {
      claimNextProcessingJob: vi.fn(async () => null),
    };

    const worker = new ResumeWorkerProcessor({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorage,
      parserService: mockParser as ResumeParsingService,
    });

    const processed = await worker.processNextJob();
    expect(processed).toBe(false);
  });

  it('claims and completes a queued text extraction job', async () => {
    const completeSpy = vi.fn(async () => {});
    const mockRepo: Partial<ResumeRepository> = {
      claimNextProcessingJob: vi.fn(async () => ({
        id: 'job-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'EXTRACT_TEXT',
        attempts: 1,
        resumeDocument: {
          id: 'doc-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      })),
      completeProcessingJob: completeSpy,
    };

    const worker = new ResumeWorkerProcessor({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorage,
      parserService: mockParser as ResumeParsingService,
    });

    const processed = await worker.processNextJob();
    expect(processed).toBe(true);

    expect(completeSpy).toHaveBeenCalledWith(
      'job-1',
      'doc-1',
      'org-1',
      expect.objectContaining({
        extractedText: 'Parsed candidate text',
        qualityStatus: 'COMPLETE',
      }),
    );
  });

  it('handles parsing failure by marking retryable or permanent failure', async () => {
    const failSpy = vi.fn(async () => {});
    const failingParser: Partial<ResumeParsingService> = {
      parse: vi.fn(async () => {
        throw new Error('Decompression failure');
      }),
    };

    const mockRepo: Partial<ResumeRepository> = {
      claimNextProcessingJob: vi.fn(async () => ({
        id: 'job-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'EXTRACT_TEXT',
        attempts: 2,
        resumeDocument: {
          id: 'doc-1',
          objectKey: '2026-11/corrupt.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      })),
      failProcessingJob: failSpy,
    };

    const worker = new ResumeWorkerProcessor({
      repository: mockRepo as ResumeRepository,
      storageService: mockStorage,
      parserService: failingParser as ResumeParsingService,
    });

    const processed = await worker.processNextJob();
    expect(processed).toBe(true);

    expect(failSpy).toHaveBeenCalledWith('job-1', 'doc-1', 'Decompression failure', false);
  });
});
