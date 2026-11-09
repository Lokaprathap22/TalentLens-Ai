import { describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import type { GoogleGenAI } from '@google/genai';
import type { PrismaClient } from '@talentlens/database';
import { createAssessmentProvider } from './assessment.js';
import { WorkerJobProcessor } from './processor.js';
import type { WorkerStorageService } from './storage.js';

describe('WorkerJobProcessor — Lease Claiming, Heartbeats, Fencing & Authorization', () => {
  it('returns false when no jobs are eligible', async () => {
    const mockTx = {
      $queryRaw: vi.fn(async () => []),
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as PrismaClient;

    const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
      heartbeatIntervalMs: 0,
    });
    const result = await processor.processNextJob();
    expect(result).toBe(false);
  });

  it('claims eligible job with unique lease token and worker ID', async () => {
    const mockJob = {
      id: 'job-1',
      status: 'QUEUED',
      attempts: 0,
      resume_document_id: 'doc-1',
      organization_id: 'org-1',
      requisition_id: 'req-1',
    };

    const mockClaimedRecord = {
      id: 'job-1',
      batchId: 'batch-1',
      organizationId: 'org-1',
      resumeDocumentId: 'doc-1',
      jobType: 'EXTRACT_TEXT',
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() + 300000),
      batch: {
        requisitionId: 'req-1',
      },
      resumeDocument: {
        id: 'doc-1',
        objectKey: '2026-11/test.pdf',
        fileType: 'PDF' as const,
        organizationId: 'org-1',
      },
    };

    let txCallCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [mockJob]),
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      processingJob: {
        findUnique: vi.fn(async () => mockClaimedRecord),
      },
    };

    const mockTx2 = {
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
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

    const processor = new WorkerJobProcessor(mockDb, mockStorage, {
      workerId: 'worker-unit-test-1',
      heartbeatIntervalMs: 0,
    });

    const processed = await processor.processNextJob();

    expect(processed).toBe(true);
    expect(txCallCount).toBe(2);
    expect(mockTx1.$executeRaw).toHaveBeenCalled();
    expect(mockTx2.$executeRaw).toHaveBeenCalled();
    expect(mockTx2.documentExtraction.create).toHaveBeenCalled();
  });

  it('transitions stale expired job with attempts >= 3 to FAILED', async () => {
    const staleExhaustedJob = {
      id: 'job-stale-1',
      status: 'PROCESSING',
      attempts: 3,
      resume_document_id: 'doc-stale-1',
      organization_id: 'org-1',
    };

    const mockTx = {
      $queryRaw: vi.fn(async () => [staleExhaustedJob]),
      processingJob: {
        update: vi.fn(async () => ({})),
      },
      resumeDocument: {
        update: vi.fn(async () => ({})),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as PrismaClient;

    const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
      heartbeatIntervalMs: 0,
    });
    const result = await processor.processNextJob();

    expect(result).toBe(false);
    expect(mockTx.processingJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-stale-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          lastErrorCode: 'STALE_LEASE_EXPIRED_MAX_ATTEMPTS_EXHAUSTED',
        }),
      }),
    );
    expect(mockTx.resumeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-stale-1' },
        data: expect.objectContaining({ parseStatus: 'FAILED' }),
      }),
    );
  });

  it('holds job when active authorization is missing at claim time', async () => {
    const unconsentedJob = {
      id: 'job-unconsented',
      status: 'QUEUED',
      attempts: 0,
      resume_document_id: 'doc-1',
      organization_id: 'org-1',
    };

    const mockTx = {
      $queryRaw: vi.fn(async () => [unconsentedJob]),
      candidateConsent: {
        findFirst: vi.fn(async () => null), // No active consent
      },
      processingJob: {
        update: vi.fn(async () => ({})),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as PrismaClient;

    const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
      heartbeatIntervalMs: 0,
    });
    const result = await processor.processNextJob();

    expect(result).toBe(false);
    expect(mockTx.processingJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-unconsented' },
        data: expect.objectContaining({
          status: 'HELD_FOR_AUTHORIZATION',
        }),
      }),
    );
  });

  it('fences out stale worker when lease token is mismatched at completion', async () => {
    const mockClaimedRecord = {
      id: 'job-stale-owner',
      batchId: 'batch-1',
      organizationId: 'org-1',
      resumeDocumentId: 'doc-1',
      jobType: 'EXTRACT_TEXT',
      attempts: 1,
      leaseExpiresAt: new Date(),
      resumeDocument: {
        id: 'doc-1',
        objectKey: '2026-11/test.pdf',
        fileType: 'PDF' as const,
        organizationId: 'org-1',
      },
    };

    let txCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'job-stale-owner',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-1',
          organization_id: 'org-1',
        },
      ]),
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      processingJob: {
        findUnique: vi.fn(async () => mockClaimedRecord),
      },
    };

    const mockTx2 = {
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 0), // Fenced out! 0 rows updated
      documentExtraction: {
        create: vi.fn(),
      },
      resumeDocument: {
        update: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        txCount += 1;
        if (txCount === 1) return cb(mockTx1);
        return cb(mockTx2);
      }),
    } as unknown as PrismaClient;

    const mockStorage = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4\nJane Doe')),
    } as unknown as WorkerStorageService;

    const processor = new WorkerJobProcessor(mockDb, mockStorage, {
      heartbeatIntervalMs: 0,
    });
    const result = await processor.processNextJob();

    expect(result).toBe(true);
    // Because updatedCount === 0 (fenced out), extraction must NOT be persisted
    expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
    expect(mockTx2.resumeDocument.update).not.toHaveBeenCalled();
  });

  it('holds job and discards extraction if consent is revoked during processing', async () => {
    const mockClaimedRecord = {
      id: 'job-revoked-consent',
      batchId: 'batch-1',
      organizationId: 'org-1',
      resumeDocumentId: 'doc-1',
      jobType: 'EXTRACT_TEXT',
      attempts: 1,
      leaseExpiresAt: new Date(),
      resumeDocument: {
        id: 'doc-1',
        objectKey: '2026-11/test.pdf',
        fileType: 'PDF' as const,
        organizationId: 'org-1',
      },
    };

    let txCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'job-revoked-consent',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-1',
          organization_id: 'org-1',
        },
      ]),
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      processingJob: {
        findUnique: vi.fn(async () => mockClaimedRecord),
      },
    };

    const mockTx2 = {
      candidateConsent: {
        findFirst: vi.fn(async () => null), // Consent revoked while processing!
      },
      $executeRaw: vi.fn(async () => 1), // Sets HELD_FOR_AUTHORIZATION
      documentExtraction: {
        create: vi.fn(),
      },
      resumeDocument: {
        update: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        txCount += 1;
        if (txCount === 1) return cb(mockTx1);
        return cb(mockTx2);
      }),
    } as unknown as PrismaClient;

    const mockStorage = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4\nJane Doe')),
    } as unknown as WorkerStorageService;

    const processor = new WorkerJobProcessor(mockDb, mockStorage, {
      heartbeatIntervalMs: 0,
    });
    const result = await processor.processNextJob();

    expect(result).toBe(true);
    // Updated to HELD_FOR_AUTHORIZATION
    expect(mockTx2.$executeRaw).toHaveBeenCalled();
    // No extraction created
    expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
    expect(mockTx2.resumeDocument.update).not.toHaveBeenCalled();
  });

  it('heartbeat renewal fails when lease is expired, marking leaseLost and skipping completion writes', async () => {
    const mockClaimedRecord = {
      id: 'job-expired-heartbeat',
      batchId: 'batch-1',
      organizationId: 'org-1',
      resumeDocumentId: 'doc-1',
      jobType: 'EXTRACT_TEXT',
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1000), // already expired
      resumeDocument: {
        id: 'doc-1',
        objectKey: '2026-11/test.pdf',
        fileType: 'PDF' as const,
        organizationId: 'org-1',
      },
    };

    let txCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'job-expired-heartbeat',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-1',
          organization_id: 'org-1',
        },
      ]),
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      processingJob: {
        findUnique: vi.fn(async () => mockClaimedRecord),
      },
    };

    const mockTx2 = {
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      documentExtraction: {
        create: vi.fn(),
      },
      resumeDocument: {
        update: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        txCount += 1;
        if (txCount === 1) return cb(mockTx1);
        return cb(mockTx2);
      }),
      $executeRaw: vi.fn(async () => 0), // Heartbeat renewal returns 0 (expired/lost lease)
    } as unknown as PrismaClient;

    const mockStorage = {
      read: vi.fn(async () => {
        // Wait long enough for heartbeat to fire
        await new Promise((resolve) => setTimeout(resolve, 60));
        return Buffer.from('%PDF-1.4\nJane Doe');
      }),
    } as unknown as WorkerStorageService;

    const processor = new WorkerJobProcessor(mockDb, mockStorage, {
      heartbeatIntervalMs: 20, // Fast heartbeat for test
    });

    const result = await processor.processNextJob();

    expect(result).toBe(true);
    // Heartbeat attempted renewal
    expect(mockDb.$executeRaw).toHaveBeenCalled();
    // Because heartbeat returned 0, lease was lost -> Phase 3 completion tx must NOT be called
    expect(txCount).toBe(1);
    expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
  });

  it('worker-thread initialization failure does not invoke main-thread parser and runs normal retry/failure handling', async () => {
    const mockClaimedRecord = {
      id: 'job-thread-failure',
      batchId: 'batch-1',
      organizationId: 'org-1',
      resumeDocumentId: 'doc-1',
      jobType: 'EXTRACT_TEXT',
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() + 300_000),
      resumeDocument: {
        id: 'doc-1',
        objectKey: '2026-11/test.pdf',
        fileType: 'PDF' as const,
        organizationId: 'org-1',
      },
    };

    let txCount = 0;
    const mockTx1 = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'job-thread-failure',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-1',
          organization_id: 'org-1',
        },
      ]),
      candidateConsent: {
        findFirst: vi.fn(async () => ({ id: 'consent-1' })),
      },
      $executeRaw: vi.fn(async () => 1),
      processingJob: {
        findUnique: vi.fn(async () => mockClaimedRecord),
      },
    };

    // Phase 4 failure transaction
    const mockTx2 = {
      $executeRaw: vi.fn(async () => 1),
      resumeDocument: {
        update: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        txCount += 1;
        if (txCount === 1) return cb(mockTx1);
        return cb(mockTx2);
      }),
    } as unknown as PrismaClient;

    const mockStorage = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4\nJane Doe')),
    } as unknown as WorkerStorageService;

    // Simulate worker-thread initialization failure (e.g. out of memory / thread spawn restriction)
    const failingWorkerFactory = vi.fn(() => {
      throw new Error('EPERM: cannot spawn worker thread');
    });

    const processor = new WorkerJobProcessor(mockDb, mockStorage, {
      heartbeatIntervalMs: 0,
      workerFactory: failingWorkerFactory,
    });

    const result = await processor.processNextJob();

    expect(result).toBe(true);
    // Factory was attempted
    expect(failingWorkerFactory).toHaveBeenCalled();
    // Phase 4 failure recording ran
    expect(txCount).toBe(2);
    expect(mockTx2.$executeRaw).toHaveBeenCalled();
  });

  it('parses document using isolated worker thread without blocking', async () => {
    const processor = new WorkerJobProcessor({} as PrismaClient, {} as WorkerStorageService);

    const validPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 45 >>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Senior Software Engineer) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000187 00000 n\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n282\n%%EOF',
    );

    const parsed = await processor.parseDocument(validPdfBuffer, 'PDF');
    expect(parsed).toBeDefined();
    expect(parsed.qualityStatus).toBe('COMPLETE');
    expect(parsed.extractedText).toContain('Senior Software Engineer');
  });

  describe('ASSESS_CANDIDATE job processing', () => {
    it('claims and completes ASSESS_CANDIDATE job successfully with evidence verification and scoring', async () => {
      const mockJob = {
        id: 'assess-job-1',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: {
          requisitionId: 'req-1',
        },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: {
          findFirst: vi.fn(async () => ({ id: 'consent-1' })),
        },
        $executeRaw: vi.fn(async () => 1),
        processingJob: {
          findUnique: vi.fn(async () => mockClaimedRecord),
        },
      };

      const mockTx2 = {
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-1', record_status: 'ACTIVE' }]),
        $executeRaw: vi.fn(async () => 1),
        candidateConsent: {
          findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
        },
        candidateAssessment: {
          upsert: vi.fn(async () => ({ id: 'cand-assess-1' })),
        },
        assessmentText: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: 'assess-text-1' })),
        },
        criterionAssessment: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'crit-assess-1' })),
        },
        evidenceSnippet: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'snip-1' })),
        },
        auditLog: {
          create: vi.fn(async () => ({ id: 'audit-1' })),
        },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText:
              'Senior Engineer with 8 years of TypeScript and Node.js production experience.',
            pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: 77 }],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Senior Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'typescript',
                label: 'TypeScript',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
                displayOrder: 1,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'input-hash-1',
          outputHash: 'output-hash-1',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 1.0,
              explanation: 'Candidate has 8 years of TypeScript production experience.',
              evidenceQuotes: ['8 years of TypeScript and Node.js production experience'],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();

      expect(processed).toBe(true);
      expect(mockProvider.assess).toHaveBeenCalled();
      expect(mockTx2.candidateAssessment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: 'COMPLETE',
            organizationId: 'org-1',
            candidateId: 'cand-1',
          }),
        }),
      );
      expect(mockTx2.criterionAssessment.create).toHaveBeenCalled();
      expect(mockTx2.evidenceSnippet.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verified: true,
            verificationMethod: 'EXACT_QUOTE',
          }),
        }),
      );
      expect(mockTx2.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'ASSESSMENT_COMPLETED',
          }),
        }),
      );
    });

    it('holds ASSESS_CANDIDATE job when consent is withdrawn during inference', async () => {
      const mockJob = {
        id: 'assess-job-consent-loss',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-consent-loss',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-consent-loss', record_status: 'ACTIVE' }]),
        $executeRaw: vi.fn(async () => 1),
        candidateConsent: { findFirst: vi.fn(async () => null) }, // Revoked!
        candidateAssessment: { upsert: vi.fn() },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'h1',
          outputHash: 'h2',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 0.8,
              explanation: 'ok',
              evidenceQuotes: [],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();

      expect(processed).toBe(true);
      expect(mockTx2.candidateAssessment.upsert).not.toHaveBeenCalled();
      // Verifies job was held for authorization
      expect(mockTx2.$executeRaw).toHaveBeenCalled();
    });

    it('fences out worker if lease token is invalidated before completion transaction', async () => {
      const mockJob = {
        id: 'assess-job-fenced',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-fenced',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'cand-1', record_status: 'ACTIVE' }])
          .mockResolvedValueOnce([]), // Fenced: 0 rows match lease
        $executeRaw: vi.fn(async () => 0),
        candidateAssessment: { upsert: vi.fn() },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'h1',
          outputHash: 'h2',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 0.8,
              explanation: 'ok',
              evidenceQuotes: [],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();

      expect(processed).toBe(true);
      // Ensure no assessment was written
      expect(mockTx2.candidateAssessment.upsert).not.toHaveBeenCalled();
    });

    it('records retryable failure if assessment provider throws an error', async () => {
      const mockJob = {
        id: 'assess-job-error',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-error',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $executeRaw: vi.fn(async () => 1),
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer text',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => {
          throw new Error('503 Service Unavailable: AI provider rate limited');
        }),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();

      expect(processed).toBe(true);
      expect(txCount).toBe(2);
      expect(mockTx2.$executeRaw).toHaveBeenCalled();
    });

    it('uses the shared Gemini provider when ASSESSMENT_PROVIDER="gemini" is configured (F-01)', async () => {
      const critId = '123e4567-e89b-42d3-a456-426614174000';
      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          criteria: [
            {
              criterionId: critId,
              status: 'MATCH',
              score: 0.9,
              explanation: 'Verified TypeScript in resume',
              evidenceQuotes: ['TypeScript'],
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 },
      });

      const mockClient = {
        models: {
          generateContent: mockGenerateContent,
        },
      } as unknown as GoogleGenAI;

      const prevEnv = { ...process.env };
      try {
        process.env['NODE_ENV'] = 'development';
        process.env['ASSESSMENT_PROVIDER'] = 'gemini';
        process.env['GEMINI_API_KEY'] = 'test-worker-key';
        process.env['GEMINI_MODEL'] = 'gemini-3.8-flash';

        const provider = createAssessmentProvider({
          client: mockClient,
        });
        const processor = new WorkerJobProcessor({} as PrismaClient, {} as WorkerStorageService, {
          heartbeatIntervalMs: 0,
          assessmentProvider: provider,
        });

        const output = await processor.assessmentProvider.assess({
          jobTitle: 'Backend Engineer',
          criteria: [
            {
              id: critId,
              key: 'ts',
              label: 'TypeScript',
              category: 'Technical',
              requirementType: 'MUST_HAVE',
              weight: 100,
            },
          ],
          resumeText: 'Experienced in TypeScript.',
        });

        expect(output.model).toBe('gemini-3.8-flash');
        expect(output.criteria[0]?.score).toBe(0.9);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      } finally {
        process.env = prevEnv;
      }
    });

    it('RB-03 (A, B, C): redacts confirmed candidate name and candidate code from active requisition-specific consent before provider execution and blocks execution when pre-provider consent is missing', async () => {
      const mockJob = {
        id: 'assess-job-redact-1',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-redact-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-redact-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-redact-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-redact-1',
          candidateId: 'cand-redact-1',
          objectKey: '2026-11/alexandra.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: {
          findFirst: vi.fn(async () => ({
            id: 'consent-req-1',
            candidateId: 'cand-redact-1',
            confirmationName: 'Alexandra Vance-Sterling',
            noticeTextHash: 'hash-1',
            candidate: {
              id: 'cand-redact-1',
              candidateCode: 'CAN-998877',
              profiles: [{ location: '742 Evergreen Terrace' }],
            },
          })),
        },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-redact-1', record_status: 'ACTIVE' }]),
        $executeRaw: vi.fn(async () => 1),
        candidateConsent: {
          findFirst: vi.fn(async () => ({
            id: 'consent-req-1',
            candidateId: 'cand-redact-1',
            noticeTextHash: 'hash-1',
          })),
        },
        candidateAssessment: { upsert: vi.fn(async () => ({ id: 'cand-assess-redact-1' })) },
        assessmentText: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: 'assess-text-redact-1' })),
        },
        criterionAssessment: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'crit-assess-1' })),
        },
        evidenceSnippet: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'snip-1' })),
        },
        auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
      };

      const rawUnredactedResume =
        'Alexandra Vance-Sterling (Candidate ID: CAN-998877) | Email: alexandra@example.com | Phone: (415) 555-0199 | Address: 742 Evergreen Terrace | DOB: 1990-05-14 | Senior Engineer with 8 years of TypeScript experience.';

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        candidateConsent: {
          findFirst: vi.fn(async () => ({
            id: 'consent-req-1',
            candidateId: 'cand-redact-1',
            confirmationName: 'Alexandra Vance-Sterling',
            noticeTextHash: 'hash-1',
            candidate: {
              id: 'cand-redact-1',
              candidateCode: 'CAN-998877',
              profiles: [{ location: '742 Evergreen Terrace' }],
            },
          })),
        },
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-redact-1',
            extractedText: rawUnredactedResume,
            pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: rawUnredactedResume.length }],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Senior Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'typescript',
                label: 'TypeScript',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
                displayOrder: 1,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      let capturedProviderResumeText = '';
      const mockProvider = {
        assess: vi.fn(async (input: { resumeText: string }) => {
          capturedProviderResumeText = input.resumeText;
          return {
            model: 'test-model',
            promptVersion: '2026-11-assessment-v1',
            inputHash: 'in-1',
            outputHash: 'out-1',
            criteria: [
              {
                criterionId: 'crit-ts',
                status: 'MATCH' as const,
                score: 1.0,
                explanation: 'Verified TypeScript experience.',
                evidenceQuotes: ['8 years of TypeScript experience'],
              },
            ],
          };
        }),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-rb03-1',
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      expect(mockProvider.assess).toHaveBeenCalledTimes(1);

      // Verify NO unredacted candidate name, code, email, phone, address, or DOB entered provider input
      expect(capturedProviderResumeText).not.toContain('Alexandra');
      expect(capturedProviderResumeText).not.toContain('Vance-Sterling');
      expect(capturedProviderResumeText).not.toContain('CAN-998877');
      expect(capturedProviderResumeText).not.toContain('alexandra@example.com');
      expect(capturedProviderResumeText).not.toContain('555-0199');
      expect(capturedProviderResumeText).not.toContain('742 Evergreen Terrace');
      expect(capturedProviderResumeText).not.toContain('1990-05-14');
      // Technical evidence remains intact
      expect(capturedProviderResumeText).toContain('8 years of TypeScript experience');
    });

    it('RB-03 (C): blocks provider execution and holds job if requisition-specific consent is revoked before provider call', async () => {
      const mockJob = {
        id: 'assess-job-pre-revoke',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-pre-revoke',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockHoldTx = {
        $executeRaw: vi.fn(async () => 1),
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockHoldTx);
        }),
        candidateConsent: {
          // Consent was withdrawn right after claim and before provider execution!
          findFirst: vi.fn(async () => null),
        },
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Senior Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-rb03-pre',
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      // Provider must NOT be called when pre-execution consent revalidation fails!
      expect(mockProvider.assess).not.toHaveBeenCalled();
      expect(mockHoldTx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('RB-03 (D, E, F, G): throws WorkerLeaseLostError and aborts transaction if final fenced job update affects 0 rows', async () => {
      const mockJob = {
        id: 'assess-job-final-fence',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-final-fence',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      let tx2AbortedByThrow = false;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-final-fence', record_status: 'ACTIVE' }]),
        // Final fenced UPDATE returns 0 (lease expired or stolen before final update)
        $executeRaw: vi.fn(async () => 0),
        candidateConsent: {
          findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
        },
        candidateAssessment: {
          upsert: vi.fn(async () => ({ id: 'cand-assess-1' })),
        },
        assessmentText: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: 'assess-text-1' })),
        },
        criterionAssessment: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'crit-assess-1' })),
        },
        evidenceSnippet: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({ id: 'snip-1' })),
        },
        auditLog: {
          create: vi.fn(async () => ({ id: 'audit-1' })),
        },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          try {
            return await cb(mockTx2);
          } catch (err) {
            tx2AbortedByThrow = true;
            throw err;
          }
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'h1',
          outputHash: 'h2',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 1.0,
              explanation: 'ok',
              evidenceQuotes: ['TypeScript experience'],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-rb03-fence',
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      // Transaction 2 must have thrown WorkerLeaseLostError so Prisma rolls back all assessment writes!
      expect(tx2AbortedByThrow).toBe(true);
      // Audit log after the fenced UPDATE must never be reached
      expect(mockTx2.auditLog.create).not.toHaveBeenCalled();
      // And Phase 4 failure transaction must NOT have run (txCount remains 2)
      expect(txCount).toBe(2);
    });

    it('rejects completion before writing artifacts when lease expires while waiting on FOR UPDATE row lock (post-lock clock_timestamp check)', async () => {
      const mockJob = {
        id: 'assess-job-lock-wait-expired',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-lock-wait-expired',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCount = 0;
      let tx2AbortedByThrow = false;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      // Simulate: 1st $queryRaw locks ACTIVE candidate FIRST,
      // 2nd $queryRaw (FOR UPDATE on processing_jobs) returns 1 row (IndexScan evaluated before lock wait),
      // 3rd $queryRaw (post-lock clock_timestamp verification) returns 0 rows (lease expired during lock wait).
      const mockTx2 = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'cand-1', record_status: 'ACTIVE' }])
          .mockResolvedValueOnce([{ id: 'assess-job-lock-wait-expired' }])
          .mockResolvedValueOnce([]),
        $executeRaw: vi.fn(async () => 1),
        candidateConsent: {
          findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
        },
        candidateAssessment: { upsert: vi.fn() },
        assessmentText: { findFirst: vi.fn(), create: vi.fn() },
        criterionAssessment: { deleteMany: vi.fn(), create: vi.fn() },
        evidenceSnippet: { deleteMany: vi.fn(), create: vi.fn() },
        auditLog: { create: vi.fn() },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          try {
            return await cb(mockTx2);
          } catch (err) {
            tx2AbortedByThrow = true;
            throw err;
          }
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'h1',
          outputHash: 'h2',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 1.0,
              explanation: 'ok',
              evidenceQuotes: ['TypeScript experience'],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-lock-wait-fence',
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      expect(tx2AbortedByThrow).toBe(true);
      expect(mockTx2.$queryRaw).toHaveBeenCalledTimes(3);
      expect(mockTx2.candidateAssessment.upsert).not.toHaveBeenCalled();
      expect(mockTx2.auditLog.create).not.toHaveBeenCalled();
      expect(txCount).toBe(2);
    });

    it('acquires candidates FOR UPDATE before processing_jobs FOR UPDATE in handleAssessCandidate', async () => {
      const mockJob = {
        id: 'assess-job-lock-order',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        job_type: 'ASSESS_CANDIDATE',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'assess-job-lock-order',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'ASSESS_CANDIDATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: '2026-11/test.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      const sqlStatements: string[] = [];
      let txCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
          sqlStatements.push((query.strings ?? []).join(' '));
          return [{ id: 'cand-1', record_status: 'ACTIVE' }];
        }),
        $executeRaw: vi.fn(async () => 1),
        candidateConsent: {
          findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
        },
        candidateAssessment: { upsert: vi.fn(async () => ({ id: 'ca-1' })) },
        assessmentText: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: 'at-1' })),
        },
        criterionAssessment: { deleteMany: vi.fn(), create: vi.fn() },
        evidenceSnippet: { deleteMany: vi.fn(), create: vi.fn() },
        auditLog: { create: vi.fn() },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCount += 1;
          if (txCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            id: 'ext-1',
            extractedText: 'Engineer with TypeScript experience.',
            pageMapJson: [],
          })),
        },
        scorecardVersion: {
          findFirst: vi.fn(async () => ({
            id: 'scorecard-v1',
            requisition: { title: 'Backend Engineer' },
            criteria: [
              {
                id: 'crit-ts',
                key: 'ts',
                label: 'TS',
                category: 'EXPERIENCE',
                requirementType: 'MUST_HAVE',
                weight: 1.0,
                active: true,
              },
            ],
          })),
        },
      } as unknown as PrismaClient;

      const mockProvider = {
        assess: vi.fn(async () => ({
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'h1',
          outputHash: 'h2',
          criteria: [
            {
              criterionId: 'crit-ts',
              status: 'MATCH' as const,
              score: 1.0,
              explanation: 'ok',
              evidenceQuotes: ['TypeScript experience'],
            },
          ],
        })),
      };

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-lock-order',
        heartbeatIntervalMs: 0,
        assessmentProvider: mockProvider,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      expect(sqlStatements.length).toBeGreaterThanOrEqual(2);
      expect(sqlStatements[0]).toContain('"candidates"');
      expect(sqlStatements[0]).toContain('FOR UPDATE');
      expect(sqlStatements[1]).toContain('"processing_jobs"');
      expect(sqlStatements[1]).toContain('FOR UPDATE');
    });
  });

  describe('Candidate Profile Extraction & Duplicate Detection Pipeline', () => {
    it('extracts role, experience, location, and skills with evidence from resume text', async () => {
      const { extractProfileFromText } = await import('./processor.js');
      const resume = `
        Jane Doe
        Current Role: Senior Staff Software Architect
        Experience: 8 years of experience building distributed systems
        Location: Seattle, WA
        Notice Period: 30 days

        Summary:
        Accomplished systems engineer with deep expertise in cloud architectures,
        scalable data platforms, and high-performance microservices.

        Technical Skills:
        Languages: TypeScript, Go, Python, Rust
        Databases: PostgreSQL, Redis, MongoDB
        Infrastructure: Docker, Kubernetes, AWS, Terraform, CI/CD
      `;

      const profile = extractProfileFromText(resume);
      expect(profile.currentRole).toBe('Senior Staff Software Architect');
      expect(profile.experienceYears).toBe(8);
      expect(profile.location).toBe('Seattle, WA');
      expect(profile.noticeDays).toBe(30);
      expect(profile.summary).toContain('Accomplished systems engineer');

      const skillNames = profile.skills.map((s) => s.name);
      expect(skillNames).toContain('TypeScript');
      expect(skillNames).toContain('PostgreSQL');
      expect(skillNames).toContain('Docker');
      expect(skillNames).toContain('Kubernetes');

      const tsSkill = profile.skills.find((s) => s.name === 'TypeScript');
      expect(tsSkill?.evidenceQuote).toContain('TypeScript');
    });

    it('processes EXTRACT_PROFILE job and idempotently creates profile and skills', async () => {
      const mockJob = {
        id: 'job-profile-1',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'job-profile-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'EXTRACT_PROFILE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: 'key-1.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCallCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $executeRaw: vi.fn(async () => 1),
        candidateProfile: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({ id: 'prof-1' })),
        },
        candidateSkill: {
          create: vi.fn(async () => ({})),
        },
        processingJob: {
          create: vi.fn(async () => ({})),
        },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCallCount += 1;
          if (txCallCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        documentExtraction: {
          findFirst: vi.fn(async () => ({
            extractedText: 'Senior Engineer with TypeScript and PostgreSQL',
          })),
        },
      } as unknown as PrismaClient;

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-profile-test',
        heartbeatIntervalMs: 0,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      expect(mockTx2.candidateProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            candidateId: 'cand-1',
            profileVersion: 1,
          }),
        }),
      );
      expect(mockTx2.processingJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: 'DETECT_DUPLICATE',
            status: 'QUEUED',
          }),
        }),
      );
    });

    it('processes DETECT_DUPLICATE job and queues ASSESS_CANDIDATE when approved scorecard exists', async () => {
      const mockJob = {
        id: 'job-dup-1',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        requisition_id: 'req-1',
      };

      const mockClaimedRecord = {
        id: 'job-dup-1',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'DETECT_DUPLICATE',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: 'key-1.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      let txCallCount = 0;
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [mockJob]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $executeRaw: vi.fn(async () => 1),
        resumeDocument: {
          findFirst: vi.fn(async () => ({ id: 'doc-existing-dup', candidateId: 'cand-other' })),
        },
        auditLog: {
          create: vi.fn(async () => ({})),
        },
        scorecard: {
          findFirst: vi.fn(async () => ({ id: 'sc-approved-1' })),
        },
        processingJob: {
          create: vi.fn(async () => ({})),
        },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCallCount += 1;
          if (txCallCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
        resumeDocument: {
          findUnique: vi.fn(async () => ({ sha256: 'sha-duplicate-test-123' })),
        },
      } as unknown as PrismaClient;

      const processor = new WorkerJobProcessor(mockDb, {} as WorkerStorageService, {
        workerId: 'worker-dup-test',
        heartbeatIntervalMs: 0,
      });

      const processed = await processor.processNextJob();
      expect(processed).toBe(true);
      expect(mockTx2.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'DUPLICATE_CANDIDATE_DETECTED',
            metadataJson: expect.objectContaining({
              matchedOn: 'SHA-256',
            }),
          }),
        }),
      );
      expect(mockTx2.processingJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: 'ASSESS_CANDIDATE',
            status: 'QUEUED',
          }),
        }),
      );
    });

    describe('Worker Candidate Lifecycle Fencing Fencing Regression Suite', () => {
      const baseClaimedRecord = {
        id: 'job-fence-1',
        batchId: 'batch-fence-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-1',
        jobType: 'EXTRACT_TEXT' as const,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-1',
          candidateId: 'cand-1',
          objectKey: 'key-1.pdf',
          fileType: 'PDF' as const,
          organizationId: 'org-1',
        },
      };

      const mockQueuedJob = {
        id: 'job-fence-1',
        status: 'QUEUED',
        attempts: 0,
        resume_document_id: 'doc-1',
        organization_id: 'org-1',
        requisition_id: 'req-1',
      };

      it('propagates database query failure/lock timeout during candidate locking and aborts Phase 2', async () => {
        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => baseClaimedRecord) },
        };

        const dbLockError = new Error(
          'canceling statement due to statement timeout (lock wait timeout)',
        );
        const mockTx2 = {
          $queryRaw: vi.fn(async () => {
            throw dbLockError;
          }),
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: { create: vi.fn() },
          resumeDocument: { update: vi.fn() },
        };

        let tx3Phase4Executed = false;
        const mockTx3 = {
          $executeRaw: vi.fn(async () => {
            tx3Phase4Executed = true;
            return 1;
          }),
          resumeDocument: { update: vi.fn() },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            if (txCallCount === 2) return cb(mockTx2);
            return cb(mockTx3);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 test resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-fence-query-failure',
          heartbeatIntervalMs: 0,
        });
        vi.spyOn(processor, 'parseDocument').mockResolvedValue({
          extractedText: 'Sample resume text',
          pageMapJson: { pages: [] },
          parser: 'pdf-text',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(mockTx2.$queryRaw).toHaveBeenCalled();
        expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
        expect(mockTx2.resumeDocument.update).not.toHaveBeenCalled();
        expect(tx3Phase4Executed).toBe(true);
      });

      it('fails closed when candidate record is missing', async () => {
        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => baseClaimedRecord) },
        };

        const mockTx2 = {
          $queryRaw: vi.fn(async () => []), // Candidate row NOT found in DB
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: { create: vi.fn() },
          resumeDocument: { update: vi.fn() },
          processingJob: { create: vi.fn() },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            return cb(mockTx2);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 test resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-fence-missing',
          heartbeatIntervalMs: 0,
        });
        vi.spyOn(processor, 'parseDocument').mockResolvedValue({
          extractedText: 'Sample resume text',
          pageMapJson: { pages: [] },
          parser: 'pdf-text',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(txCallCount).toBe(2);
        expect(mockTx2.$queryRaw).toHaveBeenCalled();
        expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
        expect(mockTx2.resumeDocument.update).not.toHaveBeenCalled();
        expect(mockTx2.processingJob.create).not.toHaveBeenCalled();
        expect(mockTx2.$executeRaw).toHaveBeenCalled();
      });

      it('rejects candidate with non-ACTIVE status and aborts processing', async () => {
        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => baseClaimedRecord) },
        };

        const mockTx2 = {
          $queryRaw: vi.fn(async () => [{ id: 'cand-1', record_status: 'PENDING_DELETION' }]),
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: { create: vi.fn() },
          resumeDocument: { update: vi.fn() },
          processingJob: { create: vi.fn() },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            return cb(mockTx2);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 test resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-fence-non-active',
          heartbeatIntervalMs: 0,
        });
        vi.spyOn(processor, 'parseDocument').mockResolvedValue({
          extractedText: 'Sample resume text',
          pageMapJson: { pages: [] },
          parser: 'pdf-text',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(txCallCount).toBe(2);
        expect(mockTx2.$queryRaw).toHaveBeenCalled();
        expect(mockTx2.documentExtraction.create).not.toHaveBeenCalled();
        expect(mockTx2.resumeDocument.update).not.toHaveBeenCalled();
        expect(mockTx2.processingJob.create).not.toHaveBeenCalled();
      });

      it('successfully processes when candidate is locked and confirmed ACTIVE', async () => {
        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => baseClaimedRecord) },
        };

        const mockTx2 = {
          $queryRaw: vi.fn(async () => [{ id: 'cand-1', record_status: 'ACTIVE' }]),
          candidateConsent: {
            findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
          },
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: {
            create: vi.fn(async () => ({})),
            aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
          },
          resumeDocument: { update: vi.fn(async () => ({})) },
          processingJob: { create: vi.fn(async () => ({})) },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            return cb(mockTx2);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 test resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-fence-active',
          heartbeatIntervalMs: 0,
        });
        vi.spyOn(processor, 'parseDocument').mockResolvedValue({
          extractedText: 'Sample resume text',
          pageMapJson: { pages: [] },
          parser: 'pdf-text',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(mockTx2.$queryRaw).toHaveBeenCalled();
        expect(mockTx2.documentExtraction.create).toHaveBeenCalled();
        expect(mockTx2.resumeDocument.update).toHaveBeenCalled();
        expect(mockTx2.processingJob.create).toHaveBeenCalled();
      });

      it('preserves NEEDS_REVIEW quality and parseStatus when OCR returns partial extraction', async () => {
        const { PdfTextExtractor } = await import('@talentlens/document-processing');
        vi.spyOn(PdfTextExtractor.prototype, 'parse').mockResolvedValueOnce({
          extractedText: 'Page 1 partial OCR content',
          pageMapJson: {
            pages: [{ pageNumber: 1, textLength: 26, startOffset: 0, endOffset: 26 }],
          },
          parser: 'pdf-text+ocr',
          ocrUsed: true,
          qualityStatus: 'NEEDS_REVIEW',
        });

        const mockOcrQueuedJob = {
          id: 'job-ocr-partial',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-ocr-1',
          organization_id: 'org-1',
          requisition_id: 'req-1',
        };

        const mockOcrClaimedRecord = {
          ...baseClaimedRecord,
          id: 'job-ocr-partial',
          jobType: 'OCR' as const,
          resumeDocumentId: 'doc-ocr-1',
        };

        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockOcrQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => mockOcrClaimedRecord) },
        };

        const mockTx2 = {
          $queryRaw: vi.fn(async () => [{ id: 'cand-1', record_status: 'ACTIVE' }]),
          candidateConsent: {
            findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
          },
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: {
            create: vi.fn(async () => ({})),
            aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
          },
          resumeDocument: { update: vi.fn(async () => ({})) },
          processingJob: { create: vi.fn(async () => ({})) },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            return cb(mockTx2);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 scanned resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-ocr-partial',
          heartbeatIntervalMs: 0,
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(mockTx2.documentExtraction.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              qualityStatus: 'NEEDS_REVIEW',
              ocrUsed: true,
            }),
          }),
        );
        expect(mockTx2.resumeDocument.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { parseStatus: 'NEEDS_REVIEW' },
          }),
        );
        expect(mockTx2.processingJob.create).not.toHaveBeenCalled();
      });

      it('preserves FAILED quality and parseStatus when OCR returns FAILED even with partial text', async () => {
        const { PdfTextExtractor } = await import('@talentlens/document-processing');
        vi.spyOn(PdfTextExtractor.prototype, 'parse').mockResolvedValueOnce({
          extractedText: 'Unrecoverable corruption after page 1',
          pageMapJson: {
            pages: [{ pageNumber: 1, textLength: 37, startOffset: 0, endOffset: 37 }],
          },
          parser: 'pdf-text+ocr',
          ocrUsed: true,
          qualityStatus: 'FAILED',
        });

        const mockOcrQueuedJob = {
          id: 'job-ocr-failed',
          status: 'QUEUED',
          attempts: 0,
          resume_document_id: 'doc-ocr-fail-1',
          organization_id: 'org-1',
          requisition_id: 'req-1',
        };

        const mockOcrClaimedRecord = {
          ...baseClaimedRecord,
          id: 'job-ocr-failed',
          jobType: 'OCR' as const,
          resumeDocumentId: 'doc-ocr-fail-1',
        };

        let txCallCount = 0;
        const mockTx1 = {
          $queryRaw: vi.fn(async () => [mockOcrQueuedJob]),
          candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
          $executeRaw: vi.fn(async () => 1),
          processingJob: { findUnique: vi.fn(async () => mockOcrClaimedRecord) },
        };

        const mockTx2 = {
          $queryRaw: vi.fn(async () => [{ id: 'cand-1', record_status: 'ACTIVE' }]),
          candidateConsent: {
            findFirst: vi.fn(async () => ({ id: 'consent-1', candidateId: 'cand-1' })),
          },
          $executeRaw: vi.fn(async () => 1),
          documentExtraction: {
            create: vi.fn(async () => ({})),
            aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
          },
          resumeDocument: { update: vi.fn(async () => ({})) },
          processingJob: { create: vi.fn(async () => ({})) },
        };

        const mockDb = {
          $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            txCallCount += 1;
            if (txCallCount === 1) return cb(mockTx1);
            return cb(mockTx2);
          }),
        } as unknown as PrismaClient;

        const mockStorage = {
          read: vi.fn(async () => Buffer.from('%PDF-1.4 scanned resume buffer')),
        } as unknown as WorkerStorageService;

        const processor = new WorkerJobProcessor(mockDb, mockStorage, {
          workerId: 'worker-ocr-failed',
          heartbeatIntervalMs: 0,
        });

        const processed = await processor.processNextJob();
        expect(processed).toBe(true);
        expect(mockTx2.documentExtraction.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              qualityStatus: 'FAILED',
              ocrUsed: true,
            }),
          }),
        );
        expect(mockTx2.resumeDocument.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { parseStatus: 'FAILED' },
          }),
        );
        expect(mockTx2.processingJob.create).not.toHaveBeenCalled();
      });
    });

    it('permanently fails attempt 1 without retry and stays alive when parsing throws SecurityLimitExceededError', async () => {
      const payload = Buffer.from(
        `<w:document><w:body><w:p><w:t>${'A'.repeat(250_000)}</w:t></w:p></w:body></w:document>`,
        'utf8',
      );
      const deflated = zlib.deflateRawSync(payload);
      const filename = Buffer.from('word/document.xml', 'utf8');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(deflated.length, 18);
      header.writeUInt32LE(payload.length, 22);
      header.writeUInt16LE(filename.length, 26);
      const bombDocx = Buffer.concat([header, filename, deflated]);

      const mockClaimedRecord = {
        id: 'job-docx-bomb',
        batchId: 'batch-1',
        organizationId: 'org-1',
        resumeDocumentId: 'doc-bomb-1',
        jobType: 'EXTRACT_TEXT',
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
        batch: { requisitionId: 'req-1' },
        resumeDocument: {
          id: 'doc-bomb-1',
          objectKey: '2026-11/bomb.docx',
          fileType: 'DOCX' as const,
          organizationId: 'org-1',
        },
      };

      let txCallCount = 0;
      const recordedSqlValues: unknown[] = [];
      const mockTx1 = {
        $queryRaw: vi.fn(async () => [
          {
            id: 'job-docx-bomb',
            status: 'QUEUED',
            attempts: 0,
            resume_document_id: 'doc-bomb-1',
            organization_id: 'org-1',
            requisition_id: 'req-1',
          },
        ]),
        candidateConsent: { findFirst: vi.fn(async () => ({ id: 'consent-1' })) },
        $executeRaw: vi.fn(async () => 1),
        processingJob: { findUnique: vi.fn(async () => mockClaimedRecord) },
      };

      const mockTx2 = {
        $executeRaw: vi.fn(async (sqlQuery: { values?: unknown[] }) => {
          recordedSqlValues.push(...(sqlQuery?.values ?? []));
          return 1;
        }),
        resumeDocument: { update: vi.fn(async () => ({})) },
      };

      const mockDb = {
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCallCount += 1;
          if (txCallCount === 1) return cb(mockTx1);
          return cb(mockTx2);
        }),
      } as unknown as PrismaClient;

      const mockStorage = {
        read: vi.fn(async () => bombDocx),
      } as unknown as WorkerStorageService;

      const processor = new WorkerJobProcessor(mockDb, mockStorage, {
        heartbeatIntervalMs: 0,
      });

      const handled = await processor.processNextJob();
      expect(handled).toBe(true);
      expect(txCallCount).toBe(2);
      expect(recordedSqlValues[0]).toBe('FAILED');
      expect(String(recordedSqlValues[1])).toMatch(/^DOCUMENT_SECURITY_LIMIT_EXCEEDED:/);
      expect(mockTx2.resumeDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc-bomb-1' },
        data: { parseStatus: 'FAILED' },
      });
    });
  });
});
