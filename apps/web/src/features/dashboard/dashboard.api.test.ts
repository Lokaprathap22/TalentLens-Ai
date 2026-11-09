import { describe, expect, it, vi, beforeEach } from 'vitest';

import { apiClient } from '../../lib/api-client.js';
import { fetchLiveDashboardData, isDashboardSummaryResponse } from './dashboard.api.js';

describe('dashboard.api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockRecruiterResponse = {
    role: 'RECRUITER',
    generatedAt: '2026-11-08T12:00:00.000Z',
    metrics: {
      totalActiveRequisitions: 5,
      requisitionsRequiringAttention: 2,
      candidatesInPipeline: 24,
      candidatesAwaitingAssessment: 4,
      candidatesAwaitingReview: 7,
      pendingClientDecisions: 3,
      upcomingConfirmedInterviews: 2,
    },
    pipelineStages: [
      { key: 'intake', label: 'Intake', count: 4, hint: 'Awaiting assessment' },
      { key: 'assessed', label: 'Assessed', count: 5, hint: 'Criteria evaluated' },
      { key: 'review', label: 'Review', count: 7, hint: 'Recruiter verification' },
      { key: 'shortlisted', label: 'Shortlisted', count: 3, hint: 'Approved for client' },
      { key: 'client', label: 'Client', count: 3, hint: 'With hiring manager' },
      { key: 'interview', label: 'Interview', count: 2, hint: 'Confirmed schedule' },
    ],
    recentRequisitions: [
      {
        id: 'req-1',
        title: 'Senior Distributed Systems Engineer',
        clientName: 'Acme Corp',
        status: 'OPEN' as const,
        candidatesCount: 12,
        awaitingReviewCount: 4,
        withClientCount: 2,
        updatedAt: '2026-11-08T10:00:00.000Z',
      },
    ],
    reviewQueue: [
      {
        candidateId: 'cand-1',
        requisitionId: 'req-1',
        candidateCode: 'CAN-8A4F1D',
        requisitionTitle: 'Senior Distributed Systems Engineer',
        assessmentStatus: 'COMPLETE' as const,
        score: 88,
        coverage: 92,
        consent: 'ACTIVE' as const,
        lastActivityAt: '2026-11-08T09:30:00.000Z',
      },
    ],
    upcomingInterviews: [
      {
        id: 'int-1',
        candidateCode: 'CAN-8A4F1D',
        requisitionTitle: 'Senior Distributed Systems Engineer',
        startAt: '2026-11-10T14:00:00.000Z',
        endAt: '2026-11-10T15:00:00.000Z',
        timezone: 'America/New_York',
        format: 'VIDEO' as const,
        status: 'ACCEPTED' as const,
      },
    ],
    recentActivity: [
      {
        id: 'act-1',
        kind: 'review_recorded',
        summary: 'Recruiter verified assessment for CAN-8A4F1D',
        actor: 'Jane Recruiter',
        createdAt: '2026-11-08T09:30:00.000Z',
      },
    ],
  };

  const mockClientResponse = {
    role: 'CLIENT_HIRING_MANAGER',
    generatedAt: '2026-11-08T12:00:00.000Z',
    metrics: {
      pendingCandidateReviews: 3,
      submittedAwaitingDecisions: 3,
      upcomingConfirmedInterviews: 1,
      recentDecisionsCount: 4,
      activeRequisitionsCount: 2,
    },
    pendingReviews: [
      {
        submissionId: 'sub-1',
        candidateCode: 'CAN-7B3E2C',
        requisitionId: 'req-1',
        requisitionTitle: 'Senior Distributed Systems Engineer',
        clientId: 'cli-1',
        clientName: 'Client 1',
        submittedAt: '2026-11-07T14:00:00.000Z',
        status: 'SUBMITTED' as const,
        criteriaCount: 4,
        advisoryScore: 92,
      },
    ],
    upcomingInterviews: [
      {
        id: 'int-2',
        candidateCode: 'CAN-7B3E2C',
        requisitionTitle: 'Senior Distributed Systems Engineer',
        startAt: '2026-11-11T10:00:00.000Z',
        endAt: '2026-11-11T11:00:00.000Z',
        timezone: 'Europe/London',
        format: 'VIDEO' as const,
        status: 'ACCEPTED' as const,
      },
    ],
    recentDecisions: [
      {
        id: 'dec-1',
        candidateCode: 'CAN-6C2D1B',
        requisitionTitle: 'Staff Backend Engineer',
        decision: 'SHORTLIST' as const,
        reason: 'Strong architectural experience',
        createdAt: '2026-11-06T15:00:00.000Z',
      },
    ],
    activeRequisitions: [
      {
        id: 'req-1',
        title: 'Senior Distributed Systems Engineer',
        clientId: 'cli-1',
        clientName: 'Client 1',
        status: 'OPEN' as const,
        activeSubmissionsCount: 3,
        interviewsCount: 1,
      },
    ],
    recentActivity: [
      {
        id: 'act-2',
        kind: 'submitted',
        summary: 'Candidate CAN-7B3E2C submitted for review',
        actor: 'Recruitment Team',
        createdAt: '2026-11-07T14:00:00.000Z',
      },
    ],
  };

  describe('isDashboardSummaryResponse', () => {
    it('accepts valid recruiter summary response', () => {
      expect(isDashboardSummaryResponse(mockRecruiterResponse)).toBe(true);
    });

    it('accepts valid client summary response', () => {
      expect(isDashboardSummaryResponse(mockClientResponse)).toBe(true);
    });

    it('rejects null, non-objects, and missing required fields', () => {
      expect(isDashboardSummaryResponse(null)).toBe(false);
      expect(isDashboardSummaryResponse('invalid')).toBe(false);
      expect(isDashboardSummaryResponse({ role: 'UNKNOWN' })).toBe(false);
      expect(isDashboardSummaryResponse({ role: 'RECRUITER' })).toBe(false);
      expect(
        isDashboardSummaryResponse({
          role: 'RECRUITER',
          generatedAt: '2026-11-08T00:00:00Z',
          metrics: {},
          pipelineStages: [],
          // missing reviewQueue, etc.
        }),
      ).toBe(false);
    });
  });

  describe('fetchLiveDashboardData', () => {
    it('fetches and maps recruiter dashboard data in a single request', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockRecruiterResponse);

      const data = await fetchLiveDashboardData();

      expect(apiClient.get).toHaveBeenCalledWith('/dashboard/summary', {});
      expect(data.role).toBe('RECRUITER');
      if (data.role === 'RECRUITER') {
        expect(data.metrics.totalActiveRequisitions).toBe(5);
        expect(data.metrics.candidatesAwaitingReview).toBe(7);
        expect(data.pipeline).toHaveLength(6);
        expect(data.requisitions).toHaveLength(1);
        expect(data.requisitions[0]?.title).toBe('Senior Distributed Systems Engineer');
        expect(data.reviewQueue).toHaveLength(1);
        expect(data.reviewQueue[0]?.candidateCode).toBe('CAN-8A4F1D');
        expect(data.interviews).toHaveLength(1);
        expect(data.interviews[0]?.timeZone).toBe('America/New_York');
        expect(data.activity).toHaveLength(1);
        expect(data.activity[0]?.kind).toBe('review_recorded');
      }
    });

    it('fetches and maps client hiring manager dashboard data', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockClientResponse);

      const data = await fetchLiveDashboardData();

      expect(apiClient.get).toHaveBeenCalledWith('/dashboard/summary', {});
      expect(data.role).toBe('CLIENT_HIRING_MANAGER');
      if (data.role === 'CLIENT_HIRING_MANAGER') {
        expect(data.metrics.pendingCandidateReviews).toBe(3);
        expect(data.metrics.upcomingConfirmedInterviews).toBe(1);
        expect(data.pendingReviews).toHaveLength(1);
        expect(data.pendingReviews[0]?.candidateCode).toBe('CAN-7B3E2C');
        expect(data.pendingReviews[0]?.advisoryScore).toBe(92);
        expect(data.recentDecisions).toHaveLength(1);
        expect(data.recentDecisions[0]?.decision).toBe('SHORTLIST');
        expect(data.activeRequisitions).toHaveLength(1);
        expect(data.activity).toHaveLength(1);
      }
    });

    it('throws ApiError with 502 status when the server returns invalid data', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ unexpected: true });

      await expect(fetchLiveDashboardData()).rejects.toThrow(
        'Received an unexpected dashboard summary response from the server.',
      );
    });

    it('passes AbortSignal to apiClient.get when provided', async () => {
      const controller = new AbortController();
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockRecruiterResponse);

      await fetchLiveDashboardData(controller.signal);

      expect(apiClient.get).toHaveBeenCalledWith('/dashboard/summary', {
        signal: controller.signal,
      });
    });
  });
});
