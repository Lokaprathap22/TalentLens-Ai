import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { createConsentRepository } from '../consent/consent.repository.js';
import { hashToken } from '../consent/consent.service.js';
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

    await c.consentWithdrawalRequest.deleteMany({ where: { organizationId: orgId } });
    await c.candidateConsent.deleteMany({ where: { organizationId: orgId } });

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

  describe('Milestone 5 Integration Tests — Worker Leases, Recovery & Authorization Gating', () => {
    let fixture: TestFixture;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
    });

    afterAll(async () => {
      await fixture.cleanup(pgClient);
    });

    it('1. Holds upload jobs when authorization is missing and initializes lease fields as null', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/held-test.pdf',
            fileName: 'held-test.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const job = await pgClient.processingJob.findFirst({
        where: { batchId: batchResult.batchId },
      });

      expect(job).toBeDefined();
      expect(job?.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(job?.leaseExpiresAt).toBeNull();
      expect(job?.lockedBy).toBeNull();
      expect(job?.leaseToken).toBeNull();
      expect(job?.attempts).toBe(0);
    });

    it('2. Ensures held jobs cannot be claimed by worker queries', async () => {
      const claimed = await repository.claimNextProcessingJob('worker-test-1');
      expect(claimed).toBeNull();
    });

    it('3. Enables release path on genuine active HIRING_USE consent and rejects revoked consent', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/auth-release.pdf',
            fileName: 'auth-release.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;

      // Attempt release without consent -> fails
      const unconsentedRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
      );
      expect(unconsentedRelease.releasedCount).toBe(0);
      expect(unconsentedRelease.reason).toBe('NO_ACTIVE_VALID_CONSENT');

      // Regression test: legacy consent with requisitionId = null cannot release held job for a new requisition
      const legacyConsent = await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: null, // Legacy null-requisition consent!
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });

      const legacyRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
        fixture.principal.userId,
        fixture.requisitionId,
      );
      expect(legacyRelease.releasedCount).toBe(0);
      expect(legacyRelease.reason).toBe('NO_ACTIVE_VALID_CONSENT');

      await pgClient.candidateConsent.delete({ where: { id: legacyConsent.id } });

      // Add revoked consent -> fails
      const revokedConsent = await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
          withdrawnAt: new Date(), // Revoked!
        },
      });

      const revokedRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
      );
      expect(revokedRelease.releasedCount).toBe(0);

      // Attempt release with empty policy version -> fails
      await pgClient.candidateConsent.update({
        where: { id: revokedConsent.id },
        data: { policyVersion: '' },
      });
      const emptyPolicyRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
      );
      expect(emptyPolicyRelease.releasedCount).toBe(0);
      expect(emptyPolicyRelease.reason).toBe('NO_ACTIVE_VALID_CONSENT');

      // Now restore valid policy version and active consent
      await pgClient.candidateConsent.update({
        where: { id: revokedConsent.id },
        data: { withdrawnAt: null, policyVersion: 'v1.0' },
      });

      // Recruiter assigned to a different requisition cannot release jobs for this requisition
      const unauthorizedRecruiterId = randomUUID();
      const unauthorizedRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
        unauthorizedRecruiterId,
      );
      expect(unauthorizedRelease.releasedCount).toBe(0);
      expect(unauthorizedRelease.reason).toBe('UNAUTHORIZED_REQUISITION');

      // Authorized recruiter releases jobs successfully!
      const validRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
        fixture.principal.userId,
      );
      expect(validRelease.releasedCount).toBe(1);

      // Verify status is now QUEUED in PostgreSQL
      const releasedJob = await pgClient.processingJob.findFirst({
        where: { batchId: batchResult.batchId },
      });
      expect(releasedJob?.status).toBe('QUEUED');
    });

    it('4. Claims released job atomically establishing lease ownership, UUID token and DB clock expiration', async () => {
      const claimed = await repository.claimNextProcessingJob('worker-node-alpha', 5);
      expect(claimed).toBeDefined();
      expect(claimed?.lockedBy).toBe('worker-node-alpha');
      expect(claimed?.leaseToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 200_000);

      // Verify in PostgreSQL
      const dbJob = await pgClient.processingJob.findUnique({
        where: { id: claimed!.id },
      });
      expect(dbJob?.status).toBe('PROCESSING');
      expect(dbJob?.lockedBy).toBe('worker-node-alpha');
      expect(dbJob?.leaseToken).toBe(claimed?.leaseToken);
    });

    it('5. Prevents two workers from claiming the same active lease', async () => {
      const secondClaim = await repository.claimNextProcessingJob('worker-node-beta', 5);
      expect(secondClaim).toBeNull();
    });

    it('6. Heartbeat renewal extends expiration for matching token and rejects old/invalid token', async () => {
      const job = await pgClient.processingJob.findFirst({
        where: { status: 'PROCESSING' },
      });
      expect(job).toBeDefined();

      // Renewal with wrong token fails
      const badRenewal = await repository.renewJobLease(job!.id, randomUUID(), 5);
      expect(badRenewal).toBe(false);

      // Renewal with correct token succeeds
      const goodRenewal = await repository.renewJobLease(job!.id, job!.leaseToken!, 10);
      expect(goodRenewal).toBe(true);

      const renewedJob = await pgClient.processingJob.findUnique({
        where: { id: job!.id },
      });
      expect(renewedJob?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 500_000);
    });

    it('7. Ensures active lease cannot be reclaimed while unexpired', async () => {
      const reclaimAttempt = await repository.claimNextProcessingJob('worker-reclaimer', 5);
      expect(reclaimAttempt).toBeNull();
    });

    it('8. Reclaims expired lease with new token and fences out old worker from completing', async () => {
      const activeJob = await pgClient.processingJob.findFirst({
        where: { status: 'PROCESSING' },
      });
      expect(activeJob).toBeDefined();
      const oldLeaseToken = activeJob!.leaseToken!;

      // Simulate lease expiration by setting leaseExpiresAt in the past
      await pgClient.processingJob.update({
        where: { id: activeJob!.id },
        data: {
          leaseExpiresAt: new Date(Date.now() - 30_000), // expired 30s ago
        },
      });

      // Another worker reclaims the expired job!
      const reclaimed = await repository.claimNextProcessingJob('worker-new-owner', 5);
      expect(reclaimed).toBeDefined();
      expect(reclaimed?.id).toBe(activeJob!.id);
      expect(reclaimed?.lockedBy).toBe('worker-new-owner');
      expect(reclaimed?.leaseToken).not.toBe(oldLeaseToken);
      expect(reclaimed?.attempts).toBe(2);

      // Old worker tries to complete using old token -> FENCED OUT!
      const parserResult: ParserResult = {
        extractedText: 'Stale extraction from fenced worker.',
        pageMapJson: { pageCount: 1 },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      };

      const oldComplete = await repository.completeProcessingJob(
        reclaimed!.id,
        reclaimed!.resumeDocumentId,
        reclaimed!.organizationId,
        parserResult,
        oldLeaseToken, // Stale token!
      );
      expect(oldComplete).toBe(false);

      // Verify no extraction was created by the old worker
      const extractions = await pgClient.documentExtraction.findMany({
        where: { resumeDocumentId: reclaimed!.resumeDocumentId },
      });
      expect(extractions).toHaveLength(0);
    });

    it('9. Completes job with current lease token, persists extraction, and clears lease fields idempotently', async () => {
      const currentJob = await pgClient.processingJob.findFirst({
        where: { status: 'PROCESSING' },
      });
      expect(currentJob).toBeDefined();

      const parserResult: ParserResult = {
        extractedText: 'Valid extracted text from current lease holder.',
        pageMapJson: { pageCount: 1 },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      };

      const completed = await repository.completeProcessingJob(
        currentJob!.id,
        currentJob!.resumeDocumentId!,
        currentJob!.organizationId,
        parserResult,
        currentJob!.leaseToken!,
      );
      expect(completed).toBe(true);

      const dbJob = await pgClient.processingJob.findUnique({
        where: { id: currentJob!.id },
      });
      expect(dbJob?.status).toBe('SUCCEEDED');
      expect(dbJob?.leaseToken).toBeNull();
      expect(dbJob?.lockedBy).toBeNull();
      expect(dbJob?.leaseExpiresAt).toBeNull();

      const extraction = await pgClient.documentExtraction.findFirst({
        where: { resumeDocumentId: currentJob!.resumeDocumentId! },
      });
      expect(extraction).toBeDefined();
      expect(extraction?.extractedText).toBe(parserResult.extractedText);

      // Idempotency: re-completing does not duplicate extractions
      const duplicateComplete = await repository.completeProcessingJob(
        currentJob!.id,
        currentJob!.resumeDocumentId!,
        currentJob!.organizationId,
        parserResult,
        currentJob!.leaseToken!,
      );
      expect(duplicateComplete).toBe(false); // Already SUCCEEDED, leaseToken cleared

      const count = await pgClient.documentExtraction.count({
        where: { resumeDocumentId: currentJob!.resumeDocumentId! },
      });
      expect(count).toBe(1);
    });

    it('9b. Cannot renew, complete, or fail an expired lease even with matching token (no token resurrection)', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/expired-lease-tests.pdf',
            fileName: 'expired-lease-tests.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;
      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });
      await repository.releaseHeldProcessingJobs(fixture.organizationId, candidateId);

      const job = await repository.claimNextProcessingJob('worker-expiration-tester', 5);
      expect(job).toBeDefined();
      const token = job!.leaseToken;

      // Force lease to be expired in the past
      await pgClient.processingJob.update({
        where: { id: job!.id },
        data: { leaseExpiresAt: new Date(Date.now() - 10_000) },
      });

      // 1. Heartbeat renewal must fail on expired lease!
      const renewResult = await repository.renewJobLease(job!.id, token, 5);
      expect(renewResult).toBe(false);

      // 2. Completion must fail on expired lease!
      const parserResult: ParserResult = {
        extractedText: 'Should not persist on expired lease.',
        pageMapJson: { pageCount: 1 },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      };
      const completeResult = await repository.completeProcessingJob(
        job!.id,
        job!.resumeDocumentId,
        job!.organizationId,
        parserResult,
        token,
      );
      expect(completeResult).toBe(false);

      // Extraction must NOT have been persisted
      const extractions = await pgClient.documentExtraction.findMany({
        where: { resumeDocumentId: job!.resumeDocumentId },
      });
      expect(extractions).toHaveLength(0);

      // 3. Failure recording must also fail on expired lease!
      const failResult = await repository.failProcessingJob(
        job!.id,
        job!.resumeDocumentId,
        'Should not record on expired lease',
        false,
        token,
      );
      expect(failResult).toBe(false);

      // Clean up the expired job by reclaiming it and completing it
      const reclaimed = await repository.claimNextProcessingJob('cleanup-worker', 5);
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.id).toBe(job!.id);
      await repository.completeProcessingJob(
        reclaimed!.id,
        reclaimed!.resumeDocumentId,
        reclaimed!.organizationId,
        parserResult,
        reclaimed!.leaseToken,
      );
    });

    it('10. Enforces retry backoff on RETRYABLE_FAILURE jobs', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/retry-backoff-test.pdf',
            fileName: 'retry-backoff-test.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;

      // Add consent and release
      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });

      await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candidateId,
        fixture.principal.userId,
        fixture.requisitionId,
      );

      // Attempt 1: claim
      const job1 = await repository.claimNextProcessingJob('worker-retry', 5);
      expect(job1).toBeDefined();
      expect(job1?.attempts).toBe(1);

      // Fail attempt 1
      await repository.failProcessingJob(
        job1!.id,
        job1!.resumeDocumentId,
        'Transient parser error',
        false,
        job1!.leaseToken,
      );

      // Immediately after failure, not eligible due to 30s backoff
      const immediate = await repository.claimNextProcessingJob('worker-retry', 5);
      expect(immediate).toBeNull();

      // Fast-forward 35 seconds
      await pgClient.processingJob.update({
        where: { id: job1!.id },
        data: { updatedAt: new Date(Date.now() - 35_000) },
      });

      // Attempt 2: claimable
      const job2 = await repository.claimNextProcessingJob('worker-retry', 5);
      expect(job2).toBeDefined();
      expect(job2?.attempts).toBe(2);

      // Fail attempt 2
      await repository.failProcessingJob(
        job2!.id,
        job2!.resumeDocumentId,
        'Transient parser error 2',
        false,
        job2!.leaseToken,
      );

      // Fast-forward 125 seconds
      await pgClient.processingJob.update({
        where: { id: job2!.id },
        data: { updatedAt: new Date(Date.now() - 125_000) },
      });

      // Attempt 3: claimable
      const job3 = await repository.claimNextProcessingJob('worker-retry', 5);
      expect(job3).toBeDefined();
      expect(job3?.attempts).toBe(3);

      // Fail attempt 3 permanently
      await repository.failProcessingJob(
        job3!.id,
        job3!.resumeDocumentId,
        'Max attempts reached',
        false,
        job3!.leaseToken,
      );

      const failedJob = await pgClient.processingJob.findUnique({
        where: { id: job3!.id },
      });
      expect(failedJob?.status).toBe('FAILED');
      expect(failedJob?.lastErrorCode).toBe('Max attempts reached');
    });

    it('11. Transitions stale expired job with attempts >= 3 to FAILED on recovery', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/exhausted-stale.pdf',
            fileName: 'exhausted-stale.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;
      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });
      await repository.releaseHeldProcessingJobs(fixture.organizationId, candidateId);

      const job = await repository.claimNextProcessingJob('worker-exhaust', 5);
      expect(job).toBeDefined();

      // Simulate that this job had 3 attempts and expired
      await pgClient.processingJob.update({
        where: { id: job!.id },
        data: {
          attempts: 3,
          leaseExpiresAt: new Date(Date.now() - 30_000), // expired
        },
      });

      // Claiming should detect attempts >= 3 on stale recovery and fail it!
      const reclaim = await repository.claimNextProcessingJob('worker-exhaust', 5);
      expect(reclaim).toBeNull();

      const failedJob = await pgClient.processingJob.findUnique({
        where: { id: job!.id },
      });
      expect(failedJob?.status).toBe('FAILED');
      expect(failedJob?.lastErrorCode).toBe('STALE_LEASE_EXPIRED_MAX_ATTEMPTS_EXHAUSTED');

      const failedResume = await pgClient.resumeDocument.findUnique({
        where: { id: job!.resumeDocumentId },
      });
      expect(failedResume?.parseStatus).toBe('FAILED');
    });

    it('12. Holds job and discards extraction when consent is revoked during processing', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/revocation-in-flight.pdf',
            fileName: 'revocation-in-flight.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;
      const consent = await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });
      await repository.releaseHeldProcessingJobs(fixture.organizationId, candidateId);

      const job = await repository.claimNextProcessingJob('worker-revocation', 5);
      expect(job).toBeDefined();

      // Candidate withdraws consent while worker is in flight!
      await pgClient.candidateConsent.update({
        where: { id: consent.id },
        data: { withdrawnAt: new Date() },
      });

      // Worker attempts to complete
      const parserResult: ParserResult = {
        extractedText: 'Should never be stored due to revoked consent.',
        pageMapJson: { pageCount: 1 },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      };

      const completeResult = await repository.completeProcessingJob(
        job!.id,
        job!.resumeDocumentId,
        job!.organizationId,
        parserResult,
        job!.leaseToken,
      );
      expect(completeResult).toBe(false);

      // Verify job is back in HELD_FOR_AUTHORIZATION with lease cleared
      const heldJob = await pgClient.processingJob.findUnique({
        where: { id: job!.id },
      });
      expect(heldJob?.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(heldJob?.leaseToken).toBeNull();
      expect(heldJob?.lockedBy).toBeNull();
      expect(heldJob?.leaseExpiresAt).toBeNull();

      // Verify NO extraction was created
      const extraction = await pgClient.documentExtraction.findFirst({
        where: { resumeDocumentId: job!.resumeDocumentId },
      });
      expect(extraction).toBeNull();
    });

    it('13. Migration consistency: legacy queued job lacking valid consent is transitioned to HELD_FOR_AUTHORIZATION on claim', async () => {
      const fileSha = randomUUID().replace(/-/g, '');
      const batchResult = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/legacy-queued.pdf',
            fileName: 'legacy-queued.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: fileSha,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );

      const candidateId = batchResult.accepted[0]!.candidateId;
      const job = await pgClient.processingJob.findFirst({
        where: { batchId: batchResult.batchId },
      });
      expect(job).toBeDefined();

      // Simulate a legacy job that remained QUEUED from before the migration,
      // but whose candidate consent has an empty policyVersion
      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: '', // Invalid empty policy version!
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });

      // Manually simulate a legacy job in QUEUED status
      await pgClient.processingJob.update({
        where: { id: job!.id },
        data: { status: 'QUEUED' },
      });

      // Worker attempts to claim it
      const claimed = await repository.claimNextProcessingJob('worker-claim-tester', 5);
      // Must NOT return the job for processing!
      expect(claimed).toBeNull();

      // Verify that claim-time authorization check safely transitioned it to HELD_FOR_AUTHORIZATION!
      const dbJob = await pgClient.processingJob.findUnique({
        where: { id: job!.id },
      });
      expect(dbJob?.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(dbJob?.leaseToken).toBeNull();
      expect(dbJob?.leaseExpiresAt).toBeNull();
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

      // In Milestone 5, authorize candidates and release held jobs so workers can claim them
      for (const item of res.accepted) {
        await pgClient.candidateConsent.create({
          data: {
            organizationId: fixture.principal.organizationId,
            candidateId: item.candidateId,
            requisitionId: fixture.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            policyVersion: '1.0',
            captureMethod: 'RECRUITER_RECORDED',
            capturedAt: new Date(),
          },
        });
        await repository.releaseHeldProcessingJobs(
          fixture.principal.organizationId,
          item.candidateId,
          fixture.principal.userId,
          fixture.requisitionId,
        );
      }

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
      const res = await repository.createResumeBatch(
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

      // In Milestone 5, authorize candidates and release held jobs
      for (const item of res.accepted) {
        await pgClient.candidateConsent.create({
          data: {
            organizationId: fixture.principal.organizationId,
            candidateId: item.candidateId,
            requisitionId: fixture.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            policyVersion: '1.0',
            captureMethod: 'RECRUITER_RECORDED',
            capturedAt: new Date(),
          },
        });
        await repository.releaseHeldProcessingJobs(
          fixture.principal.organizationId,
          item.candidateId,
          fixture.principal.userId,
          fixture.requisitionId,
        );
      }

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
        job!.leaseToken ?? undefined,
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
      const res = await repository.createResumeBatch(
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

      // In Milestone 5, authorize candidates and release held jobs
      for (const item of res.accepted) {
        await pgClient.candidateConsent.create({
          data: {
            organizationId: fixture.principal.organizationId,
            candidateId: item.candidateId,
            requisitionId: fixture.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            policyVersion: '1.0',
            captureMethod: 'RECRUITER_RECORDED',
            capturedAt: new Date(),
          },
        });
        await repository.releaseHeldProcessingJobs(
          fixture.principal.organizationId,
          item.candidateId,
          fixture.principal.userId,
          fixture.requisitionId,
        );
      }

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
        job1!.leaseToken ?? undefined,
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
        job2!.leaseToken ?? undefined,
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
        job3!.leaseToken ?? undefined,
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

  describe('Test 8: Requisition-Specific Resume Reuse, Versioning & Identity Safety (F-10) and Composite FK Catalog (F-12)', () => {
    let fixture: TestFixture;
    let secondRequisitionId: string;

    beforeAll(async () => {
      fixture = await createTestFixture(pgClient);
      const secondReq = await pgClient.requisition.create({
        data: {
          organizationId: fixture.organizationId,
          clientId: fixture.clientId,
          title: 'Second Requisition — Principal Architect',
          jdText: 'Principal Architect JD',
          status: 'OPEN',
          assignedRecruiterId: fixture.recruiterId,
          createdById: fixture.recruiterId,
        },
      });
      secondRequisitionId = secondReq.id;
    });

    afterAll(async () => {
      if (secondRequisitionId) {
        await pgClient.auditLog.deleteMany({
          where: { requisitionId: secondRequisitionId },
        });
        await pgClient.processingJob.deleteMany({
          where: { batch: { requisitionId: secondRequisitionId } },
        });
        await pgClient.processingBatch.deleteMany({
          where: { requisitionId: secondRequisitionId },
        });
        await pgClient.consentInvitation.deleteMany({
          where: { requisitionId: secondRequisitionId },
        });
        await pgClient.candidateConsent.deleteMany({
          where: { requisitionId: secondRequisitionId },
        });
        await pgClient.requisition.deleteMany({
          where: { id: secondRequisitionId },
        });
      }
      await fixture.cleanup(pgClient);
    });

    it('supports requisition-specific duplicate detection, known-candidate resume reuse across requisitions, version=2 uploads, and prevents silent SHA-256 candidate merging (F-10)', async () => {
      const shaV1 = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const shaV2 = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

      // 1. Upload candidate 1 resume to Requisition 1
      const batch1 = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/cand1-v1.pdf',
            fileName: 'cand1-v1.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1200,
            sha256: shaV1,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const cand1Id = batch1.accepted[0]!.candidateId;
      const doc1Id = batch1.accepted[0]!.resumeDocumentId;

      // 2. Same-requisition lookup reports Requisition 1 in requisitionIds
      const lookupAfterReq1 = await repository.findExistingResumeBySha256(
        fixture.organizationId,
        shaV1,
      );
      expect(lookupAfterReq1?.requisitionIds).toContain(fixture.requisitionId);
      expect(lookupAfterReq1?.requisitionIds).not.toContain(secondRequisitionId);

      // 3. Reusing known candidate's resume for Requisition 2 reuses the existing ResumeDocument without duplicate storage
      const reused = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        cand1Id,
      );
      expect(reused).not.toBeNull();
      expect(reused?.resumeDocumentId).toBe(doc1Id);
      expect(reused?.candidateId).toBe(cand1Id);
      expect(reused?.jobStatus).toBe('HELD_FOR_AUTHORIZATION'); // Requires separate Req 2 consent!
      expect(reused?.isExisting).toBe(false);

      // Calling reuse again on Requisition 2 is idempotent
      const reusedAgain = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        cand1Id,
      );
      expect(reusedAgain?.isExisting).toBe(true);
      expect(reusedAgain?.jobId).toBe(reused?.jobId);

      // Candidate appears in both Requisition 1 and Requisition 2 resume lists
      const req1List = await repository.listResumesForRequisition(
        fixture.organizationId,
        fixture.recruiterId,
        fixture.requisitionId,
      );
      const req2List = await repository.listResumesForRequisition(
        fixture.organizationId,
        fixture.recruiterId,
        secondRequisitionId,
      );
      expect(req1List.some((r) => r.id === doc1Id && r.candidateId === cand1Id)).toBe(true);
      expect(req2List.some((r) => r.id === doc1Id && r.candidateId === cand1Id)).toBe(true);

      // 4. Known candidate uploads a newer resume version (version = 2)
      const batchV2 = await repository.createResumeBatch(
        fixture.principal,
        secondRequisitionId,
        [
          {
            storageKey: '2026-11/cand1-v2.pdf',
            fileName: 'cand1-v2.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1500,
            sha256: shaV2,
            candidateId: cand1Id,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const docV2Id = batchV2.accepted[0]!.resumeDocumentId;
      expect(batchV2.accepted[0]!.candidateId).toBe(cand1Id);
      const docV2InDb = await pgClient.resumeDocument.findUnique({ where: { id: docV2Id } });
      expect(docV2InDb?.version).toBe(2);

      // 5. Uncertain identity: uploading an identical SHA-256 to Requisition 2 WITHOUT candidateId creates a distinct candidate (never silently merges!)
      const batchUnlinked = await repository.createResumeBatch(
        fixture.principal,
        secondRequisitionId,
        [
          {
            storageKey: '2026-11/other-cand-same-sha.pdf',
            fileName: 'other-cand-same-sha.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1200,
            sha256: shaV1,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      expect(batchUnlinked.accepted[0]!.candidateId).not.toBe(cand1Id);
    });

    it('verifies live PostgreSQL catalog has composite tenant FKs and candidate_consents composite index (F-12)', async () => {
      const indexRows = await pgClient.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'candidate_consents_organization_id_candidate_id_requisition_idx',
            'candidate_consents_id_candidate_org_key',
            'candidate_submissions_id_req_org_key',
            'resume_documents_organization_id_candidate_id_sha256_key'
          )
      `;
      const names = indexRows.map((r) => r.indexname);
      expect(names).toContain('candidate_consents_organization_id_candidate_id_requisition_idx');
      expect(names).toContain('candidate_consents_id_candidate_org_key');
      expect(names).toContain('candidate_submissions_id_req_org_key');
      expect(names).toContain('resume_documents_organization_id_candidate_id_sha256_key');

      const fkRows = await pgClient.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conname IN (
          'consent_withdrawal_requests_consent_id_candidate_id_organi_fkey',
          'interview_proposals_submission_id_requisition_id_organizat_fkey'
        )
      `;
      const fkNames = fkRows.map((r) => r.conname);
      expect(fkNames).toContain('consent_withdrawal_requests_consent_id_candidate_id_organi_fkey');
      expect(fkNames).toContain('interview_proposals_submission_id_requisition_id_organizat_fkey');
    });

    it('RB-01 (A, B, C, F): already-parsed resume reused before destination consent reuses existing extraction upon consent without redundant extraction or version collision', async () => {
      const consentRepo = createConsentRepository(pgClient as unknown as PrismaClient);
      const shaParsed = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

      // 1. Upload resume under Requisition A
      const batchA = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/rb01-parsed.pdf',
            fileName: 'rb01-parsed.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            sha256: shaParsed,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const candId = batchA.accepted[0]!.candidateId;
      const docId = batchA.accepted[0]!.resumeDocumentId;

      // Grant consent for Requisition A and parse the document
      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId: candId,
          requisitionId: fixture.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });
      await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candId,
        fixture.recruiterId,
        fixture.requisitionId,
      );

      const claimedReqA = await repository.claimNextProcessingJob('worker-rb01-a', 5);
      expect(claimedReqA).not.toBeNull();
      expect(claimedReqA?.resumeDocumentId).toBe(docId);

      const originalExtractedText =
        'Principal Distributed Systems Engineer with 12 years of Go, Rust, and PostgreSQL experience.';
      const completedA = await repository.completeProcessingJob(
        claimedReqA!.id,
        docId,
        fixture.organizationId,
        {
          extractedText: originalExtractedText,
          pageMapJson: {
            pageCount: 1,
            pages: [{ pageNumber: 1, startOffset: 0, endOffset: originalExtractedText.length }],
          },
          parser: 'talentlens-pdf-v1',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        },
        claimedReqA!.leaseToken ?? undefined,
      );
      expect(completedA).toBe(true);

      const extractionBeforeReuse = await pgClient.documentExtraction.findFirst({
        where: { resumeDocumentId: docId, organizationId: fixture.organizationId },
      });
      expect(extractionBeforeReuse?.version).toBe(1);
      expect(extractionBeforeReuse?.extractedText).toBe(originalExtractedText);

      // 2. Reuse the already-parsed resume for Requisition B BEFORE Requisition B has consent
      const reusedB = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        candId,
        docId,
      );
      expect(reusedB).not.toBeNull();
      expect(reusedB?.jobStatus).toBe('HELD_FOR_AUTHORIZATION');
      expect(reusedB?.parseStatus).toBe('PARSED');

      const batchBBeforeConsent = await pgClient.processingBatch.findUnique({
        where: { id: reusedB!.batchId },
      });
      expect(batchBBeforeConsent?.status).toBe('CREATED');

      // Scenario F: No destination processing occurs before consent
      const unauthorizedClaim = await repository.claimNextProcessingJob('worker-rb01-unauth', 5);
      expect(unauthorizedClaim).toBeNull();

      // 3. Candidate accepts consent invitation for Requisition B
      const rawInviteToken = `rb01-invite-${randomUUID()}`;
      const inviteTokenHash = hashToken(rawInviteToken);
      await pgClient.consentInvitation.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId: candId,
          requisitionId: secondRequisitionId,
          createdById: fixture.recruiterId,
          email: `rb01-${candId.slice(0, 8)}@example.com`,
          tokenHash: inviteTokenHash,
          purpose: 'HIRING_USE',
          policyVersion: '2026-11-v1',
          noticeTextHash: 'a'.repeat(64),
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const acceptedConsent = await consentRepo.acceptInvitation(
        inviteTokenHash,
        ' Candidate RB01 ',
      );
      expect(acceptedConsent).not.toBeNull();
      expect(acceptedConsent?.releasedJobCount).toBe(1);

      // Scenario A: Existing valid extraction is reused; destination job is SUCCEEDED (not QUEUED) and batch is COMPLETED
      const jobBAfterConsent = await pgClient.processingJob.findUnique({
        where: { id: reusedB!.jobId },
      });
      expect(jobBAfterConsent?.status).toBe('SUCCEEDED');
      expect(jobBAfterConsent?.finishedAt).not.toBeNull();

      const batchBAfterConsent = await pgClient.processingBatch.findUnique({
        where: { id: reusedB!.batchId },
      });
      expect(batchBAfterConsent?.status).toBe('COMPLETED');

      // No redundant EXTRACT_TEXT job is queued for any worker
      const redundantClaim = await repository.claimNextProcessingJob('worker-rb01-post', 5);
      expect(redundantClaim).toBeNull();

      // Calling releaseHeldProcessingJobs again is idempotent
      const secondRelease = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        candId,
        fixture.recruiterId,
        secondRequisitionId,
      );
      expect(secondRelease.releasedCount).toBe(0);

      // Scenario B & C: No duplicate extraction version is created; existing extraction contents and Requisition A records remain untouched
      const extractionsAfter = await pgClient.documentExtraction.findMany({
        where: { resumeDocumentId: docId, organizationId: fixture.organizationId },
      });
      expect(extractionsAfter).toHaveLength(1);
      expect(extractionsAfter[0]!.id).toBe(extractionBeforeReuse!.id);
      expect(extractionsAfter[0]!.version).toBe(1);
      expect(extractionsAfter[0]!.extractedText).toBe(originalExtractedText);

      const jobAAfter = await pgClient.processingJob.findUnique({
        where: { id: claimedReqA!.id },
      });
      expect(jobAAfter?.status).toBe('SUCCEEDED');

      // Extraction is retrievable under Requisition B
      const reqBExtraction = await repository.findLatestExtraction(
        fixture.organizationId,
        fixture.recruiterId,
        secondRequisitionId,
        docId,
      );
      expect(reqBExtraction?.id).toBe(extractionBeforeReuse!.id);
      expect(reqBExtraction?.extractedText).toBe(originalExtractedText);
    });

    it('RB-01 (D & E): unparsed documents and documents with missing/inconsistent extractions are queued for normal extraction after consent', async () => {
      const shaUnparsed = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const shaInconsistent = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

      // Scenario D: Unparsed document reused before consent -> queued after consent
      const batchUnparsed = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/rb01-unparsed.pdf',
            fileName: 'rb01-unparsed.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: shaUnparsed,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const unparsedCandId = batchUnparsed.accepted[0]!.candidateId;
      const unparsedDocId = batchUnparsed.accepted[0]!.resumeDocumentId;

      const reusedUnparsed = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        unparsedCandId,
        unparsedDocId,
      );
      expect(reusedUnparsed?.jobStatus).toBe('HELD_FOR_AUTHORIZATION');

      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId: unparsedCandId,
          requisitionId: secondRequisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });

      const releasedUnparsed = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        unparsedCandId,
        fixture.recruiterId,
        secondRequisitionId,
      );
      expect(releasedUnparsed.releasedCount).toBe(1);

      const unparsedJobAfter = await pgClient.processingJob.findUnique({
        where: { id: reusedUnparsed!.jobId },
      });
      expect(unparsedJobAfter?.status).toBe('QUEUED');

      // Scenario E: Inconsistent state where ResumeDocument.parseStatus is 'PARSED' but DocumentExtraction is missing
      const batchInconsistent = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/rb01-inconsistent.pdf',
            fileName: 'rb01-inconsistent.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: shaInconsistent,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const inconsistentCandId = batchInconsistent.accepted[0]!.candidateId;
      const inconsistentDocId = batchInconsistent.accepted[0]!.resumeDocumentId;

      // Forcibly set parseStatus = 'PARSED' without creating a DocumentExtraction record
      await pgClient.resumeDocument.update({
        where: { id: inconsistentDocId },
        data: { parseStatus: 'PARSED' },
      });

      const reusedInconsistent = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        inconsistentCandId,
        inconsistentDocId,
      );
      expect(reusedInconsistent?.jobStatus).toBe('HELD_FOR_AUTHORIZATION');
      // Healed from PARSED to PENDING because no extraction record exists!
      expect(reusedInconsistent?.parseStatus).toBe('PENDING');

      await pgClient.candidateConsent.create({
        data: {
          organizationId: fixture.organizationId,
          candidateId: inconsistentCandId,
          requisitionId: secondRequisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'v1.0',
          captureMethod: 'RECRUITER_RECORDED',
          capturedAt: new Date(),
        },
      });

      const releasedInconsistent = await repository.releaseHeldProcessingJobs(
        fixture.organizationId,
        inconsistentCandId,
        fixture.recruiterId,
        secondRequisitionId,
      );
      expect(releasedInconsistent.releasedCount).toBe(1);

      const inconsistentJobAfter = await pgClient.processingJob.findUnique({
        where: { id: reusedInconsistent!.jobId },
      });
      // Must be QUEUED for extraction, NOT falsely marked SUCCEEDED!
      expect(inconsistentJobAfter?.status).toBe('QUEUED');
    });

    it('RB-02: concurrent reuse requests (Promise.all) and sequential retries resolve to identical batchId and jobId without duplicate jobs or orphaned batches', async () => {
      const shaConcurrent = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

      // 1. Upload candidate resume under Requisition A
      const uploadBatch = await repository.createResumeBatch(
        fixture.principal,
        fixture.requisitionId,
        [
          {
            storageKey: '2026-11/rb02-concurrent.pdf',
            fileName: 'rb02-concurrent.pdf',
            fileType: 'PDF',
            mimeType: 'application/pdf',
            sizeBytes: 1536,
            sha256: shaConcurrent,
          },
        ],
        { totalUploaded: 1, duplicates: 0, rejected: 0 },
      );
      const candId = uploadBatch.accepted[0]!.candidateId;
      const docId = uploadBatch.accepted[0]!.resumeDocumentId;

      const batchesBefore = await pgClient.processingBatch.count({
        where: {
          organizationId: fixture.organizationId,
          requisitionId: secondRequisitionId,
        },
      });

      // 2. Execute two simultaneous reuse requests for the exact same (organization, requisition, candidate, resumeDocument)
      const [resA, resB] = await Promise.all([
        repository.reuseCandidateResumeForRequisition!(
          fixture.principal,
          secondRequisitionId,
          candId,
          docId,
        ),
        repository.reuseCandidateResumeForRequisition!(
          fixture.principal,
          secondRequisitionId,
          candId,
          docId,
        ),
      ]);

      expect(resA).not.toBeNull();
      expect(resB).not.toBeNull();

      // Both must resolve to identical batchId and jobId
      expect(resA!.jobId).toBe(resB!.jobId);
      expect(resA!.batchId).toBe(resB!.batchId);
      expect(resA!.resumeDocumentId).toBe(docId);
      expect(resB!.resumeDocumentId).toBe(docId);

      // Exactly one request created the initial job (isExisting: false) and the other observed it (isExisting: true)
      expect([resA!.isExisting, resB!.isExisting].sort()).toEqual([false, true]);

      // Verify exactly one ProcessingJob exists for this (requisition, resumeDocument)
      const jobsInDestReq = await pgClient.processingJob.findMany({
        where: {
          organizationId: fixture.organizationId,
          resumeDocumentId: docId,
          batch: {
            requisitionId: secondRequisitionId,
          },
        },
      });
      expect(jobsInDestReq).toHaveLength(1);
      expect(jobsInDestReq[0]!.id).toBe(resA!.jobId);

      // Verify exactly one new ProcessingBatch was created and zero orphaned batches exist
      const batchesAfter = await pgClient.processingBatch.count({
        where: {
          organizationId: fixture.organizationId,
          requisitionId: secondRequisitionId,
        },
      });
      expect(batchesAfter - batchesBefore).toBe(1);

      const orphanedBatches = await pgClient.processingBatch.count({
        where: {
          organizationId: fixture.organizationId,
          requisitionId: secondRequisitionId,
          jobs: { none: {} },
        },
      });
      expect(orphanedBatches).toBe(0);

      // 3. Sequential retry returns the exact same batchId and jobId
      const retrySeq = await repository.reuseCandidateResumeForRequisition!(
        fixture.principal,
        secondRequisitionId,
        candId,
        docId,
      );
      expect(retrySeq?.isExisting).toBe(true);
      expect(retrySeq?.jobId).toBe(resA!.jobId);
      expect(retrySeq?.batchId).toBe(resA!.batchId);
    });
  });
});
