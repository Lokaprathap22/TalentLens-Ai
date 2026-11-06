import { describe, expect, it } from 'vitest';

import { filterCandidates, sortCandidatesByActivity } from './use-candidates.js';
import {
  getParseStatusLabel,
  getParseStatusTone,
  getReviewStatusLabel,
  getReviewStatusTone,
} from './types.js';
import type { CandidateSummary, ReviewStatus } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    candidateId: 'aaaa-aaaa-aaaa-aaaa',
    candidateCode: 'CAN-A1A1A1A1',
    resumeDocumentId: 'bbbb-bbbb-bbbb-bbbb',
    resumeFileName: 'alice-cv.pdf',
    parseStatus: 'PARSED',
    assessmentId: null,
    assessmentStatus: null,
    overallScore: null,
    coverage: null,
    isComplete: false,
    criteriaCount: 0,
    criteriaMetCount: 0,
    reviewStatus: 'NOT_REVIEWED',
    reviewedAt: null,
    isShortlisted: false,
    shortlistedAt: null,
    submissionId: null,
    submissionStatus: null,
    submittedAt: null,
    lastActivityAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

const C1 = makeCandidate({
  candidateId: 'c1-c1-c1-c1',
  candidateCode: 'CAN-11111111',
  resumeFileName: 'alice.pdf',
  parseStatus: 'PARSED',
  lastActivityAt: '2026-10-22T10:00:00.000Z',
});

const C2 = makeCandidate({
  candidateId: 'c2-c2-c2-c2',
  candidateCode: 'CAN-22222222',
  resumeFileName: 'bob.docx',
  parseStatus: 'PENDING',
  lastActivityAt: '2026-10-20T08:00:00.000Z',
});

const C3 = makeCandidate({
  candidateId: 'c3-c3-c3-c3',
  candidateCode: 'CAN-33333333',
  resumeFileName: 'charlie.pdf',
  parseStatus: 'NEEDS_REVIEW',
  reviewStatus: 'REVIEWED',
  lastActivityAt: '2026-10-21T12:00:00.000Z',
});

const C4 = makeCandidate({
  candidateId: 'c4-c4-c4-c4',
  candidateCode: 'CAN-44444444',
  resumeFileName: 'diana.pdf',
  parseStatus: 'FAILED',
  lastActivityAt: '2026-10-19T06:00:00.000Z',
});

const ALL = [C1, C2, C3, C4];

// ---------------------------------------------------------------------------
// filterCandidates
// ---------------------------------------------------------------------------

describe('use-candidates: filterCandidates', () => {
  it('1. returns all candidates when filter is ALL and search is empty', () => {
    const result = filterCandidates(ALL, { processing: 'ALL', search: '' });
    expect(result).toHaveLength(4);
  });

  it('2. filters by PARSED processing status', () => {
    const result = filterCandidates(ALL, { processing: 'PARSED', search: '' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C1.candidateId);
  });

  it('3. filters by PENDING processing status', () => {
    const result = filterCandidates(ALL, { processing: 'PENDING', search: '' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C2.candidateId);
  });

  it('4. filters by NEEDS_REVIEW processing status', () => {
    const result = filterCandidates(ALL, { processing: 'NEEDS_REVIEW', search: '' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C3.candidateId);
  });

  it('5. filters by FAILED processing status', () => {
    const result = filterCandidates(ALL, { processing: 'FAILED', search: '' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C4.candidateId);
  });

  it('6. filters by search term matching candidateCode (case-insensitive)', () => {
    const result = filterCandidates(ALL, { processing: 'ALL', search: 'CAN-11' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C1.candidateId);
  });

  it('7. filters by search term matching resumeFileName (case-insensitive)', () => {
    const result = filterCandidates(ALL, { processing: 'ALL', search: 'BOB' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C2.candidateId);
  });

  it('8. returns empty array when search matches nothing', () => {
    const result = filterCandidates(ALL, { processing: 'ALL', search: 'zzz-no-match' });
    expect(result).toHaveLength(0);
  });

  it('9. combines processing filter and search', () => {
    const result = filterCandidates(ALL, { processing: 'PARSED', search: 'alice' });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe(C1.candidateId);
  });

  it('10. returns empty when status filter and search together match nothing', () => {
    const result = filterCandidates(ALL, { processing: 'PENDING', search: 'alice' });
    expect(result).toHaveLength(0);
  });

  it('11. does not search over PII-like fields (guardcheck: only code and filename)', () => {
    // If candidateId were searched, 'c1-c1' would match C1.
    // This test ensures the function only searches candidateCode and resumeFileName.
    const result = filterCandidates(ALL, { processing: 'ALL', search: 'c1-c1' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortCandidatesByActivity
// ---------------------------------------------------------------------------

describe('use-candidates: sortCandidatesByActivity', () => {
  it('12. sorts candidates by lastActivityAt descending', () => {
    const sorted = sortCandidatesByActivity(ALL);
    expect(sorted.map((c) => c.candidateId)).toEqual([
      C1.candidateId, // Oct 22
      C3.candidateId, // Oct 21
      C2.candidateId, // Oct 20
      C4.candidateId, // Oct 19
    ]);
  });

  it('13. is stable for equal lastActivityAt using candidateId', () => {
    const A = makeCandidate({ candidateId: 'aaa', lastActivityAt: '2026-10-20T10:00:00.000Z' });
    const B = makeCandidate({ candidateId: 'bbb', lastActivityAt: '2026-10-20T10:00:00.000Z' });
    const sorted = sortCandidatesByActivity([B, A]);
    // Sorted ascending by candidateId when dates are equal
    expect(sorted[0]?.candidateId).toBe('aaa');
    expect(sorted[1]?.candidateId).toBe('bbb');
  });

  it('14. does not mutate the input array', () => {
    const input = [C4, C1];
    const sorted = sortCandidatesByActivity(input);
    expect(input[0]?.candidateId).toBe(C4.candidateId); // Original unchanged
    expect(sorted[0]?.candidateId).toBe(C1.candidateId); // Sorted result correct
  });
});

// ---------------------------------------------------------------------------
// Status label and tone helpers
// ---------------------------------------------------------------------------

describe('types: getParseStatusLabel', () => {
  it('15. returns expected labels for all known statuses', () => {
    expect(getParseStatusLabel('PENDING')).toBe('Queued');
    expect(getParseStatusLabel('PROCESSING')).toBe('Processing');
    expect(getParseStatusLabel('PARSED')).toBe('Extracted');
    expect(getParseStatusLabel('NEEDS_REVIEW')).toBe('Needs review');
    expect(getParseStatusLabel('FAILED')).toBe('Extraction failed');
  });

  it('16. returns the raw status string for unknown statuses', () => {
    expect(getParseStatusLabel('UNKNOWN_STATUS')).toBe('UNKNOWN_STATUS');
  });
});

describe('types: getParseStatusTone', () => {
  it('17. PENDING → neutral, PROCESSING → info, PARSED → success', () => {
    expect(getParseStatusTone('PENDING')).toBe('neutral');
    expect(getParseStatusTone('PROCESSING')).toBe('info');
    expect(getParseStatusTone('PARSED')).toBe('success');
  });

  it('18. NEEDS_REVIEW → warning, FAILED → danger', () => {
    expect(getParseStatusTone('NEEDS_REVIEW')).toBe('warning');
    expect(getParseStatusTone('FAILED')).toBe('danger');
  });
});

describe('types: getReviewStatusLabel', () => {
  it('19. returns expected labels for all review statuses', () => {
    expect(getReviewStatusLabel('NOT_REVIEWED')).toBe('Not reviewed');
    expect(getReviewStatusLabel('REVIEWED')).toBe('Reviewed');
    expect(getReviewStatusLabel('NEEDS_REVIEW')).toBe('Flagged');
    expect(getReviewStatusLabel('CLOSED')).toBe('Closed');
  });

  it('safely handles unknown review status values without throwing', () => {
    expect(getReviewStatusLabel('UNKNOWN_VALUE' as unknown as ReviewStatus)).toBe('Unknown');
  });
});

describe('types: getReviewStatusTone', () => {
  it('20. returns correct tones', () => {
    expect(getReviewStatusTone('NOT_REVIEWED')).toBe('neutral');
    expect(getReviewStatusTone('REVIEWED')).toBe('success');
    expect(getReviewStatusTone('NEEDS_REVIEW')).toBe('warning');
    expect(getReviewStatusTone('CLOSED')).toBe('neutral');
  });

  it('safely handles unknown review status tones without throwing', () => {
    expect(getReviewStatusTone('UNKNOWN_VALUE' as unknown as ReviewStatus)).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Consent-aware status semantics (critical domain invariants)
// ---------------------------------------------------------------------------

describe('consent-aware processing: PENDING does not imply processing has started', () => {
  it('21. PENDING candidates have no assessmentId (processing is held)', () => {
    // This test documents the invariant that PENDING candidates must not be
    // shown as "processing" or "assessment in progress". The UI shows "Queued"
    // which is accurate — the job may be HELD_FOR_AUTHORIZATION awaiting consent.
    const pending = makeCandidate({
      parseStatus: 'PENDING',
      assessmentId: null,
      assessmentStatus: null,
    });
    expect(pending.parseStatus).toBe('PENDING');
    expect(pending.assessmentId).toBeNull();
    expect(pending.assessmentStatus).toBeNull();
    // The label for PENDING is "Queued" — not "Processing" or "In progress"
    expect(getParseStatusLabel('PENDING')).toBe('Queued');
  });

  it('22. PROCESSING status has info tone (not success/done)', () => {
    // Active processing is shown as info (blue) to distinguish from PARSED (green)
    expect(getParseStatusTone('PROCESSING')).toBe('info');
    expect(getParseStatusTone('PARSED')).toBe('success');
    // These should not be equal
    expect(getParseStatusTone('PROCESSING')).not.toBe(getParseStatusTone('PARSED'));
  });
});
