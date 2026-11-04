import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../../../packages/database/dist/generated/prisma/client.js';
import { createConsentRepository, type ConsentRepository } from '../consent/consent.repository.js';
import {
  WorkflowInterviewNotFoundError,
  WorkflowInterviewStateError,
  WorkflowProhibitedFeedbackError,
  WorkflowShortlistRequiredError,
  WorkflowSubmissionNotFoundError,
  WorkflowSubmissionStateError,
} from './workflow.errors.js';
import { createWorkflowRepository, type WorkflowRepository } from './workflow.repository.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

function assertSafeIntegrationDatabase(): string {
  const connStr =
    process.env['TALENTLENS_INTEGRATION_DATABASE_URL'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://talentlens:talentlens_local_only@localhost:5432/talentlens_scorecard_test';

  if (!connStr.includes('talentlens_scorecard_test')) {
    throw new Error(
      `Refusing to run integration test against database: "${connStr}". Target database must be "talentlens_scorecard_test".`,
    );
  }
  return connStr;
}

function createTestPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

maybeDescribe('workflow repository & service — live postgresql integration tests', () => {
  let client: PrismaClient;
  let repository: WorkflowRepository;
  let consentRepository: ConsentRepository;

  beforeAll(async () => {
    const connStr = assertSafeIntegrationDatabase();
    client = createTestPrismaClient(connStr);
    await client.$connect();
    repository = createWorkflowRepository(client);
    consentRepository = createConsentRepository(client);
  });

  afterAll(async () => {
    if (client) {
      await client.$disconnect();
    }
  });

  async function createFixture() {
    const orgId = randomUUID();
    const recruiterUserId = randomUUID();
    const clientUserId = randomUUID();
    const clientId = randomUUID();
    const clientMembershipId = randomUUID();
    const candidateId = randomUUID();
    const requisitionId = randomUUID();
    const otherRequisitionId = randomUUID();
    const scorecardVersionId = randomUUID();
    const criterionId = randomUUID();
    const resumeDocId = randomUUID();
    const batchId = randomUUID();
    const extractionId = randomUUID();
    const asmtTextId = randomUUID();
    const assessmentId = randomUUID();

    // 1. Organization
    await client.organization.create({
      data: {
        id: orgId,
        name: `Workflow Org ${orgId.slice(0, 8)}`,
        normalizedName: `workflow-org-${orgId.slice(0, 8)}`,
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
        id: clientUserId,
        organizationId: orgId,
        email: `clientuser-${clientUserId.slice(0, 8)}@example.com`,
        normalizedEmail: `clientuser-${clientUserId.slice(0, 8)}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    // 3. Client & Membership
    await client.client.create({
      data: {
        id: clientId,
        organizationId: orgId,
        name: `Acme Corp ${clientId.slice(0, 8)}`,
        normalizedName: `acme-corp-${clientId.slice(0, 8)}`,
        status: 'ACTIVE',
      },
    });

    await client.clientMembership.create({
      data: {
        id: clientMembershipId,
        organizationId: orgId,
        clientId,
        userId: clientUserId,
        role: 'CLIENT_HIRING_MANAGER',
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
        title: 'Senior Distributed Systems Engineer',
        jdText: 'Looking for a Senior Distributed Systems Engineer with Kafka and Raft experience.',
        status: 'OPEN',
        assignedRecruiterId: recruiterUserId,
        createdById: recruiterUserId,
      },
    });

    await client.requisition.create({
      data: {
        id: otherRequisitionId,
        organizationId: orgId,
        clientId,
        title: 'Other Requisition',
        jdText: 'Another job description.',
        status: 'OPEN',
        assignedRecruiterId: recruiterUserId,
        createdById: recruiterUserId,
      },
    });

    // 6. Scorecard Version & Criterion
    await client.scorecardVersion.create({
      data: {
        id: scorecardVersionId,
        organizationId: orgId,
        requisitionId,
        version: 1,
        status: 'APPROVED',
        weightsJson: { criteria: {} },
        approvedById: recruiterUserId,
        approvedAt: new Date(),
      },
    });

    await client.scorecardCriterion.create({
      data: {
        id: criterionId,
        scorecardVersionId,
        key: 'distributed-systems',
        label: 'Distributed Systems',
        category: 'SKILL',
        requirementType: 'MUST_HAVE',
        weight: 100,
        ruleJson: {},
        active: true,
        displayOrder: 1,
      },
    });

    // 7. Resume Document & Processing Batch
    await client.processingBatch.create({
      data: {
        id: batchId,
        organizationId: orgId,
        requisitionId,
        createdById: recruiterUserId,
        status: 'COMPLETED',
        totalFiles: 1,
      },
    });

    await client.resumeDocument.create({
      data: {
        id: resumeDocId,
        organizationId: orgId,
        candidateId,
        objectKey: `resumes/${orgId}/${resumeDocId}.pdf`,
        sha256: randomBytes(32).toString('hex'),
        mimeType: 'application/pdf',
        fileType: 'PDF',
        sizeBytes: 2048n,
        version: 1,
        parseStatus: 'PARSED',
        uploadedById: recruiterUserId,
      },
    });

    await client.processingJob.create({
      data: {
        id: randomUUID(),
        organizationId: orgId,
        batchId,
        resumeDocumentId: resumeDocId,
        jobType: 'VALIDATE_FILE',
        status: 'SUCCEEDED',
      },
    });

    // 8. Extraction & Assessment Text
    await client.documentExtraction.create({
      data: {
        id: extractionId,
        organizationId: orgId,
        resumeDocumentId: resumeDocId,
        version: 1,
        extractedText:
          'Senior Distributed Systems Architect with 7 years experience in Kafka and Raft.',
        pageMapJson: {},
        parser: 'test-parser',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      },
    });

    await client.assessmentText.create({
      data: {
        id: asmtTextId,
        organizationId: orgId,
        resumeDocumentId: resumeDocId,
        documentExtractionId: extractionId,
        version: 1,
        redactedText:
          'Senior Distributed Systems Architect with 7 years experience in Kafka and Raft.',
        redactorVersion: '2026-11-redactor-v1',
        pageMapJson: [{ pageNumber: 1, startOffset: 0, endOffset: 80 }],
        redactionMapJson: [],
      },
    });

    // 9. Candidate Assessment & Criterion Assessment & Evidence Snippet
    await client.candidateAssessment.create({
      data: {
        id: assessmentId,
        organizationId: orgId,
        requisitionId,
        candidateId,
        resumeDocumentId: resumeDocId,
        documentExtractionId: extractionId,
        scorecardVersionId,
        assessmentTextId: asmtTextId,
        score: 95.0,
        coverage: 100,
        status: 'COMPLETE',
        formulaVersion: 'v1',
        modelMetadataJson: {},
      },
    });

    const critAssessmentId = randomUUID();
    await client.criterionAssessment.create({
      data: {
        id: critAssessmentId,
        organizationId: orgId,
        assessmentId,
        criterionId,
        scorecardVersionId,
        resumeDocumentId: resumeDocId,
        assessmentTextId: asmtTextId,
        documentExtractionId: extractionId,
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Candidate has 7 years experience with Raft and distributed consensus.',
      },
    });

    await client.evidenceSnippet.create({
      data: {
        id: randomUUID(),
        organizationId: orgId,
        criterionAssessmentId: critAssessmentId,
        assessmentId,
        scorecardVersionId,
        quote: '7 years experience in Kafka and Raft',
        pageNumber: 1,
        startOffset: 10,
        endOffset: 46,
        verified: true,
        verificationMethod: 'EXACT_QUOTE',
        assessmentTextId: asmtTextId,
        resumeDocumentId: resumeDocId,
        documentExtractionId: extractionId,
      },
    });

    // 10. Active Candidate Consent for this requisition
    const consentId = randomUUID();
    await client.candidateConsent.create({
      data: {
        id: consentId,
        organizationId: orgId,
        candidateId,
        requisitionId,
        purpose: 'HIRING_USE',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'valid-approved-hash',
        captureMethod: 'RECRUITER_RECORDED',
        capturedAt: new Date(),
        capturedById: recruiterUserId,
      },
    });

    return {
      orgId,
      recruiterUserId,
      clientUserId,
      clientId,
      clientMembershipId,
      candidateId,
      requisitionId,
      otherRequisitionId,
      resumeDocId,
      assessmentId,
      consentId,
    };
  }

  it('records original resume inspection and enables recruiter shortlist and submission', async () => {
    const fx = await createFixture();

    // 1. Initial state: Recruiter has NOT inspected original resume
    const inspectedInitially = await repository.hasRecruiterInspectedResume(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.resumeDocId,
    );
    expect(inspectedInitially).toBe(false);

    // 2. Simulate recruiter opening/inspecting original resume file
    await client.auditLog.create({
      data: {
        organizationId: fx.orgId,
        actorId: fx.recruiterUserId,
        action: 'ORIGINAL_RESUME_INSPECTED',
        resourceType: 'ResumeDocument',
        resourceId: fx.resumeDocId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        metadataJson: { resumeDocumentId: fx.resumeDocId },
      },
    });

    const inspectedAfter = await repository.hasRecruiterInspectedResume(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.resumeDocId,
    );
    expect(inspectedAfter).toBe(true);

    // 3. Record recruiter review and explicit shortlist
    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Exceeds technical requirements',
    );
    expect(review.decision).toBe('REVIEWED');

    const shortlist = await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted for client interview',
    );
    expect(shortlist.shortlistedById).toBe(fx.recruiterUserId);

    // Verify pipeline event for shortlist
    const pipelineEvent = await client.pipelineEvent.findFirst({
      where: {
        organizationId: fx.orgId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        toStage: 'RECRUITER_SHORTLISTED',
      },
    });
    expect(pipelineEvent).not.toBeNull();
    expect(pipelineEvent?.actorId).toBe(fx.recruiterUserId);
    expect(pipelineEvent?.reason).toContain('Shortlisted');

    // 4. Create client submission
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );
    expect(submission.status).toBe('SUBMITTED');

    // 5. Client views submission with contact masking
    const clientView = await repository.getSubmissionForClient(
      fx.orgId,
      fx.clientId,
      submission.id,
    );
    expect(clientView).not.toBeNull();
    expect(clientView?.candidateRef).toContain('CAND-SUB-');
    expect(clientView?.assessment?.score).toBe(95);
    expect(clientView?.assessment?.criteria[0]?.verifiedQuotes[0]).toContain('Kafka and Raft');
    const maskedView = clientView as unknown as Record<string, unknown>;
    expect(maskedView['candidateCode']).toBeUndefined();
    expect(maskedView['candidateId']).toBeUndefined();

    // 6. Client records feedback: PROPOSE_INTERVIEW
    const futureStart = new Date(Date.now() + 86400000);
    const futureEnd = new Date(futureStart.getTime() + 3600000);
    const interviewProposal = await repository.recordClientInterviewProposal(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      futureStart,
      futureEnd,
      'Asia/Kolkata',
      'VIDEO',
      'Panel interview with lead architect',
    );
    expect(interviewProposal.decision).toBe('PROPOSE_INTERVIEW');
    expect(interviewProposal.format).toBe('VIDEO');
    expect(interviewProposal.status).toBe('PROPOSED');

    // Check submission status updated
    const updatedSub = await client.candidateSubmission.findUnique({
      where: { id: submission.id },
    });
    expect(updatedSub?.status).toBe('INTERVIEW_PROPOSED');

    // 7. Recruiter responds to interview: ACCEPT
    const acceptResult = await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      interviewProposal.id,
      'ACCEPT',
    );
    expect(acceptResult.success).toBe(true);

    const updatedProposal = await client.interviewProposal.findUnique({
      where: { id: interviewProposal.id },
    });
    expect(updatedProposal?.status).toBe('ACCEPTED');

    const scheduledEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'INTERVIEW_SCHEDULED',
      },
    });
    expect(scheduledEvent).not.toBeNull();
  });

  it('candidate consent withdrawal immediately updates submissions to WITHDRAWN and revokes client access', async () => {
    const fx = await createFixture();

    // 1. Setup review and submission
    const review = await client.candidateReview.create({
      data: {
        organizationId: fx.orgId,
        reviewerId: fx.recruiterUserId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        decision: 'REVIEWED',
      },
    });

    const submission = await client.candidateSubmission.create({
      data: {
        organizationId: fx.orgId,
        requisitionId: fx.requisitionId,
        clientId: fx.clientId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        assessmentId: fx.assessmentId,
        reviewId: review.id,
        submittedById: fx.recruiterUserId,
        status: 'SUBMITTED',
      },
    });

    // Verify client can initially access submission
    const initialClientView = await repository.getSubmissionForClient(
      fx.orgId,
      fx.clientId,
      submission.id,
    );
    expect(initialClientView).not.toBeNull();

    // Create a pending proposal and a historical completed proposal
    const pendingProposal = await client.interviewProposal.create({
      data: {
        organizationId: fx.orgId,
        submissionId: submission.id,
        requisitionId: fx.requisitionId,
        proposerUserId: fx.clientUserId,
        proposerRole: 'CLIENT_HIRING_MANAGER',
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    const completedProposal = await client.interviewProposal.create({
      data: {
        organizationId: fx.orgId,
        submissionId: submission.id,
        requisitionId: fx.requisitionId,
        proposerUserId: fx.recruiterUserId,
        proposerRole: 'RECRUITER',
        startAt: new Date(Date.now() - 86400000),
        endAt: new Date(Date.now() - 82800000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'COMPLETED',
      },
    });

    // 2. Candidate initiates and confirms consent withdrawal
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = await (async () => {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(rawToken, 'utf8').digest('hex');
    })();

    await client.consentWithdrawalRequest.create({
      data: {
        organizationId: fx.orgId,
        candidateId: fx.candidateId,
        consentId: fx.consentId,
        tokenHash,
        email: 'candidate@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    // Confirm withdrawal through consent repository
    const withdrawalResult = await consentRepository.confirmWithdrawal(tokenHash);
    expect(withdrawalResult).not.toBeNull();

    // 3. Verify submission status updated to WITHDRAWN in database
    const withdrawnSub = await client.candidateSubmission.findUnique({
      where: { id: submission.id },
    });
    expect(withdrawnSub?.status).toBe('WITHDRAWN');

    // 3b. Verify pending interview proposal is CANCELLED while completed is preserved
    const updatedPendingProposal = await client.interviewProposal.findUnique({
      where: { id: pendingProposal.id },
    });
    expect(updatedPendingProposal?.status).toBe('CANCELLED');

    const updatedCompletedProposal = await client.interviewProposal.findUnique({
      where: { id: completedProposal.id },
    });
    expect(updatedCompletedProposal?.status).toBe('COMPLETED');

    // 4. Verify client view now fails closed / returns null
    const clientViewAfterWithdrawal = await repository.getSubmissionForClient(
      fx.orgId,
      fx.clientId,
      submission.id,
    );
    expect(clientViewAfterWithdrawal).toBeNull();

    // 5. Verify pipeline event was recorded for withdrawal
    const withdrewEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'CANDIDATE_WITHDREW',
      },
    });
    expect(withdrewEvent).not.toBeNull();
  });

  it('proves strict cross-client tenant isolation: Client B cannot view Client A submissions', async () => {
    const fx = await createFixture();

    const otherClientId = randomUUID();
    await client.client.create({
      data: {
        id: otherClientId,
        organizationId: fx.orgId,
        name: `Other Client ${otherClientId.slice(0, 8)}`,
        normalizedName: `other-client-${otherClientId.slice(0, 8)}`,
        status: 'ACTIVE',
      },
    });

    const review = await client.candidateReview.create({
      data: {
        organizationId: fx.orgId,
        reviewerId: fx.recruiterUserId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        decision: 'REVIEWED',
      },
    });

    const submission = await client.candidateSubmission.create({
      data: {
        organizationId: fx.orgId,
        requisitionId: fx.requisitionId,
        clientId: fx.clientId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        assessmentId: fx.assessmentId,
        reviewId: review.id,
        submittedById: fx.recruiterUserId,
        status: 'SUBMITTED',
      },
    });

    // Client B attempts to fetch submission belonging to Client A
    const crossClientView = await repository.getSubmissionForClient(
      fx.orgId,
      otherClientId, // Client B
      submission.id,
    );
    expect(crossClientView).toBeNull();
  });

  it('proves resubmission preserves historical submissions and decisions, while remaining idempotent for active submissions', async () => {
    const fx = await createFixture();

    const review = await client.candidateReview.create({
      data: {
        organizationId: fx.orgId,
        reviewerId: fx.recruiterUserId,
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        decision: 'REVIEWED',
      },
    });

    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted for submission',
    );

    // 1. First submission
    const sub1 = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );
    expect(sub1.status).toBe('SUBMITTED');

    // Add a client decision to sub1
    await client.clientDecision.create({
      data: {
        organizationId: fx.orgId,
        clientId: fx.clientId,
        submissionId: sub1.id,
        clientUserId: fx.clientUserId,
        membershipId: fx.clientMembershipId,
        decision: 'REJECT',
        reason: 'Missing specific cloud experience',
      },
    });

    // Mark sub1 as CLIENT_REJECTED (terminal state)
    await client.candidateSubmission.update({
      where: { id: sub1.id },
      data: { status: 'CLIENT_REJECTED' },
    });

    // 2. Resubmit candidate for the same requisition
    const sub2 = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // Verify sub2 is a BRAND NEW submission record preserving history!
    expect(sub2.id).not.toBe(sub1.id);
    expect(sub2.status).toBe('SUBMITTED');

    // Verify historical sub1 still exists intact with its original decisions and status
    const historicalSub = await client.candidateSubmission.findUnique({
      where: { id: sub1.id },
      include: { decisions: true },
    });
    expect(historicalSub).not.toBeNull();
    expect(historicalSub?.status).toBe('CLIENT_REJECTED');
    expect(historicalSub?.decisions).toHaveLength(1);
    expect(historicalSub?.decisions[0]?.reason).toBe('Missing specific cloud experience');

    // 3. Duplicate submission while sub2 is active is IDEMPOTENT (returns sub2 without creating a third)
    const sub2Duplicate = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );
    expect(sub2Duplicate.id).toBe(sub2.id);

    // Verify total submissions in database for this requisition & candidate is exactly 2 (sub1 and sub2)
    const allSubs = await client.candidateSubmission.findMany({
      where: {
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
      },
    });
    expect(allSubs).toHaveLength(2);

    // 4. Attempting to insert another active submission violates partial unique index
    await expect(
      client.candidateSubmission.create({
        data: {
          organizationId: fx.orgId,
          requisitionId: fx.requisitionId,
          clientId: fx.clientId,
          candidateId: fx.candidateId,
          resumeDocumentId: fx.resumeDocId,
          assessmentId: fx.assessmentId,
          reviewId: review.id,
          submittedById: fx.recruiterUserId,
          status: 'SUBMITTED', // Active duplicate!
        },
      }),
    ).rejects.toThrow();
  });

  it('recruiter proposes alternative interview window; client accepts proposal transitioning it to ACCEPTED and emitting pipeline event', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong profile',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted for round 1',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // Initial client proposal
    const clientProposal = await repository.recordClientInterviewProposal(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      new Date(Date.now() + 86400000),
      new Date(Date.now() + 90000000),
      'UTC',
      'VIDEO',
      'Initial discussion',
    );

    // Recruiter proposes alternative
    const altStart = new Date(Date.now() + 172800000);
    const altEnd = new Date(Date.now() + 176400000);
    await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      clientProposal.id,
      'PROPOSE_ALTERNATIVE',
      {
        startAt: altStart,
        endAt: altEnd,
        timezone: 'UTC',
        format: 'VIDEO',
        reason: 'Recruiter alternative time slot',
      },
    );

    // Original client proposal is now RESCHEDULED
    const originalAfterAlt = await client.interviewProposal.findUnique({
      where: { id: clientProposal.id },
    });
    expect(originalAfterAlt?.status).toBe('RESCHEDULED');

    // New recruiter proposal is created with status PROPOSED
    const recruiterProposal = await client.interviewProposal.findFirst({
      where: {
        submissionId: submission.id,
        proposerRole: 'RECRUITER',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(recruiterProposal).not.toBeNull();
    expect(recruiterProposal?.status).toBe('PROPOSED');

    // Client accepts the recruiter's proposed alternative
    const acceptResult = await repository.respondToInterviewAsClient(
      fx.orgId,
      fx.clientId,
      submission.id,
      recruiterProposal!.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'ACCEPT',
    );
    expect(acceptResult.success).toBe(true);
    expect(acceptResult.status).toBe('ACCEPTED');

    // Verify database record is ACCEPTED
    const acceptedInDb = await client.interviewProposal.findUnique({
      where: { id: recruiterProposal!.id },
    });
    expect(acceptedInDb?.status).toBe('ACCEPTED');

    // Verify pipeline event was emitted
    const pipelineEvents = await client.pipelineEvent.findMany({
      where: {
        submissionId: submission.id,
        toStage: 'INTERVIEW_SCHEDULED',
      },
    });
    expect(pipelineEvents.length).toBeGreaterThanOrEqual(1);

    // Verify duplicate acceptance is rejected
    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        submission.id,
        recruiterProposal!.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);
  });

  it('client rejects interview proposal with reason; further acceptance is rejected', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong profile',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    const clientInitialProposal = await repository.recordClientInterviewProposal(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      new Date(Date.now() + 86400000),
      new Date(Date.now() + 90000000),
      'UTC',
      'VIDEO',
      'Interview slot',
    );

    const altResult = await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      clientInitialProposal.id,
      'PROPOSE_ALTERNATIVE',
      {
        startAt: new Date(Date.now() + 172800000),
        endAt: new Date(Date.now() + 176400000),
        timezone: 'UTC',
        format: 'VIDEO',
        reason: 'Recruiter alternative slot',
      },
    );
    const proposal = { id: altResult.proposalId! };

    // Rejecting without reason fails
    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        submission.id,
        proposal.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'REJECT',
        'no', // too short (<3)
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);

    // Reject with valid reason succeeds
    const rejectResult = await repository.respondToInterviewAsClient(
      fx.orgId,
      fx.clientId,
      submission.id,
      proposal.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'REJECT',
      'Schedule conflict with engineering team',
    );
    expect(rejectResult.status).toBe('REJECTED');

    const rejectedInDb = await client.interviewProposal.findUnique({
      where: { id: proposal.id },
    });
    expect(rejectedInDb?.status).toBe('REJECTED');
    expect(rejectedInDb?.reason).toBe('Schedule conflict with engineering team');

    // Accepting rejected proposal fails
    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        submission.id,
        proposal.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);
  });

  it('consent withdrawal cancels future ACCEPTED interviews while preserving COMPLETED and other requisition records', async () => {
    const fx = await createFixture();

    // 1. Requisition 1: Create submission
    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong profile',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const subReq1 = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // Interview 1 on Req 1: Future ACCEPTED interview (startAt in 48 hours)
    const futureAccepted = await client.interviewProposal.create({
      data: {
        organizationId: fx.orgId,
        submissionId: subReq1.id,
        requisitionId: fx.requisitionId,
        proposerUserId: fx.clientUserId,
        proposerRole: 'CLIENT_HIRING_MANAGER',
        status: 'ACCEPTED',
        startAt: new Date(Date.now() + 48 * 3600 * 1000),
        endAt: new Date(Date.now() + 49 * 3600 * 1000),
        timezone: 'UTC',
        format: 'VIDEO',
      },
    });

    // Interview 2 on Req 1: COMPLETED interview in the past
    const completedPast = await client.interviewProposal.create({
      data: {
        organizationId: fx.orgId,
        submissionId: subReq1.id,
        requisitionId: fx.requisitionId,
        proposerUserId: fx.clientUserId,
        proposerRole: 'CLIENT_HIRING_MANAGER',
        status: 'COMPLETED',
        startAt: new Date(Date.now() - 48 * 3600 * 1000),
        endAt: new Date(Date.now() - 47 * 3600 * 1000),
        timezone: 'UTC',
        format: 'VIDEO',
      },
    });

    // 2. Other Requisition (otherRequisitionId): Independent consent, submission, and future interview
    await client.candidateConsent.create({
      data: {
        organizationId: fx.orgId,
        candidateId: fx.candidateId,
        requisitionId: fx.otherRequisitionId,
        purpose: 'HIRING_USE',
        status: 'ACTIVE',
        policyVersion: '2026-11-v1',
        noticeTextHash: 'hash-other',
        confirmationName: 'Alice Smith',
        captureMethod: 'CANDIDATE_PORTAL',
        capturedAt: new Date(),
        capturedById: fx.recruiterUserId,
      },
    });

    const otherScorecardVersionId = randomUUID();
    await client.scorecardVersion.create({
      data: {
        id: otherScorecardVersionId,
        organizationId: fx.orgId,
        requisitionId: fx.otherRequisitionId,
        version: 1,
        status: 'APPROVED',
        weightsJson: { criteria: {} },
        approvedById: fx.recruiterUserId,
        approvedAt: new Date(),
      },
    });

    const otherReviewId = randomUUID();
    await client.candidateReview.create({
      data: {
        id: otherReviewId,
        organizationId: fx.orgId,
        reviewerId: fx.recruiterUserId,
        requisitionId: fx.otherRequisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        decision: 'REVIEWED',
      },
    });

    const extraction = await client.documentExtraction.findFirstOrThrow({
      where: { resumeDocumentId: fx.resumeDocId },
    });

    const asmtText = await client.assessmentText.findFirstOrThrow({
      where: { resumeDocumentId: fx.resumeDocId },
    });

    const otherAssessmentId = randomUUID();
    await client.candidateAssessment.create({
      data: {
        id: otherAssessmentId,
        organizationId: fx.orgId,
        requisitionId: fx.otherRequisitionId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        documentExtractionId: extraction.id,
        scorecardVersionId: otherScorecardVersionId,
        assessmentTextId: asmtText.id,
        score: 85,
        coverage: 100,
        status: 'COMPLETE',
        formulaVersion: 'v1',
        modelMetadataJson: {},
      },
    });

    const subReq2 = await client.candidateSubmission.create({
      data: {
        organizationId: fx.orgId,
        requisitionId: fx.otherRequisitionId,
        clientId: fx.clientId,
        candidateId: fx.candidateId,
        resumeDocumentId: fx.resumeDocId,
        assessmentId: otherAssessmentId,
        reviewId: otherReviewId,
        submittedById: fx.recruiterUserId,
        status: 'SUBMITTED',
      },
    });

    const otherReqFutureInterview = await client.interviewProposal.create({
      data: {
        organizationId: fx.orgId,
        submissionId: subReq2.id,
        requisitionId: fx.otherRequisitionId,
        proposerUserId: fx.clientUserId,
        proposerRole: 'CLIENT_HIRING_MANAGER',
        status: 'ACCEPTED',
        startAt: new Date(Date.now() + 72 * 3600 * 1000),
        endAt: new Date(Date.now() + 73 * 3600 * 1000),
        timezone: 'UTC',
        format: 'VIDEO',
      },
    });

    // 3. Candidate withdraws consent strictly for Requisition 1
    const tokenHash = randomBytes(32).toString('hex');
    await client.consentWithdrawalRequest.create({
      data: {
        organizationId: fx.orgId,
        candidateId: fx.candidateId,
        consentId: fx.consentId,
        tokenHash,
        email: 'alice@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    await consentRepository.confirmWithdrawal(tokenHash);

    // 4. Verify outcome:
    // A. Future ACCEPTED interview on Req 1 MUST be cancelled
    const futureAfterWithdrawal = await client.interviewProposal.findUnique({
      where: { id: futureAccepted.id },
    });
    expect(futureAfterWithdrawal?.status).toBe('CANCELLED');
    expect(futureAfterWithdrawal?.reason).toBe('Candidate consent withdrawn');

    // B. Completed past interview on Req 1 MUST be preserved
    const completedAfterWithdrawal = await client.interviewProposal.findUnique({
      where: { id: completedPast.id },
    });
    expect(completedAfterWithdrawal?.status).toBe('COMPLETED');

    // C. Independent other requisition interview MUST be completely unaffected
    const otherReqAfterWithdrawal = await client.interviewProposal.findUnique({
      where: { id: otherReqFutureInterview.id },
    });
    expect(otherReqAfterWithdrawal?.status).toBe('ACCEPTED');

    // D. Attempting to accept the cancelled interview fails
    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        subReq1.id,
        futureAccepted.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'ACCEPT',
      ),
    ).rejects.toThrow();
  });

  it('rejects prohibited discriminatory client feedback, records audit log, and preserves candidate submission state', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong profile',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // Client attempts to reject candidate with explicit age-discriminatory feedback
    await expect(
      repository.recordClientFeedback(
        fx.orgId,
        fx.clientId,
        submission.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'REJECT',
        'Candidate is too old for this team, looking for someone young.',
      ),
    ).rejects.toThrow(WorkflowProhibitedFeedbackError);

    // Verify submission status has NOT become CLIENT_REJECTED
    const subInDb = await client.candidateSubmission.findUnique({
      where: { id: submission.id },
    });
    expect(subInDb?.status).toBe('SUBMITTED');

    // Verify no ClientDecision was created
    const decisions = await client.clientDecision.findMany({
      where: { submissionId: submission.id },
    });
    expect(decisions).toHaveLength(0);

    // Verify audit log captured the prohibited attempt
    const auditLogs = await client.auditLog.findMany({
      where: {
        action: 'CLIENT_FEEDBACK_PROHIBITED_DETECTED',
        resourceId: submission.id,
      },
    });
    expect(auditLogs).toHaveLength(1);
    expect((auditLogs[0]?.metadataJson as Record<string, unknown>)?.['prohibitedCategory']).toBe(
      'AGE',
    );
  });

  it('proves recruiter and client shortlist actions produce distinct pipeline stages and audit actors', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong candidate',
    );

    // Recruiter shortlists
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Top choice by recruiter',
    );

    // 1. Recruiter shortlist event must be RECRUITER_SHORTLISTED with recruiter as actor
    const recruiterShortlistEvent = await client.pipelineEvent.findFirst({
      where: {
        requisitionId: fx.requisitionId,
        candidateId: fx.candidateId,
        toStage: 'RECRUITER_SHORTLISTED',
      },
    });
    expect(recruiterShortlistEvent).not.toBeNull();
    expect(recruiterShortlistEvent?.actorId).toBe(fx.recruiterUserId);

    // CandidateShortlist and CandidateReview records must be independent
    const reviewRecord = await client.candidateReview.findFirst({
      where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId },
    });
    const shortlistRecord = await client.candidateShortlist.findFirst({
      where: { candidateId: fx.candidateId, requisitionId: fx.requisitionId },
    });
    expect(reviewRecord?.id).not.toBe(shortlistRecord?.id);

    // Recruiter submits to client
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    const submissionEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'SUBMITTED_TO_CLIENT',
      },
    });
    expect(submissionEvent).not.toBeNull();
    expect(submissionEvent?.fromStage).toBe('RECRUITER_SHORTLISTED');
    expect(submissionEvent?.actorId).toBe(fx.recruiterUserId);

    // Client shortlists candidate
    await repository.recordClientFeedback(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'SHORTLIST',
      'Client team agrees candidate is a strong fit',
    );

    // 2. Client shortlist event must be CLIENT_SHORTLISTED with client user as actor
    const clientShortlistEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'CLIENT_SHORTLISTED',
      },
    });
    expect(clientShortlistEvent).not.toBeNull();
    expect(clientShortlistEvent?.actorId).toBe(fx.clientUserId);
    expect(clientShortlistEvent?.fromStage).toBe('SUBMITTED_TO_CLIENT');
  });

  it('proves interview completion records INTERVIEW_COMPLETED and never creates an offer stage', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong candidate',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    const proposal = await repository.recordClientInterviewProposal(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      new Date(Date.now() + 86400000),
      new Date(Date.now() + 90000000),
      'UTC',
      'VIDEO',
      'Technical interview',
    );

    // Recruiter accepts proposal
    await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      proposal.id,
      'ACCEPT',
    );

    // Recruiter completes interview
    const completeResult = await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      proposal.id,
      'COMPLETE',
    );
    expect(completeResult.success).toBe(true);

    // Proposal status is COMPLETED
    const proposalInDb = await client.interviewProposal.findUnique({
      where: { id: proposal.id },
    });
    expect(proposalInDb?.status).toBe('COMPLETED');

    // Pipeline event must be INTERVIEW_COMPLETED
    const completedEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'INTERVIEW_COMPLETED',
      },
    });
    expect(completedEvent).not.toBeNull();
    expect(completedEvent?.fromStage).toBe('INTERVIEW_SCHEDULED');

    // OFFERED event must NOT exist
    const offeredEvent = await client.pipelineEvent.findFirst({
      where: {
        submissionId: submission.id,
        toStage: 'OFFERED',
      },
    });
    expect(offeredEvent).toBeNull();
  });

  it('enforces interview proposal counterparty role, exact proposal lookup without fallback, expiration check, and atomic transitions (F-02)', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong candidate',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    const clientProposal = await repository.recordClientInterviewProposal(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      new Date(Date.now() + 86400000),
      new Date(Date.now() + 90000000),
      'UTC',
      'VIDEO',
      'Initial slot',
    );

    // 1. Client cannot accept or reject their own proposal
    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        submission.id,
        clientProposal.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);

    // 2. Unknown decisionId must throw WorkflowInterviewNotFoundError (never silently fall back to latest proposal)
    await expect(
      repository.respondToInterview(
        fx.orgId,
        fx.recruiterUserId,
        fx.requisitionId,
        submission.id,
        randomUUID(),
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewNotFoundError);

    // 3. Recruiter proposes alternative; recruiter cannot self-accept their own alternative
    const altResult = await repository.respondToInterview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      submission.id,
      clientProposal.id,
      'PROPOSE_ALTERNATIVE',
      {
        startAt: new Date(Date.now() + 172800000),
        endAt: new Date(Date.now() + 176400000),
        timezone: 'UTC',
        format: 'VIDEO',
        reason: 'Recruiter alternative',
      },
    );

    await expect(
      repository.respondToInterview(
        fx.orgId,
        fx.recruiterUserId,
        fx.requisitionId,
        submission.id,
        altResult.proposalId!,
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);

    // 4. Expired proposal cannot be accepted
    await client.interviewProposal.update({
      where: { id: altResult.proposalId! },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });

    await expect(
      repository.respondToInterviewAsClient(
        fx.orgId,
        fx.clientId,
        submission.id,
        altResult.proposalId!,
        fx.clientUserId,
        fx.clientMembershipId,
        'ACCEPT',
      ),
    ).rejects.toThrow(WorkflowInterviewStateError);
  });

  it('consent withdrawal preserves historical CLIENT_REJECTED submissions and records accurate prior stage for active submissions (F-04)', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Strong candidate',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );

    // Submission 1: Rejected by client (historical terminal state)
    const rejectedSub = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );
    await repository.recordClientFeedback(
      fx.orgId,
      fx.clientId,
      rejectedSub.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'REJECT',
      'Not enough distributed systems experience',
    );

    // Submission 2: Resubmitted and shortlisted by client (active state = CLIENT_SHORTLISTED)
    const activeSub = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );
    await repository.recordClientFeedback(
      fx.orgId,
      fx.clientId,
      activeSub.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'SHORTLIST',
      'Strong second look after architecture discussion',
    );

    // Withdraw consent
    const tokenHash = randomBytes(32).toString('hex');
    await client.consentWithdrawalRequest.create({
      data: {
        organizationId: fx.orgId,
        candidateId: fx.candidateId,
        consentId: fx.consentId,
        tokenHash,
        email: 'alice@example.com',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await consentRepository.confirmWithdrawal(tokenHash);

    // Verify historical rejectedSub remains CLIENT_REJECTED (not overwritten to WITHDRAWN)
    const rejectedAfter = await client.candidateSubmission.findUnique({
      where: { id: rejectedSub.id },
    });
    expect(rejectedAfter?.status).toBe('CLIENT_REJECTED');

    // Verify no CANDIDATE_WITHDREW pipeline event was emitted for rejectedSub
    const rejectedWithdrawEvents = await client.pipelineEvent.findMany({
      where: {
        submissionId: rejectedSub.id,
        toStage: 'CANDIDATE_WITHDREW',
      },
    });
    expect(rejectedWithdrawEvents).toHaveLength(0);

    // Verify activeSub transitioned to WITHDRAWN and recorded accurate fromStage = CLIENT_SHORTLISTED
    const activeAfter = await client.candidateSubmission.findUnique({
      where: { id: activeSub.id },
    });
    expect(activeAfter?.status).toBe('WITHDRAWN');

    const activeWithdrawEvents = await client.pipelineEvent.findMany({
      where: {
        submissionId: activeSub.id,
        toStage: 'CANDIDATE_WITHDREW',
      },
    });
    expect(activeWithdrawEvents).toHaveLength(1);
    expect(activeWithdrawEvents[0]?.fromStage).toBe('CLIENT_SHORTLISTED');
  });

  it('listSubmissionsForClient excludes submissions whose exact-scope consent is EXPIRED, WITHDRAWN, or missing (F-07)', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Approved',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // Active consent: visible in list
    const listBefore = await repository.listSubmissionsForClient(fx.orgId, fx.clientId);
    expect(listBefore.some((s) => s.submissionId === submission.id)).toBe(true);

    // Mark consent EXPIRED while submission row is still SUBMITTED
    await client.candidateConsent.update({
      where: { id: fx.consentId },
      data: { status: 'EXPIRED' },
    });

    const listExpired = await repository.listSubmissionsForClient(fx.orgId, fx.clientId);
    expect(listExpired.some((s) => s.submissionId === submission.id)).toBe(false);

    const detailExpired = await repository.getSubmissionForClient(
      fx.orgId,
      fx.clientId,
      submission.id,
    );
    expect(detailExpired).toBeNull();
  });

  it('enforces REVIEWED decision before shortlist/submission and invalidates shortlist when review changes to NEEDS_REVIEW or CLOSED (F-08)', async () => {
    const fx = await createFixture();

    // 1. Cannot shortlist without a REVIEWED decision
    await expect(
      repository.recordShortlist(
        fx.orgId,
        fx.recruiterUserId,
        fx.requisitionId,
        fx.candidateId,
        'Premature shortlist',
      ),
    ).rejects.toThrow(WorkflowShortlistRequiredError);

    // 2. Record NEEDS_REVIEW -> still cannot shortlist
    await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'NEEDS_REVIEW',
      'Hold for verification',
    );
    await expect(
      repository.recordShortlist(
        fx.orgId,
        fx.recruiterUserId,
        fx.requisitionId,
        fx.candidateId,
        'Still not reviewed positively',
      ),
    ).rejects.toThrow(WorkflowShortlistRequiredError);

    // 3. Record REVIEWED -> shortlist succeeds
    await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Verified positive review',
    );
    const shortlist = await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted now',
    );
    expect(shortlist.id).toBeDefined();

    // 4. Subsequent review changing decision to CLOSED invalidates the shortlist and blocks submission
    const closedReview = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'CLOSED',
      'Candidate no longer available',
    );

    const remainingShortlist = await repository.findShortlist(
      fx.orgId,
      fx.requisitionId,
      fx.candidateId,
    );
    expect(remainingShortlist).toBeNull();

    await expect(
      repository.createSubmission(
        fx.orgId,
        fx.recruiterUserId,
        fx.requisitionId,
        fx.clientId,
        fx.candidateId,
        fx.resumeDocId,
        fx.assessmentId,
        closedReview.id,
      ),
    ).rejects.toThrow(WorkflowShortlistRequiredError);
  });

  it('enforces client submission state transitions and fairness screening across interview proposal reasons (F-05, F-13)', async () => {
    const fx = await createFixture();

    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Approved',
    );
    await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted',
    );
    const submission = await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    // 1. Prohibited demographic content in interview proposal reason is rejected and audited
    await expect(
      repository.recordClientInterviewProposal(
        fx.orgId,
        fx.clientId,
        submission.id,
        fx.clientUserId,
        fx.clientMembershipId,
        new Date(Date.now() + 86400000),
        new Date(Date.now() + 90000000),
        'UTC',
        'VIDEO',
        'We prefer a younger candidate for this team',
      ),
    ).rejects.toThrow(WorkflowProhibitedFeedbackError);

    // 2. Reject the submission
    await repository.recordClientFeedback(
      fx.orgId,
      fx.clientId,
      submission.id,
      fx.clientUserId,
      fx.clientMembershipId,
      'REJECT',
      'Does not meet distributed systems requirement',
    );

    // 3. Rejected submission cannot be re-shortlisted or have interviews proposed on it
    await expect(
      repository.recordClientFeedback(
        fx.orgId,
        fx.clientId,
        submission.id,
        fx.clientUserId,
        fx.clientMembershipId,
        'SHORTLIST',
        'Attempting to shortlist a rejected submission',
      ),
    ).rejects.toThrow(WorkflowSubmissionStateError);

    await expect(
      repository.recordClientInterviewProposal(
        fx.orgId,
        fx.clientId,
        submission.id,
        fx.clientUserId,
        fx.clientMembershipId,
        new Date(Date.now() + 86400000),
        new Date(Date.now() + 90000000),
        'UTC',
        'VIDEO',
        'Attempting to propose interview on rejected submission',
      ),
    ).rejects.toThrow(WorkflowSubmissionStateError);

    // 4. Non-existent submission throws WorkflowSubmissionNotFoundError
    await expect(
      repository.recordClientFeedback(
        fx.orgId,
        fx.clientId,
        randomUUID(),
        fx.clientUserId,
        fx.clientMembershipId,
        'SHORTLIST',
        'Valid reason',
      ),
    ).rejects.toThrow(WorkflowSubmissionNotFoundError);
  });

  it('supports client discovery (F-06), shortlist status in candidate list, and candidate pipeline timeline queries', async () => {
    const fx = await createFixture();

    // Create a suspended client and a second active client without membership for fx.clientUserId
    const suspendedClientId = randomUUID();
    const unmemberedClientId = randomUUID();
    await client.client.createMany({
      data: [
        {
          id: suspendedClientId,
          organizationId: fx.orgId,
          name: `Suspended Client ${suspendedClientId.slice(0, 8)}`,
          normalizedName: `suspended-${suspendedClientId.slice(0, 8)}`,
          status: 'INACTIVE',
        },
        {
          id: unmemberedClientId,
          organizationId: fx.orgId,
          name: `Unmembered Client ${unmemberedClientId.slice(0, 8)}`,
          normalizedName: `unmembered-${unmemberedClientId.slice(0, 8)}`,
          status: 'ACTIVE',
        },
      ],
    });

    // 1. Recruiter sees active clients in their organization (excluding SUSPENDED)
    const recruiterClients = await repository.listAuthorizedClients!(
      fx.orgId,
      fx.recruiterUserId,
      'RECRUITER',
    );
    expect(recruiterClients.some((c) => c.id === fx.clientId)).toBe(true);
    expect(recruiterClients.some((c) => c.id === unmemberedClientId)).toBe(true);
    expect(recruiterClients.some((c) => c.id === suspendedClientId)).toBe(false);

    // 2. Client hiring manager sees ONLY active clients where they have an ACTIVE ClientMembership
    const managerClients = await repository.listAuthorizedClients!(
      fx.orgId,
      fx.clientUserId,
      'CLIENT_HIRING_MANAGER',
    );
    expect(managerClients).toHaveLength(1);
    expect(managerClients[0]?.id).toBe(fx.clientId);
    expect(managerClients[0]?.membershipRole).toBe('CLIENT_HIRING_MANAGER');

    // 3. Before shortlist: candidate list shows shortlist: null
    const listBefore = await repository.listCandidatesForRequisition(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      { limit: 20, offset: 0 },
    );
    const candBefore = listBefore.items.find((i) => i.candidateId === fx.candidateId);
    expect(candBefore).toBeDefined();
    expect(candBefore?.shortlist).toBeNull();

    // 4. Review + Shortlist + Submit -> candidate list shows shortlist timestamp and timeline shows ordered events
    const review = await repository.recordCandidateReview(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      fx.resumeDocId,
      'REVIEWED',
      'Reviewed and verified',
    );
    const shortlist = await repository.recordShortlist(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      'Shortlisted for client',
    );
    await repository.createSubmission(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.clientId,
      fx.candidateId,
      fx.resumeDocId,
      fx.assessmentId,
      review.id,
    );

    const listAfter = await repository.listCandidatesForRequisition(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      { limit: 20, offset: 0 },
    );
    const candAfter = listAfter.items.find((i) => i.candidateId === fx.candidateId);
    expect(candAfter?.shortlist?.shortlistedAt.toISOString()).toBe(
      shortlist.shortlistedAt.toISOString(),
    );

    // 5. Candidate timeline returns ordered events for this requisition and candidate
    const timeline = await repository.getCandidateTimeline!(
      fx.orgId,
      fx.recruiterUserId,
      fx.requisitionId,
      fx.candidateId,
      { limit: 50, offset: 0 },
    );
    expect(timeline).not.toBeNull();
    expect(timeline?.candidate.id).toBe(fx.candidateId);
    expect(timeline?.total).toBeGreaterThanOrEqual(3);
    const stages = timeline!.items.map((e) => e.toStage);
    expect(stages).toEqual(['RECRUITER_REVIEW', 'RECRUITER_SHORTLISTED', 'SUBMITTED_TO_CLIENT']);
    expect(timeline!.items[0]?.actorRole).toBe('RECRUITER');

    // Unassigned recruiter is denied timeline access
    const deniedTimeline = await repository.getCandidateTimeline!(
      fx.orgId,
      randomUUID(),
      fx.requisitionId,
      fx.candidateId,
      { limit: 50, offset: 0 },
    );
    expect(deniedTimeline).toBeNull();
  });
});
