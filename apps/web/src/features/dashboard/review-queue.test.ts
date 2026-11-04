import { describe, expect, it } from 'vitest';

import { sampleDashboard } from '../../dev-fixtures/dashboard.fixture.js';
import { formatDateParts, formatRelative, formatTimeRange } from '../../lib/format.js';
import {
  LOW_COVERAGE_THRESHOLD,
  classify,
  countByTab,
  evidenceState,
  filterQueue,
} from './review-queue.js';
import type { ReviewQueueItem } from './types.js';

describe('review-queue classification & evidence invariants', () => {
  const baseItem: ReviewQueueItem = {
    candidateCode: 'CAN-9001',
    requisitionTitle: 'Senior Backend Engineer',
    assessmentStatus: 'COMPLETE',
    score: 82,
    coverage: 90,
    consent: 'ACTIVE',
    lastActivityAt: '2026-11-05T02:00:00.000Z',
  };

  it('places candidates with active consent and >= 60% coverage into the ready tab', () => {
    expect(classify(baseItem)).toBe('ready');
    expect(evidenceState(baseItem)).toBe('COMPLETE');
  });

  it('flags coverage below threshold as INSUFFICIENT_EVIDENCE and routes to gaps tab', () => {
    const lowCoverage: ReviewQueueItem = {
      ...baseItem,
      assessmentStatus: 'NEEDS_REVIEW',
      score: 63,
      coverage: LOW_COVERAGE_THRESHOLD - 6,
    };
    expect(classify(lowCoverage)).toBe('gaps');
    expect(evidenceState(lowCoverage)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('never treats a null score as Complete even when consent is active', () => {
    const unscored: ReviewQueueItem = {
      ...baseItem,
      assessmentStatus: 'NEEDS_REVIEW',
      score: null,
      coverage: 31,
    };
    expect(classify(unscored)).toBe('gaps');
    expect(evidenceState(unscored)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('routes pending or withdrawn consent to the consent holds tab regardless of score', () => {
    const withdrawn: ReviewQueueItem = {
      ...baseItem,
      consent: 'WITHDRAWN',
    };
    const pending: ReviewQueueItem = {
      ...baseItem,
      assessmentStatus: 'NOT_ASSESSED',
      score: null,
      coverage: null,
      consent: 'PENDING',
    };

    expect(classify(withdrawn)).toBe('consent');
    expect(classify(pending)).toBe('consent');
  });

  it('computes accurate tab counts and filters by candidate code or role title', () => {
    const counts = countByTab(sampleDashboard.reviewQueue);
    expect(counts.ready).toBe(5);
    expect(counts.gaps).toBe(4);
    expect(counts.consent).toBe(3);

    const byCandidate = filterQueue(sampleDashboard.reviewQueue, 'ready', 'CAN-4821');
    expect(byCandidate).toHaveLength(1);
    expect(byCandidate[0]?.candidateCode).toBe('CAN-4821');

    const byRole = filterQueue(sampleDashboard.reviewQueue, 'ready', 'data platform');
    expect(byRole.map((item) => item.candidateCode)).toEqual(['CAN-4803', 'CAN-4786']);
  });

  it('formats relative time and interview timezones deterministically', () => {
    expect(formatRelative('2026-11-05T02:00:00.000Z', '2026-11-05T04:00:00.000Z')).toBe(
      '2 hours ago',
    );

    const kolkataParts = formatDateParts('2026-11-06T09:30:00.000Z', 'Asia/Kolkata');
    expect(kolkataParts).toEqual({ weekday: 'Fri', day: '6', month: 'Nov' });

    const kolkataRange = formatTimeRange(
      '2026-11-06T09:30:00.000Z',
      '2026-11-06T10:30:00.000Z',
      'Asia/Kolkata',
    );
    expect(kolkataRange).toContain('15:00–16:00');
  });
});
