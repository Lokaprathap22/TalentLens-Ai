import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDatabaseClient } from '@talentlens/database';
import { createWorkflowRepository } from './workflow.repository.js';
import { createWorkflowService } from './workflow.service.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)('Interviews PostgreSQL Integration Suite', () => {
  async function createOrganizationFixture(namePrefix: string) {
    const db = getDatabaseClient();
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const org = await db.organization.create({
      data: {
        name: `${namePrefix} ${suffix}`,
        normalizedName: `${namePrefix.toLowerCase()}-${suffix}`,
      },
    });

    const recruiter = await db.user.create({
      data: {
        organizationId: org.id,
        email: `recruiter-${suffix}@example.com`,
        normalizedEmail: `recruiter-${suffix}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Recruiter ${suffix}`,
      },
    });

    const clientUser = await db.user.create({
      data: {
        organizationId: org.id,
        email: `client-hm-${suffix}@example.com`,
        normalizedEmail: `client-hm-${suffix}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Client HM ${suffix}`,
      },
    });

    const clientEntity = await db.client.create({
      data: {
        organizationId: org.id,
        name: `Client Alpha ${suffix}`,
        normalizedName: `client-alpha-${suffix}`,
        status: 'ACTIVE',
      },
    });

    const clientMembership = await db.clientMembership.create({
      data: {
        organizationId: org.id,
        clientId: clientEntity.id,
        userId: clientUser.id,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    const requisition = await db.requisition.create({
      data: {
        organizationId: org.id,
        clientId: clientEntity.id,
        title: `Senior Architect ${suffix}`,
        jdText: 'Job description text for senior architect.',
        status: 'OPEN',
        assignedRecruiterId: recruiter.id,
        createdById: recruiter.id,
      },
    });

    const scorecardVersion = await db.scorecardVersion.create({
      data: {
        organizationId: org.id,
        requisitionId: requisition.id,
        version: 1,
        status: 'APPROVED',
        weightsJson: {},
        approvedById: recruiter.id,
        approvedAt: new Date(),
      },
    });

    const candidate = await db.candidate.create({
      data: {
        organizationId: org.id,
        candidateCode: `CAN-${suffix.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    const batch = await db.processingBatch.create({
      data: {
        organizationId: org.id,
        requisitionId: requisition.id,
        createdById: recruiter.id,
        status: 'COMPLETED',
        totalFiles: 1,
      },
    });

    const resumeDoc = await db.resumeDocument.create({
      data: {
        organizationId: org.id,
        candidateId: candidate.id,
        objectKey: `resumes/${org.id}/${randomUUID()}.pdf`,
        sha256: randomBytes(32).toString('hex'),
        mimeType: 'application/pdf',
        fileType: 'PDF',
        sizeBytes: 1024n,
        version: 1,
        parseStatus: 'PARSED',
        uploadedById: recruiter.id,
      },
    });

    await db.processingJob.create({
      data: {
        organizationId: org.id,
        batchId: batch.id,
        resumeDocumentId: resumeDoc.id,
        jobType: 'VALIDATE_FILE',
        status: 'SUCCEEDED',
      },
    });

    const extraction = await db.documentExtraction.create({
      data: {
        organizationId: org.id,
        resumeDocumentId: resumeDoc.id,
        version: 1,
        extractedText: 'Extracted resume text',
        pageMapJson: {},
        parser: 'test-parser',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      },
    });

    const asmtText = await db.assessmentText.create({
      data: {
        organizationId: org.id,
        resumeDocumentId: resumeDoc.id,
        documentExtractionId: extraction.id,
        version: 1,
        redactedText: 'Redacted resume text',
        redactorVersion: '2026-11-redactor-v1',
        pageMapJson: [],
        redactionMapJson: [],
      },
    });

    const assessment = await db.candidateAssessment.create({
      data: {
        organizationId: org.id,
        requisitionId: requisition.id,
        candidateId: candidate.id,
        resumeDocumentId: resumeDoc.id,
        documentExtractionId: extraction.id,
        scorecardVersionId: scorecardVersion.id,
        assessmentTextId: asmtText.id,
        score: 88.5,
        coverage: 92.0,
        status: 'COMPLETE',
        formulaVersion: 'v1',
        modelMetadataJson: {},
      },
    });

    const review = await db.candidateReview.create({
      data: {
        organizationId: org.id,
        candidateId: candidate.id,
        requisitionId: requisition.id,
        resumeDocumentId: resumeDoc.id,
        reviewerId: recruiter.id,
        decision: 'REVIEWED',
      },
    });

    const submission = await db.candidateSubmission.create({
      data: {
        organizationId: org.id,
        candidateId: candidate.id,
        requisitionId: requisition.id,
        clientId: clientEntity.id,
        submittedById: recruiter.id,
        assessmentId: assessment.id,
        reviewId: review.id,
        resumeDocumentId: resumeDoc.id,
        status: 'SUBMITTED',
      },
    });

    return {
      org,
      recruiter,
      clientUser,
      clientEntity,
      clientMembership,
      requisition,
      candidate,
      submission,
      suffix,
    };
  }

  it('enforces organization boundary isolation between two tenants', async () => {
    const db = getDatabaseClient();
    const repo = createWorkflowRepository(db);
    const service = createWorkflowService(repo);

    const fixtureA = await createOrganizationFixture('OrgA');
    const fixtureB = await createOrganizationFixture('OrgB');

    // Create interview proposal in Org A
    const now = new Date();
    const interviewA = await db.interviewProposal.create({
      data: {
        organizationId: fixtureA.org.id,
        submissionId: fixtureA.submission.id,
        requisitionId: fixtureA.requisition.id,
        proposerUserId: fixtureA.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 86400000), // tomorrow
        endAt: new Date(now.getTime() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // Create interview proposal in Org B
    const interviewB = await db.interviewProposal.create({
      data: {
        organizationId: fixtureB.org.id,
        submissionId: fixtureB.submission.id,
        requisitionId: fixtureB.requisition.id,
        proposerUserId: fixtureB.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 172800000), // 2 days later
        endAt: new Date(now.getTime() + 176400000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // Query as Recruiter A
    const resA = await service.listInterviews(
      {
        userId: fixtureA.recruiter.id,
        organizationId: fixtureA.org.id,
        role: 'RECRUITER',
      },
      { page: 1, pageSize: 20 },
    );

    const idsA = resA.items.map((i) => i.id);
    expect(idsA).toContain(interviewA.id);
    expect(idsA).not.toContain(interviewB.id);

    // Query as Recruiter B
    const resB = await service.listInterviews(
      {
        userId: fixtureB.recruiter.id,
        organizationId: fixtureB.org.id,
        role: 'RECRUITER',
      },
      { page: 1, pageSize: 20 },
    );

    const idsB = resB.items.map((i) => i.id);
    expect(idsB).toContain(interviewB.id);
    expect(idsB).not.toContain(interviewA.id);
  });

  it('enforces client membership isolation between two clients within the same organization', async () => {
    const db = getDatabaseClient();
    const repo = createWorkflowRepository(db);
    const service = createWorkflowService(repo);

    const fx = await createOrganizationFixture('SharedOrg');

    // Create a second client and second hiring manager in the same org
    const suffix2 = Date.now().toString(36) + 'c2';
    const client2 = await db.client.create({
      data: {
        organizationId: fx.org.id,
        name: `Client Beta ${suffix2}`,
        normalizedName: `client-beta-${suffix2}`,
        status: 'ACTIVE',
      },
    });

    const clientUser2 = await db.user.create({
      data: {
        organizationId: fx.org.id,
        email: `client-hm-2-${suffix2}@example.com`,
        normalizedEmail: `client-hm-2-${suffix2}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Client HM 2 ${suffix2}`,
      },
    });

    await db.clientMembership.create({
      data: {
        organizationId: fx.org.id,
        clientId: client2.id,
        userId: clientUser2.id,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    const req2 = await db.requisition.create({
      data: {
        organizationId: fx.org.id,
        clientId: client2.id,
        title: `Client 2 Position ${suffix2}`,
        jdText: 'JD for client 2',
        status: 'OPEN',
        assignedRecruiterId: fx.recruiter.id,
        createdById: fx.recruiter.id,
      },
    });

    const sc2 = await db.scorecardVersion.create({
      data: {
        organizationId: fx.org.id,
        requisitionId: req2.id,
        version: 1,
        status: 'APPROVED',
        weightsJson: {},
        approvedById: fx.recruiter.id,
        approvedAt: new Date(),
      },
    });

    const cand2 = await db.candidate.create({
      data: {
        organizationId: fx.org.id,
        candidateCode: `CAN-C2-${suffix2.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    const resume2 = await db.resumeDocument.create({
      data: {
        organizationId: fx.org.id,
        candidateId: cand2.id,
        objectKey: `resumes/${fx.org.id}/${randomUUID()}.pdf`,
        sha256: randomBytes(32).toString('hex'),
        mimeType: 'application/pdf',
        fileType: 'PDF',
        sizeBytes: 1024n,
        version: 1,
        parseStatus: 'PARSED',
        uploadedById: fx.recruiter.id,
      },
    });

    const ext2 = await db.documentExtraction.create({
      data: {
        organizationId: fx.org.id,
        resumeDocumentId: resume2.id,
        version: 1,
        extractedText: 'Extracted resume text 2',
        pageMapJson: {},
        parser: 'test-parser',
        ocrUsed: false,
        qualityStatus: 'COMPLETE',
      },
    });

    const txt2 = await db.assessmentText.create({
      data: {
        organizationId: fx.org.id,
        resumeDocumentId: resume2.id,
        documentExtractionId: ext2.id,
        version: 1,
        redactedText: 'Redacted resume text 2',
        redactorVersion: '2026-11-redactor-v1',
        pageMapJson: [],
        redactionMapJson: [],
      },
    });

    const asmt2 = await db.candidateAssessment.create({
      data: {
        organizationId: fx.org.id,
        requisitionId: req2.id,
        candidateId: cand2.id,
        resumeDocumentId: resume2.id,
        documentExtractionId: ext2.id,
        scorecardVersionId: sc2.id,
        assessmentTextId: txt2.id,
        score: 75.0,
        coverage: 80.0,
        status: 'COMPLETE',
        formulaVersion: 'v1',
        modelMetadataJson: {},
      },
    });

    const rev2 = await db.candidateReview.create({
      data: {
        organizationId: fx.org.id,
        candidateId: cand2.id,
        requisitionId: req2.id,
        resumeDocumentId: resume2.id,
        reviewerId: fx.recruiter.id,
        decision: 'REVIEWED',
      },
    });

    const sub2 = await db.candidateSubmission.create({
      data: {
        organizationId: fx.org.id,
        candidateId: cand2.id,
        requisitionId: req2.id,
        clientId: client2.id,
        submittedById: fx.recruiter.id,
        assessmentId: asmt2.id,
        reviewId: rev2.id,
        resumeDocumentId: resume2.id,
        status: 'SUBMITTED',
      },
    });

    // Create interview for Client 1
    const now = new Date();
    const interview1 = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: fx.submission.id,
        requisitionId: fx.requisition.id,
        proposerUserId: fx.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 86400000),
        endAt: new Date(now.getTime() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // Create interview for Client 2
    const interview2 = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: sub2.id,
        requisitionId: req2.id,
        proposerUserId: fx.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 100000000),
        endAt: new Date(now.getTime() + 103600000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // Query as Client HM 1 (authorized only for Client 1)
    const resHM1 = await service.listInterviews(
      {
        userId: fx.clientUser.id,
        organizationId: fx.org.id,
        role: 'CLIENT_HIRING_MANAGER',
      },
      { page: 1, pageSize: 20 },
    );

    const idsHM1 = resHM1.items.map((i) => i.id);
    expect(idsHM1).toContain(interview1.id);
    expect(idsHM1).not.toContain(interview2.id);

    // Query as Client HM 2 (authorized only for Client 2)
    const resHM2 = await service.listInterviews(
      {
        userId: clientUser2.id,
        organizationId: fx.org.id,
        role: 'CLIENT_HIRING_MANAGER',
      },
      { page: 1, pageSize: 20 },
    );

    const idsHM2 = resHM2.items.map((i) => i.id);
    expect(idsHM2).toContain(interview2.id);
    expect(idsHM2).not.toContain(interview1.id);

    // Query as Recruiter (authorized for both in this organization)
    const resRecruiter = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      { page: 1, pageSize: 20 },
    );

    const idsRecruiter = resRecruiter.items.map((i) => i.id);
    expect(idsRecruiter).toContain(interview1.id);
    expect(idsRecruiter).toContain(interview2.id);
  });

  it('correctly handles status categories, action flags, search, and date filters', async () => {
    const db = getDatabaseClient();
    const repo = createWorkflowRepository(db);
    const service = createWorkflowService(repo);

    const fx = await createOrganizationFixture('StatusOrg');
    const now = new Date();

    // 1. Pending Action for Recruiter: proposed by Client HM
    const proposalFromClient = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: fx.submission.id,
        requisitionId: fx.requisition.id,
        proposerUserId: fx.clientUser.id,
        proposerRole: 'CLIENT_HIRING_MANAGER',
        startAt: new Date(now.getTime() + 86400000),
        endAt: new Date(now.getTime() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // 1b. Pending Action for Client: proposed by Recruiter
    const proposalFromRecruiter = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: fx.submission.id,
        requisitionId: fx.requisition.id,
        proposerUserId: fx.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 120000000),
        endAt: new Date(now.getTime() + 123600000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
      },
    });

    // 2. Upcoming Accepted Interview
    const acceptedInterview = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: fx.submission.id,
        requisitionId: fx.requisition.id,
        proposerUserId: fx.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() + 172800000), // in 2 days
        endAt: new Date(now.getTime() + 176400000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'ACCEPTED',
      },
    });

    // 3. Completed Interview
    const completedInterview = await db.interviewProposal.create({
      data: {
        organizationId: fx.org.id,
        submissionId: fx.submission.id,
        requisitionId: fx.requisition.id,
        proposerUserId: fx.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(now.getTime() - 86400000), // yesterday
        endAt: new Date(now.getTime() - 82800000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'COMPLETED',
      },
    });

    // Recruiter view: verify action flags for proposal from client
    const resRecruiterPending = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      { statusCategory: 'PENDING_ACTION' },
    );

    const itemPendingRecruiter = resRecruiterPending.items.find(
      (i) => i.id === proposalFromClient.id,
    );
    expect(itemPendingRecruiter).toBeDefined();
    expect(itemPendingRecruiter?.canAccept).toBe(true);
    expect(itemPendingRecruiter?.canReject).toBe(true);
    expect(itemPendingRecruiter?.canReschedule).toBe(true);
    expect(itemPendingRecruiter?.canComplete).toBe(false);

    // Client view: verify action flags for proposal from recruiter (client can accept/reject recruiter's proposal)
    const resClientPending = await service.listInterviews(
      {
        userId: fx.clientUser.id,
        organizationId: fx.org.id,
        role: 'CLIENT_HIRING_MANAGER',
      },
      { statusCategory: 'PENDING_ACTION' },
    );

    const itemPendingClient = resClientPending.items.find((i) => i.id === proposalFromRecruiter.id);
    expect(itemPendingClient).toBeDefined();
    expect(itemPendingClient?.canAccept).toBe(true);
    expect(itemPendingClient?.canReject).toBe(true);

    // Client view: in ALL proposals, verify client cannot accept their own proposal
    const resClientAll = await service.listInterviews(
      {
        userId: fx.clientUser.id,
        organizationId: fx.org.id,
        role: 'CLIENT_HIRING_MANAGER',
      },
      { statusCategory: 'ALL' },
    );

    const itemClientOwnProposal = resClientAll.items.find((i) => i.id === proposalFromClient.id);
    expect(itemClientOwnProposal).toBeDefined();
    expect(itemClientOwnProposal?.canAccept).toBe(false);
    expect(itemClientOwnProposal?.canReject).toBe(false);

    // Verify UPCOMING category
    const resUpcoming = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      { statusCategory: 'UPCOMING' },
    );

    const itemUpcoming = resUpcoming.items.find((i) => i.id === acceptedInterview.id);
    expect(itemUpcoming).toBeDefined();
    expect(itemUpcoming?.canComplete).toBe(true); // Recruiter can mark complete

    // Verify COMPLETED category
    const resCompleted = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      { statusCategory: 'COMPLETED' },
    );

    const itemCompleted = resCompleted.items.find((i) => i.id === completedInterview.id);
    expect(itemCompleted).toBeDefined();
    expect(itemCompleted?.status).toBe('COMPLETED');
    expect(itemCompleted?.canAccept).toBe(false);
    expect(itemCompleted?.canReject).toBe(false);
    expect(itemCompleted?.canComplete).toBe(false);

    // Verify Search by candidate code
    const resSearch = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      { search: fx.candidate.candidateCode },
    );
    expect(resSearch.items.length).toBeGreaterThanOrEqual(3);

    // Verify Date Range filter
    const resDateFilter = await service.listInterviews(
      {
        userId: fx.recruiter.id,
        organizationId: fx.org.id,
        role: 'RECRUITER',
      },
      {
        fromDate: new Date(now.getTime() - 100000000).toISOString(),
        toDate: new Date(now.getTime() - 50000000).toISOString(),
      },
    );
    expect(resDateFilter.items.some((i) => i.id === completedInterview.id)).toBe(true);
    expect(resDateFilter.items.some((i) => i.id === acceptedInterview.id)).toBe(false);

    // Verify counts
    expect(resRecruiterPending.counts.total).toBeGreaterThanOrEqual(3);
    expect(resRecruiterPending.counts.upcoming).toBeGreaterThanOrEqual(1);
    expect(resRecruiterPending.counts.pendingAction).toBeGreaterThanOrEqual(1);
    expect(resRecruiterPending.counts.completed).toBeGreaterThanOrEqual(1);
  });
});
