import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clientAcceptInterviewProposal,
  clientProposeInterview,
  clientRejectInterviewProposal,
  getClientSubmission,
  listAuthorizedClients,
  listClientSubmissions,
  recordClientFeedback,
  resolveClientPortalErrorMessage,
} from './client-portal.api.js';
import type {
  AuthorizedClient,
  ClientFeedbackInput,
  ClientInterviewProposalInput,
  ClientPortalStatusFilter,
  ClientSubmissionDetail,
  ClientSubmissionSummary,
} from './types.js';

export interface UseClientPortalFilter {
  search: string;
  status: ClientPortalStatusFilter;
}

export interface ClientPortalMetrics {
  total: number;
  pendingReview: number;
  shortlisted: number;
  declined: number;
}

export interface UseClientPortalResult {
  clients: AuthorizedClient[];
  selectedClient: AuthorizedClient | null;
  selectedClientId: string | null;
  setSelectedClientId: (id: string) => void;
  submissions: ClientSubmissionSummary[];
  filteredSubmissions: ClientSubmissionSummary[];
  metrics: ClientPortalMetrics;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  filter: UseClientPortalFilter;
  setFilter: (patch: Partial<UseClientPortalFilter>) => void;
  selectedSubmissionId: string | null;
  setSelectedSubmissionId: (id: string | null) => void;
  selectedDetail: ClientSubmissionDetail | null;
  isDetailLoading: boolean;
  detailError: string | null;
  isSubmittingFeedback: boolean;
  feedbackError: string | null;
  isInterviewLoading: boolean;
  interviewError: string | null;
  submitFeedback: (input: ClientFeedbackInput) => Promise<void>;
  proposeInterview: (input: ClientInterviewProposalInput) => Promise<void>;
  acceptInterview: (proposalId: string) => Promise<void>;
  rejectInterview: (proposalId: string, reason: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useClientPortal(): UseClientPortalResult {
  const [clients, setClients] = useState<AuthorizedClient[]>([]);
  const [selectedClientId, setSelectedClientIdState] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<ClientSubmissionSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilterState] = useState<UseClientPortalFilter>({
    search: '',
    status: 'ALL',
  });

  // Detail modal state
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ClientSubmissionDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Feedback mutation state
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Interview state
  const [isInterviewLoading, setIsInterviewLoading] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  // Load authorized clients on mount
  useEffect(() => {
    mountedRef.current = true;
    let isCancelled = false;

    async function fetchClients(): Promise<void> {
      await Promise.resolve();
      if (isCancelled) return;
      setStatus('loading');
      setError(null);
      try {
        const clientList = await listAuthorizedClients();
        if (isCancelled) return;
        setClients(clientList);

        // Auto-select first client if none selected
        if (clientList.length > 0) {
          setSelectedClientIdState((prev) => prev ?? clientList[0]!.id);
        } else {
          setStatus('ready');
        }
      } catch (err: unknown) {
        if (isCancelled) return;
        setError(
          resolveClientPortalErrorMessage(
            err,
            'Failed to load authorized clients for your account.',
          ),
        );
        setStatus('error');
      }
    }

    void fetchClients();

    return () => {
      isCancelled = true;
      mountedRef.current = false;
    };
  }, []);

  // Fetch submissions when selected client changes
  const loadSubmissions = useCallback(async (clientId: string) => {
    setStatus('loading');
    setError(null);
    try {
      const result = await listClientSubmissions(clientId);
      if (!mountedRef.current) return;
      setSubmissions(result);
      setStatus('ready');
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(
        resolveClientPortalErrorMessage(
          err,
          'Failed to load candidate submissions for this client.',
        ),
      );
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!selectedClientId) return;

    let isCancelled = false;

    async function fetchOnClientChange(): Promise<void> {
      await Promise.resolve();
      if (isCancelled || !mountedRef.current) return;
      await loadSubmissions(selectedClientId!);
    }

    void fetchOnClientChange();

    return () => {
      isCancelled = true;
    };
  }, [selectedClientId, loadSubmissions]);

  // Load detail when selectedSubmissionId changes
  useEffect(() => {
    let isCancelled = false;

    async function fetchDetail(): Promise<void> {
      await Promise.resolve();
      if (isCancelled) return;

      if (!selectedSubmissionId || !selectedClientId) {
        setSelectedDetail(null);
        setDetailError(null);
        return;
      }

      setIsDetailLoading(true);
      setDetailError(null);

      try {
        const detail = await getClientSubmission(selectedClientId, selectedSubmissionId);
        if (isCancelled) return;
        setSelectedDetail(detail);
      } catch (err: unknown) {
        if (isCancelled) return;
        setDetailError(
          resolveClientPortalErrorMessage(err, 'Failed to load submission details for review.'),
        );
      } finally {
        if (!isCancelled) {
          setIsDetailLoading(false);
        }
      }
    }

    void fetchDetail();

    return () => {
      isCancelled = true;
    };
  }, [selectedSubmissionId, selectedClientId]);

  const setSelectedClientId = useCallback((id: string) => {
    setSelectedClientIdState(id);
    setSelectedSubmissionId(null);
    setSelectedDetail(null);
  }, []);

  const setFilter = useCallback((patch: Partial<UseClientPortalFilter>) => {
    setFilterState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Reload current client submissions
  const reload = useCallback(async () => {
    if (selectedClientId) {
      await loadSubmissions(selectedClientId);
    }
  }, [selectedClientId, loadSubmissions]);

  // Submit client feedback
  const submitFeedback = useCallback(
    async (input: ClientFeedbackInput) => {
      if (!selectedClientId || !selectedSubmissionId) return;

      setIsSubmittingFeedback(true);
      setFeedbackError(null);

      try {
        await recordClientFeedback(selectedClientId, selectedSubmissionId, input);

        // Refresh detail
        const updatedDetail = await getClientSubmission(selectedClientId, selectedSubmissionId);
        if (mountedRef.current) {
          setSelectedDetail(updatedDetail);
        }

        // Refresh submissions list
        await reload();
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setFeedbackError(
          resolveClientPortalErrorMessage(
            err,
            'Failed to record feedback. Please check your submission and try again.',
          ),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsSubmittingFeedback(false);
        }
      }
    },
    [selectedClientId, selectedSubmissionId, reload],
  );

  // Propose interview from client portal
  const proposeInterview = useCallback(
    async (input: ClientInterviewProposalInput) => {
      if (!selectedClientId || !selectedSubmissionId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await clientProposeInterview(selectedClientId, selectedSubmissionId, input);

        // Refresh detail
        const updatedDetail = await getClientSubmission(selectedClientId, selectedSubmissionId);
        if (mountedRef.current) {
          setSelectedDetail(updatedDetail);
        }

        // Refresh submissions list
        await reload();
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveClientPortalErrorMessage(
            err,
            'Failed to propose interview window. Please check the date and timezone.',
          ),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [selectedClientId, selectedSubmissionId, reload],
  );

  // Accept recruiter interview proposal
  const acceptInterview = useCallback(
    async (proposalId: string) => {
      if (!selectedClientId || !selectedSubmissionId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await clientAcceptInterviewProposal(selectedClientId, selectedSubmissionId, proposalId);

        // Refresh detail
        const updatedDetail = await getClientSubmission(selectedClientId, selectedSubmissionId);
        if (mountedRef.current) {
          setSelectedDetail(updatedDetail);
        }

        // Refresh submissions list
        await reload();
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveClientPortalErrorMessage(err, 'Failed to accept interview proposal.'),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [selectedClientId, selectedSubmissionId, reload],
  );

  // Reject recruiter interview proposal
  const rejectInterview = useCallback(
    async (proposalId: string, reason: string) => {
      if (!selectedClientId || !selectedSubmissionId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await clientRejectInterviewProposal(
          selectedClientId,
          selectedSubmissionId,
          proposalId,
          reason,
        );

        // Refresh detail
        const updatedDetail = await getClientSubmission(selectedClientId, selectedSubmissionId);
        if (mountedRef.current) {
          setSelectedDetail(updatedDetail);
        }

        // Refresh submissions list
        await reload();
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveClientPortalErrorMessage(err, 'Failed to decline interview proposal.'),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [selectedClientId, selectedSubmissionId, reload],
  );

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) ?? null,
    [clients, selectedClientId],
  );

  // Compute metrics
  const metrics = useMemo<ClientPortalMetrics>(() => {
    let pendingReview = 0;
    let shortlisted = 0;
    let declined = 0;

    for (const sub of submissions) {
      if (sub.status === 'SUBMITTED') {
        pendingReview++;
      } else if (sub.status === 'CLIENT_SHORTLISTED') {
        shortlisted++;
      } else if (sub.status === 'CLIENT_REJECTED') {
        declined++;
      }
    }

    return {
      total: submissions.length,
      pendingReview,
      shortlisted,
      declined,
    };
  }, [submissions]);

  // Filter submissions
  const filteredSubmissions = useMemo(() => {
    const query = filter.search.trim().toLowerCase();

    return submissions.filter((sub) => {
      // Status filter
      if (filter.status !== 'ALL') {
        if (sub.status !== filter.status) {
          return false;
        }
      }

      // Search filter
      if (query.length > 0) {
        const refMatch = sub.candidateRef.toLowerCase().includes(query);
        const reqMatch = sub.requisitionTitle.toLowerCase().includes(query);
        if (!refMatch && !reqMatch) {
          return false;
        }
      }

      return true;
    });
  }, [submissions, filter]);

  return {
    clients,
    selectedClient,
    selectedClientId,
    setSelectedClientId,
    submissions,
    filteredSubmissions,
    metrics,
    status,
    error,
    filter,
    setFilter,
    selectedSubmissionId,
    setSelectedSubmissionId,
    selectedDetail,
    isDetailLoading,
    detailError,
    isSubmittingFeedback,
    feedbackError,
    isInterviewLoading,
    interviewError,
    submitFeedback,
    proposeInterview,
    acceptInterview,
    rejectInterview,
    reload,
  };
}
