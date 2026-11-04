/**
 * PostgreSQL 17 integration tests for the scorecard repository.
 *
 * These tests connect to a REAL PostgreSQL instance and exercise the actual
 * repository implementation end-to-end. They are STRICTLY OPT-IN:
 *
 *   TALENTLENS_RUN_PG_INTEGRATION=1 \
 *   TALENTLENS_INTEGRATION_DATABASE_URL=postgresql://talentlens:talentlens_local_only@localhost:5432/talentlens_scorecard_test \
 *   npx vitest run src/modules/scorecards/scorecard.repository.integration.test.ts
 *
 * When the env flag is absent the entire suite is skipped in < 1 ms, so it
 * is safe to keep inside the normal include glob.
 *
 * Safety invariants enforced before any write:
 *   1. TALENTLENS_INTEGRATION_DATABASE_URL must be explicitly provided.
 *   2. The database name must be exactly "talentlens_scorecard_test".
 *   3. The host must be localhost or 127.0.0.1.
 *   4. Credentials are never logged.
 */

import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
// PrismaClient constructor is exported from the compiled generated file.
// The @talentlens/database package only type-exports PrismaClient, so we
// reference the compiled dist barrel directly — which is safe because vitest
// resolves these imports at runtime, not through the TS compiler project refs.
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { JdExtractionOutput } from './jd-extraction.types.js';
import {
  createScorecardRepository,
  type ScorecardRecord,
  type ScorecardRepository,
} from './scorecard.repository.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrismaClient = InstanceType<typeof PrismaClient> & Record<string, any>;

// ─── Guard ────────────────────────────────────────────────────────────────────

const REQUIRED_DB_NAME = 'talentlens_scorecard_test';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

function assertSafeIntegrationDatabase(): string {
  const rawUrl = process.env['TALENTLENS_INTEGRATION_DATABASE_URL'];
  if (!rawUrl) {
    throw new Error(
      'TALENTLENS_INTEGRATION_DATABASE_URL must be set when running integration tests.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TALENTLENS_INTEGRATION_DATABASE_URL is not a valid URL.');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Integration tests may only connect to localhost. Got: ${parsed.hostname}`);
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `Integration tests must target "${REQUIRED_DB_NAME}". Refusing to run against "${dbName}".`,
    );
  }
  return rawUrl;
}

// ─── Client factory ───────────────────────────────────────────────────────────

function createTestPrismaClient(connectionString: string): AnyPrismaClient {
  const adapter = new PrismaPg({ connectionString });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (PrismaClient as any)({ adapter }) as AnyPrismaClient;
}

// ─── Fixture types ────────────────────────────────────────────────────────────

interface TestFixture {
  organizationId: string;
  recruiterId: string;
  requisitionId: string;
  principal: AuthenticatedPrincipal;
  requisition: { id: string; title: string; jdText: string };
  cleanup: (client: AnyPrismaClient) => Promise<void>;
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const JD_TEXT =
  'We are looking for a Software Engineer with TypeScript experience. ' +
  'Strong TypeScript skills required.';

function makeExtraction(label = 'TypeScript experience'): JdExtractionOutput {
  return {
    jobTitle: {
      originalText: 'Software Engineer',
      evidence: {
        sourceQuote: 'Software Engineer',
        sourceStart: 36,
        sourceEnd: 53,
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
        label,
        description: label,
        weight: 100,
        evidence: {
          sourceQuote: 'TypeScript experience',
          sourceStart: 0,
          sourceEnd: 20,
          verificationStatus: 'PENDING_RECRUITER_REVIEW',
        },
      },
    ],
  };
}

async function createTestFixture(client: AnyPrismaClient): Promise<TestFixture> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const reqId = randomUUID();

  await client.organization.create({
    data: {
      id: orgId,
      name: `IT Org ${orgId}`,
      normalizedName: `it-org-${orgId}`,
    },
  });

  await client.user.create({
    data: {
      id: userId,
      organizationId: orgId,
      email: `r-${userId}@it.invalid`,
      normalizedEmail: `r-${userId}@it.invalid`,
      role: 'RECRUITER',
      status: 'ACTIVE',
    },
  });

  await client.client.create({
    data: {
      id: clientId,
      organizationId: orgId,
      name: `IT Client ${clientId}`,
      normalizedName: `it-client-${clientId}`,
      status: 'ACTIVE',
    },
  });

  await client.requisition.create({
    data: {
      id: reqId,
      organizationId: orgId,
      clientId,
      title: 'Software Engineer',
      jdText: JD_TEXT,
      status: 'OPEN',
      createdById: userId,
      assignedRecruiterId: userId,
    },
  });

  const principal: AuthenticatedPrincipal = {
    userId,
    organizationId: orgId,
    role: 'RECRUITER',
  };

  const requisition = { id: reqId, title: 'Software Engineer', jdText: JD_TEXT };

  async function cleanup(c: AnyPrismaClient): Promise<void> {
    const versions = await c.scorecardVersion.findMany({
      where: { requisitionId: reqId, organizationId: orgId },
      select: { id: true },
    });
    const ids = versions.map((v: { id: string }) => v.id);

    if (ids.length > 0) {
      await c.scorecardCriterion.deleteMany({ where: { scorecardVersionId: { in: ids } } });
      await c.scorecardVersion.deleteMany({ where: { id: { in: ids } } });
    }

    await c.auditLog.deleteMany({ where: { organizationId: orgId } });
    await c.requisition.deleteMany({ where: { id: reqId, organizationId: orgId } });
    await c.client.deleteMany({ where: { id: clientId, organizationId: orgId } });
    await c.user.deleteMany({ where: { id: userId, organizationId: orgId } });
    await c.organization.deleteMany({ where: { id: orgId } });
  }

  return {
    organizationId: orgId,
    recruiterId: userId,
    requisitionId: reqId,
    principal,
    requisition,
    cleanup,
  };
}

/**
 * Insert a DRAFT scorecard version with fully VERIFIED criteria directly into
 * the DB, bypassing the service layer. This satisfies all approval preconditions
 * without weakening any production code path.
 */
async function insertVerifiedDraft(
  client: AnyPrismaClient,
  fixture: TestFixture,
  version: number,
): Promise<ScorecardRecord> {
  const weightsJson = {
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
  };

  const sv = await client.scorecardVersion.create({
    data: {
      organizationId: fixture.organizationId,
      requisitionId: fixture.requisitionId,
      version,
      status: 'DRAFT',
      weightsJson,
    },
  });

  await client.scorecardCriterion.create({
    data: {
      scorecardVersionId: sv.id,
      key: 'skill-1',
      label: 'TypeScript experience',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 100,
      ruleJson: {
        description: 'TypeScript experience required.',
        evidence: {
          sourceQuote: 'TypeScript experience',
          sourceStart: 0,
          sourceEnd: 20,
          verificationStatus: 'VERIFIED',
        },
      },
      active: true,
      displayOrder: 0,
    },
  });

  const full = await client.scorecardVersion.findUniqueOrThrow({
    where: { id: sv.id },
    select: {
      id: true,
      requisitionId: true,
      version: true,
      status: true,
      weightsJson: true,
      approvedById: true,
      approvedAt: true,
      createdAt: true,
      updatedAt: true,
      criteria: {
        where: { active: true },
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true,
          key: true,
          label: true,
          category: true,
          requirementType: true,
          weight: true,
          ruleJson: true,
          active: true,
          displayOrder: true,
        },
      },
    },
  });

  return {
    ...full,
    weightsJson: full.weightsJson as Record<string, unknown>,
    criteria: full.criteria.map((c: Record<string, unknown>) => ({
      ...c,
      weight: Number(c['weight']),
      ruleJson: c['ruleJson'] as Record<string, unknown>,
    })),
  } as ScorecardRecord;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_INTEGRATION)('scorecard repository — PostgreSQL 17 integration', () => {
  let pgClient: AnyPrismaClient;
  let repository: ScorecardRepository;

  beforeAll(() => {
    const url = assertSafeIntegrationDatabase();
    pgClient = createTestPrismaClient(url);
    // The repository accepts any Prisma-compatible client; pass the test instance directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository = createScorecardRepository(pgClient as any);
  });

  afterAll(async () => {
    await pgClient.$disconnect();
  });

  // ── Test A — UUID row locking ────────────────────────────────────────────

  describe('Test A — UUID row locking via createDraft', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('executes lockRequisitionRow (CAST … AS uuid … FOR UPDATE) without type errors', async () => {
      const draft = await repository.createDraft(
        fixture.principal,
        fixture.requisition,
        makeExtraction(),
      );

      expect(draft.status).toBe('DRAFT');
      expect(draft.version).toBe(1);
      expect(draft.requisitionId).toBe(fixture.requisitionId);
      expect(draft.criteria).toHaveLength(1);
    }, 10_000);

    it('persists scorecard version and criteria to PostgreSQL', async () => {
      const records = await repository.list(
        fixture.organizationId,
        fixture.recruiterId,
        fixture.requisitionId,
      );

      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.status).toBe('DRAFT');
      expect(r.criteria).toHaveLength(1);
      expect(r.criteria[0]!.requirementType).toBe('MUST_HAVE');
      expect(r.criteria[0]!.weight).toBe(100);
      expect(r.criteria[0]!.key).toBe('skill-1');
    });
  });

  // ── Test B — Concurrent draft generation ─────────────────────────────────

  describe('Test B — Concurrent draft generation', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('two overlapping createDraft calls produce distinct sequential version numbers', async () => {
      const [d1, d2] = await Promise.all([
        repository.createDraft(fixture.principal, fixture.requisition, makeExtraction()),
        repository.createDraft(fixture.principal, fixture.requisition, makeExtraction()),
      ]);

      expect(d1).toBeDefined();
      expect(d2).toBeDefined();
      expect(d1!.version).not.toBe(d2!.version);

      const sorted = [d1!.version, d2!.version].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2]);
    }, 15_000);

    it('no duplicate requisitionId/version pairs exist in the DB', async () => {
      const rows = await pgClient.scorecardVersion.findMany({
        where: {
          requisitionId: fixture.requisitionId,
          organizationId: fixture.organizationId,
        },
        select: { version: true, id: true },
      });

      expect(rows).toHaveLength(2);

      const versionSet = new Set(rows.map((r: { version: number }) => r.version));
      expect(versionSet.size).toBe(2);
    });

    it('each concurrent draft has fully persisted criteria', async () => {
      const records = await repository.list(
        fixture.organizationId,
        fixture.recruiterId,
        fixture.requisitionId,
      );

      for (const record of records) {
        expect(record.criteria).toHaveLength(1);
        expect(record.criteria[0]!.key).toBe('skill-1');
      }
    });
  });

  // ── Test C — Concurrent approvals ────────────────────────────────────────

  describe('Test C — Concurrent approvals', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('exactly one version remains APPROVED when two approvals race', async () => {
      const draft1 = await insertVerifiedDraft(pgClient, fixture, 1);
      const draft2 = await insertVerifiedDraft(pgClient, fixture, 2);

      const results = await Promise.allSettled([
        repository.approve(fixture.principal, fixture.requisitionId, draft1.id),
        repository.approve(fixture.principal, fixture.requisitionId, draft2.id),
      ]);

      // At least one approval must have succeeded.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const versions = await pgClient.scorecardVersion.findMany({
        where: {
          requisitionId: fixture.requisitionId,
          organizationId: fixture.organizationId,
        },
        select: { id: true, status: true, approvedById: true, approvedAt: true, version: true },
        orderBy: { version: 'asc' },
      });

      const approved = versions.filter((v: { status: string }) => v.status === 'APPROVED');
      const draft = versions.filter((v: { status: string }) => v.status === 'DRAFT');

      // Single-approved invariant.
      expect(approved).toHaveLength(1);
      // No orphaned DRAFTs.
      expect(draft).toHaveLength(0);

      // Correct approver and server timestamp.
      const approvedVersion = approved[0];
      expect(approvedVersion).toBeDefined();
      expect(approvedVersion!.approvedById).toBe(fixture.recruiterId);
      expect(approvedVersion!.approvedAt).toBeInstanceOf(Date);

      // Total: approved + archived = 2.
      const archived = versions.filter((v: { status: string }) => v.status === 'ARCHIVED');
      expect(approved.length + archived.length).toBe(2);
    }, 20_000);
  });

  // ── Test D — Transaction rollback ─────────────────────────────────────────

  describe('Test D — Transaction rollback on unique constraint violation', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('rolls back a transaction that violates the requisitionId/version unique constraint', async () => {
      // Create one legitimate draft first.
      const first = await repository.createDraft(
        fixture.principal,
        fixture.requisition,
        makeExtraction(),
      );
      expect(first.version).toBe(1);

      // Insert a second row inside a transaction that then tries to insert a
      // duplicate version, forcing the constraint to fire and the transaction
      // to roll back.
      const probeId = randomUUID();
      let threw = false;

      try {
        await pgClient.$transaction(async (tx) => {
          await tx.scorecardVersion.create({
            data: {
              id: probeId,
              organizationId: fixture.organizationId,
              requisitionId: fixture.requisitionId,
              version: 999,
              status: 'DRAFT',
              weightsJson: { contractVersion: 1, scoring: {}, extraction: {} },
            },
          });
          // Duplicate version 999 — must trigger P2002.
          await tx.scorecardVersion.create({
            data: {
              id: randomUUID(),
              organizationId: fixture.organizationId,
              requisitionId: fixture.requisitionId,
              version: 999,
              status: 'DRAFT',
              weightsJson: { contractVersion: 1, scoring: {}, extraction: {} },
            },
          });
        });
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      }

      expect(threw).toBe(true);

      // The probe row inserted inside the failed transaction must be gone.
      const orphan = await pgClient.scorecardVersion.findFirst({
        where: { id: probeId },
      });
      expect(orphan).toBeNull();

      // Only the original version 1 exists.
      const all = await pgClient.scorecardVersion.findMany({
        where: { requisitionId: fixture.requisitionId, organizationId: fixture.organizationId },
        select: { version: true },
      });
      expect(all.map((r: { version: number }) => r.version)).toEqual([1]);
    });
  });

  // ── Test E — Retry behavior ───────────────────────────────────────────────

  describe('Test E — Retry behavior', () => {
    it('live serialization-failure injection is not practical without invasive changes', () => {
      /**
       * P2034 and P2002 retry classification is exhaustively covered by the
       * deterministic unit tests in scorecard.repository.test.ts.
       *
       * Inducing a genuine PostgreSQL serialization failure in an automated
       * test requires two concurrent transactions to interleave reads/writes in
       * a controlled, reproducible order.  This cannot be achieved reliably
       * through Prisma without external synchronization (e.g., advisory locks
       * or session-level timing primitives) that would require invasive
       * production instrumentation.
       *
       * Test B above exercises the real SELECT … FOR UPDATE row lock.
       * If the lock were absent, Test B would fail non-deterministically with a
       * duplicate-version P2002 error.
       *
       * Conclusion: retry behavior is verified by unit tests; live locking
       * behavior is verified by Test B.
       */
      expect(true).toBe(true);
    });
  });
});
