import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { emptyDashboard, sampleDashboard } from '../../dev-fixtures/dashboard.fixture.js';
import { fetchLiveDashboardData } from './dashboard.api.js';
import type { DashboardData } from './types.js';

export type DashboardState =
  | { status: 'loading' }
  | { status: 'error'; error?: unknown }
  | { status: 'ready'; data: DashboardData };

const ALLOW_SYNTHETIC_FIXTURES =
  !import.meta.env.PROD && import.meta.env.MODE !== 'staging' && import.meta.env.MODE !== 'preview';

/**
 * Data hook for the recruiter dashboard.
 *
 * In production builds and live environments, this hook aggregates authoritative
 * server-side data from /clients, /requisitions, and /candidates.
 *
 * In development preview mode, deterministic fixtures can be previewed via
 * `?state=sample|empty|loading|error|live`.
 */
export function useDashboardData(): {
  state: DashboardState;
  isSample: boolean;
  reload: () => void;
} {
  const [params] = useSearchParams();
  const rawState = params.get('state');
  const preview = ALLOW_SYNTHETIC_FIXTURES ? rawState : null;
  const [attempt, setAttempt] = useState(0);
  const [liveState, setLiveState] = useState<DashboardState>({ status: 'loading' });

  // In test mode, default to sample unless explicit 'live' is specified
  const isTestMode = import.meta.env.MODE === 'test';
  const shouldUseLive =
    !ALLOW_SYNTHETIC_FIXTURES ||
    rawState === 'live' ||
    (!isTestMode && (!preview || preview === 'live'));

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (preview === 'loading') {
      return;
    }
    if (preview === 'error' && attempt === 0) {
      return;
    }
    if (preview === 'empty' || preview === 'sample') {
      return;
    }

    if (!shouldUseLive) {
      return;
    }

    let isMounted = true;
    const controller = new AbortController();

    async function load(): Promise<void> {
      await Promise.resolve();
      if (!isMounted) return;
      setLiveState({ status: 'loading' });

      try {
        const data = await fetchLiveDashboardData(controller.signal);
        if (isMounted) {
          setLiveState({ status: 'ready', data });
        }
      } catch (err) {
        if (isMounted && !controller.signal.aborted) {
          setLiveState({ status: 'error', error: err });
        }
      }
    }

    void load();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [preview, attempt, shouldUseLive]);

  if (preview === 'loading') {
    return {
      state: { status: 'loading' },
      isSample: false,
      reload,
    };
  }

  if (preview === 'error' && attempt === 0) {
    return {
      state: { status: 'error' },
      isSample: false,
      reload,
    };
  }

  if (preview === 'empty') {
    return {
      state: { status: 'ready', data: emptyDashboard },
      isSample: false,
      reload,
    };
  }

  if (preview === 'sample' || (!shouldUseLive && isTestMode)) {
    return {
      state: { status: 'ready', data: sampleDashboard },
      isSample: true,
      reload,
    };
  }

  return {
    state: liveState,
    isSample: false,
    reload,
  };
}
