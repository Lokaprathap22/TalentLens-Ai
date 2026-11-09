import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  clientAcceptInterview,
  clientRejectInterview,
  listInterviews,
  recruiterAcceptInterview,
  recruiterCompleteInterview,
  recruiterProposeAlternativeInterview,
  recruiterRejectInterview,
} from './interviews.api.js';
import { formatInterviewFormatLabel, formatInterviewSchedule } from './types.js';
import type { InterviewItem, ListInterviewsResponse } from './types.js';

const SAMPLE_INTERVIEW: InterviewItem = {
  id: 'int-1111-1111',
  submissionId: 'sub-1111-1111',
  requisitionId: 'req-1111-1111',
  requisitionTitle: 'Senior Distributed Engineer',
  clientId: 'cli-1111-1111',
  clientName: 'Acme Systems',
  candidateId: 'can-1111-1111',
  candidateCode: 'CAN-88421',
  proposerUserId: 'usr-1111-1111',
  proposerRole: 'CLIENT_HIRING_MANAGER',
  startAt: '2026-11-20T14:00:00.000Z',
  endAt: '2026-11-20T15:00:00.000Z',
  timezone: 'UTC',
  format: 'VIDEO',
  status: 'PROPOSED',
  reason: null,
  expiresAt: null,
  canAccept: true,
  canReject: true,
  canReschedule: true,
  canComplete: false,
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const SAMPLE_RESPONSE: ListInterviewsResponse = {
  items: [SAMPLE_INTERVIEW],
  total: 1,
  page: 1,
  pageSize: 15,
  totalPages: 1,
  counts: {
    total: 1,
    upcoming: 0,
    pendingAction: 1,
    completed: 0,
    rejected: 0,
  },
};

describe('interviews.api client suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listInterviews', () => {
    it('calls GET /interviews with default params and returns parsed response', async () => {
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(SAMPLE_RESPONSE);

      const res = await listInterviews();

      expect(getSpy).toHaveBeenCalledWith('/interviews', {});
      expect(res.items.length).toBe(1);
      expect(res.items[0]?.candidateCode).toBe('CAN-88421');
      expect(res.counts.pendingAction).toBe(1);
    });

    it('forwards query filters in query string', async () => {
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(SAMPLE_RESPONSE);

      await listInterviews({
        page: 2,
        pageSize: 10,
        search: 'CAN-88',
        statusCategory: 'PENDING_ACTION',
        clientId: 'cli-1111-1111',
        requisitionId: 'req-1111-1111',
        fromDate: '2026-11-01',
        toDate: '2026-11-30',
        sortBy: 'startAt',
        sortOrder: 'asc',
      });

      expect(getSpy).toHaveBeenCalledTimes(1);
      const url = getSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('pageSize=10');
      expect(url).toContain('search=CAN-88');
      expect(url).toContain('statusCategory=PENDING_ACTION');
      expect(url).toContain('clientId=cli-1111-1111');
      expect(url).toContain('requisitionId=req-1111-1111');
      expect(url).toContain('fromDate=2026-11-01');
      expect(url).toContain('toDate=2026-11-30');
      expect(url).toContain('sortBy=startAt');
      expect(url).toContain('sortOrder=asc');
    });

    it('rejects invalid or corrupted responses with 502 ApiError', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ bad: 'data' });

      await expect(listInterviews()).rejects.toThrow(ApiError);
    });
  });

  describe('recruiter actions', () => {
    it('recruiterAcceptInterview posts to correct endpoint', async () => {
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ success: true });

      const res = await recruiterAcceptInterview('req-1', 'sub-1', 'int-1');

      expect(postSpy).toHaveBeenCalledWith(
        '/requisitions/req-1/submissions/sub-1/interviews/int-1/accept',
        {},
      );
      expect(res.success).toBe(true);
    });

    it('recruiterRejectInterview validates reason and posts to reject endpoint', async () => {
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ success: true });

      const res = await recruiterRejectInterview(
        'req-1',
        'sub-1',
        'int-1',
        'Hiring manager unavailable',
      );

      expect(postSpy).toHaveBeenCalledWith(
        '/requisitions/req-1/submissions/sub-1/interviews/int-1/reject',
        { reason: 'Hiring manager unavailable' },
      );
      expect(res.success).toBe(true);
    });

    it('recruiterRejectInterview throws 400 when reason is empty', async () => {
      await expect(recruiterRejectInterview('req-1', 'sub-1', 'int-1', '   ')).rejects.toThrow(
        'A rejection reason is required.',
      );
    });

    it('recruiterProposeAlternativeInterview posts proposal body', async () => {
      const postSpy = vi
        .spyOn(apiClient, 'post')
        .mockResolvedValueOnce({ proposalId: 'new-int-1' });

      const res = await recruiterProposeAlternativeInterview('req-1', 'sub-1', {
        proposalId: 'int-1',
        startAt: '2026-11-21T10:00:00.000Z',
        endAt: '2026-11-21T11:00:00.000Z',
        timezone: 'UTC',
        format: 'VIDEO',
      });

      expect(postSpy).toHaveBeenCalledWith(
        '/requisitions/req-1/submissions/sub-1/interviews/propose',
        {
          proposalId: 'int-1',
          startAt: '2026-11-21T10:00:00.000Z',
          endAt: '2026-11-21T11:00:00.000Z',
          timezone: 'UTC',
          format: 'VIDEO',
        },
      );
      expect(res.proposalId).toBe('new-int-1');
    });

    it('recruiterCompleteInterview posts to complete endpoint', async () => {
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ success: true });

      const res = await recruiterCompleteInterview('req-1', 'sub-1', 'int-1');

      expect(postSpy).toHaveBeenCalledWith(
        '/requisitions/req-1/submissions/sub-1/interviews/int-1/complete',
        {},
      );
      expect(res.success).toBe(true);
    });
  });

  describe('client hiring manager actions', () => {
    it('clientAcceptInterview posts to client accept endpoint', async () => {
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ success: true });

      const res = await clientAcceptInterview('cli-1', 'sub-1', 'int-1');

      expect(postSpy).toHaveBeenCalledWith(
        '/clients/cli-1/submissions/sub-1/interviews/int-1/accept',
        {},
      );
      expect(res.success).toBe(true);
    });

    it('clientRejectInterview validates reason and posts to client reject endpoint', async () => {
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ success: true });

      const res = await clientRejectInterview('cli-1', 'sub-1', 'int-1', 'Schedule conflict');

      expect(postSpy).toHaveBeenCalledWith(
        '/clients/cli-1/submissions/sub-1/interviews/int-1/reject',
        { reason: 'Schedule conflict' },
      );
      expect(res.success).toBe(true);
    });

    it('clientRejectInterview throws 400 when reason is missing', async () => {
      await expect(clientRejectInterview('cli-1', 'sub-1', 'int-1', '')).rejects.toThrow(
        'A rejection reason is required.',
      );
    });
  });

  describe('helpers', () => {
    it('formats interview schedule into date and time range', () => {
      const { dateStr, timeRangeStr } = formatInterviewSchedule(
        '2026-11-20T14:00:00.000Z',
        '2026-11-20T15:00:00.000Z',
        'UTC',
      );
      expect(dateStr).toContain('2026');
      expect(timeRangeStr).toContain('2:00');
    });

    it('formats interview format labels', () => {
      expect(formatInterviewFormatLabel('VIDEO')).toBe('Video Call');
      expect(formatInterviewFormatLabel('PHONE')).toBe('Phone Call');
      expect(formatInterviewFormatLabel('IN_PERSON')).toBe('In Person');
    });
  });
});
