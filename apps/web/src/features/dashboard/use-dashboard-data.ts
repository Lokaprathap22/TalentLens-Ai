import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { emptyDashboard, sampleDashboard } from '../../dev-fixtures/dashboard.fixture.js';
import type { DashboardData } from './types.js';

export type DashboardState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: DashboardData };

const ALLOW_SYNTHETIC_FIXTURES = import.meta.env.DEV || import.meta.env.MODE === 'test';

/**
 * Data seam for the dashboard.
 *
 * API wiring is a later milestone: in development and tests, this hook resolves
 * deterministic synthetic fixtures (`?state=loading|error|empty` previews alternate
 * states). In production builds, synthetic fixtures never leak into live metrics.
 */
export function useDashboardData(): {
  state: DashboardState;
  isSample: boolean;
  reload: () => void;
} {
  const [params] = useSearchParams();
  const preview = ALLOW_SYNTHETIC_FIXTURES ? params.get('state') : null;
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${preview ?? 'sample'}:${attempt}`;
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);

  useEffect(() => {
    if (preview === 'loading') {
      return undefined;
    }
    // Resolve on the next tick so the loading state is a real, exercised code path.
    const timer = setTimeout(() => {
      setResolvedKey(requestKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [preview, requestKey]);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  let state: DashboardState;
  if (preview === 'loading' || resolvedKey !== requestKey) {
    state = { status: 'loading' };
  } else if (preview === 'error' && attempt === 0) {
    state = { status: 'error' };
  } else {
    const useEmpty = !ALLOW_SYNTHETIC_FIXTURES || preview === 'empty';
    state = {
      status: 'ready',
      data: useEmpty ? emptyDashboard : sampleDashboard,
    };
  }

  return {
    state,
    isSample: ALLOW_SYNTHETIC_FIXTURES && preview !== 'empty',
    reload,
  };
}
