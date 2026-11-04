import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { createResumeRepository, type ResumeRepository } from './resume.repository.js';
import type { ParserResult } from './resume.types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrismaClient = InstanceType<typeof PrismaClient> & Record<string, any>;

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

function createTestPrismaClient(connectionString: string): AnyPrismaClient {
  const adapter = new PrismaPg({ connectionString });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (PrismaClient as any)({ adapter }) as AnyPrismaClient;
}

interface TestFixture {
  organizationId: string;
  recruiterId: string;
  clientId: string;
  requisitionId: string;
  principal: AuthenticatedPrincipal;
  cleanup: (client: AnyPrismaClient) => Promise<void>;
}

async function createTestFixture(client: AnyPrismaClient): Promise<TestFixture> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const reqId = randomUUID();

  await client.organization.create({
    data: {
      id: orgId,
      name: `Resume Test Org ${orgId}`,
      normalizedName: `resume-test-org-${orgId}`,
    },
  });

  await client.user.create({
    data: {
      id: userId,
      organizationId: orgId,
      email: `recruiter-${userId}@resume-test.invalid`,
      normalizedEmail: `recruiter-${userId}@resume-test.invalid`,
      role: 'RECRUITER',
      status: 'ACTIVE',
    },
  });

  await client.client.create({
    data: {
      id: clientId,
      organizationId: orgId,
      name: `Client ${clientId}`,
      normalizedName: `client-${clientId}`,
      status: 'ACTIVE',
    },
  });

  await client.requisition.create({
    data: {
      id: reqId,
      organizationId: orgId,
      clientId,
      title: 'Principal Backend Engineer',
      jdText: 'TypeScript and PostgreSQL experience required.',
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

  async function cleanup(c: AnyPrismaClient): Promise<void> {
    // Delete in strict FK dependency order
    const batches = await c.processingBatch.findMany({
      where: { requisitionId: reqId, organizationId: orgId },
      select: { id: true },
    });
    const batchIds = batches.map((b: { id: string }) => b.id);

    if (batchIds.length > 0) {
      await c.processingJob.deleteMany({
        where: { batchId: { in: batchIds }, organizationId: orgId },
      });
      await c.processingBatch.deleteMany({
        where: { id: { in: batchIds }, organizationId: orgId },
      });
    }

    const resumes = await c.resumeDocument.findMany({
      where: { organizationId: orgId },
      select: { id: true, candidateId: true },
    });
    const resumeIds = resumes.map((r: { id: string }) => r.id);
    const candidateIds = resumes.map((r: { candidateId: string }) => r.candidateId);

    if (resumeIds.length > 0) {
      await c.documentExtraction.deleteMany({
        where: { resumeDocumentId: { in: resumeIds } },
      });
      await c.resumeDocument.deleteMany({
        where: { id: { in: resumeIds } },
      });
    }

    if (candidateIds.length > 0) {
      await c.candidate.deleteMany({
        where: { id: { in: candidateIds } },
      });
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
    clientId,
    requisitionId: reqId,
    principal,
    cleanup,
  };
}

describe.skipIf(!RUN_INTEGRATION)('resume repository — PostgreSQL 17 integration', () => {
  let pgClient: AnyPrismaClient;
  let repository: ResumeRepository;

  beforeAll(() => {
    const url = assertSafeIntegrationDatabase();
    pgClient = createTestPrismaClient(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository = createResumeRepository(pgClient as any);
  });

  afterAll(async () => {
    await pgClient.$disconnect();
  });

  describe('Test 1: Batch, Candidate, Resume, and ProcessingJob Creation', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('creates batch, candidate, resume document and queued jobs atomically in PostgreSQL 17', async () => {
      const file1Sha = randomUUID().replace(/-/g, '');
      const file2Sha = randomUUID().replace(/-/g, '');

      const result = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/test1.pdf',
            fileName: 'test1.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: file1Sha,
          },
          {
            storageKey: '2026-11/test2.docx',
            fileName: 'test2.docx',
            fileType: 'DOCX',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 2048,
            sha256: file2Sha,
          },
        ],
        { totalUploaded: 2, duplicates: 0, rejected: 0 },
      );

      expect(result.batchId).toBeDefined();
      expect(result.accepted).toHaveLength(2);

      // Verify rows in PostgreSQL
      const batch = await pgClient.processingBatch.findUnique({
        where: { id: result.batchId },
      });
      expect(batch).toBeDefined();
      expect(batch?.totalFiles).toBe(2);
      expect(batch?.status).toBe('CREATED');

      const jobs = await pgClient.processingJob.findMany({
        where: { batchId: result.batchId },
      });
      expect(jobs).toHaveLength(2);
      expect(
        jobs.every(
          (j: { status: string; jobType: string }) =>
            j.status === 'QUEUED' && j.jobType === 'EXTRACT_TEXT',
        ),
      ).toBe(true);

      const candidates = await pgClient.candidate.findMany({
        where: { organizationId: fixture.organizationId },
      });
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.candidateCode).toMatch(/^CAN-[A-F0-9]{8}$/);

      const resumes = await pgClient.resumeDocument.findMany({
        where: { organizationId: fixture.organizationId },
      });
      expect(resumes).toHaveLength(2);
      expect(resumes.every((r: { parseStatus: string }) => r.parseStatus === 'PENDING')).toBe(true);
    });
  });

  describe('Test 2: PostgreSQL @@unique([organizationId, sha256]) Constraint Enforcement', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('enforces unique sha256 within the same organization', async () => {
      const sharedSha = randomUUID().replace(/-/g, '');

      // First creation succeeds
      await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/first.pdf',
            fileName: 'first.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 500,
            sha256: sharedSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      // Lookup finds existing
      const existing = await repository.findExistingResumeBySha256(
        fixture.organizationId,
        sharedSha,
      );
      expect(existing).toBeDefined();
      expect(existing?.sha256).toBe(sharedSha);

      // Attempting to forcibly insert a duplicate row into the DB triggers P2002
      let threw = false;
      try {
        await pgClient.resumeDocument.create({
          data: {
            organizationId: fixture.organizationId,
            candidateId: existing!.candidateId,
            objectKey: '2026-11/duplicate.pdf',
            sha256: sharedSha,
            mimeType: 'application/pdf',
            fileType: 'PDF',
            sizeBytes: BigInt(500),
            version: 2,
            parseStatus: 'PENDING',
            uploadedById: fixture.recruiterId,
          },
        });
      } catch (err: unknown) {
        threw = true;
        expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      }
      expect(threw).toBe(true);
    });
  });

  describe('Test 3: Concurrent Worker Job Claiming (FOR UPDATE SKIP LOCKED)', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('two racing workers claim distinct jobs without deadlock or double-claiming', async () => {
      // Enqueue 2 jobs
      const res = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/worker1.pdf',
            fileName: 'worker1.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 100,
            sha256: randomUUID().replace(/-/g, ''),
          },
          {
            storageKey: '2026-11/worker2.pdf',
            fileName: 'worker2.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 200,
            sha256: randomUUID().replace(/-/g, ''),
          },
        ],
        { totalUploaded: 2, duplicates: 0, rejected: 0 },
      );
      expect(res.accepted).toHaveLength(2);

      // Race two workers concurrently claiming next job
      const [job1, job2] = await Promise.all([
        repository.claimNextProcessingJob(),
        repository.claimNextProcessingJob(),
      ]);

      expect(job1).toBeDefined();
      expect(job2).toBeDefined();

      // Must claim two different jobs!
      expect(job1!.id).not.toBe(job2!.id);

      // Both are marked PROCESSING
      const dbJob1 = await pgClient.processingJob.findUnique({ where: { id: job1!.id } });
      const dbJob2 = await pgClient.processingJob.findUnique({ where: { id: job2!.id } });
      expect(dbJob1?.status).toBe('PROCESSING');
      expect(dbJob2?.status).toBe('PROCESSING');

      // Third worker finds no more jobs
      const job3 = await repository.claimNextProcessingJob();
      expect(job3).toBeNull();
    });
  });

  describe('Test 4: Job Completion and DocumentExtraction Storage', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('completes processing job, creates DocumentExtraction record, and updates ResumeDocument status', async () => {
      await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/finish.pdf',
            fileName: 'finish.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 300,
            sha256: randomUUID().replace(/-/g, ''),
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const job = await repository.claimNextProcessingJob();
      expect(job).toBeDefined();

      const parserResult: ParserResult = {
        extractedText: 'Senior Full Stack Engineer with 7 years of Node.js experience.',
        pageMapJson: {
          pageCount: 1,
          pages: [
            {
              pageNumber: 1,
              startOffset: 0,
              endOffset: 63,
              text: 'Senior Full Stack Engineer with 7 years of Node.js experience.',
            },
          ],
        },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      };

      await repository.completeProcessingJob(
        job!.id,
        job!.resumeDocumentId,
        job!.organizationId,
        parserResult,
      );

      // Verify DocumentExtraction row exists in PostgreSQL
      const extraction = await pgClient.documentExtraction.findFirst({
        where: { resumeDocumentId: job!.resumeDocumentId },
      });
      expect(extraction).toBeDefined();
      expect(extraction?.extractedText).toBe(parserResult.extractedText);
      expect(extraction?.qualityStatus).toBe('COMPLETE');

      // Verify ResumeDocument status updated to PARSED
      const resume = await pgClient.resumeDocument.findUnique({
        where: { id: job!.resumeDocumentId },
      });
      expect(resume?.parseStatus).toBe('PARSED');

      // Verify ProcessingJob status updated to SUCCEEDED
      const completedJob = await pgClient.processingJob.findUnique({
        where: { id: job!.id },
      });
      expect(completedJob?.status).toBe('SUCCEEDED');

      // Idempotency: completing again does NOT create another extraction record
      await repository.completeProcessingJob(
        job!.id,
        job!.resumeDocumentId,
        job!.organizationId,
        parserResult,
      );

      const count = await pgClient.documentExtraction.count({
        where: { resumeDocumentId: job!.resumeDocumentId },
      });
      expect(count).toBe(1);
    });
  });

  describe('Test 5: Bounded Retry Backoff and Exhaustion in PostgreSQL', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('enforces backoff delay on RETRYABLE_FAILURE jobs and exhausts after 3 attempts', async () => {
      await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/retry-backoff.pdf',
            fileName: 'retry-backoff.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 150,
            sha256: randomUUID().replace(/-/g, ''),
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      // Attempt 1: Claim queued job
      const job1 = await repository.claimNextProcessingJob();
      expect(job1).toBeDefined();
      expect(job1!.attempts).toBe(1);

      // Fail attempt 1
      await repository.failProcessingJob(
        job1!.id,
        job1!.resumeDocumentId,
        'Transient I/O failure',
        false,
      );

      // Immediately after failure, job must NOT be eligible due to 30s backoff!
      const immediateClaim = await repository.claimNextProcessingJob();
      expect(immediateClaim).toBeNull();

      // Fast-forward updated_at to 35 seconds ago
      const thirtyFiveSecAgo = new Date(Date.now() - 35_000);
      await pgClient.processingJob.update({
        where: { id: job1!.id },
        data: { updatedAt: thirtyFiveSecAgo },
      });

      // Now attempt 2 can be claimed!
      const job2 = await repository.claimNextProcessingJob();
      expect(job2).toBeDefined();
      expect(job2!.id).toBe(job1!.id);
      expect(job2!.attempts).toBe(2);

      // Fail attempt 2
      await repository.failProcessingJob(
        job2!.id,
        job2!.resumeDocumentId,
        'Transient I/O failure 2',
        false,
      );

      // Immediately after attempt 2 failure, job must NOT be eligible due to 120s backoff!
      const immediateClaim2 = await repository.claimNextProcessingJob();
      expect(immediateClaim2).toBeNull();

      // Fast-forward updated_at to 125 seconds ago
      const twoMinutesAgo = new Date(Date.now() - 125_000);
      await pgClient.processingJob.update({
        where: { id: job2!.id },
        data: { updatedAt: twoMinutesAgo },
      });

      // Claim attempt 3
      const job3 = await repository.claimNextProcessingJob();
      expect(job3).toBeDefined();
      expect(job3!.attempts).toBe(3);

      // Fail attempt 3 (should permanently fail!)
      await repository.failProcessingJob(
        job3!.id,
        job3!.resumeDocumentId,
        'Permanent exhaustion failure',
        false,
      );

      const exhaustedJob = await pgClient.processingJob.findUnique({
        where: { id: job3!.id },
      });
      expect(exhaustedJob?.status).toBe('FAILED');
      expect(exhaustedJob?.lastErrorCode).toBe('Permanent exhaustion failure');

      // Will NEVER be claimed again
      await pgClient.processingJob.update({
        where: { id: job3!.id },
        data: { updatedAt: new Date(Date.now() - 1_000_000) },
      });
      const neverClaimed = await repository.claimNextProcessingJob();
      expect(neverClaimed).toBeNull();
    });
  });
});
