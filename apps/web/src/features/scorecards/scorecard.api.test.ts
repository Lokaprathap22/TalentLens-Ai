import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClientModule from '../../lib/api-client.js';
import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  approveScorecardDraft,
  computeApprovalReadiness,
  createScorecardDraft,
  getScorecard,
  isValidScorecardRecord,
  listScorecards,
  resolveScorecardErrorMessage,
  updateScorecardDraft,
} from './scorecard.api.js';
import type { ScorecardRecord } from './types.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
    },
  };
});

const mockApiClient = vi.mocked(apiClient);

const validScorecard: ScorecardRecord = {
  id: 'a0000000-0000-4000-8000-000000000001',
  requisitionId: 'b0000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'DRAFT',
  weights: { scoring: { skill: 60, experience: 40 } },
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  criteria: [
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      key: 'typescript',
      label: 'TypeScript Proficiency',
      description: 'Minimum 3 years of production TypeScript experience.',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      displayOrder: 1,
      active: true,
      evidence: {
        sourceQuote: '3+ years production TypeScript',
        sourceStart: 120,
        sourceEnd: 151,
        verificationStatus: 'VERIFIED',
      },
    },
    {
      id: 'c0000000-0000-4000-8000-000000000002',
      key: 'cloud',
      label: 'Cloud Deployment',
      description: 'Experience deploying Docker containers on AWS or GCP.',
      category: 'EXPERIENCE',
      requirementType: 'PREFERRED',
      weight: 40,
      displayOrder: 2,
      active: true,
      evidence: {
        sourceQuote: 'Experience with Docker on AWS',
        sourceStart: 210,
        sourceEnd: 238,
        verificationStatus: 'VERIFIED',
      },
    },
  ],
};

describe('scorecard.api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidScorecardRecord', () => {
    it('returns true for a fully compliant ScorecardRecord', () => {
      expect(isValidScorecardRecord(validScorecard)).toBe(true);
    });

    it('returns true for an empty criteria list in a manual draft', () => {
      const emptyDraft = { ...validScorecard, criteria: [] };
      expect(isValidScorecardRecord(emptyDraft)).toBe(true);
    });

    it('returns false for non-object or null', () => {
      expect(isValidScorecardRecord(null)).toBe(false);
      expect(isValidScorecardRecord('string')).toBe(false);
      expect(isValidScorecardRecord(123)).toBe(false);
    });

    it('returns false when required fields are missing or invalid', () => {
      expect(isValidScorecardRecord({ ...validScorecard, id: '' })).toBe(false);
      expect(isValidScorecardRecord({ ...validScorecard, version: 0 })).toBe(false);
      expect(isValidScorecardRecord({ ...validScorecard, status: 'UNKNOWN' })).toBe(false);
      expect(isValidScorecardRecord({ ...validScorecard, criteria: null })).toBe(false);
    });

    it('returns false if criterion has invalid fields', () => {
      const invalidCriteria = [
        {
          ...validScorecard.criteria[0]!,
          category: 'INVALID_CATEGORY',
        },
      ];
      expect(isValidScorecardRecord({ ...validScorecard, criteria: invalidCriteria })).toBe(false);
    });
  });

  describe('computeApprovalReadiness', () => {
    it('indicates ready when weights sum to 100, at least one MUST_HAVE exists, and all active evidence is verified', () => {
      const readiness = computeApprovalReadiness(validScorecard);
      expect(readiness.isReady).toBe(true);
      expect(readiness.hasActiveCriteria).toBe(true);
      expect(readiness.hasMustHaveCriterion).toBe(true);
      expect(readiness.weightsSumTo100).toBe(true);
      expect(readiness.totalActiveWeight).toBe(100);
      expect(readiness.allActiveEvidenceVerified).toBe(true);
      expect(readiness.unverifiedCount).toBe(0);
      expect(readiness.blockingReasons).toHaveLength(0);
    });

    it('blocks approval if active criteria do not sum to 100%', () => {
      const invalid = {
        ...validScorecard,
        criteria: [
          { ...validScorecard.criteria[0]!, weight: 50 },
          { ...validScorecard.criteria[1]!, weight: 40 },
        ],
      };
      const readiness = computeApprovalReadiness(invalid);
      expect(readiness.isReady).toBe(false);
      expect(readiness.weightsSumTo100).toBe(false);
      expect(readiness.totalActiveWeight).toBe(90);
      expect(readiness.blockingReasons[0]).toContain('weights must sum to exactly 100%');
    });

    it('blocks approval if no active criterion is MUST_HAVE', () => {
      const invalid = {
        ...validScorecard,
        criteria: [
          { ...validScorecard.criteria[0]!, requirementType: 'PREFERRED' as const },
          { ...validScorecard.criteria[1]!, requirementType: 'PREFERRED' as const },
        ],
      };
      const readiness = computeApprovalReadiness(invalid);
      expect(readiness.isReady).toBe(false);
      expect(readiness.hasMustHaveCriterion).toBe(false);
      expect(readiness.blockingReasons).toContain(
        'Scorecard must have at least one active "Must-Have" requirement.',
      );
    });

    it('blocks approval if active criteria have unverified evidence', () => {
      const invalid = {
        ...validScorecard,
        criteria: [
          validScorecard.criteria[0]!,
          {
            ...validScorecard.criteria[1]!,
            evidence: {
              ...validScorecard.criteria[1]!.evidence!,
              verificationStatus: 'PENDING_RECRUITER_REVIEW' as const,
            },
          },
        ],
      };
      const readiness = computeApprovalReadiness(invalid);
      expect(readiness.isReady).toBe(false);
      expect(readiness.allActiveEvidenceVerified).toBe(false);
      expect(readiness.unverifiedCount).toBe(1);
      expect(readiness.blockingReasons[0]).toContain(
        '1 active criterion requires verified source evidence',
      );
    });

    it('ignores inactive criteria when computing weights and verification status', () => {
      const scorecardWithInactive = {
        ...validScorecard,
        criteria: [
          validScorecard.criteria[0]!,
          validScorecard.criteria[1]!,
          {
            id: 'c0000000-0000-4000-8000-000000000003',
            key: 'legacy-skill',
            label: 'Legacy Technology',
            description: 'Deprecated skill',
            category: 'SKILL' as const,
            requirementType: 'PREFERRED' as const,
            weight: 50,
            displayOrder: 3,
            active: false,
            evidence: null,
          },
        ],
      };
      const readiness = computeApprovalReadiness(scorecardWithInactive);
      expect(readiness.isReady).toBe(true);
      expect(readiness.totalActiveWeight).toBe(100);
    });

    describe('weight approval tolerance alignment (backend tolerance 0.0001)', () => {
      const createScorecardWithWeights = (weights: number[]) => ({
        ...validScorecard,
        criteria: weights.map((w, index) => ({
          ...validScorecard.criteria[0]!,
          id: `c0000000-0000-4000-8000-00000000000${index + 1}`,
          key: `key-${index + 1}`,
          requirementType: (index === 0 ? 'MUST_HAVE' : 'PREFERRED') as 'MUST_HAVE' | 'PREFERRED',
          weight: w,
          displayOrder: index + 1,
          active: true,
          evidence: {
            sourceQuote: 'valid quote',
            sourceStart: 10,
            sourceEnd: 21,
            verificationStatus: 'VERIFIED' as const,
          },
        })),
      });

      it('rejects total 99 (diff = 1 > 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 49]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
      });

      it('rejects total 99.999 (diff = 0.001 > 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 49.999]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
      });

      it('accepts total 99.99995 (diff = 0.00005 <= 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 49.99995]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(true);
        expect(readiness.isReady).toBe(true);
      });

      it('accepts total 100 (diff = 0 <= 0.0001)', () => {
        const sc = createScorecardWithWeights([60, 40]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(true);
        expect(readiness.isReady).toBe(true);
      });

      it('accepts total 100.00005 (diff = 0.00005 <= 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 50.00005]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(true);
        expect(readiness.isReady).toBe(true);
      });

      it('rejects total 100.0005 (diff = 0.0005 > 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 50.0005]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
      });

      it('rejects total 101 (diff = 1 > 0.0001)', () => {
        const sc = createScorecardWithWeights([50, 51]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
      });

      it('rejects when an active criterion has weight 0 even if total is 100', () => {
        const sc = createScorecardWithWeights([100, 0]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
        expect(readiness.blockingReasons).toContain(
          'All active criteria must have a positive weight (> 0%).',
        );
      });

      it('rejects when an active criterion has negative weight even if total is 100', () => {
        const sc = createScorecardWithWeights([110, -10]);
        const readiness = computeApprovalReadiness(sc);
        expect(readiness.weightsSumTo100).toBe(false);
        expect(readiness.isReady).toBe(false);
      });
    });
  });

  describe('resolveScorecardErrorMessage', () => {
    it('returns custom message for 400 on approve action', () => {
      const err = new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'invalid_request',
      });
      const msg = resolveScorecardErrorMessage(err, 'Fallback', { action: 'approve' });
      expect(msg).toContain('Scorecard approval criteria not met');
    });

    it('returns custom message for 502 AI provider unavailable', () => {
      const err = new ApiError({ status: 502, code: 'provider_unavailable', message: '' });
      const msg = resolveScorecardErrorMessage(err, 'Fallback');
      expect(msg).toContain('The AI requirement extraction provider is currently unreachable');
    });

    it('distinguishes provider_invalid_response, provider_invalid_request, and provider_content_blocked from provider_unavailable', () => {
      const invalidResponseMsg = resolveScorecardErrorMessage(
        new ApiError({ status: 502, code: 'provider_invalid_response', message: '' }),
        'Fallback',
      );
      expect(invalidResponseMsg).toContain('invalid or incomplete structured response');
      expect(invalidResponseMsg).not.toContain('currently unreachable');

      const invalidRequestMsg = resolveScorecardErrorMessage(
        new ApiError({ status: 502, code: 'provider_invalid_request', message: '' }),
        'Fallback',
      );
      expect(invalidRequestMsg).toContain('request or schema was rejected');
      expect(invalidRequestMsg).not.toContain('currently unreachable');

      const blockedMsg = resolveScorecardErrorMessage(
        new ApiError({ status: 422, code: 'provider_content_blocked', message: '' }),
        'Fallback',
      );
      expect(blockedMsg).toContain('safety or content policy block');
    });

    it('returns custom message for 504 AI provider timeout', () => {
      const err = new ApiError({ status: 504, code: 'provider_timeout', message: '' });
      const msg = resolveScorecardErrorMessage(err, 'Fallback');
      expect(msg).toContain('The AI extraction service timed out');
    });

    it('returns custom message for 503 service unavailable', () => {
      const err = new ApiError({ status: 503, code: 'service_unavailable', message: '' });
      const msg = resolveScorecardErrorMessage(err, 'Fallback');
      expect(msg).toContain(
        'The AI extraction service is not configured or temporarily unavailable',
      );
    });
  });

  describe('API calls', () => {
    it('listScorecards fetches scorecard versions for a requisition', async () => {
      mockApiClient.get.mockResolvedValueOnce({ scorecards: [validScorecard] });
      const result = await listScorecards(validScorecard.requisitionId);
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards`,
        {},
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(validScorecard.id);
    });

    it('getScorecard fetches specific scorecard version', async () => {
      mockApiClient.get.mockResolvedValueOnce({ scorecard: validScorecard });
      const result = await getScorecard(validScorecard.requisitionId, validScorecard.id);
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards/${validScorecard.id}`,
        {},
      );
      expect(result.id).toBe(validScorecard.id);
    });

    it('createScorecardDraft sends AI mode or manual mode correctly', async () => {
      mockApiClient.post.mockResolvedValueOnce({ scorecard: validScorecard });
      await createScorecardDraft(validScorecard.requisitionId, { mode: 'ai' });
      expect(mockApiClient.post).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards/drafts`,
        { mode: 'ai' },
      );

      mockApiClient.post.mockResolvedValueOnce({ scorecard: validScorecard });
      await createScorecardDraft(validScorecard.requisitionId, { mode: 'manual' });
      expect(mockApiClient.post).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards/drafts`,
        { mode: 'manual' },
      );
    });

    it('updateScorecardDraft sends updated criteria', async () => {
      mockApiClient.patch.mockResolvedValueOnce({ scorecard: validScorecard });
      await updateScorecardDraft(validScorecard.requisitionId, validScorecard.id, {
        criteria: [
          {
            id: validScorecard.criteria[0]!.id,
            label: 'Updated Label',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 60,
            displayOrder: 1,
            active: true,
          },
        ],
      });
      expect(mockApiClient.patch).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards/${validScorecard.id}`,
        expect.objectContaining({
          criteria: expect.any(Array),
        }),
      );
    });

    it('approveScorecardDraft sends empty body to approve endpoint', async () => {
      mockApiClient.post.mockResolvedValueOnce({
        scorecard: { ...validScorecard, status: 'APPROVED' },
      });
      const result = await approveScorecardDraft(validScorecard.requisitionId, validScorecard.id);
      expect(mockApiClient.post).toHaveBeenCalledWith(
        `/requisitions/${validScorecard.requisitionId}/scorecards/${validScorecard.id}/approve`,
        {},
      );
      expect(result.status).toBe('APPROVED');
    });
  });
});
