import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@talentlens/database';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';

import { createConsentRepository, type ConsentRepository } from './consent.repository.js';
import { createResumeRepository, type ResumeRepository } from '../resumes/resume.repository.js';
import { hashToken } from './consent.service.js';

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
      await client.documentExtraction.deleteMany({ where: { organizationId: orgId } });
      await client.processingJob.deleteMany({ where: { organizationId: orgId } });
      await client.resumeDocument.deleteMany({ where: { organizationId: orgId } });
      await client.processingBatch.deleteMany({ where: { organizationId: orgId } });
      await client.consentWithdrawalRequest.deleteMany({ where: { candidateId } });
      await client.consentInvitation.deleteMany({ where: { candidateId } });
      await client.candidateConsent.deleteMany({ where: { candidateId } });
      await client.auditLog.deleteMany({ where: { organizationId: orgId } });
      await client.requisition.deleteMany({ where: { organizationId: orgId } });
      await client.candidate.deleteMany({ where: { id: candidateId } });
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
});
