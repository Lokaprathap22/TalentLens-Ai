import type { ReviewQueueItem } from './types.js';

export type QueueTab = 'ready' | 'gaps' | 'consent';
export type EvidenceState =
  'COMPLETE' | 'INSUFFICIENT_EVIDENCE' | 'NEEDS_REVIEW' | 'FAILED' | 'NOT_ASSESSED';

/** Coverage below this share of verified criteria is treated as insufficient evidence. */
export const LOW_COVERAGE_THRESHOLD = 60;

export function classify(item: ReviewQueueItem): QueueTab {
  if (item.consent !== 'ACTIVE') return 'consent';
  if (
    item.assessmentStatus !== 'COMPLETE' ||
    item.coverage === null ||
    item.coverage < LOW_COVERAGE_THRESHOLD
  ) {
    return 'gaps';
  }
  return 'ready';
}

/**
 * Evidence state shown to the recruiter. Missing or thin evidence is surfaced explicitly;
 * it is never presented as a low score.
 */
export function evidenceState(item: ReviewQueueItem): EvidenceState {
  if (item.assessmentStatus === 'FAILED') return 'FAILED';
  if (item.assessmentStatus === 'NOT_ASSESSED') return 'NOT_ASSESSED';
  if (item.coverage === null || item.coverage < LOW_COVERAGE_THRESHOLD || item.score === null) {
    return 'INSUFFICIENT_EVIDENCE';
  }
  return item.assessmentStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'COMPLETE';
}

export function countByTab(items: ReviewQueueItem[]): Record<QueueTab, number> {
  const counts: Record<QueueTab, number> = { ready: 0, gaps: 0, consent: 0 };
  for (const item of items) counts[classify(item)] += 1;
  return counts;
}

export function filterQueue(
  items: ReviewQueueItem[],
  tab: QueueTab,
  query: string,
): ReviewQueueItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      classify(item) === tab &&
      (needle === '' ||
        item.candidateCode.toLowerCase().includes(needle) ||
        item.requisitionTitle.toLowerCase().includes(needle)),
  );
}
