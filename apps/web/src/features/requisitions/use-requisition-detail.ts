import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError } from '../../lib/api-client.js';
import {
  getRequisition,
  resolveRequisitionErrorMessage,
  transitionRequisitionStatus,
  updateRequisition,
} from './requisition.api.js';
import type { RequisitionRecord, TransitionTargetStatus, UpdateRequisitionInput } from './types.js';

export type RequisitionDetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; requisition: RequisitionRecord };

export interface UseRequisitionDetailResult {
  state: RequisitionDetailState;
  requisition: RequisitionRecord | null;
  reload: () => Promise<void>;
  updateDraft: (input: UpdateRequisitionInput) => Promise<RequisitionRecord>;
  transitionStatus: (targetStatus: TransitionTargetStatus) => Promise<RequisitionRecord>;
}

export function useRequisitionDetail(requisitionId: string): UseRequisitionDetailResult {
  const [state, setState] = useState<RequisitionDetailState>({ status: 'loading' });
  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);

  const executeFetch = useCallback(async (id: string, version: number): Promise<void> => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      if (mountedRef.current && fetchVersionRef.current === version) {
        setState({
          status: 'error',
          message: 'A valid requisition identifier is required.',
          notFound: true,
        });
      }
      return;
    }

    try {
      const record = await getRequisition(trimmedId);
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }
      setState({
        status: 'ready',
        requisition: record,
      });
    } catch (error) {
      if (!mountedRef.current || fetchVersionRef.current !== version) {
        return;
      }

      const isNotFound = isApiError(error) && (error.status === 404 || error.code === 'not_found');
      setState({
        status: 'error',
        notFound: isNotFound,
        message: resolveRequisitionErrorMessage(
          error,
          'Unable to load requisition details right now. Please try again.',
        ),
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const version = ++fetchVersionRef.current;
    void executeFetch(requisitionId, version);

    return () => {
      mountedRef.current = false;
      fetchVersionRef.current += 1;
    };
  }, [requisitionId, executeFetch]);

  const reload = useCallback(async (): Promise<void> => {
    const version = ++fetchVersionRef.current;
    setState({ status: 'loading' });
    await executeFetch(requisitionId, version);
  }, [requisitionId, executeFetch]);

  const updateDraft = useCallback(
    async (input: UpdateRequisitionInput): Promise<RequisitionRecord> => {
      const updated = await updateRequisition(requisitionId, input);
      if (mountedRef.current) {
        setState({ status: 'ready', requisition: updated });
      }
      return updated;
    },
    [requisitionId],
  );

  const transitionStatus = useCallback(
    async (targetStatus: TransitionTargetStatus): Promise<RequisitionRecord> => {
      const updated = await transitionRequisitionStatus(requisitionId, targetStatus);
      if (mountedRef.current) {
        setState({ status: 'ready', requisition: updated });
      }
      return updated;
    },
    [requisitionId],
  );

  const requisition = state.status === 'ready' ? state.requisition : null;

  return {
    state,
    requisition,
    reload,
    updateDraft,
    transitionStatus,
  };
}
