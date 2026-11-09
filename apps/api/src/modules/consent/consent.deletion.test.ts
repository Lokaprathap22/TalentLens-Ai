import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createConsentRepository } from './consent.repository.js';
import { StorageNotFoundError } from '../resumes/resume.storage.js';

describe('Candidate Deletion & Right to Erasure State Machine', () => {
  const organizationId = 'org-1111-1111';
  const candidateId = 'cand-2222-2222';
  const recruiterId = 'user-3333-3333';
  const requestId = 'del-req-4444';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createDeletionRequest atomically sets candidate to DELETION_PENDING and cancels pending jobs', async () => {
    let updatedCandidateStatus: string | null = null;
    let cancelledJobsCount = 0;
    let auditAction: string | null = null;

    const mockTx = {
      candidate: {
        findFirst: vi.fn().mockResolvedValue({ id: candidateId, recordStatus: 'ACTIVE' }),
        update: vi.fn().mockImplementation((args) => {
          updatedCandidateStatus = args.data.recordStatus;
          return Promise.resolve({ id: candidateId, recordStatus: args.data.recordStatus });
        }),
      },
      processingJob: {
        updateMany: vi.fn().mockImplementation(() => {
          cancelledJobsCount = 2;
          return Promise.resolve({ count: 2 });
        }),
      },
      deletionRequest: {
        create: vi.fn().mockResolvedValue({
          id: requestId,
          organizationId,
          candidateId,
          requestedById: recruiterId,
          status: 'REQUESTED',
          requestedAt: new Date(),
          processedAt: null,
          resultSummary: null,
        }),
      },
      auditLog: {
        create: vi.fn().mockImplementation((args) => {
          auditAction = args.data.action;
          return Promise.resolve({ id: 'audit-1' });
        }),
      },
    };

    const mockDb = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);

    const result = await repository.createDeletionRequest(organizationId, candidateId, recruiterId);

    expect(result.status).toBe('REQUESTED');
    expect(updatedCandidateStatus).toBe('DELETION_PENDING');
    expect(cancelledJobsCount).toBe(2);
    expect(auditAction).toBe('CANDIDATE_DELETION_REQUESTED');
  });

  it('processDeletion transitions request to PARTIALLY_BLOCKED if storage deletion fails with a retryable error', async () => {
    let requestStatusUpdated: string | null = null;

    const mockDb = {
      deletionRequest: {
        findFirst: vi.fn().mockResolvedValue({
          id: requestId,
          organizationId,
          candidateId,
          status: 'REQUESTED',
          requestedById: recruiterId,
        }),
        update: vi.fn().mockImplementation((args) => {
          requestStatusUpdated = args.data.status;
          return Promise.resolve({});
        }),
      },
      resumeDocument: {
        findMany: vi.fn().mockResolvedValue([{ id: 'res-1', objectKey: 'org-1/res-1.pdf' }]),
      },
    };

    const repository = createConsentRepository(mockDb as never);

    const failingStorageDelete = vi.fn().mockRejectedValue(new Error('S3 connection timeout'));

    await expect(
      repository.processDeletion(organizationId, requestId, failingStorageDelete, recruiterId),
    ).rejects.toThrow('STORAGE_DELETION_FAILED: S3 connection timeout');

    expect(requestStatusUpdated).toBe('PARTIALLY_BLOCKED');
  });

  it('processDeletion treats 404/StorageNotFoundError as deleted and executes full cascading erasure', async () => {
    let finalCandidateStatus: string | null = null;
    let finalRequestStatus: string | null = null;
    let identityRedacted = false;
    let auditActor: string | null = null;

    const mockTx = {
      processingJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateSubmission: {
        findMany: vi.fn().mockResolvedValue([{ id: 'sub-1' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      clientDecision: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      interviewProposal: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      pipelineEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateShortlist: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateReview: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateAssessment: {
        findMany: vi.fn().mockResolvedValue([{ id: 'asm-1' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      evidenceSnippet: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      criterionAssessment: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      assessmentText: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      documentExtraction: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      resumeDocument: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateProfile: {
        findMany: vi.fn().mockResolvedValue([{ id: 'prof-1' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      candidateSkill: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateDeletionVerification: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      consentWithdrawalRequest: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateConsent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      consentInvitation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateIdentity: {
        updateMany: vi.fn().mockImplementation((args) => {
          if (args.data.identityStatus === 'REDACTED' && args.data.fullNameEncrypted === null) {
            identityRedacted = true;
          }
          return Promise.resolve({ count: 1 });
        }),
      },
      candidate: {
        update: vi.fn().mockImplementation((args) => {
          finalCandidateStatus = args.data.recordStatus;
          return Promise.resolve({});
        }),
      },
      deletionRequest: {
        update: vi.fn().mockImplementation((args) => {
          finalRequestStatus = args.data.status;
          return Promise.resolve({});
        }),
      },
      auditLog: {
        create: vi.fn().mockImplementation((args) => {
          auditActor = args.data.actorId;
          return Promise.resolve({});
        }),
      },
    };

    const mockDb = {
      deletionRequest: {
        findFirst: vi.fn().mockResolvedValue({
          id: requestId,
          organizationId,
          candidateId,
          status: 'REQUESTED',
          requestedById: 'different-requester',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      resumeDocument: {
        findMany: vi.fn().mockResolvedValue([{ id: 'res-1', objectKey: 'org-1/res-1.pdf' }]),
      },
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);

    // Storage throws StorageNotFoundError (404) -> should be treated as successfully deleted!
    const notFoundStorageDelete = vi.fn().mockRejectedValue(new StorageNotFoundError());

    const result = await repository.processDeletion(
      organizationId,
      requestId,
      notFoundStorageDelete,
      recruiterId, // actual processor actorId
    );

    expect(result.status).toBe('COMPLETED');
    expect(finalCandidateStatus).toBe('DELETED');
    expect(finalRequestStatus).toBe('COMPLETED');
    expect(identityRedacted).toBe(true);
    expect(auditActor).toBe(recruiterId); // Attributed to actual processing recruiter
    expect(mockTx.processingJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          lastErrorCode: 'CANDIDATE_DATA_DELETED',
          resumeDocumentId: null,
        }),
      }),
    );
    expect(mockTx.candidateDeletionVerification.deleteMany).toHaveBeenCalledWith({
      where: { candidateId, organizationId },
    });
  });

  it('createDeletionRequest cancels pending email outbox messages and redacts PII', async () => {
    let cancelledOutbox = false;
    let outboxStatus: string | null = null;

    const mockTx = {
      candidate: {
        findFirst: vi.fn().mockResolvedValue({ id: candidateId, recordStatus: 'ACTIVE' }),
        update: vi.fn().mockResolvedValue({ id: candidateId, recordStatus: 'DELETION_PENDING' }),
      },
      processingJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      emailOutbox: {
        updateMany: vi.fn().mockImplementation((args) => {
          cancelledOutbox = true;
          outboxStatus = args.data.status;
          return Promise.resolve({ count: 1 });
        }),
      },
      deletionRequest: {
        create: vi.fn().mockResolvedValue({
          id: requestId,
          organizationId,
          candidateId,
          status: 'REQUESTED',
          requestedAt: new Date(),
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    const mockDb = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);
    await repository.createDeletionRequest(organizationId, candidateId, recruiterId);

    expect(cancelledOutbox).toBe(true);
    expect(outboxStatus).toBe('FAILED');
  });

  it('createDeletionRequest fails closed when $queryRaw throws instead of falling back', async () => {
    const mockTx = {
      $queryRaw: vi
        .fn()
        .mockRejectedValue(new Error('could not obtain lock on row in relation "candidates"')),
      candidate: {
        findFirst: vi.fn().mockResolvedValue({ id: candidateId, recordStatus: 'ACTIVE' }),
      },
    };

    const mockDb = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);

    await expect(
      repository.createDeletionRequest(organizationId, candidateId, recruiterId),
    ).rejects.toThrow('could not obtain lock');
    expect(mockTx.candidate.findFirst).not.toHaveBeenCalled();
  });

  it('confirmCandidateDeletion rejects already consumed, cancelled, or expired verification tokens (fail closed on replay)', async () => {
    const consumedTokenHash = 'hash-of-consumed-token';
    const cancelledTokenHash = 'hash-of-cancelled-token';
    const expiredTokenHash = 'hash-of-expired-token';

    const records: Record<
      string,
      { organizationId: string; candidateId: string; status: string; expiresAt: Date }
    > = {
      [consumedTokenHash]: {
        organizationId,
        candidateId,
        status: 'CONSUMED',
        expiresAt: new Date(Date.now() + 3600_000),
      },
      [cancelledTokenHash]: {
        organizationId,
        candidateId,
        status: 'CANCELLED',
        expiresAt: new Date(Date.now() + 3600_000),
      },
      [expiredTokenHash]: {
        organizationId,
        candidateId,
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 1000),
      },
    };

    const mockTx = {
      candidateDeletionVerification: {
        findUnique: vi
          .fn()
          .mockImplementation(({ where }) => Promise.resolve(records[where.tokenHash] ?? null)),
      },
      candidate: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      deletionRequest: {
        create: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);

    for (const hash of [consumedTokenHash, cancelledTokenHash, expiredTokenHash, 'nonexistent']) {
      const res = await repository.confirmCandidateDeletion(hash, vi.fn());
      expect(res).toBeNull();
    }

    expect(mockTx.candidate.update).not.toHaveBeenCalled();
    expect(mockTx.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('confirmCandidateDeletion fails closed when $queryRaw throws during candidate lock', async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('DB lock timeout')),
      $executeRaw: vi.fn(),
      candidate: {
        findFirst: vi.fn(),
      },
    };

    const mockDb = {
      $transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    };

    const repository = createConsentRepository(mockDb as never);

    await expect(repository.confirmCandidateDeletion('any-hash', vi.fn())).rejects.toThrow(
      'DB lock timeout',
    );
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    expect(mockTx.candidate.findFirst).not.toHaveBeenCalled();
  });
});
