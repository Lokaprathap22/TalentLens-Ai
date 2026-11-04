import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@talentlens/database';
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
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-1' }]),
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
        $queryRaw: vi.fn(async () => [{ id: 'assess-job-consent-loss' }]),
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
        $queryRaw: vi.fn(async () => []), // Fenced: 0 rows match lease
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
  });
});
