import type { PrismaClient } from '@talentlens/database';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { createWorkflowRepository } from './workflow.repository.js';

const clientPrincipal: AuthenticatedPrincipal = {
  userId: 'client-user-1',
  organizationId: 'org-1',
  role: 'CLIENT_HIRING_MANAGER',
};

const recruiterPrincipal: AuthenticatedPrincipal = {
  userId: 'recruiter-1',
  organizationId: 'org-1',
  role: 'RECRUITER',
};

describe('workflow.repository client PII masking & tenant scoping', () => {
  it('listInterviews masks candidateCode for CLIENT_HIRING_MANAGER, enforces ACTIVE/org scoping, and blocks searching raw candidateCode', async () => {
    const findManyMock = vi.fn(async () => [
      {
        id: 'prop-1',
        submissionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
        requisitionId: 'req-1',
        proposerUserId: 'recruiter-1',
        proposerRole: 'RECRUITER',
        startAt: new Date('2026-11-20T10:00:00.000Z'),
        endAt: new Date('2026-11-20T11:00:00.000Z'),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'PROPOSED',
        reason: null,
        expiresAt: null,
        createdAt: new Date('2026-11-10T00:00:00.000Z'),
        updatedAt: new Date('2026-11-10T00:00:00.000Z'),
        submission: {
          id: '12345678-aaaa-bbbb-cccc-1234567890ab',
          candidateId: 'cand-1',
          clientId: 'client-1',
          status: 'INTERVIEW_PROPOSED',
          candidate: { id: 'cand-1', candidateCode: 'CAN-RAW-SECRET' },
          client: { name: 'Acme Financial' },
        },
        requisition: {
          id: 'req-1',
          title: 'Principal Engineer',
        },
      },
    ]);

    const mockDb = {
      clientMembership: {
        findMany: vi.fn(async () => [{ clientId: 'client-1' }]),
      },
      interviewProposal: {
        findMany: findManyMock,
      },
    } as unknown as PrismaClient;

    const repo = createWorkflowRepository(mockDb);

    // 1. Searching raw internal candidateCode returns zero hits for client
    const rawSearchResult = await repo.listInterviews!(clientPrincipal, {
      search: 'CAN-RAW-SECRET',
    });
    expect(rawSearchResult.items).toHaveLength(0);

    // Query includes org + ACTIVE + not-WITHDRAWN filters and avoids selecting raw candidateCode
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          submission: expect.objectContaining({
            organizationId: 'org-1',
            status: { not: 'WITHDRAWN' },
            candidate: { recordStatus: 'ACTIVE' },
          }),
        }),
        include: expect.objectContaining({
          submission: expect.objectContaining({
            select: expect.objectContaining({
              candidate: { select: { id: true } },
            }),
          }),
        }),
      }),
    );

    // 2. Searching masked submission reference returns the item with masked candidateCode
    const maskedSearchResult = await repo.listInterviews!(clientPrincipal, {
      search: 'CAND-SUB-12345678',
    });
    expect(maskedSearchResult.items).toHaveLength(1);
    expect(maskedSearchResult.items[0]!.candidateCode).toBe('CAND-SUB-12345678');

    // 3. Recruiter still sees raw candidateCode and can search by it
    const recruiterResult = await repo.listInterviews!(recruiterPrincipal, {
      search: 'CAN-RAW-SECRET',
    });
    expect(recruiterResult.items).toHaveLength(1);
    expect(recruiterResult.items[0]!.candidateCode).toBe('CAN-RAW-SECRET');
  });

  it('getClientDashboardSummary scopes every query by organizationId/ACTIVE and masks candidateCode and activity summaries', async () => {
    const submissionIdA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const submissionIdB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const submissionIdC = 'cccccccc-1111-2222-3333-444444444444';

    const candidateSubmissionFindMany = vi.fn(async () => [
      {
        id: submissionIdA,
        requisitionId: 'req-1',
        clientId: 'client-1',
        submittedAt: new Date('2026-11-10T01:00:00.000Z'),
        status: 'SUBMITTED',
        requisition: { id: 'req-1', title: 'Security Architect' },
        client: { id: 'client-1', name: 'Apex Bank' },
        assessment: { score: 88, criterionAssessments: [{ id: 'ca-1' }] },
      },
    ]);
    const interviewProposalFindMany = vi.fn(async () => [
      {
        id: 'prop-1',
        submissionId: submissionIdB,
        requisitionId: 'req-1',
        proposerUserId: 'recruiter-1',
        proposerRole: 'RECRUITER',
        startAt: new Date('2026-11-22T14:00:00.000Z'),
        endAt: new Date('2026-11-22T15:00:00.000Z'),
        timezone: 'UTC',
        format: 'VIDEO',
        status: 'ACCEPTED',
        reason: null,
        expiresAt: null,
        createdAt: new Date('2026-11-10T02:00:00.000Z'),
        updatedAt: new Date('2026-11-10T02:00:00.000Z'),
        submission: {
          candidateId: 'cand-2',
          requisition: {
            title: 'Security Architect',
            client: { id: 'client-1', name: 'Apex Bank' },
          },
        },
      },
    ]);
    const clientDecisionFindMany = vi.fn(async () => [
      {
        id: 'dec-1',
        decision: 'SHORTLIST',
        reason: 'Strong architecture depth',
        submissionId: submissionIdC,
        createdAt: new Date('2026-11-10T03:00:00.000Z'),
        submission: {
          requisition: { title: 'Security Architect' },
        },
      },
    ]);
    const requisitionFindMany = vi.fn(async () => [
      {
        id: 'req-1',
        title: 'Security Architect',
        clientId: 'client-1',
        client: { name: 'Apex Bank' },
        status: 'OPEN',
        submissions: [{ id: submissionIdA }],
        interviewProposals: [{ id: 'prop-1' }],
      },
    ]);
    const auditLogFindMany = vi.fn(async () => [
      {
        id: 'log-1',
        action: 'CANDIDATE_SUBMITTED_TO_CLIENT',
        resourceType: 'CandidateSubmission',
        createdAt: new Date('2026-11-10T01:00:00.000Z'),
        metadataJson: { submissionId: submissionIdA },
        actor: { role: 'RECRUITER' },
        candidate: { candidateCode: 'CAN-LEAK-NEVER' },
        requisition: { title: 'Security Architect' },
        client: { name: 'Apex Bank' },
      },
    ]);

    const mockDb = {
      clientMembership: {
        findMany: vi.fn(async () => [
          { clientId: 'client-1', client: { id: 'client-1', name: 'Apex Bank' } },
        ]),
      },
      candidateSubmission: { findMany: candidateSubmissionFindMany },
      interviewProposal: { findMany: interviewProposalFindMany },
      clientDecision: { findMany: clientDecisionFindMany },
      requisition: { findMany: requisitionFindMany },
      auditLog: { findMany: auditLogFindMany },
    } as unknown as PrismaClient;

    const repo = createWorkflowRepository(mockDb);
    const summary = await repo.getClientDashboardSummary!(clientPrincipal);

    expect(summary.pendingReviews[0]!.candidateCode).toBe('CAND-SUB-AAAAAAAA');
    expect(summary.upcomingInterviews[0]!.candidateCode).toBe('CAND-SUB-BBBBBBBB');
    expect(summary.recentDecisions[0]!.candidateCode).toBe('CAND-SUB-CCCCCCCC');
    expect(summary.recentActivity[0]!.summary).toContain('CAND-SUB-AAAAAAAA');
    expect(summary.recentActivity[0]!.summary).not.toContain('CAN-LEAK-NEVER');

    // Every query enforces organizationId + ACTIVE/non-WITHDRAWN where appropriate
    expect(candidateSubmissionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          candidate: { recordStatus: 'ACTIVE' },
        }),
      }),
    );
    expect(interviewProposalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          submission: expect.objectContaining({
            organizationId: 'org-1',
            status: { not: 'WITHDRAWN' },
            candidate: { recordStatus: 'ACTIVE' },
          }),
        }),
      }),
    );
    expect(clientDecisionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          submission: expect.objectContaining({
            organizationId: 'org-1',
            status: { not: 'WITHDRAWN' },
            candidate: { recordStatus: 'ACTIVE' },
          }),
        }),
      }),
    );
    expect(requisitionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
        }),
      }),
    );
    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
        }),
      }),
    );
  });
});

