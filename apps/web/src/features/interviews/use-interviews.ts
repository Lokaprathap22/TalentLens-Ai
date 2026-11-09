import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../app/workspace.js';
import {
  clientAcceptInterview,
  clientRejectInterview,
  listInterviews,
  recruiterAcceptInterview,
  recruiterCompleteInterview,
  recruiterProposeAlternativeInterview,
  recruiterRejectInterview,
} from './interviews.api.js';
import type {
  InterviewCounts,
  InterviewFormat,
  InterviewItem,
  InterviewStatusCategory,
} from './types.js';

export interface UseInterviewsFilter {
  search: string;
  statusCategory: InterviewStatusCategory;
  clientId: string;
  requisitionId: string;
  fromDate: string;
  toDate: string;
  sortBy: 'startAt' | 'createdAt' | 'status';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export type InterviewsDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      items: InterviewItem[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      counts: InterviewCounts;
    };

export interface UseInterviewsResult {
  state: InterviewsDirectoryState;
  filter: UseInterviewsFilter;
  setSearch: (search: string) => void;
  setStatusCategory: (statusCategory: InterviewStatusCategory) => void;
  setClientId: (clientId: string) => void;
  setRequisitionId: (requisitionId: string) => void;
  setDateRange: (fromDate: string, toDate: string) => void;
  setSort: (sortBy: 'startAt' | 'createdAt' | 'status', sortOrder?: 'asc' | 'desc') => void;
  setPage: (page: number) => void;
  resetFilters: () => void;
  reload: () => Promise<void>;
  // Action Handlers
  isActing: boolean;
  actionError: string | null;
  feedback: { type: 'success' | 'error'; message: string } | null;
  dismissFeedback: () => void;
  handleAccept: (item: InterviewItem) => Promise<boolean>;
  handleReject: (item: InterviewItem, reason: string) => Promise<boolean>;
  handleReschedule: (
    item: InterviewItem,
    input: { startAt: string; endAt: string; timezone: string; format?: InterviewFormat },
  ) => Promise<boolean>;
  handleComplete: (item: InterviewItem) => Promise<boolean>;
}

export const DEFAULT_INTERVIEWS_PAGE_SIZE = 15;

export const INITIAL_INTERVIEWS_FILTER: UseInterviewsFilter = {
  search: '',
  statusCategory: 'ALL',
  clientId: '',
  requisitionId: '',
  fromDate: '',
  toDate: '',
  sortBy: 'startAt',
  sortOrder: 'desc',
  page: 1,
  pageSize: DEFAULT_INTERVIEWS_PAGE_SIZE,
};

export function useInterviews(initialFilter?: Partial<UseInterviewsFilter>): UseInterviewsResult {
  const { user } = useWorkspace();
  const [filter, setFilter] = useState<UseInterviewsFilter>({
    ...INITIAL_INTERVIEWS_FILTER,
    ...initialFilter,
  });

  const [state, setState] = useState<InterviewsDirectoryState>({ status: 'loading' });
  const [isActing, setIsActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(
    async (currentFilter: UseInterviewsFilter, version: number): Promise<void> => {
      try {
        const response = await listInterviews({
          page: currentFilter.page,
          pageSize: currentFilter.pageSize,
          search: currentFilter.search.trim() || undefined,
          statusCategory: currentFilter.statusCategory,
          clientId: currentFilter.clientId || undefined,
          requisitionId: currentFilter.requisitionId || undefined,
          fromDate: currentFilter.fromDate || undefined,
          toDate: currentFilter.toDate || undefined,
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
          counts: response.counts,
        });
      } catch (error) {
        if (!mountedRef.current || fetchVersionRef.current !== version) {
          return;
        }

        const msg = error instanceof Error ? error.message : 'Unable to load interviews right now.';
        setState({
          status: 'error',
          message: msg,
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
    setFilter((prev) => ({ ...prev, search, page: 1 }));
  }, []);

  const setStatusCategory = useCallback((statusCategory: InterviewStatusCategory) => {
    setFilter((prev) => ({ ...prev, statusCategory, page: 1 }));
  }, []);

  const setClientId = useCallback((clientId: string) => {
    setFilter((prev) => ({ ...prev, clientId, page: 1 }));
  }, []);

  const setRequisitionId = useCallback((requisitionId: string) => {
    setFilter((prev) => ({ ...prev, requisitionId, page: 1 }));
  }, []);

  const setDateRange = useCallback((fromDate: string, toDate: string) => {
    setFilter((prev) => ({ ...prev, fromDate, toDate, page: 1 }));
  }, []);

  const setSort = useCallback(
    (sortBy: 'startAt' | 'createdAt' | 'status', sortOrder?: 'asc' | 'desc') => {
      setFilter((prev) => ({
        ...prev,
        sortBy,
        sortOrder:
          sortOrder ?? (prev.sortBy === sortBy && prev.sortOrder === 'asc' ? 'desc' : 'asc'),
        page: 1,
      }));
    },
    [],
  );

  const setPage = useCallback((page: number) => {
    setFilter((prev) => ({ ...prev, page: Math.max(1, page) }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilter(INITIAL_INTERVIEWS_FILTER);
  }, []);

  const dismissFeedback = useCallback(() => {
    setFeedback(null);
  }, []);

  // Consequential actions with real server mutations
  const handleAccept = useCallback(
    async (item: InterviewItem): Promise<boolean> => {
      setIsActing(true);
      setActionError(null);
      try {
        if (user.role === 'CLIENT_HIRING_MANAGER') {
          await clientAcceptInterview(item.clientId, item.submissionId, item.id);
        } else {
          await recruiterAcceptInterview(item.requisitionId, item.submissionId, item.id);
        }
        setFeedback({
          type: 'success',
          message: `Interview proposal for ${item.candidateCode} confirmed successfully.`,
        });
        await reload();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to accept interview proposal.';
        setActionError(msg);
        setFeedback({ type: 'error', message: msg });
        return false;
      } finally {
        setIsActing(false);
      }
    },
    [reload, user.role],
  );

  const handleReject = useCallback(
    async (item: InterviewItem, reason: string): Promise<boolean> => {
      setIsActing(true);
      setActionError(null);
      try {
        if (user.role === 'CLIENT_HIRING_MANAGER') {
          await clientRejectInterview(item.clientId, item.submissionId, item.id, reason);
        } else {
          await recruiterRejectInterview(item.requisitionId, item.submissionId, item.id, reason);
        }
        setFeedback({
          type: 'success',
          message: `Interview proposal for ${item.candidateCode} was declined.`,
        });
        await reload();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to decline interview proposal.';
        setActionError(msg);
        setFeedback({ type: 'error', message: msg });
        return false;
      } finally {
        setIsActing(false);
      }
    },
    [reload, user.role],
  );

  const handleReschedule = useCallback(
    async (
      item: InterviewItem,
      input: {
        startAt: string;
        endAt: string;
        timezone: string;
        format?: InterviewFormat | undefined;
      },
    ): Promise<boolean> => {
      setIsActing(true);
      setActionError(null);
      try {
        await recruiterProposeAlternativeInterview(item.requisitionId, item.submissionId, {
          proposalId: item.id,
          startAt: input.startAt,
          endAt: input.endAt,
          timezone: input.timezone,
          format: input.format,
        });
        setFeedback({
          type: 'success',
          message: `Alternative interview window proposed for ${item.candidateCode}.`,
        });
        await reload();
        return true;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to propose alternative interview window.';
        setActionError(msg);
        setFeedback({ type: 'error', message: msg });
        return false;
      } finally {
        setIsActing(false);
      }
    },
    [reload],
  );

  const handleComplete = useCallback(
    async (item: InterviewItem): Promise<boolean> => {
      setIsActing(true);
      setActionError(null);
      try {
        await recruiterCompleteInterview(item.requisitionId, item.submissionId, item.id);
        setFeedback({
          type: 'success',
          message: `Interview for ${item.candidateCode} marked as completed.`,
        });
        await reload();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to complete interview.';
        setActionError(msg);
        setFeedback({ type: 'error', message: msg });
        return false;
      } finally {
        setIsActing(false);
      }
    },
    [reload],
  );

  return {
    state,
    filter,
    setSearch,
    setStatusCategory,
    setClientId,
    setRequisitionId,
    setDateRange,
    setSort,
    setPage,
    resetFilters,
    reload,
    isActing,
    actionError,
    feedback,
    dismissFeedback,
    handleAccept,
    handleReject,
    handleReschedule,
    handleComplete,
  };
}
