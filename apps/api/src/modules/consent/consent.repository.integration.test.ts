import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import {
  computeContactFingerprint,
  createConsentRepository,
  type ConsentRepository,
} from './consent.repository.js';
import { createResumeRepository, type ResumeRepository } from '../resumes/resume.repository.js';
import { hashToken } from './consent.service.js';
import { encryptEmailPayload } from '../email/email.crypto.js';
import { PostgresEmailOutboxStore } from '../email/email.outbox.js';
import { InMemoryEmailProvider } from '../email/email.provider.js';
import { TransactionalEmailService } from '../email/email.service.js';
import {
  WorkerEmailDispatcher,
  type EmailDispatcherProvider,
} from '../../../../worker/src/email-dispatcher.js';

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

maybeDescribe('consent repository — live postgresql integration tests', () => {
  let client: AnyPrismaClient;
  let repository: ConsentRepository;
  let resumeRepository: ResumeRepository;

  beforeAll(async () => {
    const connStr = assertSafeIntegrationDatabase();
    client = createTestPrismaClient(connStr);
    await client.$connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository = createConsentRepository(client as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumeRepository = createResumeRepository(client as any);
  });

  afterAll(async () => {
    if (client) {
      await client.$disconnect();
    }
  });

  async function createFixture() {
    const orgId = randomUUID();
    const userId = randomUUID();
    const clientId = randomUUID();
    const candidateId = randomUUID();
    const reqAId = randomUUID();
    const reqBId = randomUUID();

    await client.organization.create({
      data: {
        id: orgId,
        name: `Consent Test Org ${orgId.slice(0, 8)}`,
        normalizedName: `consent-org-${orgId.slice(0, 8)}`,
      },
    });

    await client.user.create({
      data: {
        id: userId,
        organizationId: orgId,
        email: `recruiter-${userId.slice(0, 8)}@example.com`,
        normalizedEmail: `recruiter-${userId.slice(0, 8)}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    await client.client.create({
      data: {
        id: clientId,
        organizationId: orgId,
        name: `Client ${clientId.slice(0, 8)}`,
        normalizedName: `client-${clientId.slice(0, 8)}`,
        status: 'ACTIVE',
      },
    });

    await client.candidate.create({
      data: {
        id: candidateId,
        organizationId: orgId,
        candidateCode: `CAN-${randomUUID().slice(0, 8).toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    await client.requisition.create({
      data: {
        id: reqAId,
        organizationId: orgId,
        clientId,
        title: 'Backend Engineer - Req A',
        jdText: 'Backend job description text',
        status: 'OPEN',
        createdById: userId,
        assignedRecruiterId: userId,
      },
    });

    await client.requisition.create({
      data: {
        id: reqBId,
        organizationId: orgId,
        clientId,
        title: 'Frontend Engineer - Req B',
        jdText: 'Frontend job description text',
        status: 'OPEN',
        createdById: userId,
        assignedRecruiterId: userId,
      },
    });

    async function cleanup() {
      await client.clientDecision.deleteMany({ where: { organizationId: orgId } });
      await client.interviewProposal.deleteMany({ where: { organizationId: orgId } });
      await client.pipelineEvent.deleteMany({ where: { organizationId: orgId } });
      await client.candidateSubmission.deleteMany({ where: { organizationId: orgId } });
      await client.candidateShortlist.deleteMany({ where: { organizationId: orgId } });
      await client.candidateReview.deleteMany({ where: { organizationId: orgId } });
      await client.evidenceSnippet.deleteMany({ where: { organizationId: orgId } });
      await client.criterionAssessment.deleteMany({ where: { organizationId: orgId } });
      await client.candidateAssessment.deleteMany({ where: { organizationId: orgId } });
      await client.scorecardCriterion.deleteMany({
        where: { scorecardVersion: { organizationId: orgId } },
      });
      await client.scorecardVersion.deleteMany({ where: { organizationId: orgId } });
      await client.assessmentText.deleteMany({ where: { organizationId: orgId } });
      await client.documentExtraction.deleteMany({ where: { organizationId: orgId } });
      await client.processingJob.deleteMany({ where: { organizationId: orgId } });
      await client.resumeDocument.deleteMany({ where: { organizationId: orgId } });
      await client.processingBatch.deleteMany({ where: { organizationId: orgId } });
      await client.candidateSkill.deleteMany({ where: { organizationId: orgId } });
      await client.candidateProfile.deleteMany({ where: { organizationId: orgId } });
      await client.candidateDeletionVerification.deleteMany({ where: { organizationId: orgId } });
      await client.consentWithdrawalRequest.deleteMany({ where: { organizationId: orgId } });
      await client.consentInvitation.deleteMany({ where: { organizationId: orgId } });
      await client.candidateConsent.deleteMany({ where: { organizationId: orgId } });
      await client.candidateIdentity.deleteMany({ where: { organizationId: orgId } });
      await client.deletionRequest.deleteMany({ where: { organizationId: orgId } });
      await client.emailOutbox.deleteMany({ where: { organizationId: orgId } });
      await client.auditLog.deleteMany({ where: { organizationId: orgId } });
      await client.requisition.deleteMany({ where: { organizationId: orgId } });
      await client.candidate.deleteMany({ where: { organizationId: orgId } });
      await client.client.deleteMany({ where: { organizationId: orgId } });
      await client.user.deleteMany({ where: { organizationId: orgId } });
      await client.organization.deleteMany({ where: { id: orgId } });
    }

    return { orgId, userId, candidateId, reqAId, reqBId, cleanup };
  }

  it('atomically creates invitation and supersedes earlier pending invitation', async () => {
    const fixture = await createFixture();
    try {
      const rawToken1 = randomBytes(32).toString('hex');
      const tokenHash1 = hashToken(rawToken1);

      const inv1 = await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqAId,
        createdById: fixture.userId,
        tokenHash: tokenHash1,
        email: 'candidate@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-1',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(inv1.status).toBe('PENDING');

      // Create a second invitation for the same candidate and requisition
      const rawToken2 = randomBytes(32).toString('hex');
      const tokenHash2 = hashToken(rawToken2);

      const inv2 = await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqAId,
        createdById: fixture.userId,
        tokenHash: tokenHash2,
        email: 'candidate@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-2',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(inv2.status).toBe('PENDING');

      // The first invitation should now be SUPERSEDED
      const checkInv1 = await client.consentInvitation.findUnique({
        where: { id: inv1.id },
      });
      expect(checkInv1?.status).toBe('SUPERSEDED');

      // Inspecting the first token should show superseded / not pending
      const notice1 = await repository.findPendingNoticeByTokenHash(tokenHash1);
      expect(notice1).toBeNull();

      // Inspecting the second token should be active and valid
      const notice2 = await repository.findPendingNoticeByTokenHash(tokenHash2);
      expect(notice2).not.toBeNull();
      expect(notice2?.requisitionTitle).toBe('Backend Engineer - Req A');
      expect(notice2?.policyVersion).toBe('2026-11-v1');
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts consent, enforces requisition scope, and releases only matching jobs', async () => {
    const fixture = await createFixture();
    try {
      // Create batch and held job for Requisition A
      const batchA = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          totalFiles: 1,
          status: 'CREATED',
        },
      });

      const resumeA = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-a.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 1,
          parseStatus: 'PENDING',
          uploadedById: fixture.userId,
        },
      });

      const jobA = await client.processingJob.create({
        data: {
          batchId: batchA.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeA.id,
          jobType: 'EXTRACT_TEXT',
          status: 'HELD_FOR_AUTHORIZATION',
          attempts: 0,
        },
      });

      // Create batch and held job for Requisition B (DIFFERENT REQUISITION)
      const batchB = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqBId,
          createdById: fixture.userId,
          totalFiles: 1,
          status: 'CREATED',
        },
      });

      const resumeB = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-b.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 2,
          parseStatus: 'PENDING',
          uploadedById: fixture.userId,
        },
      });

      const jobB = await client.processingJob.create({
        data: {
          batchId: batchB.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeB.id,
          jobType: 'EXTRACT_TEXT',
          status: 'HELD_FOR_AUTHORIZATION',
          attempts: 0,
        },
      });

      // Issue invitation for Requisition A ONLY
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);

      await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqAId,
        createdById: fixture.userId,
        tokenHash,
        email: 'candidate@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-a',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Candidate accepts consent for Requisition A
      const acceptResult = await repository.acceptInvitation(tokenHash, 'Jane Candidate');

      expect(acceptResult?.status).toBe('ACCEPTED');
      expect(acceptResult?.releasedJobCount).toBe(1);

      // Verify that Job A is now QUEUED
      const updatedJobA = await client.processingJob.findUnique({
        where: { id: jobA.id },
      });
      expect(updatedJobA?.status).toBe('QUEUED');

      // Verify that Job B for Requisition B is STILL HELD_FOR_AUTHORIZATION
      const updatedJobB = await client.processingJob.findUnique({
        where: { id: jobB.id },
      });
      expect(updatedJobB?.status).toBe('HELD_FOR_AUTHORIZATION');

      // Verify created CandidateConsent record has correct requisitionId and noticeTextHash
      expect(acceptResult?.consentId).toBeDefined();
      const consentRecord = await client.candidateConsent.findUnique({
        where: { id: acceptResult!.consentId! },
      });
      expect(consentRecord?.status).toBe('ACTIVE');
      expect(consentRecord?.requisitionId).toBe(fixture.reqAId);
      expect(consentRecord?.confirmationName).toBe('Jane Candidate');
      expect(consentRecord?.noticeTextHash).toBe('hash-notice-a');

      // Attempting to consume the token again must fail
      const secondAccept = await repository.acceptInvitation(tokenHash, 'Jane Candidate');
      expect(secondAccept).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('proves null-requisition legacy consent cannot authorize new requisition processing or release', async () => {
    const fixture = await createFixture();
    try {
      // 1. Create a legacy CandidateConsent with requisitionId = null (historical org-wide record)
      await client.candidateConsent.create({
        data: {
          candidateId: fixture.candidateId,
          organizationId: fixture.orgId,
          requisitionId: null, // Legacy null wildcard
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: 'legacy-v0',
          captureMethod: 'IMPORTED',
          capturedAt: new Date(),
        },
      });

      // 2. Create batch and held job for Requisition A
      const batchA = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          totalFiles: 1,
          status: 'CREATED',
        },
      });

      const resumeA = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-legacy-req.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 1,
          parseStatus: 'PENDING',
          uploadedById: fixture.userId,
        },
      });

      const jobA = await client.processingJob.create({
        data: {
          batchId: batchA.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeA.id,
          jobType: 'EXTRACT_TEXT',
          status: 'HELD_FOR_AUTHORIZATION',
          attempts: 0,
        },
      });

      // 3. Attempt to release held jobs using candidate release workflow
      const releaseResult = await resumeRepository.releaseHeldProcessingJobs(
        fixture.orgId,
        fixture.candidateId,
        fixture.userId,
        fixture.reqAId,
      );
      // Must NOT release because no active consent with matching requisitionId exists
      expect(releaseResult.releasedCount).toBe(0);

      // Verify Job A is STILL HELD_FOR_AUTHORIZATION
      const checkJobA = await client.processingJob.findUnique({
        where: { id: jobA.id },
      });
      expect(checkJobA?.status).toBe('HELD_FOR_AUTHORIZATION');

      // 4. Attempt to claim job when queued (simulate worker claim)
      await client.processingJob.update({
        where: { id: jobA.id },
        data: { status: 'QUEUED' },
      });

      const claimResult = await resumeRepository.claimNextProcessingJob(
        'worker-instance-legacy',
        5,
      );
      // Because legacy null consent does not match candidateJob.requisition_id, claim should gate and transition to HELD_FOR_AUTHORIZATION
      expect(claimResult).toBeNull();

      const jobAfterClaim = await client.processingJob.findUnique({
        where: { id: jobA.id },
      });
      expect(jobAfterClaim?.status).toBe('HELD_FOR_AUTHORIZATION');
    } finally {
      await fixture.cleanup();
    }
  });

  it('scopes withdrawal strictly to the exact consent: holds Req A, preserves Req B eligibility, fences Req A worker, keeps Req B authorization intact', async () => {
    const fixture = await createFixture();
    try {
      // 1. Create Active Consent for Requisition A
      const consentA = await client.candidateConsent.create({
        data: {
          candidateId: fixture.candidateId,
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          captureMethod: 'CANDIDATE_PORTAL',
          capturedAt: new Date(),
        },
      });

      // 2. Create Active Consent for Requisition B
      const consentB = await client.candidateConsent.create({
        data: {
          candidateId: fixture.candidateId,
          organizationId: fixture.orgId,
          requisitionId: fixture.reqBId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          captureMethod: 'CANDIDATE_PORTAL',
          capturedAt: new Date(),
        },
      });

      // 3. Create Queued Job and In-Flight Processing Job for Requisition A
      const batchA = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          totalFiles: 2,
          status: 'PROCESSING',
        },
      });

      const resumeA1 = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-a1.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 1,
          parseStatus: 'PENDING',
          uploadedById: fixture.userId,
        },
      });

      const queuedJobA = await client.processingJob.create({
        data: {
          batchId: batchA.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeA1.id,
          jobType: 'EXTRACT_TEXT',
          status: 'QUEUED',
          attempts: 0,
        },
      });

      const resumeA2 = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-a2.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 2,
          parseStatus: 'PROCESSING',
          uploadedById: fixture.userId,
        },
      });

      const leaseTokenA = randomUUID();
      const inFlightJobA = await client.processingJob.create({
        data: {
          batchId: batchA.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeA2.id,
          jobType: 'EXTRACT_TEXT',
          status: 'PROCESSING',
          attempts: 1,
          lockedBy: 'worker-instance-a',
          leaseToken: leaseTokenA,
          leaseExpiresAt: new Date(Date.now() + 600000),
        },
      });

      // 4. Create Queued Job and In-Flight Processing Job for Requisition B
      const batchB = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqBId,
          createdById: fixture.userId,
          totalFiles: 2,
          status: 'PROCESSING',
        },
      });

      const resumeB1 = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-b1.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 3,
          parseStatus: 'PENDING',
          uploadedById: fixture.userId,
        },
      });

      const queuedJobB = await client.processingJob.create({
        data: {
          batchId: batchB.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeB1.id,
          jobType: 'EXTRACT_TEXT',
          status: 'QUEUED',
          attempts: 0,
        },
      });

      const resumeB2 = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey: `private/${fixture.orgId}/test-b2.pdf`,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(1024),
          version: 4,
          parseStatus: 'PROCESSING',
          uploadedById: fixture.userId,
        },
      });

      const leaseTokenB = randomUUID();
      const inFlightJobB = await client.processingJob.create({
        data: {
          batchId: batchB.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resumeB2.id,
          jobType: 'EXTRACT_TEXT',
          status: 'PROCESSING',
          attempts: 1,
          lockedBy: 'worker-instance-b',
          leaseToken: leaseTokenB,
          leaseExpiresAt: new Date(Date.now() + 600000),
        },
      });

      // 5. Candidate initiates and confirms withdrawal specifically for Consent A (Requisition A)
      const rawWithdrawTokenA = randomBytes(32).toString('hex');
      const withdrawTokenHashA = hashToken(rawWithdrawTokenA);

      await repository.createWithdrawalRequest({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        consentId: consentA.id,
        tokenHash: withdrawTokenHashA,
        email: 'candidate@example.com',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const confirmResult = await repository.confirmWithdrawal(withdrawTokenHashA);
      expect(confirmResult?.status).toBe('WITHDRAWN');
      // Exactly 2 jobs from Requisition A (1 queued + 1 in-flight) were transitioned to HELD_FOR_AUTHORIZATION
      expect(confirmResult?.heldJobCount).toBe(2);

      // Verify Consent A is WITHDRAWN
      const updatedConsentA = await client.candidateConsent.findUnique({
        where: { id: consentA.id },
      });
      expect(updatedConsentA?.status).toBe('WITHDRAWN');
      expect(updatedConsentA?.withdrawnAt).not.toBeNull();

      // Verify Consent B is STILL ACTIVE and unmodified
      const updatedConsentB = await client.candidateConsent.findUnique({
        where: { id: consentB.id },
      });
      expect(updatedConsentB?.status).toBe('ACTIVE');
      expect(updatedConsentB?.withdrawnAt).toBeNull();

      // Verify Requisition A jobs are now HELD_FOR_AUTHORIZATION with worker leases wiped
      const updatedQueuedJobA = await client.processingJob.findUnique({
        where: { id: queuedJobA.id },
      });
      expect(updatedQueuedJobA?.status).toBe('HELD_FOR_AUTHORIZATION');

      const updatedInFlightJobA = await client.processingJob.findUnique({
        where: { id: inFlightJobA.id },
      });
      expect(updatedInFlightJobA?.status).toBe('HELD_FOR_AUTHORIZATION');
      expect(updatedInFlightJobA?.leaseToken).toBeNull();
      expect(updatedInFlightJobA?.lockedBy).toBeNull();
      expect(updatedInFlightJobA?.leaseExpiresAt).toBeNull();

      // Verify Worker A cannot complete Job A after withdrawal (fenced out by lease wipe and missing consent)
      const workerACompletion = await resumeRepository.completeProcessingJob(
        inFlightJobA.id,
        resumeA2.id,
        fixture.orgId,
        {
          extractedText: 'Extracted text from resume A2',
          pageMapJson: {},
          parser: 'pdf-parser',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        },
        leaseTokenA,
      );
      expect(workerACompletion).toBe(false);

      // Verify Requisition B jobs remain unaffected:
      // Queued Job B remains QUEUED
      const updatedQueuedJobB = await client.processingJob.findUnique({
        where: { id: queuedJobB.id },
      });
      expect(updatedQueuedJobB?.status).toBe('QUEUED');

      // In-flight Job B remains PROCESSING with its lease intact
      const updatedInFlightJobB = await client.processingJob.findUnique({
        where: { id: inFlightJobB.id },
      });
      expect(updatedInFlightJobB?.status).toBe('PROCESSING');
      expect(updatedInFlightJobB?.leaseToken).toBe(leaseTokenB);

      // Verify Worker B CAN complete Job B because Consent B remains valid and intact
      const workerBCompletion = await resumeRepository.completeProcessingJob(
        inFlightJobB.id,
        resumeB2.id,
        fixture.orgId,
        {
          extractedText: 'Extracted text from resume B2',
          pageMapJson: {},
          parser: 'pdf-parser',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        },
        leaseTokenB,
      );
      expect(workerBCompletion).toBe(true);

      const finalJobB = await client.processingJob.findUnique({
        where: { id: inFlightJobB.id },
      });
      expect(finalJobB?.status).toBe('SUCCEEDED');
    } finally {
      await fixture.cleanup();
    }
  });

  it('prevents duplicate active consent for the same scope and ensures withdrawal leaves zero active consents for that requisition', async () => {
    const fixture = await createFixture();
    try {
      // 1. Candidate accepts Invitation 1 for Requisition A
      const rawTokenA1 = randomBytes(32).toString('hex');
      const tokenHashA1 = hashToken(rawTokenA1);
      await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqAId,
        createdById: fixture.userId,
        tokenHash: tokenHashA1,
        email: 'jane@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-a1',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const acceptA1 = await repository.acceptInvitation(tokenHashA1, 'Jane Candidate');
      expect(acceptA1?.status).toBe('ACCEPTED');
      expect(acceptA1?.consentId).toBeDefined();

      const consentA1 = await client.candidateConsent.findUnique({
        where: { id: acceptA1!.consentId! },
      });
      expect(consentA1?.status).toBe('ACTIVE');

      // 2. Repeated invitation for the same candidate and Requisition A is accepted
      const rawTokenA2 = randomBytes(32).toString('hex');
      const tokenHashA2 = hashToken(rawTokenA2);
      await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqAId,
        createdById: fixture.userId,
        tokenHash: tokenHashA2,
        email: 'jane@example.com',
        policyVersion: '2026-11-v2',
        noticeTextHash: 'hash-notice-a2',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const acceptA2 = await repository.acceptInvitation(tokenHashA2, 'Jane Candidate Updated');
      expect(acceptA2?.status).toBe('ACCEPTED');
      expect(acceptA2?.consentId).toBeDefined();

      // Verify that prior active consent A1 was retired/expired
      const updatedConsentA1 = await client.candidateConsent.findUnique({
        where: { id: acceptA1!.consentId! },
      });
      expect(updatedConsentA1?.status).toBe('EXPIRED');

      // Verify that consent A2 is the new active consent
      const consentA2 = await client.candidateConsent.findUnique({
        where: { id: acceptA2!.consentId! },
      });
      expect(consentA2?.status).toBe('ACTIVE');
      expect(consentA2?.policyVersion).toBe('2026-11-v2');

      // Exactly ONE active consent exists for Requisition A
      const activeConsentsA = await client.candidateConsent.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          status: 'ACTIVE',
        },
      });
      expect(activeConsentsA).toHaveLength(1);
      expect(activeConsentsA[0]?.id).toBe(consentA2?.id);

      // 3. Create independent ACTIVE consent for Requisition B
      const rawTokenB = randomBytes(32).toString('hex');
      const tokenHashB = hashToken(rawTokenB);
      await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqBId,
        createdById: fixture.userId,
        tokenHash: tokenHashB,
        email: 'jane@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-b',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const acceptB = await repository.acceptInvitation(tokenHashB, 'Jane Candidate');
      expect(acceptB?.status).toBe('ACCEPTED');

      const consentB = await client.candidateConsent.findUnique({
        where: { id: acceptB!.consentId! },
      });
      expect(consentB?.status).toBe('ACTIVE');

      // 4. Proves PostgreSQL partial unique index prevents inserting duplicate ACTIVE consent
      let duplicateInsertFailed = false;
      try {
        await client.candidateConsent.create({
          data: {
            organizationId: fixture.orgId,
            candidateId: fixture.candidateId,
            requisitionId: fixture.reqAId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            policyVersion: '2026-11-v1',
            noticeTextHash: 'hash-notice-legacy',
            confirmationName: 'Jane Duplicate',
            captureMethod: 'IMPORTED',
            capturedAt: new Date(),
          },
        });
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          duplicateInsertFailed = true;
        }
      }
      expect(duplicateInsertFailed).toBe(true);

      // Confirm there is still strictly 1 active row for Req A
      const singleActiveA = await client.candidateConsent.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          status: 'ACTIVE',
        },
      });
      expect(singleActiveA).toHaveLength(1);

      // 5. Candidate initiates withdrawal for Requisition A
      const rawWithdrawToken = randomBytes(32).toString('hex');
      const withdrawHash = hashToken(rawWithdrawToken);
      await repository.createWithdrawalRequest({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        consentId: consentA2!.id,
        tokenHash: withdrawHash,
        email: 'jane@example.com',
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Confirm withdrawal
      const confirmResult = await repository.confirmWithdrawal(withdrawHash);
      expect(confirmResult?.status).toBe('WITHDRAWN');
      expect(confirmResult?.candidateId).toBe(fixture.candidateId);

      // 6. Proves: Withdrawal for Requisition A marked all active consents for Req A as WITHDRAWN
      const remainingActiveA = await client.candidateConsent.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          status: 'ACTIVE',
        },
      });
      expect(remainingActiveA).toHaveLength(0); // ZERO active consents remain for Req A!

      const recheckedA2 = await client.candidateConsent.findUnique({
        where: { id: consentA2!.id },
      });
      expect(recheckedA2?.status).toBe('WITHDRAWN');
      expect(recheckedA2?.withdrawnAt).not.toBeNull();

      // 7. Proves: Independent active consent for Requisition B remains completely intact and ACTIVE
      const recheckedB = await client.candidateConsent.findUnique({
        where: { id: consentB!.id },
      });
      expect(recheckedB?.status).toBe('ACTIVE');
      expect(recheckedB?.withdrawnAt).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('concurrency: simultaneous acceptance of competing invitations establishes exactly one active consent, transitions the other to a terminal state, and preserves other requisitions', async () => {
    const fixture = await createFixture();
    try {
      // 1. Establish an independent active consent for Requisition B
      const rawTokenB = randomBytes(32).toString('hex');
      const tokenHashB = hashToken(rawTokenB);
      await repository.createInvitation({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        requisitionId: fixture.reqBId,
        createdById: fixture.userId,
        tokenHash: tokenHashB,
        email: 'jane@example.com',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-notice-b',
        expiresAt: new Date(Date.now() + 86400000),
      });
      const acceptB = await repository.acceptInvitation(tokenHashB, 'Jane Candidate');
      expect(acceptB?.status).toBe('ACCEPTED');

      // 2. Create TWO separate pending invitations for the same candidate and Requisition A
      // (Directly inserted into PostgreSQL to simulate concurrent creation)
      const rawTokenA1 = randomBytes(32).toString('hex');
      const tokenHashA1 = hashToken(rawTokenA1);
      const rawTokenA2 = randomBytes(32).toString('hex');
      const tokenHashA2 = hashToken(rawTokenA2);

      const invA1 = await client.consentInvitation.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          tokenHash: tokenHashA1,
          email: 'jane@example.com',
          purpose: 'HIRING_USE',
          status: 'PENDING',
          policyVersion: '2026-11-v1',
          noticeTextHash: 'hash-notice-a1',
          deliveryStatus: 'SENT',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const invA2 = await client.consentInvitation.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          tokenHash: tokenHashA2,
          email: 'jane@example.com',
          purpose: 'HIRING_USE',
          status: 'PENDING',
          policyVersion: '2026-11-v1',
          noticeTextHash: 'hash-notice-a2',
          deliveryStatus: 'SENT',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      // 3. Race two simultaneous acceptance requests concurrently
      await Promise.all([
        repository.acceptInvitation(tokenHashA1, 'Jane Candidate A1'),
        repository.acceptInvitation(tokenHashA2, 'Jane Candidate A2'),
      ]);

      // 4. Verify exactly ONE active consent remains for Requisition A in PostgreSQL
      const activeConsentsA = await client.candidateConsent.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          status: 'ACTIVE',
        },
      });
      expect(activeConsentsA).toHaveLength(1);

      // 5. Verify the other consent/invitation reached a consistent terminal state (EXPIRED or SUPERSEDED)
      const allConsentsA = await client.candidateConsent.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
        },
      });

      const nonActiveConsents = allConsentsA.filter(
        (c: { status: string }) => c.status !== 'ACTIVE',
      );
      for (const nonActive of nonActiveConsents) {
        expect(['EXPIRED', 'WITHDRAWN', 'DELETED']).toContain(nonActive.status);
      }

      const updatedInv1 = await client.consentInvitation.findUnique({ where: { id: invA1.id } });
      const updatedInv2 = await client.consentInvitation.findUnique({ where: { id: invA2.id } });
      expect(['ACCEPTED', 'SUPERSEDED']).toContain(updatedInv1?.status);
      expect(['ACCEPTED', 'SUPERSEDED']).toContain(updatedInv2?.status);

      // 6. Verify independent Requisition B consent is completely unaffected and remains ACTIVE
      const activeConsentB = await client.candidateConsent.findUnique({
        where: { id: acceptB!.consentId! },
      });
      expect(activeConsentB?.status).toBe('ACTIVE');
      expect(activeConsentB?.withdrawnAt).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('deletion verification: locates candidates across non-active consents and CandidateIdentity, deduplicates per org/candidate, stores zero plaintext email, and coalesces concurrent requests', async () => {
    const fixture = await createFixture();
    try {
      const targetEmail = `erase-${randomUUID().slice(0, 8)}@example.com`;
      const secondCandId = randomUUID();

      await client.candidate.create({
        data: {
          id: secondCandId,
          organizationId: fixture.orgId,
          candidateCode: `CAN-${randomUUID().slice(0, 8).toUpperCase()}`,
          recordStatus: 'ACTIVE',
        },
      });

      // Candidate 1 has DECLINED invitation on Req A and EXPIRED invitation on Req B (0 active consents)
      await client.consentInvitation.createMany({
        data: [
          {
            organizationId: fixture.orgId,
            candidateId: fixture.candidateId,
            requisitionId: fixture.reqAId,
            createdById: fixture.userId,
            tokenHash: hashToken(randomBytes(32).toString('hex')),
            email: targetEmail,
            purpose: 'HIRING_USE',
            status: 'DECLINED',
            policyVersion: '2026-11-v1',
            noticeTextHash: 'hash-a',
            deliveryStatus: 'SENT',
            expiresAt: new Date(Date.now() + 86400000),
          },
          {
            organizationId: fixture.orgId,
            candidateId: fixture.candidateId,
            requisitionId: fixture.reqBId,
            createdById: fixture.userId,
            tokenHash: hashToken(randomBytes(32).toString('hex')),
            email: targetEmail,
            purpose: 'HIRING_USE',
            status: 'EXPIRED',
            policyVersion: '2026-11-v1',
            noticeTextHash: 'hash-b',
            deliveryStatus: 'SENT',
            expiresAt: new Date(Date.now() - 86400000),
          },
        ],
      });

      // Candidate 2 has NO invitations at all, ONLY CandidateIdentity with HMAC fingerprint
      await client.candidateIdentity.create({
        data: {
          candidateId: secondCandId,
          organizationId: fixture.orgId,
          contactFingerprint: computeContactFingerprint(targetEmail),
          identityStatus: 'ACTIVE',
        },
      });

      const matches = await repository.findCandidatesForDeletionByEmail(targetEmail.toUpperCase());
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.candidateId).sort()).toEqual(
        [fixture.candidateId, secondCandId].sort(),
      );

      // Verify schema guarantees zero plaintext email column on candidate_deletion_verifications
      const columns = await client.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'candidate_deletion_verifications'
      `);
      expect(columns.map((c: { column_name: string }) => c.column_name)).not.toContain('email');

      // Concurrent duplicate requests for Candidate 1 coalesce to a single PENDING verification & single outbox row
      const tokenHash1 = hashToken(randomBytes(32).toString('hex'));
      const tokenHash2 = hashToken(randomBytes(32).toString('hex'));
      const [ver1, ver2] = await Promise.all([
        repository.createDeletionVerification({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          tokenHash: tokenHash1,
          email: targetEmail,
          expiresAt: new Date(Date.now() + 86400000),
          emailPayload: {
            subject: 'Confirm deletion 1',
            html: '<p>Delete 1</p>',
            text: 'Delete 1',
            idempotencyKey: `del-ver-${fixture.candidateId}-1`,
          },
        }),
        repository.createDeletionVerification({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          tokenHash: tokenHash2,
          email: targetEmail,
          expiresAt: new Date(Date.now() + 86400000),
          emailPayload: {
            subject: 'Confirm deletion 2',
            html: '<p>Delete 2</p>',
            text: 'Delete 2',
            idempotencyKey: `del-ver-${fixture.candidateId}-2`,
          },
        }),
      ]);

      expect(ver1).not.toBeNull();
      expect(ver2).not.toBeNull();
      const coalescedCount = [ver1!.coalesced, ver2!.coalesced].filter(Boolean).length;
      expect(coalescedCount).toBe(1);

      const pendingVerifications = await client.candidateDeletionVerification.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          status: 'PENDING',
        },
      });
      expect(pendingVerifications).toHaveLength(1);

      const outboxRows = await client.emailOutbox.findMany({
        where: { organizationId: fixture.orgId, messageType: 'candidate_deletion_verification' },
      });
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.recipientEmail).toBeNull();
      expect(outboxRows[0]?.payloadJson).toEqual({ candidateId: fixture.candidateId });

      // Outside coalesce window, issuing a new verification supersedes prior PENDING row without violating partial unique index
      const tokenHash3 = hashToken(randomBytes(32).toString('hex'));
      const ver3 = await repository.createDeletionVerification({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        tokenHash: tokenHash3,
        email: targetEmail,
        expiresAt: new Date(Date.now() + 86400000),
        coalesceWindowMs: 0,
      });
      expect(ver3?.coalesced).toBe(false);

      const cancelledRows = await client.candidateDeletionVerification.findMany({
        where: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          status: 'CANCELLED',
        },
      });
      expect(cancelledRows).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('confirmCandidateDeletion enforces single-use token consumption, rejects replays, detaches processing jobs, and cascades full PostgreSQL erasure', async () => {
    const fixture = await createFixture();
    try {
      const targetEmail = `cascade-${randomUUID().slice(0, 8)}@example.com`;
      const objectKey = `private/${fixture.orgId}/cascade-cv.pdf`;

      await client.candidateIdentity.create({
        data: {
          candidateId: fixture.candidateId,
          organizationId: fixture.orgId,
          fullNameEncrypted: 'enc-name',
          emailEncrypted: 'enc-email',
          phoneEncrypted: 'enc-phone',
          contactFingerprint: computeContactFingerprint(targetEmail),
          identityStatus: 'ACTIVE',
        },
      });

      const consent = await client.candidateConsent.create({
        data: {
          candidateId: fixture.candidateId,
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          policyVersion: '2026-11-v1',
          captureMethod: 'CANDIDATE_PORTAL',
          capturedAt: new Date(),
        },
      });

      await client.consentInvitation.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          tokenHash: hashToken(randomBytes(32).toString('hex')),
          email: targetEmail,
          purpose: 'HIRING_USE',
          status: 'ACCEPTED',
          policyVersion: '2026-11-v1',
          noticeTextHash: 'hash-cascade',
          deliveryStatus: 'SENT',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const batch = await client.processingBatch.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          createdById: fixture.userId,
          totalFiles: 1,
          status: 'PROCESSING',
        },
      });

      const resume = await client.resumeDocument.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          objectKey,
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sha256: randomBytes(32).toString('hex'),
          sizeBytes: BigInt(2048),
          version: 1,
          parseStatus: 'PARSED',
          uploadedById: fixture.userId,
        },
      });

      const job = await client.processingJob.create({
        data: {
          batchId: batch.id,
          organizationId: fixture.orgId,
          resumeDocumentId: resume.id,
          jobType: 'ASSESS_CANDIDATE',
          status: 'QUEUED',
          attempts: 0,
        },
      });

      const extraction = await client.documentExtraction.create({
        data: {
          organizationId: fixture.orgId,
          resumeDocumentId: resume.id,
          version: 1,
          extractedText: 'Senior Engineer with 10 years TypeScript',
          pageMapJson: { page1: { startOffset: 0, endOffset: 40 } },
          parser: 'pdf-parser',
          ocrUsed: false,
          qualityStatus: 'COMPLETE',
        },
      });

      const assessmentText = await client.assessmentText.create({
        data: {
          organizationId: fixture.orgId,
          documentExtractionId: extraction.id,
          resumeDocumentId: resume.id,
          version: 1,
          redactedText: '[CANDIDATE] Senior Engineer with 10 years TypeScript',
          pageMapJson: { page1: { startOffset: 0, endOffset: 52 } },
          redactionMapJson: {},
          redactorVersion: 'v1',
        },
      });

      const scorecardVersion = await client.scorecardVersion.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          version: 1,
          status: 'APPROVED',
          weightsJson: { ts: 1 },
          approvedById: fixture.userId,
          approvedAt: new Date(),
        },
      });

      const criterion = await client.scorecardCriterion.create({
        data: {
          scorecardVersionId: scorecardVersion.id,
          key: 'ts',
          label: 'TypeScript',
          category: 'SKILL',
          requirementType: 'MUST_HAVE',
          weight: '1.0000',
          ruleJson: {},
          active: true,
          displayOrder: 1,
        },
      });

      const assessment = await client.candidateAssessment.create({
        data: {
          organizationId: fixture.orgId,
          requisitionId: fixture.reqAId,
          candidateId: fixture.candidateId,
          resumeDocumentId: resume.id,
          documentExtractionId: extraction.id,
          scorecardVersionId: scorecardVersion.id,
          assessmentTextId: assessmentText.id,
          score: '88.00',
          coverage: '100.00',
          status: 'COMPLETE',
          formulaVersion: 'v1',
          modelMetadataJson: {},
        },
      });

      const critAssessment = await client.criterionAssessment.create({
        data: {
          organizationId: fixture.orgId,
          assessmentId: assessment.id,
          criterionId: criterion.id,
          scorecardVersionId: scorecardVersion.id,
          resumeDocumentId: resume.id,
          assessmentTextId: assessmentText.id,
          documentExtractionId: extraction.id,
          status: 'MATCH',
          normalizedValue: '1.0000',
          explanation: 'Meets requirement',
        },
      });

      await client.evidenceSnippet.create({
        data: {
          organizationId: fixture.orgId,
          criterionAssessmentId: critAssessment.id,
          assessmentId: assessment.id,
          scorecardVersionId: scorecardVersion.id,
          assessmentTextId: assessmentText.id,
          resumeDocumentId: resume.id,
          documentExtractionId: extraction.id,
          quote: '10 years TypeScript',
          pageNumber: 1,
          startOffset: 24,
          endOffset: 43,
          verified: true,
        },
      });

      const profile = await client.candidateProfile.create({
        data: {
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          currentRole: 'Engineer',
          profileVersion: 1,
        },
      });

      await client.candidateSkill.create({
        data: {
          organizationId: fixture.orgId,
          candidateProfileId: profile.id,
          skillNameNormalized: 'typescript',
        },
      });

      // Seed a pending candidate-linked EmailOutbox row to prove cancellation + redaction
      const pendingEmail = await client.emailOutbox.create({
        data: {
          organizationId: fixture.orgId,
          idempotencyKey: `cand-email-${fixture.candidateId}`,
          messageType: 'consent_invitation',
          recipientEmail: null,
          recipientRole: 'CANDIDATE',
          payloadJson: { candidateId: fixture.candidateId },
          encryptedPayload: 'v1:v1:iv:tag:cipher',
          keyId: 'v1',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      await repository.createDeletionVerification({
        organizationId: fixture.orgId,
        candidateId: fixture.candidateId,
        tokenHash,
        email: targetEmail,
        expiresAt: new Date(Date.now() + 86400000),
      });

      const deletedObjectKeys: string[] = [];
      const confirmResult = await repository.confirmCandidateDeletion(tokenHash, async (key) => {
        deletedObjectKeys.push(key);
      });

      expect(confirmResult?.status).toBe('COMPLETED');
      expect(confirmResult?.candidateId).toBe(fixture.candidateId);
      expect(deletedObjectKeys).toEqual([objectKey]);

      // Replay must be rejected cleanly (single-use)
      const replayResult = await repository.confirmCandidateDeletion(tokenHash, async () => {});
      expect(replayResult).toBeNull();

      // Verify full cascading deletion & redaction in PostgreSQL
      const candRow = await client.candidate.findUnique({ where: { id: fixture.candidateId } });
      expect(candRow?.recordStatus).toBe('DELETED');

      const identRow = await client.candidateIdentity.findUnique({
        where: { candidateId: fixture.candidateId },
      });
      expect(identRow?.identityStatus).toBe('REDACTED');
      expect(identRow?.fullNameEncrypted).toBeNull();
      expect(identRow?.emailEncrypted).toBeNull();
      expect(identRow?.phoneEncrypted).toBeNull();
      expect(identRow?.contactFingerprint).toBeNull();

      const updatedJob = await client.processingJob.findUnique({ where: { id: job.id } });
      expect(updatedJob?.status).toBe('FAILED');
      expect(updatedJob?.lastErrorCode).toBe('CANDIDATE_DATA_DELETED');
      expect(updatedJob?.resumeDocumentId).toBeNull();

      const updatedEmail = await client.emailOutbox.findUnique({ where: { id: pendingEmail.id } });
      expect(updatedEmail?.status).toBe('FAILED');
      expect(updatedEmail?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
      expect(updatedEmail?.encryptedPayload).toBeNull();

      expect(
        await client.resumeDocument.count({ where: { candidateId: fixture.candidateId } }),
      ).toBe(0);
      expect(
        await client.documentExtraction.count({ where: { organizationId: fixture.orgId } }),
      ).toBe(0);
      expect(
        await client.candidateAssessment.count({ where: { candidateId: fixture.candidateId } }),
      ).toBe(0);
      expect(await client.evidenceSnippet.count({ where: { organizationId: fixture.orgId } })).toBe(
        0,
      );
      expect(
        await client.candidateDeletionVerification.count({
          where: { candidateId: fixture.candidateId },
        }),
      ).toBe(0);
      expect(await client.candidateConsent.count({ where: { id: consent.id } })).toBe(0);
      expect(
        await client.consentInvitation.count({ where: { candidateId: fixture.candidateId } }),
      ).toBe(0);
      expect(
        await client.candidateProfile.count({ where: { candidateId: fixture.candidateId } }),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  describe('P1-02: Complete candidate email-outbox erasure across all states & races', () => {
    async function seedEncryptedOutboxRow(params: {
      organizationId: string | null;
      candidateId?: string | undefined;
      idempotencyKey?: string | undefined;
      messageType?: string | undefined;
      recipientRole?: string | undefined;
      email: string;
      subject: string;
      status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'PERMANENTLY_REJECTED';
      lastError?: string | null | undefined;
      lastErrorCode?: string | null | undefined;
      payloadJson?: Record<string, unknown> | null | undefined;
      attempts?: number | undefined;
      leaseToken?: string | null | undefined;
      leaseExpiresAt?: Date | null | undefined;
      lockedBy?: string | null | undefined;
      sentAt?: Date | null | undefined;
      withEncryptedPayload?: boolean | undefined;
      plaintextColumns?: boolean | undefined;
    }): Promise<string> {
      const id = randomUUID();
      const idemKey =
        params.idempotencyKey ??
        `p1-02-${params.messageType ?? 'consent_invitation'}-${randomUUID()}`;
      const withEnc = params.withEncryptedPayload ?? params.status !== 'SENT';
      const encrypted = withEnc
        ? encryptEmailPayload(
            {
              recipientEmail: params.email,
              subject: params.subject,
              html: `<p>${params.subject} for ${params.email}</p>`,
              text: `${params.subject} for ${params.email}`,
              metadata:
                params.payloadJson ??
                (params.candidateId ? { candidateId: params.candidateId } : undefined),
            },
            { recordId: id, idempotencyKey: idemKey },
          )
        : { encryptedPayload: null, keyId: null };

      await client.emailOutbox.create({
        data: {
          id,
          organizationId: params.organizationId,
          idempotencyKey: idemKey,
          messageType: params.messageType ?? 'consent_invitation',
          recipientEmail: params.plaintextColumns ? params.email : null,
          recipientRole: params.recipientRole ?? 'CANDIDATE',
          subject: params.plaintextColumns ? params.subject : null,
          html: params.plaintextColumns ? `<p>${params.email}</p>` : null,
          text: params.plaintextColumns ? params.email : null,
          payloadJson:
            params.payloadJson !== undefined
              ? params.payloadJson === null
                ? Prisma.DbNull
                : (params.payloadJson as Prisma.InputJsonValue)
              : params.candidateId
                ? { candidateId: params.candidateId }
                : Prisma.DbNull,
          encryptedPayload: encrypted.encryptedPayload,
          keyId: encrypted.keyId ?? (params.status === 'SENT' ? 'v1' : null),
          status: params.status,
          attempts: params.attempts ?? (params.status === 'PENDING' ? 0 : 1),
          maxAttempts: 3,
          leaseToken: params.leaseToken ?? null,
          leaseExpiresAt: params.leaseExpiresAt ?? null,
          lockedBy: params.lockedBy ?? null,
          lastError: params.lastError ?? null,
          lastErrorCode: params.lastErrorCode ?? null,
          sentAt: params.sentAt ?? null,
        },
      });
      return id;
    }

    function assertIrrecoverablyErased(
      row: {
        id: string;
        idempotencyKey: string;
        encryptedPayload: string | null;
        keyId: string | null;
        recipientEmail: string | null;
        subject: string | null;
        html: string | null;
        text: string | null;
        payloadJson: unknown;
        lastError: string | null;
        leaseToken: string | null;
        leaseExpiresAt: Date | null;
        lockedBy: string | null;
        nextAttemptAt: Date | null;
      } | null,
      secrets: string[],
      allowedPayloadKeys: string[],
    ): void {
      expect(row).not.toBeNull();
      const r = row!;
      expect(r.encryptedPayload).toBeNull();
      expect(r.keyId).toBeNull();
      expect(r.recipientEmail).toBeNull();
      expect(r.subject).toBeNull();
      expect(r.html).toBeNull();
      expect(r.text).toBeNull();
      expect(r.leaseToken).toBeNull();
      expect(r.leaseExpiresAt).toBeNull();
      expect(r.lockedBy).toBeNull();
      expect(r.nextAttemptAt).toBeNull();
      expect(r.idempotencyKey).toBe(`erased:${r.id}`);

      expect(r.payloadJson).toBeTruthy();
      expect(typeof r.payloadJson).toBe('object');
      const pj = r.payloadJson as Record<string, unknown>;
      expect(pj['erased']).toBe(true);
      expect(typeof pj['erasedAt']).toBe('string');
      expect(Object.keys(pj).sort()).toEqual([...allowedPayloadKeys].sort());

      const serialized = JSON.stringify(r);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }

    it('erases PENDING, SENDING, SENT, FAILED, PERMANENTLY_REJECTED, and CANCELLED rows while preserving unrelated messages', async () => {
      const fixture = await createFixture();
      const secondOrgId = randomUUID();
      const otherCandId = randomUUID();
      const org2CandId = randomUUID();
      const secretEmail = `erase.all.${randomUUID().slice(0, 8)}@candidate-privacy.example`;
      const otherEmail = `keep.other.${randomUUID().slice(0, 8)}@candidate-privacy.example`;
      const orgAdminEmail = `recruiter.keep.${randomUUID().slice(0, 8)}@acme.example`;
      const createdExtraOutboxIds: string[] = [];

      try {
        await client.candidate.create({
          data: {
            id: otherCandId,
            organizationId: fixture.orgId,
            candidateCode: `CAN-KEEP-${randomUUID().slice(0, 6).toUpperCase()}`,
            recordStatus: 'ACTIVE',
          },
        });
        await client.organization.create({
          data: {
            id: secondOrgId,
            name: `Other Org ${secondOrgId.slice(0, 6)}`,
            normalizedName: `other-org-${secondOrgId.slice(0, 8)}`,
          },
        });
        await client.candidate.create({
          data: {
            id: org2CandId,
            organizationId: secondOrgId,
            candidateCode: `CAN-ORG2-${randomUUID().slice(0, 6).toUpperCase()}`,
            recordStatus: 'ACTIVE',
          },
        });

        // Seed all 6 lifecycle states & multiple message types for target candidate
        const pendingId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'consent_invitation',
          email: secretEmail,
          subject: `Pending Invite ${secretEmail}`,
          status: 'PENDING',
          payloadJson: { candidateId: fixture.candidateId, requisitionId: fixture.reqAId },
        });
        const sendingId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'client_submission',
          recipientRole: 'CLIENT_HIRING_MANAGER',
          email: secretEmail,
          subject: `Submission Notice ${secretEmail}`,
          status: 'SENDING',
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          lockedBy: 'worker-in-flight',
          payloadJson: { candidateId: fixture.candidateId },
        });
        const sentWithMsgId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'withdrawal_verification',
          email: secretEmail,
          subject: 'Sent Verification',
          status: 'SENT',
          sentAt: new Date('2026-11-08T10:00:00Z'),
          attempts: 1,
          withEncryptedPayload: false,
          payloadJson: {
            candidateId: fixture.candidateId,
            consentId: randomUUID(),
            messageId: 'smtp-queue-id-7788',
          },
        });
        const sentNoMsgId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'interview_notification',
          recipientRole: 'CLIENT_HIRING_MANAGER',
          email: secretEmail,
          subject: 'Sent Interview Notice',
          status: 'SENT',
          sentAt: new Date('2026-11-08T11:00:00Z'),
          attempts: 2,
          withEncryptedPayload: false,
          payloadJson: { candidateId: fixture.candidateId },
        });
        const failedExhaustedId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'consent_invitation',
          email: secretEmail,
          subject: `Failed Invite for ${secretEmail}`,
          status: 'FAILED',
          attempts: 3,
          lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
          lastError: `421 Deferred delivery to <${secretEmail}> failed after 3 attempts`,
          payloadJson: { candidateId: fixture.candidateId },
        });
        const permRejectedId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'candidate_deletion_verification',
          email: secretEmail,
          subject: `Rejected Deletion Link for ${secretEmail}`,
          status: 'PERMANENTLY_REJECTED',
          attempts: 1,
          lastErrorCode: 'PERMANENT_REJECTION',
          lastError: `550 5.1.1 <${secretEmail}>: Recipient address rejected`,
          payloadJson: { candidateId: fixture.candidateId },
        });
        // CANCELLED equivalent (status=FAILED + CANDIDATE_DELETION_PENDING) with lingering payload metadata / keyId / plaintext leaks
        const cancelledId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'client_feedback',
          recipientRole: 'RECRUITER',
          email: secretEmail,
          subject: `Pre-cancelled Email ${secretEmail}`,
          status: 'FAILED',
          lastErrorCode: 'CANDIDATE_DELETION_PENDING',
          lastError: 'Candidate deletion requested earlier',
          plaintextColumns: true,
          payloadJson: { candidateId: fixture.candidateId },
        });
        // Row matched via organizationId=NULL and idempotencyKey containing candidateId (defense in depth)
        const nullOrgId = await seedEncryptedOutboxRow({
          organizationId: null,
          idempotencyKey: `cand-legacy-${fixture.candidateId}-notif`,
          messageType: 'client_submission',
          email: secretEmail,
          subject: `Null Org Legacy ${secretEmail}`,
          status: 'PENDING',
          payloadJson: null,
        });
        createdExtraOutboxIds.push(nullOrgId);

        // Unrelated messages that MUST remain untouched & decryptable:
        // 1) Another candidate in same org
        const otherCandOutboxId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: otherCandId,
          messageType: 'consent_invitation',
          email: otherEmail,
          subject: 'Keep Same-Org Candidate Invite',
          status: 'PENDING',
          payloadJson: { candidateId: otherCandId },
        });
        // 2) Candidate in another org (same org separation)
        const org2CandOutboxId = await seedEncryptedOutboxRow({
          organizationId: secondOrgId,
          candidateId: org2CandId,
          messageType: 'consent_invitation',
          email: otherEmail,
          subject: 'Keep Other-Org Candidate Invite',
          status: 'FAILED',
          lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
          lastError: `421 Temp error for ${otherEmail}`,
          payloadJson: { candidateId: org2CandId },
        });
        createdExtraOutboxIds.push(org2CandOutboxId);
        // 3) Org-level recruiter activation email (no candidateId)
        const orgAdminOutboxId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          messageType: 'account_activation',
          recipientRole: 'RECRUITER',
          email: orgAdminEmail,
          subject: 'Activate Recruiter Account',
          status: 'PENDING',
          payloadJson: null,
        });

        // Execute candidate-initiated self-deletion (also verifies createDeletionRequest/processDeletion equivalence)
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);
        await repository.createDeletionVerification({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          tokenHash,
          email: secretEmail,
          expiresAt: new Date(Date.now() + 86400_000),
        });

        const delResult = await repository.confirmCandidateDeletion(tokenHash, async () => {});
        expect(delResult?.status).toBe('COMPLETED');

        const secrets = [secretEmail, fixture.candidateId, fixture.reqAId];
        const outboxStore = new PostgresEmailOutboxStore(client);

        // 1. PENDING -> cancelled + erased
        const rowPending = await client.emailOutbox.findUnique({ where: { id: pendingId } });
        expect(rowPending?.status).toBe('FAILED');
        expect(rowPending?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
        assertIrrecoverablyErased(rowPending, secrets, ['erased', 'erasedAt']);

        // 2. SENDING -> cancelled + lease cleared + erased
        const rowSending = await client.emailOutbox.findUnique({ where: { id: sendingId } });
        expect(rowSending?.status).toBe('FAILED');
        expect(rowSending?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
        assertIrrecoverablyErased(rowSending, secrets, ['erased', 'erasedAt']);

        // 3. SENT (with messageId & without messageId) -> keeps status='SENT', sentAt, attempts, messageId; erases candidateId & keyId
        const rowSentMsg = await client.emailOutbox.findUnique({ where: { id: sentWithMsgId } });
        expect(rowSentMsg?.status).toBe('SENT');
        expect(rowSentMsg?.sentAt?.toISOString()).toBe('2026-11-08T10:00:00.000Z');
        expect(rowSentMsg?.attempts).toBe(1);
        expect(rowSentMsg?.lastErrorCode).toBeNull();
        expect(rowSentMsg?.lastError).toBeNull();
        expect((rowSentMsg?.payloadJson as Record<string, unknown>)['messageId']).toBe(
          'smtp-queue-id-7788',
        );
        assertIrrecoverablyErased(rowSentMsg, secrets, ['erased', 'erasedAt', 'messageId']);

        const rowSentNoMsg = await client.emailOutbox.findUnique({ where: { id: sentNoMsgId } });
        expect(rowSentNoMsg?.status).toBe('SENT');
        expect(rowSentNoMsg?.attempts).toBe(2);
        assertIrrecoverablyErased(rowSentNoMsg, secrets, ['erased', 'erasedAt']);

        // 4. FAILED (MAX_ATTEMPTS_EXHAUSTED) -> preserves FAILED + code, scrubs SMTP error email & ciphertext
        const rowFailed = await client.emailOutbox.findUnique({ where: { id: failedExhaustedId } });
        expect(rowFailed?.status).toBe('FAILED');
        expect(rowFailed?.lastErrorCode).toBe('MAX_ATTEMPTS_EXHAUSTED');
        expect(rowFailed?.lastError).toBe(
          'Delivery error details redacted following candidate deletion',
        );
        assertIrrecoverablyErased(rowFailed, secrets, ['erased', 'erasedAt']);

        // 5. PERMANENTLY_REJECTED -> preserves status + code, scrubs SMTP 550 email & ciphertext
        const rowPerm = await client.emailOutbox.findUnique({ where: { id: permRejectedId } });
        expect(rowPerm?.status).toBe('PERMANENTLY_REJECTED');
        expect(rowPerm?.lastErrorCode).toBe('PERMANENT_REJECTION');
        expect(rowPerm?.lastError).toBe(
          'Delivery error details redacted following candidate deletion',
        );
        assertIrrecoverablyErased(rowPerm, secrets, ['erased', 'erasedAt']);

        // 6. CANCELLED (FAILED + CANDIDATE_DELETION_PENDING) -> fully scrubbed
        const rowCancelled = await client.emailOutbox.findUnique({ where: { id: cancelledId } });
        expect(rowCancelled?.status).toBe('FAILED');
        expect(rowCancelled?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
        assertIrrecoverablyErased(rowCancelled, secrets, ['erased', 'erasedAt']);

        // 7. organizationId=NULL & idempotency_key match -> cancelled + erased
        const rowNullOrg = await client.emailOutbox.findUnique({ where: { id: nullOrgId } });
        expect(rowNullOrg?.status).toBe('FAILED');
        expect(rowNullOrg?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
        assertIrrecoverablyErased(rowNullOrg, secrets, ['erased', 'erasedAt']);

        // 15. Verify outboxStore.getRecord cannot recover ANY deleted content
        for (const id of [
          pendingId,
          sendingId,
          sentWithMsgId,
          failedExhaustedId,
          permRejectedId,
          cancelledId,
        ]) {
          const rec = await outboxStore.getRecord(id);
          expect(rec).not.toBeNull();
          expect(rec?.recipientEmail).toBe('');
          expect(rec?.subject).toBe('');
          expect(rec?.html).toBe('');
          expect(rec?.text).toBe('');
        }

        // 12. Verify manualRetry & TransactionalEmailService.retryEmail & dispatchRecord refuse erased records
        for (const id of [pendingId, sendingId, failedExhaustedId, permRejectedId, cancelledId]) {
          expect(await outboxStore.markSending(id)).toBe(false);
          expect(await outboxStore.manualRetry(id)).toBeNull();
        }
        const provider = new InMemoryEmailProvider();
        const emailSvc = new TransactionalEmailService({
          provider,
          outboxStore,
          immediateDispatch: true,
        });
        expect((await emailSvc.retryEmail(failedExhaustedId)).delivered).toBe(false);
        expect((await emailSvc.dispatchRecord(pendingId)).delivered).toBe(false);
        expect(provider.sentMessages).toHaveLength(0);

        // 9. Idempotent repeat deletion (recruiter createDeletionRequest on DELETED candidate) preserves scrubbed tombstones
        const repeatReq = await repository.createDeletionRequest(
          fixture.orgId,
          fixture.candidateId,
          fixture.userId,
        );
        expect(repeatReq.status).toBe('COMPLETED');
        const recheckedFailed = await client.emailOutbox.findUnique({
          where: { id: failedExhaustedId },
        });
        assertIrrecoverablyErased(recheckedFailed, secrets, ['erased', 'erasedAt']);

        // 8. Verify unrelated messages remain completely intact and decryptable
        const keptSameOrg = await outboxStore.getRecord(otherCandOutboxId);
        expect(keptSameOrg?.status).toBe('PENDING');
        expect(keptSameOrg?.recipientEmail).toBe(otherEmail);
        expect(keptSameOrg?.subject).toBe('Keep Same-Org Candidate Invite');

        const keptOtherOrg = await outboxStore.getRecord(org2CandOutboxId);
        expect(keptOtherOrg?.status).toBe('FAILED');
        expect(keptOtherOrg?.recipientEmail).toBe(otherEmail);
        expect(keptOtherOrg?.lastError).toContain(otherEmail);

        const keptAdmin = await outboxStore.getRecord(orgAdminOutboxId);
        expect(keptAdmin?.status).toBe('PENDING');
        expect(keptAdmin?.recipientEmail).toBe(orgAdminEmail);
      } finally {
        if (createdExtraOutboxIds.length > 0) {
          await client.emailOutbox
            .deleteMany({ where: { id: { in: createdExtraOutboxIds } } })
            .catch(() => {});
        }
        await client.candidate.deleteMany({ where: { id: otherCandId } }).catch(() => {});
        await client.candidate.deleteMany({ where: { id: org2CandId } }).catch(() => {});
        await client.organization.deleteMany({ where: { id: secondOrgId } }).catch(() => {});
        await fixture.cleanup();
      }
    });

    it('recruiter createDeletionRequest and processDeletion erase terminal rows even if deletion is invoked via recruiter workflow', async () => {
      const fixture = await createFixture();
      const candEmail = `recruiter.del.${randomUUID().slice(0, 8)}@example.org`;
      try {
        const failedId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'consent_invitation',
          email: candEmail,
          subject: `Confidential ${candEmail}`,
          status: 'FAILED',
          attempts: 3,
          lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
          lastError: `SMTP 451 temp error for ${candEmail}`,
          payloadJson: { candidateId: fixture.candidateId },
        });
        const permId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'client_submission',
          email: candEmail,
          subject: `Rejected ${candEmail}`,
          status: 'PERMANENTLY_REJECTED',
          attempts: 1,
          lastErrorCode: 'PERMANENT_REJECTION',
          lastError: `550 unknown user ${candEmail}`,
          payloadJson: { candidateId: fixture.candidateId },
        });
        const sentId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'consent_invitation',
          email: candEmail,
          subject: 'Sent Invite',
          status: 'SENT',
          sentAt: new Date(),
          withEncryptedPayload: false,
          payloadJson: { candidateId: fixture.candidateId, messageId: 'm-rec-1' },
        });

        const delReq = await repository.createDeletionRequest(
          fixture.orgId,
          fixture.candidateId,
          fixture.userId,
        );
        expect(delReq.status).toBe('REQUESTED');

        const procRes = await repository.processDeletion(
          fixture.orgId,
          delReq.id,
          async () => {},
          fixture.userId,
        );
        expect(procRes.status).toBe('COMPLETED');

        // Re-running completed processDeletion is idempotent
        const procAgain = await repository.processDeletion(
          fixture.orgId,
          delReq.id,
          async () => {},
          fixture.userId,
        );
        expect(procAgain.status).toBe('COMPLETED');

        const fRow = await client.emailOutbox.findUnique({ where: { id: failedId } });
        const pRow = await client.emailOutbox.findUnique({ where: { id: permId } });
        const sRow = await client.emailOutbox.findUnique({ where: { id: sentId } });

        assertIrrecoverablyErased(fRow, [candEmail, fixture.candidateId], ['erased', 'erasedAt']);
        assertIrrecoverablyErased(pRow, [candEmail, fixture.candidateId], ['erased', 'erasedAt']);
        assertIrrecoverablyErased(
          sRow,
          [candEmail, fixture.candidateId],
          ['erased', 'erasedAt', 'messageId'],
        );
      } finally {
        await fixture.cleanup();
      }
    });

    it('transaction rollback leaves email_outbox records intact if deletion fails mid-transaction', async () => {
      const fixture = await createFixture();
      const candEmail = `rollback.${randomUUID().slice(0, 8)}@example.org`;
      try {
        const pendingId = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: fixture.candidateId,
          messageType: 'consent_invitation',
          email: candEmail,
          subject: `Rollback Test ${candEmail}`,
          status: 'PENDING',
          payloadJson: { candidateId: fixture.candidateId },
        });

        // Passing an invalid requestedById FK forces deletionRequest.create to fail inside createDeletionRequest's $transaction
        await expect(
          repository.createDeletionRequest(fixture.orgId, fixture.candidateId, randomUUID()),
        ).rejects.toThrow();

        const afterRollback = await client.emailOutbox.findUnique({ where: { id: pendingId } });
        expect(afterRollback?.status).toBe('PENDING');
        expect(afterRollback?.encryptedPayload).not.toBeNull();
        expect(afterRollback?.keyId).toBe('v1');
        expect((afterRollback?.payloadJson as Record<string, unknown>)['candidateId']).toBe(
          fixture.candidateId,
        );

        const outboxStore = new PostgresEmailOutboxStore(client);
        const decrypted = await outboxStore.getRecord(pendingId);
        expect(decrypted?.recipientEmail).toBe(candEmail);
      } finally {
        await fixture.cleanup();
      }
    });

    it('races deletion against worker claimForDispatch and in-progress dispatch (both success and failure outcomes) without resurrecting data', async () => {
      const fixture = await createFixture();
      const raceEmail1 = `race.claim.${randomUUID().slice(0, 8)}@example.org`;
      const raceEmail2 = `race.send.ok.${randomUUID().slice(0, 8)}@example.org`;
      const raceEmail3 = `race.send.err.${randomUUID().slice(0, 8)}@example.org`;

      try {
        // Isolate queue from any lingering PENDING/SENDING rows
        await client.emailOutbox.deleteMany({
          where: { status: { in: ['PENDING', 'SENDING'] } },
        });

        // Sub-case A: Deletion vs claimForDispatch concurrency
        const candA = fixture.candidateId;
        const rowA = await seedEncryptedOutboxRow({
          organizationId: fixture.orgId,
          candidateId: candA,
          messageType: 'consent_invitation',
          email: raceEmail1,
          subject: 'Race Claim Test',
          status: 'PENDING',
          payloadJson: { candidateId: candA },
        });

        const outboxStore = new PostgresEmailOutboxStore(client);
        const [, claimResult] = await Promise.all([
          repository.createDeletionRequest(fixture.orgId, candA, fixture.userId),
          outboxStore.claimForDispatch('worker-race-claim', 5),
        ]);
        expect(claimResult.some((r) => r.id === rowA)).toBe(false);
        const finalA = await client.emailOutbox.findUnique({ where: { id: rowA } });
        expect(finalA?.status).toBe('FAILED');
        expect(finalA?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
        assertIrrecoverablyErased(finalA, [raceEmail1, candA], ['erased', 'erasedAt']);

        // Sub-case B & C: Worker claims row, pauses inside provider.send(), deletion commits while in-flight;
        // prove Phase 4 fences BOTH success:true AND success:false responses!
        for (const outcome of [
          { success: true, messageId: 'in-flight-provider-id' },
          { success: false, error: `550 bounced <${raceEmail3}>`, isPermanentFailure: true },
        ]) {
          await client.emailOutbox.deleteMany({
            where: { status: { in: ['PENDING', 'SENDING'] } },
          });
          const candB = randomUUID();
          await client.candidate.create({
            data: {
              id: candB,
              organizationId: fixture.orgId,
              candidateCode: `CAN-INF-${randomUUID().slice(0, 6).toUpperCase()}`,
              recordStatus: 'ACTIVE',
            },
          });

          const targetEmail = outcome.success ? raceEmail2 : raceEmail3;
          const rowB = await seedEncryptedOutboxRow({
            organizationId: fixture.orgId,
            candidateId: candB,
            messageType: 'consent_invitation',
            email: targetEmail,
            subject: 'In-flight race test',
            status: 'PENDING',
            payloadJson: { candidateId: candB },
          });

          let enteredSendResolve!: () => void;
          const enteredSend = new Promise<void>((r) => {
            enteredSendResolve = r;
          });
          let releaseSendResolve!: () => void;
          const releaseSend = new Promise<void>((r) => {
            releaseSendResolve = r;
          });

          const pausingProvider: EmailDispatcherProvider = {
            async send() {
              enteredSendResolve();
              await releaseSend;
              return outcome;
            },
          };

          const dispatcher = new WorkerEmailDispatcher(client, {
            workerId: 'in-flight-race-worker',
            leaseDurationSeconds: 60,
            provider: pausingProvider,
          });

          const dispatchPromise = dispatcher.processNextEmail();
          await enteredSend;

          // Deletion executes & commits while provider.send() is still in flight
          const delTokenHash = hashToken(randomBytes(32).toString('hex'));
          await repository.createDeletionVerification({
            organizationId: fixture.orgId,
            candidateId: candB,
            tokenHash: delTokenHash,
            email: targetEmail,
            expiresAt: new Date(Date.now() + 86400_000),
          });
          const confirmed = await repository.confirmCandidateDeletion(delTokenHash, async () => {});
          expect(confirmed?.status).toBe('COMPLETED');

          // Release provider.send() -> Phase 4 MUST be fenced out and leave erased state untouched
          releaseSendResolve();
          const workerResult = await dispatchPromise;
          if (outcome.success) {
            expect(workerResult).toBe(false); // updateCount === 0
          }

          const finalB = await client.emailOutbox.findUnique({ where: { id: rowB } });
          expect(finalB?.status).toBe('FAILED');
          expect(finalB?.lastErrorCode).toBe('CANDIDATE_DELETION_PENDING');
          expect(finalB?.sentAt).toBeNull();
          assertIrrecoverablyErased(
            finalB,
            [targetEmail, candB, outcome.messageId ?? targetEmail],
            ['erased', 'erasedAt'],
          );

          // Cleanup extra candidate B row
          await client.emailOutbox.deleteMany({ where: { id: rowB } }).catch(() => {});
          await client.candidate.deleteMany({ where: { id: candB } }).catch(() => {});
        }
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
