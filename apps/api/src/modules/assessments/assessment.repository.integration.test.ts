import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import { createAssessmentRepository, type AssessmentRepository } from './assessment.repository.js';
import { createAssessmentService, type AssessmentService } from './assessment.service.js';
import { createConsentRepository, type ConsentRepository } from '../consent/consent.repository.js';
import { hashToken } from '../consent/consent.service.js';

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

const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

maybeDescribe('assessment repository & service — live postgresql integration tests', () => {
  let client: AnyPrismaClient;
  let repository: AssessmentRepository;
  let consentRepository: ConsentRepository;
  let service: AssessmentService;

  beforeAll(async () => {
    const connStr = assertSafeIntegrationDatabase();
    client = createTestPrismaClient(connStr);
    await client.$connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository = createAssessmentRepository(client as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consentRepository = createConsentRepository(client as any);
    service = createAssessmentService(repository);
  });

  afterAll(async () => {
    if (client) {
      await client.$disconnect();
    }
  });

  async function createFixture() {
    const orgId = randomUUID();
    const recruiterUserId = randomUUID();
    const otherUserId = randomUUID();
    const clientId = randomUUID();
    const candidateId = randomUUID();
    const requisitionId = randomUUID();
    const otherRequisitionId = randomUUID();
    const scorecardVersionId = randomUUID();
    const criterionId = randomUUID();
    const resumeDocId = randomUUID();
    const batchId = randomUUID();
    const extractionId = randomUUID();

    // 1. Organization
    await client.organization.create({
      data: {
        id: orgId,
        name: `Assessment Test Org ${orgId.slice(0, 8)}`,
        normalizedName: `assess-org-${orgId.slice(0, 8)}`,
      },
    });

    // 2. Users
    await client.user.create({
      data: {
        id: recruiterUserId,
        organizationId: orgId,
        email: `recruiter-${recruiterUserId.slice(0, 8)}@example.com`,
        normalizedEmail: `recruiter-${recruiterUserId.slice(0, 8)}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    await client.user.create({
      data: {
        id: otherUserId,
        organizationId: orgId,
        email: `other-${otherUserId.slice(0, 8)}@example.com`,
        normalizedEmail: `other-${otherUserId.slice(0, 8)}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    // 3. Client
    await client.client.create({
      data: {
        id: clientId,
        organizationId: orgId,
        name: `Client ${clientId.slice(0, 8)}`,
        normalizedName: `client-${clientId.slice(0, 8)}`,
        status: 'ACTIVE',
      },
    });

    // 4. Candidate
    await client.candidate.create({
      data: {
        id: candidateId,
        organizationId: orgId,
        candidateCode: `CAN-${randomUUID().slice(0, 8).toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    // 5. Requisitions
    await client.requisition.create({
      data: {
        id: requisitionId,
        organizationId: orgId,
        clientId,
        title: 'Principal Backend Engineer',
        jdText: 'Must have extensive TypeScript and PostgreSQL experience.',
        status: 'OPEN',
        createdById: recruiterUserId,
        assignedRecruiterId: recruiterUserId,
      },
    });

    await client.requisition.create({
      data: {
        id: otherRequisitionId,
        organizationId: orgId,
        clientId,
        title: 'Frontend Engineer',
        jdText: 'React frontend engineer',
        status: 'OPEN',
        createdById: otherUserId,
        assignedRecruiterId: otherUserId,
      },
    });

    // 6. Scorecard Version (APPROVED) & Criterion
    await client.scorecardVersion.create({
      data: {
        id: scorecardVersionId,
        requisitionId,
        organizationId: orgId,
        version: 1,
        status: 'APPROVED',
        approvedAt: new Date(),
        approvedById: recruiterUserId,
        weightsJson: { typescript: 1.0 },
        criteria: {
          create: [
            {
              id: criterionId,
              key: 'typescript',
              label: 'TypeScript Experience',
              category: 'EXPERIENCE',
              requirementType: 'MUST_HAVE',
              weight: new Prisma.Decimal(1.0),
              ruleJson: { type: 'keyword', keywords: ['typescript'] },
              active: true,
              displayOrder: 1,
            },
          ],
        },
      },
    });

    // 7. Active CandidateConsent for requisition
    await client.candidateConsent.create({
      data: {
        organizationId: orgId,
        candidateId,
        requisitionId,
        purpose: 'HIRING_USE',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'sha256-notice-hash-test',
        captureMethod: 'RECRUITER_RECORDED',
        capturedAt: new Date(),
      },
    });

    // 8. ProcessingBatch & ResumeDocument & Extraction
    await client.processingBatch.create({
      data: {
        id: batchId,
        organizationId: orgId,
        requisitionId,
        createdById: recruiterUserId,
        totalFiles: 1,
        status: 'COMPLETED',
      },
    });

    await client.resumeDocument.create({
      data: {
        id: resumeDocId,
        organizationId: orgId,
        candidateId,
        objectKey: `resumes/${orgId}/${resumeDocId}.pdf`,
        fileType: 'PDF',
        mimeType: 'application/pdf',
        sha256: randomBytes(32).toString('hex'),
        sizeBytes: BigInt(1024),
        version: 1,
        parseStatus: 'PARSED',
        uploadedById: recruiterUserId,
      },
    });

    const resumeSampleText =
      'Candidate Jane Doe. 9 years of professional TypeScript, Node.js, and PostgreSQL database performance engineering experience.';

    await client.documentExtraction.create({
      data: {
        id: extractionId,
        organizationId: orgId,
        resumeDocumentId: resumeDocId,
        version: 1,
        extractedText: resumeSampleText,
        pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: resumeSampleText.length }],
        parser: 'PDF_TEXT',
        qualityStatus: 'COMPLETE',
      },
    });

    async function cleanup() {
      await client.evidenceSnippet.deleteMany({ where: { organizationId: orgId } });
      await client.criterionAssessment.deleteMany({ where: { organizationId: orgId } });
      await client.candidateAssessment.deleteMany({ where: { organizationId: orgId } });
      await client.assessmentText.deleteMany({ where: { organizationId: orgId } });
      await client.documentExtraction.deleteMany({ where: { organizationId: orgId } });
      await client.processingJob.deleteMany({ where: { organizationId: orgId } });
      await client.resumeDocument.deleteMany({ where: { organizationId: orgId } });
      await client.processingBatch.deleteMany({ where: { organizationId: orgId } });
      await client.consentWithdrawalRequest.deleteMany({ where: { candidateId } });
      await client.candidateConsent.deleteMany({ where: { candidateId } });
      await client.scorecardCriterion.deleteMany({ where: { scorecardVersionId } });
      await client.scorecardVersion.deleteMany({ where: { organizationId: orgId } });
      await client.auditLog.deleteMany({ where: { organizationId: orgId } });
      await client.requisition.deleteMany({ where: { organizationId: orgId } });
      await client.candidate.deleteMany({ where: { id: candidateId } });
      await client.client.deleteMany({ where: { organizationId: orgId } });
      await client.user.deleteMany({ where: { organizationId: orgId } });
      await client.organization.deleteMany({ where: { id: orgId } });
    }

    return {
      orgId,
      recruiterUserId,
      otherUserId,
      candidateId,
      requisitionId,
      otherRequisitionId,
      scorecardVersionId,
      criterionId,
      resumeDocId,
      batchId,
      extractionId,
      resumeSampleText,
      cleanup,
    };
  }

  it('enqueues an assessment job and proves duplicate enqueue is idempotent', async () => {
    const fx = await createFixture();
    try {
      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      // 1. Enqueue
      const firstResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      expect(firstResult.isExisting).toBe(false);
      expect(firstResult.job).not.toBeNull();
      const firstJob = firstResult.job!;
      expect(firstJob.status).toBe('QUEUED');
      expect(firstJob.jobType).toBe('ASSESS_CANDIDATE');
      expect(firstJob.resumeDocumentId).toBe(fx.resumeDocId);

      // Verify in DB
      const jobInDb = await client.processingJob.findUnique({
        where: { id: firstJob.jobId },
      });
      expect(jobInDb).not.toBeNull();
      expect(jobInDb!.jobType).toBe('ASSESS_CANDIDATE');
      expect(jobInDb!.status).toBe('QUEUED');

      // 2. Duplicate Enqueue
      const duplicateResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      expect(duplicateResult.isExisting).toBe(true);
      expect(duplicateResult.job).not.toBeNull();
      expect(duplicateResult.job!.jobId).toBe(firstJob.jobId);
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects enqueue when recruiter is not assigned to requisition', async () => {
    const fx = await createFixture();
    try {
      const otherRecruiter = {
        userId: fx.otherUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      await expect(
        service.enqueue(otherRecruiter, fx.requisitionId, fx.resumeDocId),
      ).rejects.toThrow(/requisition assignment/i);
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects enqueue when scorecard is not approved', async () => {
    const fx = await createFixture();
    try {
      // Mark scorecard as DRAFT
      await client.scorecardVersion.update({
        where: { id: fx.scorecardVersionId },
        data: { status: 'DRAFT' },
      });

      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      await expect(service.enqueue(principal, fx.requisitionId, fx.resumeDocId)).rejects.toThrow(
        /approved scorecard/i,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects enqueue when active candidate consent is missing', async () => {
    const fx = await createFixture();
    try {
      // Withdraw consent
      await client.candidateConsent.updateMany({
        where: { candidateId: fx.candidateId },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
      });

      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      await expect(service.enqueue(principal, fx.requisitionId, fx.resumeDocId)).rejects.toThrow(
        /active consent/i,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('completes assessment and verifies CandidateAssessment, CriterionAssessment, EvidenceSnippet and AssessmentText', async () => {
    const fx = await createFixture();
    try {
      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      // 1. Enqueue
      const enqueueResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      expect(enqueueResult.job).not.toBeNull();
      const jobId = enqueueResult.job!.jobId;

      // 2. Simulate worker claim
      const leaseToken = randomUUID();
      const workerId = 'integration-worker-1';
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: workerId,
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 300000),
          attempts: 1,
        },
      });

      // 3. Worker assessment completion simulation
      const assessmentTextId = randomUUID();
      const assessmentId = randomUUID();
      const criterionAssessmentId = randomUUID();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.$transaction(async (tx: any) => {
        // Redacted text storage
        await tx.assessmentText.create({
          data: {
            id: assessmentTextId,
            organizationId: fx.orgId,
            documentExtractionId: fx.extractionId,
            resumeDocumentId: fx.resumeDocId,
            version: 1,
            redactedText: fx.resumeSampleText,
            pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: fx.resumeSampleText.length }],
            redactionMapJson: [],
            redactorVersion: '2026-11-redactor-v1',
          },
        });

        // Candidate assessment
        await tx.candidateAssessment.create({
          data: {
            id: assessmentId,
            organizationId: fx.orgId,
            requisitionId: fx.requisitionId,
            candidateId: fx.candidateId,
            resumeDocumentId: fx.resumeDocId,
            documentExtractionId: fx.extractionId,
            scorecardVersionId: fx.scorecardVersionId,
            assessmentTextId,
            score: new Prisma.Decimal(100),
            coverage: new Prisma.Decimal(100),
            status: 'COMPLETE',
            formulaVersion: 'weighted_criteria_v1',
            modelMetadataJson: {
              provider: 'deterministic-fake',
              model: 'deterministic-test-model',
              promptVersion: '2026-11-assessment-v1',
            },
          },
        });

        // Criterion assessment
        await tx.criterionAssessment.create({
          data: {
            id: criterionAssessmentId,
            organizationId: fx.orgId,
            assessmentId,
            criterionId: fx.criterionId,
            scorecardVersionId: fx.scorecardVersionId,
            resumeDocumentId: fx.resumeDocId,
            assessmentTextId,
            documentExtractionId: fx.extractionId,
            status: 'MATCH',
            normalizedValue: new Prisma.Decimal(1.0),
            explanation: 'TypeScript experience verified in resume.',
          },
        });

        // Evidence snippet
        await tx.evidenceSnippet.create({
          data: {
            organizationId: fx.orgId,
            criterionAssessmentId,
            assessmentId,
            scorecardVersionId: fx.scorecardVersionId,
            assessmentTextId,
            resumeDocumentId: fx.resumeDocId,
            documentExtractionId: fx.extractionId,
            quote: 'TypeScript, Node.js, and PostgreSQL',
            pageNumber: 1,
            startOffset: 45,
            endOffset: 80,
            verified: true,
            verificationMethod: 'EXACT_QUOTE',
          },
        });

        // Complete job
        await tx.processingJob.update({
          where: { id: jobId },
          data: {
            status: 'SUCCEEDED',
            leaseToken: null,
            lockedBy: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
        });
      });

      // 4. Query via service
      const retrieved = await service.getById(principal, fx.requisitionId, assessmentId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.status).toBe('COMPLETE');
      expect(retrieved.score).toBe(100);
      expect(retrieved.coverage).toBe(100);
      expect(retrieved.criteria).toHaveLength(1);
      expect(retrieved.criteria[0]!.criterionId).toBe(fx.criterionId);
      expect(retrieved.criteria[0]!.status).toBe('MATCH');
      expect(retrieved.criteria[0]!.evidence).toHaveLength(1);
      expect(retrieved.criteria[0]!.evidence[0]!.quote).toBe('TypeScript, Node.js, and PostgreSQL');
      expect(retrieved.criteria[0]!.evidence[0]!.verified).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('proves consent withdrawal immediately holds processing jobs and fences out worker', async () => {
    const fx = await createFixture();
    try {
      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      // 1. Enqueue assessment job
      const enqueueResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      expect(enqueueResult.job).not.toBeNull();
      const jobId = enqueueResult.job!.jobId;

      // 2. Claim job
      const leaseToken = randomUUID();
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-to-be-fenced',
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 300000),
          attempts: 1,
        },
      });

      // 3. Candidate confirms consent withdrawal
      const activeConsent = await client.candidateConsent.findFirst({
        where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId, status: 'ACTIVE' },
      });
      expect(activeConsent).not.toBeNull();

      const rawWithdrawToken = randomBytes(32).toString('hex');
      const withdrawTokenHash = hashToken(rawWithdrawToken);

      await consentRepository.createWithdrawalRequest({
        organizationId: fx.orgId,
        candidateId: fx.candidateId,
        consentId: activeConsent!.id,
        tokenHash: withdrawTokenHash,
        email: 'candidate@example.com',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const confirmResult = await consentRepository.confirmWithdrawal(withdrawTokenHash);
      expect(confirmResult?.status).toBe('WITHDRAWN');
      expect(confirmResult?.heldJobCount).toBe(1);

      // 4. Verify job transitioned to HELD_FOR_AUTHORIZATION and lease cleared
      const heldJob = await client.processingJob.findUnique({
        where: { id: jobId },
      });
      expect(heldJob!.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(heldJob!.leaseToken).toBeNull();

      // 5. Verify worker fenced out: attempting fenced completion with stale leaseToken fails
      const updateResult = await client.$executeRaw(Prisma.sql`
        UPDATE "processing_jobs"
        SET status = 'SUCCEEDED'
        WHERE id = ${jobId}::uuid
          AND status = 'PROCESSING'
          AND lease_token = ${leaseToken}::uuid
      `);
      expect(updateResult).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('fences failAssessmentJob so a stale worker cannot mark a job failed after lease expiry or re-claim (F-09)', async () => {
    const fx = await createFixture();
    try {
      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      const enqueueResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      const jobId = enqueueResult.job!.jobId;

      // Worker 1 claims job initially
      const staleLeaseToken = randomUUID();
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-1',
          leaseToken: staleLeaseToken,
          leaseExpiresAt: new Date(Date.now() - 60000), // Expired!
          attempts: 1,
        },
      });

      // Worker 1 (stale) attempts to mark job FAILED with expired lease -> must return false and not overwrite
      const staleExpiredResult = await repository.failAssessmentJob({
        workerId: 'worker-1',
        leaseToken: staleLeaseToken,
        jobId,
        status: 'FAILED',
        errorCode: 'STALE_WORKER_ERROR',
        attempts: 1,
      });
      expect(staleExpiredResult).toBe(false);

      // Worker 2 re-claims the job with a fresh lease
      const activeLeaseToken = randomUUID();
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-2',
          leaseToken: activeLeaseToken,
          leaseExpiresAt: new Date(Date.now() + 300000),
          attempts: 2,
        },
      });

      // Worker 1 (stale) attempts to fail job while Worker 2 holds active lease -> must return false
      const staleReclaimedResult = await repository.failAssessmentJob({
        workerId: 'worker-1',
        leaseToken: staleLeaseToken,
        jobId,
        status: 'FAILED',
        errorCode: 'STALE_WORKER_OVERWRITE',
        attempts: 1,
      });
      expect(staleReclaimedResult).toBe(false);

      const jobStillOwnedByWorker2 = await client.processingJob.findUnique({
        where: { id: jobId },
      });
      expect(jobStillOwnedByWorker2?.status).toBe('PROCESSING');
      expect(jobStillOwnedByWorker2?.lockedBy).toBe('worker-2');
      expect(jobStillOwnedByWorker2?.leaseToken).toBe(activeLeaseToken);

      // Worker 2 (active lease holder) fails job -> succeeds and clears lease
      const activeFailResult = await repository.failAssessmentJob({
        workerId: 'worker-2',
        leaseToken: activeLeaseToken,
        jobId,
        status: 'RETRYABLE_FAILURE',
        errorCode: 'PROVIDER_TIMEOUT',
        attempts: 2,
      });
      expect(activeFailResult).toBe(true);

      const failedJob = await client.processingJob.findUnique({
        where: { id: jobId },
      });
      expect(failedJob?.status).toBe('RETRYABLE_FAILURE');
      expect(failedJob?.lastErrorCode).toBe('PROVIDER_TIMEOUT');
      expect(failedJob?.lockedBy).toBeNull();
      expect(failedJob?.leaseToken).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it('RB-03 (D, E, F, G, H, I): completeAssessment enforces workerId, leaseToken, non-null unexpired lease_expires_at, consent withdrawal fencing, and atomic rollback against real PostgreSQL', async () => {
    const fx = await createFixture();
    try {
      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      const enqueueResult = await service.enqueue(principal, fx.requisitionId, fx.resumeDocId);
      const jobId = enqueueResult.job!.jobId;

      const activeConsent = await client.candidateConsent.findFirst({
        where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId, status: 'ACTIVE' },
      });
      expect(activeConsent).not.toBeNull();

      const validLeaseToken = randomUUID();
      const wrongLeaseToken = randomUUID();

      const makeCompleteParams = (overrides: { workerId?: string; leaseToken?: string }) => ({
        workerId: overrides.workerId ?? 'worker-owner-1',
        leaseToken: overrides.leaseToken ?? validLeaseToken,
        jobId,
        organizationId: fx.orgId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        documentExtractionId: fx.extractionId,
        scorecardVersionId: fx.scorecardVersionId,
        redactedText: 'Senior Engineer with TypeScript, Node.js, and PostgreSQL experience.',
        pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: 68 }],
        redactionMapJson: [],
        summary: {
          score: 100,
          coverage: 100,
          isComplete: true,
          status: 'COMPLETE' as const,
          formulaVersion: 'weighted_criteria_v2',
          criterionResults: [
            {
              criterionId: fx.criterionId,
              scorecardVersionId: fx.scorecardVersionId,
              status: 'MATCH' as const,
              normalizedValue: 1.0,
              explanation: 'Verified TypeScript in resume.',
              weight: 100,
              evidenceSnippets: [
                {
                  quote: 'TypeScript, Node.js, and PostgreSQL',
                  pageNumber: 1,
                  startOffset: 21,
                  endOffset: 56,
                  verified: true,
                  verificationMethod: 'EXACT_QUOTE' as const,
                },
              ],
            },
          ],
        },
        metadata: {
          provider: 'deterministic-fake',
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'in-hash',
          outputHash: 'out-hash',
          scoringFormula: 'weighted_criteria_v2',
          consentId: activeConsent!.id,
          consentNoticeHash: 'a'.repeat(64),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      });

      // Scenario D: Expired lease prevents successful completion and persists zero assessment rows
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-owner-1',
          leaseToken: validLeaseToken,
          leaseExpiresAt: new Date(Date.now() - 30_000),
          attempts: 1,
        },
      });

      const expiredResult = await repository.completeAssessment(makeCompleteParams({}));
      expect(expiredResult).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);

      // Set valid unexpired lease owned by worker-owner-1
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-owner-1',
          leaseToken: validLeaseToken,
          leaseExpiresAt: new Date(Date.now() + 300_000),
          attempts: 1,
        },
      });

      // Scenario E: Wrong lease token prevents success and persists zero assessment rows
      const wrongTokenResult = await repository.completeAssessment(
        makeCompleteParams({ leaseToken: wrongLeaseToken }),
      );
      expect(wrongTokenResult).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);

      // Scenario F: Wrong worker ID prevents success and persists zero assessment rows
      const wrongWorkerResult = await repository.completeAssessment(
        makeCompleteParams({ workerId: 'worker-impostor-2' }),
      );
      expect(wrongWorkerResult).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);

      // Scenario I: Consent withdrawn between provider execution and result persistence prevents commit and holds job
      await client.candidateConsent.update({
        where: { id: activeConsent!.id },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
      });

      const withdrawnConsentResult = await repository.completeAssessment(makeCompleteParams({}));
      expect(withdrawnConsentResult).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);
      const jobAfterWithdraw = await client.processingJob.findUnique({ where: { id: jobId } });
      expect(jobAfterWithdraw?.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(jobAfterWithdraw?.leaseToken).toBeNull();
      expect(jobAfterWithdraw?.lockedBy).toBeNull();

      // Restore active consent and valid lease for Scenario H
      await client.candidateConsent.update({
        where: { id: activeConsent!.id },
        data: { status: 'ACTIVE', withdrawnAt: null },
      });
      await client.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          lockedBy: 'worker-owner-1',
          leaseToken: validLeaseToken,
          leaseExpiresAt: new Date(Date.now() + 300_000),
          attempts: 1,
        },
      });

      // Scenario H: Valid current lease and active consent allows assessment and job completion atomically
      const validResult = await repository.completeAssessment(makeCompleteParams({}));
      expect(validResult).toBe(true);

      const succeededJob = await client.processingJob.findUnique({ where: { id: jobId } });
      expect(succeededJob?.status).toBe('SUCCEEDED');
      expect(succeededJob?.leaseToken).toBeNull();
      expect(succeededJob?.lockedBy).toBeNull();
      expect(succeededJob?.leaseExpiresAt).toBeNull();

      const persistedAssessments = await client.candidateAssessment.findMany({
        where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId },
        include: { criterionAssessments: { include: { evidence: true } } },
      });
      expect(persistedAssessments).toHaveLength(1);
      expect(persistedAssessments[0]!.status).toBe('COMPLETE');
      expect(persistedAssessments[0]!.criterionAssessments).toHaveLength(1);
      expect(persistedAssessments[0]!.criterionAssessments[0]!.evidence).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects completion when a worker transaction starts before lease expiry, waits on a row lock until after lease expiry, and protects a newer worker lease (clock_timestamp semantics)', async () => {
    const fx = await createFixture();
    try {
      const repository = createAssessmentRepository(client);
      const activeConsent = await client.candidateConsent.findFirst({
        where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId, status: 'ACTIVE' },
      });
      expect(activeConsent).not.toBeNull();

      const principal = {
        userId: fx.recruiterUserId,
        organizationId: fx.orgId,
        role: 'RECRUITER' as const,
      };

      const { jobId } = await repository.enqueueAssessmentJob(
        principal,
        fx.requisitionId,
        fx.candidateId,
        fx.resumeDocId,
      );

      const staleWorkerId = 'worker-stale-lock-waiter';
      const staleLeaseToken = randomUUID();
      const freshWorkerId = 'worker-fresh-reclaimer';
      const freshLeaseToken = randomUUID();

      const buildCompleteParams = (workerId: string, leaseToken: string) => ({
        workerId,
        leaseToken,
        jobId,
        organizationId: fx.orgId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        documentExtractionId: fx.extractionId,
        scorecardVersionId: fx.scorecardVersionId,
        redactedText: 'Senior TypeScript and PostgreSQL Engineer with 7 years of experience.',
        pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: 68 }],
        redactionMapJson: [],
        summary: {
          score: 90,
          coverage: 1,
          isComplete: true,
          status: 'COMPLETE' as const,
          formulaVersion: 'weighted_criteria_v2' as const,
          criterionResults: [
            {
              criterionId: fx.criterionId,
              scorecardVersionId: fx.scorecardVersionId,
              status: 'MATCH' as const,
              normalizedValue: 0.9,
              explanation: 'Confirmed TypeScript and PostgreSQL experience.',
              weight: 100,
              evidenceSnippets: [
                {
                  quote: 'TypeScript and PostgreSQL Engineer',
                  pageNumber: 1,
                  startOffset: 7,
                  endOffset: 41,
                  verified: true,
                  verificationMethod: 'EXACT_QUOTE' as const,
                },
              ],
            },
          ],
        },
        metadata: {
          provider: 'deterministic-fake',
          model: 'test-model',
          promptVersion: '2026-11-assessment-v1',
          inputHash: 'in-hash-clock',
          outputHash: 'out-hash-clock',
          scoringFormula: 'weighted_criteria_v2',
          consentId: activeConsent!.id,
          consentNoticeHash: 'a'.repeat(64),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      });

      // Part 1: Worker starts transaction BEFORE lease expires, waits on row lock until AFTER lease expires,
      // and lock holder releases lock without modifying the row (tests pure clock_timestamp() vs NOW() + post-lock check).
      await client.$executeRaw`
        UPDATE "processing_jobs"
        SET status = 'PROCESSING',
            locked_by = ${staleWorkerId},
            lease_token = ${staleLeaseToken}::uuid,
            lease_expires_at = clock_timestamp() + INTERVAL '300 milliseconds',
            attempts = 1,
            updated_at = NOW()
        WHERE id = ${jobId}::uuid
      `;

      let resolveLockAcquired1!: () => void;
      const lockAcquired1 = new Promise<void>((resolve) => {
        resolveLockAcquired1 = resolve;
      });

      const blockerTx1 = client.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "processing_jobs"
          WHERE id = ${jobId}::uuid
          FOR UPDATE
        `;
        resolveLockAcquired1();
        // Hold the row lock for 500ms so the 300ms lease expires while completeAssessment is waiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      await lockAcquired1;

      // Start completeAssessment while lease still has ~250ms remaining; it will block on the row lock
      const staleCompletionDuringWaitPromise = repository.completeAssessment(
        buildCompleteParams(staleWorkerId, staleLeaseToken),
      );

      const [, staleCompletionResult1] = await Promise.all([
        blockerTx1,
        staleCompletionDuringWaitPromise,
      ]);

      // Completion MUST be rejected even though the transaction started before lease_expires_at!
      expect(staleCompletionResult1).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);
      expect(await client.criterionAssessment.count({ where: { organizationId: fx.orgId } })).toBe(
        0,
      );
      expect(await client.evidenceSnippet.count({ where: { organizationId: fx.orgId } })).toBe(0);
      expect(
        await client.assessmentText.count({ where: { resumeDocumentId: fx.resumeDocId } }),
      ).toBe(0);
      expect(
        await client.auditLog.count({
          where: { candidateId: fx.candidateId, action: 'ASSESSMENT_COMPLETED' },
        }),
      ).toBe(0);

      // Part 2: Worker starts transaction before lease expires, waits on row lock while lease expires,
      // and a newer worker reclaims the expired lease; stale worker must NOT overwrite the newer worker's lease.
      await client.$executeRaw`
        UPDATE "processing_jobs"
        SET status = 'PROCESSING',
            locked_by = ${staleWorkerId},
            lease_token = ${staleLeaseToken}::uuid,
            lease_expires_at = clock_timestamp() + INTERVAL '300 milliseconds',
            attempts = 1,
            updated_at = NOW()
        WHERE id = ${jobId}::uuid
      `;

      let resolveLockAcquired2!: () => void;
      const lockAcquired2 = new Promise<void>((resolve) => {
        resolveLockAcquired2 = resolve;
      });

      const reclaimerTx = client.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "processing_jobs"
          WHERE id = ${jobId}::uuid
          FOR UPDATE
        `;
        resolveLockAcquired2();
        // Wait until the 300ms lease expires in wall-clock time
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Newer worker reclaims the now-expired lease
        const reclaimed = await tx.$executeRaw`
          UPDATE "processing_jobs"
          SET status = 'PROCESSING',
              locked_by = ${freshWorkerId},
              lease_token = ${freshLeaseToken}::uuid,
              lease_expires_at = clock_timestamp() + INTERVAL '5 minutes',
              attempts = attempts + 1,
              updated_at = NOW()
          WHERE id = ${jobId}::uuid
            AND status = 'PROCESSING'
            AND lease_expires_at <= clock_timestamp()
        `;
        expect(reclaimed).toBe(1);
      });

      await lockAcquired2;

      const staleCompletionVsReclaimerPromise = repository.completeAssessment(
        buildCompleteParams(staleWorkerId, staleLeaseToken),
      );

      const [, staleCompletionResult2] = await Promise.all([
        reclaimerTx,
        staleCompletionVsReclaimerPromise,
      ]);

      expect(staleCompletionResult2).toBe(false);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(0);

      // Verify the newer worker's lease was NOT overwritten
      const jobAfterReclaim = await client.processingJob.findUnique({ where: { id: jobId } });
      expect(jobAfterReclaim?.status).toBe('PROCESSING');
      expect(jobAfterReclaim?.lockedBy).toBe(freshWorkerId);
      expect(jobAfterReclaim?.leaseToken).toBe(freshLeaseToken);
      expect(jobAfterReclaim?.leaseExpiresAt).not.toBeNull();

      // Part 3: Verify the still-valid lease of the newer worker successfully completes
      const freshCompletionResult = await repository.completeAssessment(
        buildCompleteParams(freshWorkerId, freshLeaseToken),
      );
      expect(freshCompletionResult).toBe(true);

      const completedJob = await client.processingJob.findUnique({ where: { id: jobId } });
      expect(completedJob?.status).toBe('SUCCEEDED');
      expect(completedJob?.lockedBy).toBeNull();
      expect(completedJob?.leaseToken).toBeNull();
      expect(completedJob?.leaseExpiresAt).toBeNull();

      expect(
        await client.candidateAssessment.count({ where: { candidateId: fx.candidateId } }),
      ).toBe(1);
      expect(
        await client.auditLog.count({
          where: { candidateId: fx.candidateId, action: 'ASSESSMENT_COMPLETED' },
        }),
      ).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });
});
