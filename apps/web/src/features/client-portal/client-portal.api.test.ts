import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  getClientSubmission,
  listAuthorizedClients,
  listClientSubmissions,
  recordClientFeedback,
  resolveClientPortalErrorMessage,
} from './client-portal.api.js';

describe('client-portal.api', () => {
  const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
  const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listAuthorizedClients', () => {
    it('retrieves clients array from GET /clients', async () => {
      const mockClients = [
        {
          id: CLIENT_ID,
          name: 'Acme Corp',
          status: 'ACTIVE',
        },
      ];
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ clients: mockClients });

      const result = await listAuthorizedClients();

      expect(getSpy).toHaveBeenCalledWith('/clients');
      expect(result).toEqual(mockClients);
    });
  });

  describe('listClientSubmissions', () => {
    it('fetches submissions for client', async () => {
      const mockSubmissions = [
        {
          submissionId: SUBMISSION_ID,
          candidateRef: 'CAND-SUB-1234',
          requisitionId: 'req-1',
          requisitionTitle: 'Senior Full Stack Engineer',
          status: 'SUBMITTED',
          submittedAt: '2026-11-06T00:00:00.000Z',
          assessmentSummary: {
            score: 88,
            coverage: 1,
            status: 'COMPLETED',
            criteriaCount: 4,
          },
          latestDecision: null,
        },
      ];
      const getSpy = vi
        .spyOn(apiClient, 'get')
        .mockResolvedValueOnce({ submissions: mockSubmissions });

      const result = await listClientSubmissions(CLIENT_ID);

      expect(getSpy).toHaveBeenCalledWith(`/clients/${CLIENT_ID}/submissions`);
      expect(result).toEqual(mockSubmissions);
    });

    it('rejects empty clientId with 400', async () => {
      await expect(listClientSubmissions('   ')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('getClientSubmission', () => {
    it('fetches masked submission detail', async () => {
      const mockDetail = {
        submissionId: SUBMISSION_ID,
        candidateRef: 'CAND-SUB-1234',
        requisitionId: 'req-1',
        requisitionTitle: 'Senior Full Stack Engineer',
        status: 'SUBMITTED',
        submittedAt: '2026-11-06T00:00:00.000Z',
        assessment: {
          score: 88,
          coverage: 1,
          status: 'COMPLETED',
          criteria: [
            {
              label: 'TypeScript Experience',
              category: 'Technical',
              requirementType: 'MUST_HAVE',
              status: 'MET',
              reasoning: 'Demonstrated 5+ years building TS applications.',
              verifiedQuotes: ['Lead TypeScript developer at Acme.'],
            },
          ],
        },
        feedbackHistory: [],
      };
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockDetail);

      const result = await getClientSubmission(CLIENT_ID, SUBMISSION_ID);

      expect(getSpy).toHaveBeenCalledWith(`/clients/${CLIENT_ID}/submissions/${SUBMISSION_ID}`);
      expect(result).toEqual(mockDetail);
    });

    it('rejects invalid parameters with 400', async () => {
      await expect(getClientSubmission('', SUBMISSION_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(getClientSubmission(CLIENT_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('recordClientFeedback', () => {
    it('records shortlist decision with optional notes', async () => {
      const mockResponse = {
        id: 'fb-1',
        decision: 'SHORTLIST',
        createdAt: '2026-11-06T00:00:00.000Z',
      };
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResponse);

      const result = await recordClientFeedback(CLIENT_ID, SUBMISSION_ID, {
        decision: 'SHORTLIST',
        reason: 'Strong candidate match',
      });

      expect(postSpy).toHaveBeenCalledWith(
        `/clients/${CLIENT_ID}/submissions/${SUBMISSION_ID}/feedback`,
        {
          decision: 'SHORTLIST',
          reason: 'Strong candidate match',
        },
      );
      expect(result).toEqual(mockResponse);
    });

    it('records rejection decision with mandatory reason', async () => {
      const mockResponse = {
        id: 'fb-2',
        decision: 'REJECT',
        createdAt: '2026-11-06T00:00:00.000Z',
      };
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResponse);

      const result = await recordClientFeedback(CLIENT_ID, SUBMISSION_ID, {
        decision: 'REJECT',
        reason: 'Missing required distributed systems depth',
      });

      expect(postSpy).toHaveBeenCalledWith(
        `/clients/${CLIENT_ID}/submissions/${SUBMISSION_ID}/feedback`,
        {
          decision: 'REJECT',
          reason: 'Missing required distributed systems depth',
        },
      );
      expect(result).toEqual(mockResponse);
    });

    it('enforces >= 3 character reason when decision is REJECT', async () => {
      await expect(
        recordClientFeedback(CLIENT_ID, SUBMISSION_ID, {
          decision: 'REJECT',
          reason: '',
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
        message: expect.stringContaining('at least 3 characters'),
      });

      await expect(
        recordClientFeedback(CLIENT_ID, SUBMISSION_ID, {
          decision: 'REJECT',
          reason: 'no',
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
        message: expect.stringContaining('at least 3 characters'),
      });
    });

    it('validates client and submission identifiers', async () => {
      await expect(
        recordClientFeedback('', SUBMISSION_ID, { decision: 'SHORTLIST' }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('resolveClientPortalErrorMessage', () => {
    it('formats bias/prohibited feedback error messages specially', () => {
      const err = new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'Feedback contains prohibited discriminatory content (AGE)',
      });
      const resolved = resolveClientPortalErrorMessage(err, 'Fallback');
      expect(resolved).toContain('Feedback rejected by compliance filter');
      expect(resolved).toContain('prohibited discriminatory content');
    });

    it('resolves 401 as session expired', () => {
      const err = new ApiError({ status: 401, code: 'unauthorized', message: 'Unauthorized' });
      expect(resolveClientPortalErrorMessage(err, 'Fallback')).toBe(
        'Your session has expired. Please sign in again.',
      );
    });

    it('resolves 403 as client permission denied', () => {
      const err = new ApiError({ status: 403, code: 'forbidden', message: 'Forbidden' });
      expect(resolveClientPortalErrorMessage(err, 'Fallback')).toBe(
        'You do not have permission to view or manage submissions for this client.',
      );
    });

    it('resolves 404 as submission not found', () => {
      const err = new ApiError({ status: 404, code: 'not_found', message: 'Not found' });
      expect(resolveClientPortalErrorMessage(err, 'Fallback')).toBe(
        'The requested candidate submission could not be found.',
      );
    });

    it('resolves 409 as conflict', () => {
      const err = new ApiError({ status: 409, code: 'conflict', message: 'Conflict' });
      expect(resolveClientPortalErrorMessage(err, 'Fallback')).toBe(
        'A conflicting decision has already been recorded.',
      );
    });

    it('uses fallback message for other errors', () => {
      expect(resolveClientPortalErrorMessage(new Error('Generic failure'), 'Fallback')).toBe(
        'Generic failure',
      );
      expect(resolveClientPortalErrorMessage(null, 'Fallback')).toBe('Fallback');
    });
  });
});
