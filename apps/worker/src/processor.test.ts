import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@talentlens/database';
import { WorkerJobProcessor } from './processor.js';
import type { WorkerStorageService } from './storage.js';

describe('WorkerJobProcessor — Transaction Separation and Idempotency', () => {
  it('returns false when no jobs are eligible', async () => {
    const mockTx = {
      $queryRaw: vi.fn(async () => []),
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as PrismaClient;

    const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService);
    const result = await processor.processNextJob();
    expect(result).toBe(false);
  });

  it('completes job idempotently and outside long database transactions', async () => {
    const mockClaimedRecord = {
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
    };

    let txCallCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [{ id: 'job-1' }]),
      processingJob: {
        update: vi.fn(async () => mockClaimedRecord),
      },
    };

    const mockTx2 = {
      processingJob: {
        findUnique: vi.fn(async () => ({ status: 'PROCESSING' })),
        update: vi.fn(async () => ({})),
      },
      documentExtraction: {
        aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
        create: vi.fn(async () => ({})),
      },
      resumeDocument: {
        update: vi.fn(async () => ({})),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        txCallCount += 1;
        if (txCallCount === 1) return cb(mockTx1);
        return cb(mockTx2);
      }),
    } as unknown as PrismaClient;

    const mockStorage = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4\nJane Doe')),
    } as unknown as WorkerStorageService;

    const processor = new WorkerJobProcessor(mockDb, mockStorage);
    const processed = await processor.processNextJob();

    expect(processed).toBe(true);
    // Two distinct short transactions (claim tx, completion tx)
    expect(txCallCount).toBe(2);
    expect(mockStorage.read).toHaveBeenCalledWith('2026-11/test.pdf');
    expect(mockTx2.processingJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
  });
});
