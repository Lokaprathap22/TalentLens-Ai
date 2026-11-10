import { describe, expect, it, vi } from 'vitest';

import { Prisma, type PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  CriterionCategory,
  RequirementType,
  JdExtractionOutput,
} from './jd-extraction.types.js';
import {
  ScorecardCriterionKeyConflictError,
  ScorecardCriterionScopeError,
  createScorecardRepository,
  isRetryableConcurrencyError,
  withConcurrencyRetry,
  lockRequisitionRow,
} from './scorecard.repository.js';

const principal: AuthenticatedPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER',
};

const extraction: JdExtractionOutput = {
  jobTitle: {
    originalText: 'Engineer',
    evidence: {
      sourceQuote: 'Engineer',
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: 'PENDING_RECRUITER_REVIEW',
    },
  },
  minimumExperienceYears: null,
  maximumExperienceYears: null,
  experienceRequirement: null,
  requiredSkills: [],
  preferredSkills: [],
  educationRequirements: [],
  certifications: [],
  domainExperience: [],
  compensation: null,
  noticePeriod: null,
  otherRequirements: [],
  warnings: [],
  criteria: [
    {
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      label: 'TypeScript',
      description: 'TypeScript',
      weight: 100,
      evidence: {
        sourceQuote: 'TypeScript',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
};

function scorecardRecord(status: 'DRAFT' | 'APPROVED' | 'ARCHIVED' = 'DRAFT') {
  return {
    id: 'scorecard-a',
    requisitionId: 'requisition-a',
    version: 1,
    status,
    weightsJson: {
      contractVersion: 1,
      scoring: {},
      extraction: {
        contractVersion: 1,
        extractionSchemaVersion: 'jd-extraction-v2',
        jobTitle: null,
        requiredSkills: [],
        preferredSkills: [],
        educationRequirements: [],
        certifications: [],
        domainExperience: [],
        experience: { minimumYears: null, maximumYears: null, requirement: null },
        compensation: null,
        notice: null,
        otherRequirements: [],
        warnings: [],
      },
    },
    approvedById: status === 'APPROVED' ? 'recruiter-a' : null,
    approvedAt: status === 'APPROVED' ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    criteria: [
      {
        id: 'criterion-a',
        key: 'skill-1',
        label: 'TypeScript',
        category: 'SKILL' as CriterionCategory,
        requirementType: 'MUST_HAVE' as RequirementType,
        weight: 100,
        ruleJson: {
          description: 'TypeScript',
          evidence: {
            sourceQuote: 'TypeScript',
            sourceStart: 0,
            sourceEnd: 10,
            verificationStatus: 'VERIFIED',
          },
        },
        active: true,
        displayOrder: 0,
      },
    ],
  };
}

describe('scorecard repository — concurrency and retry classification', () => {
  function makePrismaError(
    code: string,
    meta?: Record<string, unknown>,
  ): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Database error', {
      code,
      clientVersion: '7.10.1',
      ...(meta !== undefined ? { meta } : {}),
    });
  }

  it('recognizes P2034 serialization conflicts as retryable', () => {
    const error = makePrismaError('P2034');
    expect(isRetryableConcurrencyError(error)).toBe(true);
  });

  it('recognizes P2002 with target array [requisitionId, version] as retryable', () => {
    const error = makePrismaError('P2002', { target: ['requisitionId', 'version'] });
    expect(isRetryableConcurrencyError(error)).toBe(true);
  });

  it('recognizes P2002 with target array in reverse order [version, requisitionId] as retryable', () => {
    const error = makePrismaError('P2002', { target: ['version', 'requisitionId'] });
    expect(isRetryableConcurrencyError(error)).toBe(true);
  });

  it('recognizes P2002 with PostgreSQL index name as retryable', () => {
    const error = makePrismaError('P2002', {
      target: 'scorecard_versions_requisition_id_version_key',
    });
    expect(isRetryableConcurrencyError(error)).toBe(true);
  });

  it('rejects P2002 for an unrelated unique constraint', () => {
    const error = makePrismaError('P2002', { target: ['scorecardVersionId', 'key'] });
    expect(isRetryableConcurrencyError(error)).toBe(false);
  });

  it('rejects unrelated Prisma errors as non-retryable', () => {
    const error = makePrismaError('P2025');
    expect(isRetryableConcurrencyError(error)).toBe(false);
  });

  it('rejects standard JavaScript errors as non-retryable', () => {
    const error = new Error('Connection lost');
    expect(isRetryableConcurrencyError(error)).toBe(false);
  });

  it('succeeds withConcurrencyRetry after a recognized transient conflict', async () => {
    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makePrismaError('P2034');
      }
      return 'success';
    });

    const result = await withConcurrencyRetry(operation);
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('bounds withConcurrencyRetry to 3 attempts and propagates error on exhaustion', async () => {
    let attempts = 0;
    const error = makePrismaError('P2034');
    const operation = vi.fn(async () => {
      attempts += 1;
      throw error;
    });

    await expect(withConcurrencyRetry(operation)).rejects.toBe(error);
    expect(attempts).toBe(3);
  });

  it('propagates non-retryable errors immediately without repeated attempts', async () => {
    let attempts = 0;
    const error = new Error('Non-retryable application failure');
    const operation = vi.fn(async () => {
      attempts += 1;
      throw error;
    });

    await expect(withConcurrencyRetry(operation)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});

describe('scorecard repository — queries and transactions', () => {
  it('scopes requisition lookup by organization and recruiter', async () => {
    const requisition = {
      findFirst: vi.fn(async () => ({
        id: 'requisition-a',
        title: 'Engineer',
        jdText: 'TypeScript',
      })),
    };
    const database = { requisition } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await repository.findAuthorizedRequisition('organization-a', 'recruiter-a', 'requisition-a');

    expect(requisition.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'requisition-a',
        organizationId: 'organization-a',
        assignedRecruiterId: 'recruiter-a',
      },
      select: { id: true, title: true, jdText: true },
    });
  });

  it('executes parameterized UUID row locking in lockRequisitionRow', async () => {
    const $queryRaw = vi.fn(async () => []);
    await lockRequisitionRow(
      { $queryRaw } as unknown as { $queryRaw: PrismaClient['$queryRaw'] },
      'req-123',
    );

    expect($queryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        strings: expect.arrayContaining([
          expect.stringContaining('SELECT id FROM "requisitions" WHERE id = CAST('),
          expect.stringContaining('AS uuid) FOR UPDATE'),
        ]),
        values: ['req-123'],
      }),
    );
  });

  it('creates versions and criteria in a serializable transaction with row locking', async () => {
    const created = scorecardRecord();
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
        create: vi.fn(async () => created),
        findUniqueOrThrow: vi.fn(async () => created),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await repository.createDraft(
      principal,
      { id: 'requisition-a', title: 'Engineer', jdText: 'TypeScript' },
      extraction,
    );

    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.scorecardVersion.aggregate).toHaveBeenCalledWith({
      where: { requisitionId: 'requisition-a', organizationId: 'organization-a' },
      _max: { version: true },
    });
    expect(transaction.scorecardVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'organization-a',
          requisitionId: 'requisition-a',
          version: 1,
          criteria: {
            create: [
              expect.objectContaining({
                label: 'TypeScript',
                requirementType: 'MUST_HAVE',
              }),
            ],
          },
        }),
      }),
    );
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel,
    });
  });

  it('updates one criterion without deleting unrelated criteria', async () => {
    const updated = scorecardRecord();
    const transaction = {
      scorecardVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'scorecard-a', weightsJson: {} })
          .mockResolvedValueOnce(updated),
        update: vi.fn(async () => undefined),
      },
      scorecardCriterion: {
        findMany: vi.fn(async () => [
          {
            id: 'criterion-a',
            key: 'skill-1',
            ruleJson: { description: 'old', evidence: { keep: true } },
          },
          { id: 'criterion-b', key: 'skill-2', ruleJson: { description: 'other' } },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await repository.updateDraft(principal, 'requisition-a', 'scorecard-a', {
      criteria: [
        {
          id: 'criterion-a',
          label: 'Updated',
          description: 'updated description',
          category: 'SKILL',
          requirementType: 'MUST_HAVE',
          weight: 100,
          displayOrder: 0,
          active: true,
        },
      ],
    });

    expect(transaction.scorecardCriterion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'criterion-a', scorecardVersionId: 'scorecard-a' },
        data: expect.objectContaining({
          key: 'skill-1',
          ruleJson: { description: 'updated description', evidence: { keep: true } },
        }),
      }),
    );
    expect(transaction.scorecardCriterion.create).not.toHaveBeenCalled();
  });

  it('rejects conflicting explicit criterion key against untouched criteria without overwriting existing keys', async () => {
    const transaction = {
      scorecardVersion: {
        findFirst: vi.fn(async () => ({ id: 'scorecard-a', weightsJson: {} })),
      },
      scorecardCriterion: {
        findMany: vi.fn(async () => [
          { id: 'criterion-a', key: 'skill-1', ruleJson: {} },
          { id: 'criterion-b', key: 'skill-2', ruleJson: {} },
        ]),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await expect(
      repository.updateDraft(principal, 'requisition-a', 'scorecard-a', {
        criteria: [
          {
            id: 'criterion-a',
            key: 'SKILL-2',
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ScorecardCriterionKeyConflictError);

    expect(transaction.scorecardCriterion.updateMany).not.toHaveBeenCalled();
  });

  it('maps P2002 criterion key constraint violation in updateDraft to ScorecardCriterionKeyConflictError', async () => {
    const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.0.0',
      meta: { target: ['scorecard_version_id', 'key'] },
    });
    const transaction = {
      scorecardVersion: {
        findFirst: vi.fn(async () => ({ id: 'scorecard-a', weightsJson: {} })),
      },
      scorecardCriterion: {
        findMany: vi.fn(async () => [
          { id: 'criterion-a', key: 'skill-1', ruleJson: {} },
        ]),
        updateMany: vi.fn(async () => {
          throw p2002Error;
        }),
        create: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await expect(
      repository.updateDraft(principal, 'requisition-a', 'scorecard-a', {
        criteria: [
          {
            id: 'criterion-a',
            label: 'TypeScript',
            description: 'TypeScript',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ScorecardCriterionKeyConflictError);
  });

  it('allocates unique manual keys without collision when manual-1 already exists', async () => {
    const updated = scorecardRecord();
    const transaction = {
      scorecardVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'scorecard-a', weightsJson: {} })
          .mockResolvedValueOnce(updated),
        update: vi.fn(async () => undefined),
      },
      scorecardCriterion: {
        findMany: vi.fn(async () => [{ id: 'criterion-a', key: 'manual-1', ruleJson: {} }]),
        create: vi.fn(async () => undefined),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await repository.updateDraft(principal, 'requisition-a', 'scorecard-a', {
      criteria: [
        {
          label: 'New Manual Item',
          description: 'Description',
          category: 'SKILL',
          requirementType: 'PREFERRED',
          weight: 0,
          displayOrder: 1,
          active: true,
        },
      ],
    });

    expect(transaction.scorecardCriterion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: 'manual-2',
        }),
      }),
    );
  });

  it('rejects a criterion ID from another scorecard', async () => {
    const transaction = {
      scorecardVersion: {
        findFirst: vi.fn(async () => ({ id: 'scorecard-a', weightsJson: {} })),
      },
      scorecardCriterion: {
        findMany: vi.fn(async () => [{ id: 'criterion-a', key: 'skill-1', ruleJson: {} }]),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    await expect(
      repository.updateDraft(principal, 'requisition-a', 'scorecard-a', {
        criteria: [
          {
            id: 'foreign-criterion',
            label: 'Other',
            description: 'Other',
            category: 'SKILL',
            requirementType: 'PREFERRED',
            weight: 0,
            displayOrder: 0,
            active: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ScorecardCriterionScopeError);
  });
});

describe('scorecard repository — approve lifecycle', () => {
  it('approves a valid draft, archives previous approved version, and sets approver metadata', async () => {
    const draft = scorecardRecord('DRAFT');
    const approved = scorecardRecord('APPROVED');
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(approved),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 }) // archives old approved
          .mockResolvedValueOnce({ count: 1 }), // sets new approved
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');

    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.scorecardVersion.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          requisitionId: 'requisition-a',
          organizationId: 'organization-a',
          status: 'APPROVED',
          id: { not: 'scorecard-a' },
        },
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(transaction.scorecardVersion.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'scorecard-a', status: 'DRAFT' }),
        data: expect.objectContaining({
          status: 'APPROVED',
          approvedById: 'recruiter-a',
          approvedAt: expect.any(Date),
        }),
      }),
    );
    expect(result?.status).toBe('APPROVED');
  });

  it('permits approval of a criterion with an empty description', async () => {
    const draft = scorecardRecord('DRAFT');
    draft.criteria[0]!.ruleJson.description = ''; // empty description
    const approved = scorecardRecord('APPROVED');
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(approved),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');
    expect(result?.status).toBe('APPROVED');
  });

  it('rejects approval if an active criterion is unverified', async () => {
    const draft = scorecardRecord('DRAFT');
    (draft.criteria[0]!.ruleJson.evidence as Record<string, unknown>).verificationStatus =
      'UNVERIFIED';
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn(async () => draft),
        updateMany: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');
    expect(result).toBeNull();
    expect(transaction.scorecardVersion.updateMany).not.toHaveBeenCalled();
  });

  it('rejects approval if a criterion contains a protected attribute', async () => {
    const draft = scorecardRecord('DRAFT');
    draft.criteria[0]!.ruleJson.description = 'Candidate must be under age 30';
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn(async () => draft),
        updateMany: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');
    expect(result).toBeNull();
    expect(transaction.scorecardVersion.updateMany).not.toHaveBeenCalled();
  });

  it('rejects approval if total weight is not 100', async () => {
    const draft = scorecardRecord('DRAFT');
    draft.criteria[0]!.weight = 50;
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn(async () => draft),
        updateMany: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');
    expect(result).toBeNull();
    expect(transaction.scorecardVersion.updateMany).not.toHaveBeenCalled();
  });

  it('rejects approval if there is no MUST_HAVE criterion', async () => {
    const draft = scorecardRecord('DRAFT');
    draft.criteria[0]!.requirementType = 'PREFERRED';
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn(async () => draft),
        updateMany: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.approve(principal, 'requisition-a', 'scorecard-a');
    expect(result).toBeNull();
    expect(transaction.scorecardVersion.updateMany).not.toHaveBeenCalled();
  });

  it('creates an empty manual draft in a serializable transaction with row locking and audit log', async () => {
    const emptyDraft = {
      ...scorecardRecord('DRAFT'),
      version: 2,
      criteria: [],
    };
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
        create: vi.fn(async () => emptyDraft),
        findUniqueOrThrow: vi.fn(async () => emptyDraft),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const created = await repository.createManualDraft!(principal, {
      id: 'requisition-a',
      title: 'Engineer',
      jdText: 'TypeScript',
    });

    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.scorecardVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'organization-a',
          requisitionId: 'requisition-a',
          version: 2,
          criteria: { create: [] },
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'organization-a',
        actorId: 'recruiter-a',
        action: 'SCORECARD_DRAFT_CREATED_MANUAL',
        resourceType: 'ScorecardVersion',
        resourceId: 'scorecard-a',
        requisitionId: 'requisition-a',
        metadataJson: {
          version: 2,
          mode: 'manual',
          criterionCount: 0,
        },
      },
    });
    expect(created.version).toBe(2);
    expect(created.criteria).toEqual([]);
  });

  it('clones an existing scorecard version in a serializable transaction with row locking and audit log', async () => {
    const sourceRecord = scorecardRecord('APPROVED');
    const clonedRecord = {
      ...scorecardRecord('DRAFT'),
      id: 'scorecard-cloned',
      version: 2,
      approvedById: null,
      approvedAt: null,
    };
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      scorecardVersion: {
        findFirst: vi.fn(async () => sourceRecord),
        aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
        create: vi.fn(async () => clonedRecord),
        findUniqueOrThrow: vi.fn(async () => clonedRecord),
      },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = createScorecardRepository(database);

    const result = await repository.cloneDraft!(
      principal,
      { id: 'requisition-a', title: 'Engineer', jdText: 'TypeScript' },
      'scorecard-a',
      (ev) =>
        ev
          ? {
              ...ev,
              verificationStatus: 'PENDING_RECRUITER_REVIEW',
            }
          : null,
    );

    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.scorecardVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'organization-a',
          requisitionId: 'requisition-a',
          version: 2,
          criteria: {
            create: [
              expect.objectContaining({
                key: 'skill-1',
                label: 'TypeScript',
                category: 'SKILL',
                requirementType: 'MUST_HAVE',
                weight: 100,
                active: true,
                displayOrder: 0,
                ruleJson: expect.objectContaining({
                  evidence: expect.objectContaining({
                    verificationStatus: 'PENDING_RECRUITER_REVIEW',
                  }),
                }),
              }),
            ],
          },
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'organization-a',
        actorId: 'recruiter-a',
        action: 'SCORECARD_DRAFT_CLONED',
        resourceType: 'ScorecardVersion',
        resourceId: 'scorecard-cloned',
        requisitionId: 'requisition-a',
        metadataJson: {
          version: 2,
          mode: 'clone',
          clonedFromVersionId: 'scorecard-a',
          clonedFromVersion: 1,
          criterionCount: 1,
        },
      },
    });
    expect(result?.status).toBe('DRAFT');
    expect(result?.approvedById).toBeNull();
  });
});
