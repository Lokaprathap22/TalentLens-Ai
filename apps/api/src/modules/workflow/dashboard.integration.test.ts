import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDatabaseClient } from '@talentlens/database';
import { createWorkflowRepository } from './workflow.repository.js';
import { createWorkflowService } from './workflow.service.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)('Dashboard PostgreSQL Integration Suite', () => {
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

    const clientUserA = await db.user.create({
      data: {
        organizationId: org.id,
        email: `client-hm-a-${suffix}@example.com`,
        normalizedEmail: `client-hm-a-${suffix}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Client HM A ${suffix}`,
      },
    });

    const clientEntityA = await db.client.create({
      data: {
        organizationId: org.id,
        name: `Client Alpha ${suffix}`,
        normalizedName: `client-alpha-${suffix}`,
        status: 'ACTIVE',
      },
    });

    const clientMembershipA = await db.clientMembership.create({
      data: {
        organizationId: org.id,
        clientId: clientEntityA.id,
        userId: clientUserA.id,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    const clientUserB = await db.user.create({
      data: {
        organizationId: org.id,
        email: `client-hm-b-${suffix}@example.com`,
        normalizedEmail: `client-hm-b-${suffix}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Client HM B ${suffix}`,
      },
    });

    const clientEntityB = await db.client.create({
      data: {
        organizationId: org.id,
        name: `Client Beta ${suffix}`,
        normalizedName: `client-beta-${suffix}`,
        status: 'ACTIVE',
      },
    });

    const clientMembershipB = await db.clientMembership.create({
      data: {
        organizationId: org.id,
        clientId: clientEntityB.id,
        userId: clientUserB.id,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    const reqA = await db.requisition.create({
      data: {
        organizationId: org.id,
        clientId: clientEntityA.id,
        title: `Senior Platform Architect ${suffix}`,
        jdText: 'Job description for Senior Platform Architect.',
        status: 'OPEN',
        createdById: recruiter.id,
        assignedRecruiterId: recruiter.id,
      },
    });

    const reqB = await db.requisition.create({
      data: {
        organizationId: org.id,
        clientId: clientEntityB.id,
        title: `Lead Systems Engineer ${suffix}`,
        jdText: 'Job description for Lead Systems Engineer.',
        status: 'OPEN',
        createdById: recruiter.id,
        assignedRecruiterId: recruiter.id,
      },
    });

    return {
      org,
      recruiter,
      clientUserA,
      clientEntityA,
      clientMembershipA,
      clientUserB,
      clientEntityB,
      clientMembershipB,
      reqA,
      reqB,
    };
  }

  async function createCandidateSubmissionFixture(
    orgId: string,
    reqId: string,
    clientId: string,
    recruiterId: string,
    candidateCode: string,
    status: 'SUBMITTED' | 'WITHDRAWN' = 'SUBMITTED',
  ) {
    const db = getDatabaseClient();

    const candidate = await db.candidate.create({
      data: {
        organizationId: orgId,
        candidateCode,
        recordStatus: 'ACTIVE',
      },
    });

    const resume = await db.resumeDocument.create({
      data: {
        organizationId: orgId,
        candidateId: candidate.id,
        objectKey: `resumes/${candidate.id}.pdf`,
        sha256: randomBytes(32).toString('hex'),
        mimeType: 'application/pdf',
        fileType: 'PDF',
        sizeBytes: 1024n,
        version: 1,
        parseStatus: 'PARSED',
        uploadedById: recruiterId,
      },
    });

    const extraction = await db.documentExtraction.create({
      data: {
        organizationId: orgId,
        resumeDocumentId: resume.id,
        version: 1,
        extractedText: 'Sample extracted resume text with verified skills.',
        pageMapJson: {},
        parser: 'pdf-parser',
        qualityStatus: 'COMPLETE',
      },
    });

    const assessmentText = await db.assessmentText.create({
      data: {
        organizationId: orgId,
        documentExtractionId: extraction.id,
        resumeDocumentId: resume.id,
        version: 1,
        redactedText: 'Sample redacted resume text.',
        pageMapJson: {},
        redactionMapJson: {},
        redactorVersion: 'v1.0.0',
      },
    });

    const scorecardVersion = await db.scorecardVersion.upsert({
      where: {
        requisitionId_version: {
          requisitionId: reqId,
          version: 1,
        },
      },
      create: {
        organizationId: orgId,
        requisitionId: reqId,
        version: 1,
        status: 'APPROVED',
        weightsJson: { skills: 100 },
        approvedById: recruiterId,
        approvedAt: new Date(),
      },
      update: {},
    });

    const assessment = await db.candidateAssessment.create({
      data: {
        organizationId: orgId,
        requisitionId: reqId,
        candidateId: candidate.id,
        resumeDocumentId: resume.id,
        documentExtractionId: extraction.id,
        scorecardVersionId: scorecardVersion.id,
        assessmentTextId: assessmentText.id,
        score: 87.5,
        coverage: 95.0,
        status: 'COMPLETE',
        formulaVersion: 'v1',
        modelMetadataJson: {},
      },
    });

    const review = await db.candidateReview.create({
      data: {
        organizationId: orgId,
        candidateId: candidate.id,
        requisitionId: reqId,
        resumeDocumentId: resume.id,
        reviewerId: recruiterId,
        decision: 'REVIEWED',
        notesInternal: 'Strong technical qualifications.',
      },
    });

    const submission = await db.candidateSubmission.create({
      data: {
        organizationId: orgId,
        candidateId: candidate.id,
        requisitionId: reqId,
        clientId,
        submittedById: recruiterId,
        assessmentId: assessment.id,
        reviewId: review.id,
        resumeDocumentId: resume.id,
        status,
      },
    });

    return { candidate, resume, assessment, review, submission };
  }

  it('1. calculates real operational metrics for recruiter dashboard', async () => {
    const f = await createOrganizationFixture('Recruiter Metrics Org');
    const db = getDatabaseClient();

    // Create 2 candidate submissions under reqA for Client A
    const sub1 = await createCandidateSubmissionFixture(
      f.org.id,
      f.reqA.id,
      f.clientEntityA.id,
      f.recruiter.id,
      `CAN-${randomUUID().slice(0, 6).toUpperCase()}`,
      'SUBMITTED',
    );

    await createCandidateSubmissionFixture(
      f.org.id,
      f.reqA.id,
      f.clientEntityA.id,
      f.recruiter.id,
      `CAN-${randomUUID().slice(0, 6).toUpperCase()}`,
      'SUBMITTED',
    );

    // Create 1 confirmed upcoming interview
    await db.interviewProposal.create({
      data: {
        organizationId: f.org.id,
        submissionId: sub1.submission.id,
        requisitionId: f.reqA.id,
        proposerUserId: f.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(Date.now() + 86400000), // tomorrow
        endAt: new Date(Date.now() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'ACCEPTED',
      },
    });

    // Create an audit log record
    await db.auditLog.create({
      data: {
        organizationId: f.org.id,
        actorId: f.recruiter.id,
        action: 'CANDIDATE_SUBMITTED_TO_CLIENT',
        resourceType: 'CandidateSubmission',
        resourceId: sub1.submission.id,
        requisitionId: f.reqA.id,
        clientId: f.clientEntityA.id,
        candidateId: sub1.candidate.id,
        metadataJson: { submissionId: sub1.submission.id },
      },
    });

    const repository = createWorkflowRepository(db);
    const service = createWorkflowService(repository);

    const summary = await service.getDashboardSummary({
      userId: f.recruiter.id,
      organizationId: f.org.id,
      role: 'RECRUITER',
    });

    expect(summary.role).toBe('RECRUITER');
    if (summary.role === 'RECRUITER') {
      expect(summary.metrics.totalActiveRequisitions).toBe(2);
      expect(summary.metrics.candidatesInPipeline).toBe(2);
      expect(summary.metrics.pendingClientDecisions).toBe(2);
      expect(summary.metrics.upcomingConfirmedInterviews).toBe(1);
      expect(summary.pipelineStages).toHaveLength(6);
      expect(summary.recentRequisitions.length).toBeGreaterThanOrEqual(1);
      expect(summary.upcomingInterviews).toHaveLength(1);
      expect(summary.recentActivity.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('2. enforces strict client membership isolation on client hiring manager dashboard', async () => {
    const f = await createOrganizationFixture('Client Isolation Org');
    const db = getDatabaseClient();

    // Create submission for Client A
    const subA = await createCandidateSubmissionFixture(
      f.org.id,
      f.reqA.id,
      f.clientEntityA.id,
      f.recruiter.id,
      `CAN-A-${randomUUID().slice(0, 4).toUpperCase()}`,
      'SUBMITTED',
    );

    // Create submission for Client B
    const subB = await createCandidateSubmissionFixture(
      f.org.id,
      f.reqB.id,
      f.clientEntityB.id,
      f.recruiter.id,
      `CAN-B-${randomUUID().slice(0, 4).toUpperCase()}`,
      'SUBMITTED',
    );

    // Create interview for Client B
    await db.interviewProposal.create({
      data: {
        organizationId: f.org.id,
        submissionId: subB.submission.id,
        requisitionId: f.reqB.id,
        proposerUserId: f.recruiter.id,
        proposerRole: 'RECRUITER',
        startAt: new Date(Date.now() + 86400000),
        endAt: new Date(Date.now() + 90000000),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'ACCEPTED',
      },
    });

    const repository = createWorkflowRepository(db);
    const service = createWorkflowService(repository);

    // Query dashboard as Client A hiring manager
    const summaryA = await service.getDashboardSummary({
      userId: f.clientUserA.id,
      organizationId: f.org.id,
      role: 'CLIENT_HIRING_MANAGER',
    });

    expect(summaryA.role).toBe('CLIENT_HIRING_MANAGER');
    if (summaryA.role === 'CLIENT_HIRING_MANAGER') {
      // Must only see Client A submission
      expect(summaryA.metrics.pendingCandidateReviews).toBe(1);
      expect(summaryA.pendingReviews).toHaveLength(1);
      expect(summaryA.pendingReviews[0]?.submissionId).toBe(subA.submission.id);
      expect(summaryA.pendingReviews[0]?.clientId).toBe(f.clientEntityA.id);

      // Must NOT see Client B's interview
      expect(summaryA.upcomingInterviews).toHaveLength(0);

      // Must only see Client A requisition
      expect(summaryA.activeRequisitions.every((r) => r.clientId === f.clientEntityA.id)).toBe(
        true,
      );
    }
  });

  it('3. safely excludes withdrawn candidate submissions from active dashboard counts', async () => {
    const f = await createOrganizationFixture('Withdrawn Exclusion Org');

    // Create 1 active submission and 1 withdrawn submission under reqA
    await createCandidateSubmissionFixture(
      f.org.id,
      f.reqA.id,
      f.clientEntityA.id,
      f.recruiter.id,
      `CAN-ACT-${randomUUID().slice(0, 4).toUpperCase()}`,
      'SUBMITTED',
    );

    await createCandidateSubmissionFixture(
      f.org.id,
      f.reqA.id,
      f.clientEntityA.id,
      f.recruiter.id,
      `CAN-WTH-${randomUUID().slice(0, 4).toUpperCase()}`,
      'WITHDRAWN',
    );

    const repository = createWorkflowRepository(getDatabaseClient());
    const service = createWorkflowService(repository);

    // Check recruiter dashboard
    const recruiterSummary = await service.getDashboardSummary({
      userId: f.recruiter.id,
      organizationId: f.org.id,
      role: 'RECRUITER',
    });

    if (recruiterSummary.role === 'RECRUITER') {
      // Only 1 active pending client decision
      expect(recruiterSummary.metrics.pendingClientDecisions).toBe(1);
    }

    // Check client hiring manager dashboard
    const clientSummary = await service.getDashboardSummary({
      userId: f.clientUserA.id,
      organizationId: f.org.id,
      role: 'CLIENT_HIRING_MANAGER',
    });

    if (clientSummary.role === 'CLIENT_HIRING_MANAGER') {
      // Only 1 pending review (withdrawn excluded)
      expect(clientSummary.metrics.pendingCandidateReviews).toBe(1);
      expect(clientSummary.pendingReviews).toHaveLength(1);
    }
  });

  it('4. safely handles empty tables without throwing runtime errors', async () => {
    const db = getDatabaseClient();
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const emptyOrg = await db.organization.create({
      data: {
        name: `Empty Dashboard Org ${suffix}`,
        normalizedName: `empty-dash-${suffix}`,
      },
    });

    const recruiter = await db.user.create({
      data: {
        organizationId: emptyOrg.id,
        email: `empty-recruiter-${suffix}@example.com`,
        normalizedEmail: `empty-recruiter-${suffix}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Recruiter ${suffix}`,
      },
    });

    const clientUser = await db.user.create({
      data: {
        organizationId: emptyOrg.id,
        email: `empty-client-${suffix}@example.com`,
        normalizedEmail: `empty-client-${suffix}@example.com`,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
        name: `Client HM ${suffix}`,
      },
    });

    const repository = createWorkflowRepository(db);
    const service = createWorkflowService(repository);

    // Recruiter on empty organization
    const recruiterSummary = await service.getDashboardSummary({
      userId: recruiter.id,
      organizationId: emptyOrg.id,
      role: 'RECRUITER',
    });

    expect(recruiterSummary.role).toBe('RECRUITER');
    if (recruiterSummary.role === 'RECRUITER') {
      expect(recruiterSummary.metrics.totalActiveRequisitions).toBe(0);
      expect(recruiterSummary.metrics.candidatesInPipeline).toBe(0);
      expect(recruiterSummary.metrics.pendingClientDecisions).toBe(0);
      expect(recruiterSummary.metrics.upcomingConfirmedInterviews).toBe(0);
      expect(recruiterSummary.recentRequisitions).toHaveLength(0);
      expect(recruiterSummary.reviewQueue).toHaveLength(0);
      expect(recruiterSummary.upcomingInterviews).toHaveLength(0);
      expect(recruiterSummary.recentActivity).toHaveLength(0);
    }

    // Client hiring manager on empty organization (no memberships)
    const clientSummary = await service.getDashboardSummary({
      userId: clientUser.id,
      organizationId: emptyOrg.id,
      role: 'CLIENT_HIRING_MANAGER',
    });

    expect(clientSummary.role).toBe('CLIENT_HIRING_MANAGER');
    if (clientSummary.role === 'CLIENT_HIRING_MANAGER') {
      expect(clientSummary.metrics.pendingCandidateReviews).toBe(0);
      expect(clientSummary.pendingReviews).toHaveLength(0);
      expect(clientSummary.upcomingInterviews).toHaveLength(0);
      expect(clientSummary.recentDecisions).toHaveLength(0);
      expect(clientSummary.activeRequisitions).toHaveLength(0);
      expect(clientSummary.recentActivity).toHaveLength(0);
    }
  });
});
