import { useCallback, useEffect, useRef, useState } from 'react';

import { listScorecards, resolveScorecardErrorMessage } from './scorecard.api.js';
import type { ScorecardRecord } from './types.js';

export interface UseScorecardsState {
  scorecards: ScorecardRecord[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  approvedScorecard: ScorecardRecord | null;
  draftScorecard: ScorecardRecord | null;
  archivedScorecards: ScorecardRecord[];
  latestScorecard: ScorecardRecord | null;
}

export function useScorecards(requisitionId: string): UseScorecardsState {
  const [scorecards, setScorecards] = useState<ScorecardRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(
    async (version: number) => {
      if (!requisitionId.trim()) {
        if (mountedRef.current && fetchVersionRef.current === version) {
          setLoading(false);
        }
        return;
      }

      try {
        const records = await listScorecards(requisitionId);
        if (!mountedRef.current || fetchVersionRef.current !== version) return;
        records.sort((a, b) => b.version - a.version);
        setScorecards(records);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || fetchVersionRef.current !== version) return;
        const message = resolveScorecardErrorMessage(err, 'Failed to load scorecard versions.', {
          action: 'list',
        });
        setError(message);
      } finally {
        if (mountedRef.current && fetchVersionRef.current === version) {
          setLoading(false);
        }
      }
    },
    [requisitionId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const currentVersion = ++fetchVersionRef.current;
    void executeFetch(currentVersion);
    return () => {
      mountedRef.current = false;
    };
  }, [executeFetch]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const nextVersion = ++fetchVersionRef.current;
    await executeFetch(nextVersion);
  }, [executeFetch]);

  const approvedScorecard = scorecards.find((s) => s.status === 'APPROVED') ?? null;
  const draftScorecard = scorecards.find((s) => s.status === 'DRAFT') ?? null;
  const archivedScorecards = scorecards.filter((s) => s.status === 'ARCHIVED');
  const latestScorecard = scorecards[0] ?? null;

  return {
    scorecards,
    loading,
    error,
    reload,
    approvedScorecard,
    draftScorecard,
    archivedScorecards,
    latestScorecard,
  };
}
