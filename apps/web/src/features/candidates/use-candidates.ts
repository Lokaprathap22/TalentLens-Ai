import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listCandidates, resolveCandidateErrorMessage } from './candidate.api.js';
import type { CandidateSummary, ListCandidatesQuery, ResumeParseStatus } from './types.js';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type CandidateDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: CandidateSummary[]; total: number };

// ---------------------------------------------------------------------------
// Client-side filter and search
// ---------------------------------------------------------------------------

export type ProcessingFilter = 'ALL' | ResumeParseStatus;
export type SubmissionFilter =
  'ALL' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED' | 'WITHDRAWN';

export interface UseCandidatesFilter {
  processing: ProcessingFilter;
  submission?: SubmissionFilter;
  search: string;
}

/**
 * Returns the subset of candidates that match the current filter and search query.
 * Search checks candidateCode and resumeFileName (never PII fields).
 */
export function filterCandidates(
  candidates: readonly CandidateSummary[],
  filter: UseCandidatesFilter,
): CandidateSummary[] {
  const normalizedQuery = filter.search.trim().toLowerCase();

  return candidates.filter((candidate) => {
    // Processing status filter
    if (filter.processing !== 'ALL' && candidate.parseStatus !== filter.processing) {
      return false;
    }

    // Submission status filter
    if (filter.submission && filter.submission !== 'ALL') {
      if (filter.submission === 'NOT_SUBMITTED') {
        if (candidate.submissionStatus) return false;
      } else if (candidate.submissionStatus !== filter.submission) {
        return false;
      }
    }

    // Text search — only over non-PII safe fields
    if (normalizedQuery.length > 0) {
      const codeMatches = candidate.candidateCode.toLowerCase().includes(normalizedQuery);
      const fileMatches = candidate.resumeFileName.toLowerCase().includes(normalizedQuery);
      if (!codeMatches && !fileMatches) {
        return false;
      }
    }

    return true;
  });
}

/** Sorts candidates by lastActivityAt descending, then by candidateId for stability. */
export function sortCandidatesByActivity(
  candidates: readonly CandidateSummary[],
): CandidateSummary[] {
  return [...candidates].sort((a, b) => {
    const byDate = b.lastActivityAt.localeCompare(a.lastActivityAt);
    if (byDate !== 0) return byDate;
    return a.candidateId.localeCompare(b.candidateId);
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseCandidatesResult {
  state: CandidateDirectoryState;
  /** All fetched candidates, sorted by last activity. */
  allCandidates: CandidateSummary[];
  /** Candidates after client-side filter and search. */
  filteredCandidates: CandidateSummary[];
  /** Total count reported by the server (for display in header). */
  total: number;
  reload: () => Promise<void>;
  /**
   * Prepend freshly uploaded candidates to the list without requiring a full reload.
   * Called after a successful upload to give instant visual feedback.
   * A subsequent reload from the server reconciles the actual state.
   */
  prependCandidates: (candidates: CandidateSummary[]) => void;
  filter: UseCandidatesFilter;
  setFilter: (patch: Partial<UseCandidatesFilter>) => void;
}

/**
 * Manages the recruiter candidate directory for a single requisition.
 *
 * Fetches from GET /api/v1/requisitions/:requisitionId/candidates.
 * Does not expose or log any PII fields.
 */
export function useCandidates(
  requisitionId: string,
  serverQuery: ListCandidatesQuery = {},
): UseCandidatesResult {
  const [state, setState] = useState<CandidateDirectoryState>({ status: 'loading' });
  const [filter, setFilterState] = useState<UseCandidatesFilter>({
    processing: 'ALL',
    search: '',
  });

  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);
  const serverQueryRef = useRef(serverQuery);

  useEffect(() => {
    serverQueryRef.current = serverQuery;
  }, [serverQuery]);

  const executeFetch = useCallback(
    async (version: number): Promise<void> => {
      try {
        const result = await listCandidates(requisitionId, serverQueryRef.current);
        if (!mountedRef.current || fetchVersionRef.current !== version) {
          return;
        }
        setState({
          status: 'ready',
          items: sortCandidatesByActivity(result.items),
          total: result.total,
        });
      } catch (error) {
        if (!mountedRef.current || fetchVersionRef.current !== version) {
          return;
        }
        setState({
          status: 'error',
          message: resolveCandidateErrorMessage(
            error,
            'Unable to load the candidate directory right now. Please try again.',
          ),
        });
      }
    },
    [requisitionId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const version = ++fetchVersionRef.current;
    void executeFetch(version);

    return () => {
      mountedRef.current = false;
      fetchVersionRef.current += 1;
    };
  }, [executeFetch]);

  const reload = useCallback(async (): Promise<void> => {
    const version = ++fetchVersionRef.current;
    setState({ status: 'loading' });
    await executeFetch(version);
  }, [executeFetch]);

  const prependCandidates = useCallback((newCandidates: CandidateSummary[]): void => {
    if (!mountedRef.current || newCandidates.length === 0) {
      return;
    }
    setState((previous) => {
      if (previous.status !== 'ready') {
        return previous;
      }
      // De-duplicate by candidateId (newly uploaded may already appear if reused)
      const existingIds = new Set(previous.items.map((c) => c.candidateId));
      const trulyNew = newCandidates.filter((c) => !existingIds.has(c.candidateId));
      if (trulyNew.length === 0) {
        return previous;
      }
      return {
        status: 'ready',
        items: sortCandidatesByActivity([...trulyNew, ...previous.items]),
        total: previous.total + trulyNew.length,
      };
    });
  }, []);

  const setFilter = useCallback((patch: Partial<UseCandidatesFilter>): void => {
    setFilterState((prev) => ({ ...prev, ...patch }));
  }, []);

  const allCandidates = useMemo(() => (state.status === 'ready' ? state.items : []), [state]);

  const filteredCandidates = useMemo(
    () => filterCandidates(allCandidates, filter),
    [allCandidates, filter],
  );

  const total = useMemo(() => (state.status === 'ready' ? state.total : 0), [state]);

  return {
    state,
    allCandidates,
    filteredCandidates,
    total,
    reload,
    prependCandidates,
    filter,
    setFilter,
  };
}
