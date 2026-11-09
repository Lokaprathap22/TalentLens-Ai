import { useCallback, useEffect, useRef, useState } from 'react';

import { listGlobalCandidates, resolveCandidateErrorMessage } from './candidate.api.js';
import type { GlobalCandidateStatusCategory, GlobalCandidateSummary } from './types.js';

export type GlobalCandidateDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      items: GlobalCandidateSummary[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };

export interface UseGlobalCandidatesFilter {
  search: string;
  requisitionId: string;
  statusCategory: 'ALL' | GlobalCandidateStatusCategory;
  sortBy: 'activity' | 'score' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface UseGlobalCandidatesResult {
  state: GlobalCandidateDirectoryState;
  filter: UseGlobalCandidatesFilter;
  setSearch: (search: string) => void;
  setRequisitionId: (requisitionId: string) => void;
  setStatusCategory: (statusCategory: 'ALL' | GlobalCandidateStatusCategory) => void;
  setSort: (sortBy: 'activity' | 'score' | 'createdAt', sortOrder?: 'asc' | 'desc') => void;
  setPage: (page: number) => void;
  resetFilters: () => void;
  reload: () => Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 20;

export const INITIAL_FILTER: UseGlobalCandidatesFilter = {
  search: '',
  requisitionId: '',
  statusCategory: 'ALL',
  sortBy: 'activity',
  sortOrder: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export function useGlobalCandidates(
  initialFilter?: Partial<UseGlobalCandidatesFilter>,
): UseGlobalCandidatesResult {
  const [filter, setFilter] = useState<UseGlobalCandidatesFilter>({
    ...INITIAL_FILTER,
    ...initialFilter,
  });

  const [state, setState] = useState<GlobalCandidateDirectoryState>({ status: 'loading' });

  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(
    async (currentFilter: UseGlobalCandidatesFilter, version: number): Promise<void> => {
      try {
        const response = await listGlobalCandidates({
          page: currentFilter.page,
          pageSize: currentFilter.pageSize,
          search: currentFilter.search.trim() || undefined,
          requisitionId: currentFilter.requisitionId || undefined,
          statusCategory:
            currentFilter.statusCategory !== 'ALL' ? currentFilter.statusCategory : undefined,
          sortBy: currentFilter.sortBy,
          sortOrder: currentFilter.sortOrder,
        });

        if (!mountedRef.current || fetchVersionRef.current !== version) {
          return;
        }

        setState({
          status: 'ready',
          items: response.items,
          total: response.total,
          page: response.page,
          pageSize: response.pageSize,
          totalPages: response.totalPages,
        });
      } catch (error) {
        if (!mountedRef.current || fetchVersionRef.current !== version) {
          return;
        }

        setState({
          status: 'error',
          message: resolveCandidateErrorMessage(
            error,
            'Unable to load the organization candidate directory right now. Please try again.',
          ),
        });
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const version = ++fetchVersionRef.current;
    void executeFetch(filter, version);

    return () => {
      mountedRef.current = false;
      fetchVersionRef.current += 1;
    };
  }, [executeFetch, filter]);

  const reload = useCallback(async (): Promise<void> => {
    const version = ++fetchVersionRef.current;
    setState({ status: 'loading' });
    await executeFetch(filter, version);
  }, [executeFetch, filter]);

  const setSearch = useCallback((search: string) => {
    const safeSearch = typeof search === 'string' ? search : '';
    setFilter((prev) => ({ ...prev, search: safeSearch, page: 1 }));
  }, []);

  const setRequisitionId = useCallback((requisitionId: string) => {
    setFilter((prev) => ({ ...prev, requisitionId, page: 1 }));
  }, []);

  const setStatusCategory = useCallback((statusCategory: 'ALL' | GlobalCandidateStatusCategory) => {
    setFilter((prev) => ({ ...prev, statusCategory, page: 1 }));
  }, []);

  const setSort = useCallback(
    (sortBy: 'activity' | 'score' | 'createdAt', sortOrder?: 'asc' | 'desc') => {
      setFilter((prev) => ({
        ...prev,
        sortBy,
        sortOrder: sortOrder ?? (sortBy === 'score' ? 'desc' : 'desc'),
        page: 1,
      }));
    },
    [],
  );

  const setPage = useCallback((page: number) => {
    setFilter((prev) => ({ ...prev, page }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilter(INITIAL_FILTER);
  }, []);

  return {
    state,
    filter,
    setSearch,
    setRequisitionId,
    setStatusCategory,
    setSort,
    setPage,
    resetFilters,
    reload,
  };
}
