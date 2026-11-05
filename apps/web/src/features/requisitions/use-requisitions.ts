import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createRequisition,
  listRequisitions,
  resolveRequisitionErrorMessage,
  transitionRequisitionStatus,
  updateRequisition,
} from './requisition.api.js';
import type {
  CreateRequisitionInput,
  RequisitionFilterStatus,
  RequisitionRecord,
  RequisitionSummaryCounts,
  TransitionTargetStatus,
  UpdateRequisitionInput,
} from './types.js';

export type RequisitionsDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; requisitions: RequisitionRecord[] };

export function sortRequisitionsByUpdatedAt(
  requisitions: readonly RequisitionRecord[],
): RequisitionRecord[] {
  return [...requisitions].sort((left, right) => {
    const byDate = right.updatedAt.localeCompare(left.updatedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });
}

export function computeRequisitionSummaryCounts(
  requisitions: readonly RequisitionRecord[],
): RequisitionSummaryCounts {
  let draft = 0;
  let open = 0;
  let paused = 0;
  let closedOrFilled = 0;

  for (const item of requisitions) {
    switch (item.status) {
      case 'DRAFT':
        draft += 1;
        break;
      case 'OPEN':
        open += 1;
        break;
      case 'PAUSED':
        paused += 1;
        break;
      case 'CLOSED':
      case 'FILLED':
        closedOrFilled += 1;
        break;
    }
  }

  return {
    total: requisitions.length,
    draft,
    open,
    paused,
    closedOrFilled,
  };
}

export function filterRequisitions(
  requisitions: readonly RequisitionRecord[],
  statusFilter: RequisitionFilterStatus,
  searchQuery: string,
): RequisitionRecord[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return requisitions.filter((item) => {
    if (statusFilter === 'DRAFT' && item.status !== 'DRAFT') {
      return false;
    }
    if (statusFilter === 'OPEN' && item.status !== 'OPEN') {
      return false;
    }
    if (statusFilter === 'PAUSED' && item.status !== 'PAUSED') {
      return false;
    }
    if (
      statusFilter === 'CLOSED_OR_FILLED' &&
      item.status !== 'CLOSED' &&
      item.status !== 'FILLED'
    ) {
      return false;
    }

    if (normalizedQuery.length > 0) {
      const titleMatches = item.title.toLowerCase().includes(normalizedQuery);
      const clientMatches = item.clientName.toLowerCase().includes(normalizedQuery);
      if (!titleMatches && !clientMatches) {
        return false;
      }
    }

    return true;
  });
}

export interface UseRequisitionsResult {
  state: RequisitionsDirectoryState;
  requisitions: RequisitionRecord[];
  summary: RequisitionSummaryCounts;
  reload: () => Promise<void>;
  createRequisitionRecord: (input: CreateRequisitionInput) => Promise<RequisitionRecord>;
  updateRequisitionDraft: (
    requisitionId: string,
    input: UpdateRequisitionInput,
  ) => Promise<RequisitionRecord>;
  transitionStatus: (
    requisitionId: string,
    targetStatus: TransitionTargetStatus,
  ) => Promise<RequisitionRecord>;
  reconcileRequisition: (record: RequisitionRecord) => void;
}

export function useRequisitions(): UseRequisitionsResult {
  const [state, setState] = useState<RequisitionsDirectoryState>({ status: 'loading' });
  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(async (version: number): Promise<void> => {
    try {
      const records = await listRequisitions();
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }
      setState({
        status: 'ready',
        requisitions: sortRequisitionsByUpdatedAt(records),
      });
    } catch (error) {
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }
      setState({
        status: 'error',
        message: resolveRequisitionErrorMessage(
          error,
          'Unable to load the requisition directory right now. Please try again.',
        ),
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initialVersion = ++fetchVersionRef.current;
    void executeFetch(initialVersion);

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

  const reconcileRequisition = useCallback((updatedRecord: RequisitionRecord): void => {
    if (!mountedRef.current) {
      return;
    }
    setState((previous) => {
      if (previous.status !== 'ready') {
        return previous;
      }
      const exists = previous.requisitions.some((item) => item.id === updatedRecord.id);
      const nextList = exists
        ? previous.requisitions.map((item) => (item.id === updatedRecord.id ? updatedRecord : item))
        : [...previous.requisitions, updatedRecord];

      return {
        status: 'ready',
        requisitions: sortRequisitionsByUpdatedAt(nextList),
      };
    });
  }, []);

  const createRequisitionRecord = useCallback(
    async (input: CreateRequisitionInput): Promise<RequisitionRecord> => {
      const created = await createRequisition(input);
      reconcileRequisition(created);
      return created;
    },
    [reconcileRequisition],
  );

  const updateRequisitionDraft = useCallback(
    async (requisitionId: string, input: UpdateRequisitionInput): Promise<RequisitionRecord> => {
      const updated = await updateRequisition(requisitionId, input);
      reconcileRequisition(updated);
      return updated;
    },
    [reconcileRequisition],
  );

  const transitionStatus = useCallback(
    async (
      requisitionId: string,
      targetStatus: TransitionTargetStatus,
    ): Promise<RequisitionRecord> => {
      const updated = await transitionRequisitionStatus(requisitionId, targetStatus);
      reconcileRequisition(updated);
      return updated;
    },
    [reconcileRequisition],
  );

  const requisitions = useMemo(() => (state.status === 'ready' ? state.requisitions : []), [state]);

  const summary = useMemo(() => computeRequisitionSummaryCounts(requisitions), [requisitions]);

  return {
    state,
    requisitions,
    summary,
    reload,
    createRequisitionRecord,
    updateRequisitionDraft,
    transitionStatus,
    reconcileRequisition,
  };
}
