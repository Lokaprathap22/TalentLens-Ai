import { useCallback, useEffect, useRef, useState } from 'react';

import {
  acceptInterviewProposal,
  completeInterview,
  getCandidateDetail,
  getCandidateTimeline,
  getResumeDetails,
  getResumeExtraction,
  getResumeFileBlob,
  proposeInterviewForSubmission,
  recordCandidateReview,
  rejectInterviewProposal,
  resolveCandidateErrorMessage,
  shortlistCandidate,
  submitCandidateToClient,
  triggerCandidateAssessment,
} from './candidate.api.js';
import type {
  CandidateDetail,
  CandidateTimelineDto,
  DocumentExtraction,
  ResumeDocumentDto,
  ReviewDecision,
} from './types.js';

export type CandidateDetailStatus = 'idle' | 'loading' | 'success' | 'error';
export type FilePreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

interface InternalDetailState {
  status: CandidateDetailStatus;
  error: string | null;
  candidate: CandidateDetail | null;
  extraction: DocumentExtraction | null;
  extractionStatus: CandidateDetailStatus;
  extractionError: string | null;
  resumeDetails: ResumeDocumentDto | null;
  hasInspectedOriginal: boolean;
}

export interface UseCandidateDetailResult {
  status: CandidateDetailStatus;
  error: string | null;
  candidate: CandidateDetail | null;
  extraction: DocumentExtraction | null;
  extractionStatus: CandidateDetailStatus;
  extractionError: string | null;
  resumeDetails: ResumeDocumentDto | null;
  fileStatus: FilePreviewStatus;
  fileError: string | null;
  fileBlobUrl: string | null;
  fileMimeType: string | null;
  fileName: string | null;
  hasInspectedOriginal: boolean;
  isAssessing: boolean;
  assessmentError: string | null;
  isSubmittingReview: boolean;
  reviewError: string | null;
  isShortlisting: boolean;
  shortlistError: string | null;
  isSubmittingToClient: boolean;
  submissionError: string | null;
  isInterviewLoading: boolean;
  interviewError: string | null;
  timeline: CandidateTimelineDto | null;
  isTimelineLoading: boolean;
  triggerAssessment: () => Promise<void>;
  inspectOriginalFile: () => Promise<void>;
  recordReview: (decision: ReviewDecision, notesInternal?: string) => Promise<void>;
  shortlist: (notesInternal?: string) => Promise<void>;
  submitToClient: () => Promise<void>;
  proposeInterview: (input: {
    startAt: string;
    endAt?: string | undefined;
    timezone: string;
    format?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | undefined;
    reason?: string | undefined;
    proposalId?: string | undefined;
  }) => Promise<void>;
  acceptInterview: (proposalId: string) => Promise<void>;
  rejectInterview: (proposalId: string, reason: string) => Promise<void>;
  completeInterviewAction: (proposalId: string) => Promise<void>;
  loadTimeline: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useCandidateDetail(
  requisitionId: string,
  candidateId: string | null,
): UseCandidateDetailResult {
  const [detailState, setDetailState] = useState<InternalDetailState>(() => ({
    status:
      candidateId && candidateId.trim() && requisitionId && requisitionId.trim()
        ? 'loading'
        : 'idle',
    error: null,
    candidate: null,
    extraction: null,
    extractionStatus: 'idle',
    extractionError: null,
    resumeDetails: null,
    hasInspectedOriginal: false,
  }));

  const [fileStatus, setFileStatus] = useState<FilePreviewStatus>('idle');
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [fileMimeType, setFileMimeType] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isAssessing, setIsAssessing] = useState(false);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [isShortlisting, setIsShortlisting] = useState(false);
  const [shortlistError, setShortlistError] = useState<string | null>(null);
  const [isSubmittingToClient, setIsSubmittingToClient] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isInterviewLoading, setIsInterviewLoading] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<CandidateTimelineDto | null>(null);
  const [isTimelineLoading, setIsTimelineLoading] = useState(false);

  const mountedRef = useRef(true);
  const fetchVersionRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      revokeBlobUrl();
    };
  }, [revokeBlobUrl]);

  const executeFetch = useCallback(
    async (version: number): Promise<void> => {
      const trimmedCandId = candidateId?.trim();
      const trimmedReqId = requisitionId.trim();

      if (!trimmedCandId || !trimmedReqId) {
        // Yield execution so this is strictly asynchronous
        await Promise.resolve();
        if (!mountedRef.current || fetchVersionRef.current !== version) return;

        revokeBlobUrl();
        setFileBlobUrl(null);
        setFileStatus('idle');
        setDetailState({
          status: 'idle',
          error: null,
          candidate: null,
          extraction: null,
          extractionStatus: 'idle',
          extractionError: null,
          resumeDetails: null,
          hasInspectedOriginal: false,
        });
        return;
      }

      try {
        const detail = await getCandidateDetail(trimmedReqId, trimmedCandId);
        if (!mountedRef.current || fetchVersionRef.current !== version) return;

        let ext: DocumentExtraction | null = null;
        let extStatus: CandidateDetailStatus = 'idle';
        let extErr: string | null = null;
        let resumeDetails: ResumeDocumentDto | null = null;

        if (detail.resume.id) {
          const [extRes, detailsRes] = await Promise.allSettled([
            getResumeExtraction(trimmedReqId, detail.resume.id),
            getResumeDetails(trimmedReqId, detail.resume.id),
          ]);

          if (extRes.status === 'fulfilled') {
            ext = extRes.value;
            extStatus = 'success';
          } else {
            extStatus = 'error';
            extErr = resolveCandidateErrorMessage(
              extRes.reason,
              'Extracted text is not yet available for this resume.',
            );
          }

          if (detailsRes.status === 'fulfilled') {
            resumeDetails = detailsRes.value;
          }
        }

        if (!mountedRef.current || fetchVersionRef.current !== version) return;

        setDetailState({
          status: 'success',
          error: null,
          candidate: detail,
          extraction: ext,
          extractionStatus: extStatus,
          extractionError: extErr,
          resumeDetails,
          hasInspectedOriginal: detail.hasInspectedOriginalResume,
        });
      } catch (err: unknown) {
        if (!mountedRef.current || fetchVersionRef.current !== version) return;

        setDetailState({
          status: 'error',
          error: resolveCandidateErrorMessage(
            err,
            'Failed to load candidate details. Please try again.',
          ),
          candidate: null,
          extraction: null,
          extractionStatus: 'idle',
          extractionError: null,
          resumeDetails: null,
          hasInspectedOriginal: false,
        });
      }
    },
    [candidateId, requisitionId, revokeBlobUrl],
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

  const reload = useCallback(async () => {
    const version = ++fetchVersionRef.current;
    setDetailState((prev) => ({ ...prev, status: 'loading' }));
    await executeFetch(version);
  }, [executeFetch]);

  const triggerAssessment = useCallback(async () => {
    const activeCand = detailState.candidate;
    if (!activeCand || !activeCand.resume.id) return;

    setIsAssessing(true);
    setAssessmentError(null);

    try {
      await triggerCandidateAssessment(requisitionId, activeCand.resume.id);
      await reload();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setAssessmentError(
        resolveCandidateErrorMessage(
          err,
          'Failed to trigger candidate assessment. Please check requirements and consent.',
        ),
      );
    } finally {
      if (mountedRef.current) {
        setIsAssessing(false);
      }
    }
  }, [detailState.candidate, requisitionId, reload]);

  const inspectOriginalFile = useCallback(async () => {
    const activeCand = detailState.candidate;
    if (!activeCand || !activeCand.resume.id) return;

    setFileStatus('loading');
    setFileError(null);

    try {
      const result = await getResumeFileBlob(
        requisitionId,
        activeCand.resume.id,
        activeCand.resume.fileName,
      );

      // Revoke previous blob URL if any
      revokeBlobUrl();

      const objectUrl = URL.createObjectURL(result.blob);
      blobUrlRef.current = objectUrl;

      setFileBlobUrl(objectUrl);
      setFileMimeType(result.mimeType);
      setFileName(result.fileName);
      setFileStatus('ready');
      setDetailState((prev) => ({
        ...prev,
        hasInspectedOriginal: true,
      }));
    } catch (err: unknown) {
      setFileStatus('error');
      setFileError(
        resolveCandidateErrorMessage(
          err,
          'Failed to retrieve the original resume file for inspection.',
        ),
      );
    }
  }, [detailState.candidate, requisitionId, revokeBlobUrl]);

  const loadTimeline = useCallback(async () => {
    const trimmedCandId = candidateId?.trim();
    const trimmedReqId = requisitionId.trim();
    if (!trimmedCandId || !trimmedReqId) return;

    setIsTimelineLoading(true);
    try {
      const data = await getCandidateTimeline(trimmedReqId, trimmedCandId, {
        limit: 50,
        offset: 0,
      });
      if (mountedRef.current) {
        setTimeline(data);
      }
    } catch {
      // Timeline is secondary; do not block primary view
    } finally {
      if (mountedRef.current) {
        setIsTimelineLoading(false);
      }
    }
  }, [candidateId, requisitionId]);

  const recordReview = useCallback(
    async (decision: ReviewDecision, notesInternal?: string) => {
      const trimmedCandId = candidateId?.trim();
      const trimmedReqId = requisitionId.trim();
      if (!trimmedCandId || !trimmedReqId) return;

      setIsSubmittingReview(true);
      setReviewError(null);

      try {
        await recordCandidateReview(trimmedReqId, trimmedCandId, decision, notesInternal);
        await reload();
        // Refresh timeline if loaded
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setReviewError(
          resolveCandidateErrorMessage(err, 'Failed to record recruiter review. Please try again.'),
        );
      } finally {
        if (mountedRef.current) {
          setIsSubmittingReview(false);
        }
      }
    },
    [candidateId, requisitionId, reload, timeline, loadTimeline],
  );

  const shortlist = useCallback(
    async (notesInternal?: string) => {
      const trimmedCandId = candidateId?.trim();
      const trimmedReqId = requisitionId.trim();
      if (!trimmedCandId || !trimmedReqId) return;

      setIsShortlisting(true);
      setShortlistError(null);

      try {
        await shortlistCandidate(trimmedReqId, trimmedCandId, notesInternal);
        await reload();
        // Refresh timeline if loaded
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setShortlistError(
          resolveCandidateErrorMessage(
            err,
            'Failed to shortlist candidate. Please verify review and consent requirements.',
          ),
        );
      } finally {
        if (mountedRef.current) {
          setIsShortlisting(false);
        }
      }
    },
    [candidateId, requisitionId, reload, timeline, loadTimeline],
  );

  const submitToClient = useCallback(async () => {
    const trimmedCandId = candidateId?.trim();
    const trimmedReqId = requisitionId.trim();
    if (!trimmedCandId || !trimmedReqId) return;

    setIsSubmittingToClient(true);
    setSubmissionError(null);

    try {
      await submitCandidateToClient(trimmedReqId, trimmedCandId);
      await reload();
      if (timeline) {
        void loadTimeline();
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setSubmissionError(
        resolveCandidateErrorMessage(
          err,
          'Failed to submit candidate to client. Please verify shortlist, consent, and inspection prerequisites.',
        ),
      );
    } finally {
      if (mountedRef.current) {
        setIsSubmittingToClient(false);
      }
    }
  }, [candidateId, requisitionId, reload, timeline, loadTimeline]);

  const proposeInterview = useCallback(
    async (input: {
      startAt: string;
      endAt?: string | undefined;
      timezone: string;
      format?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | undefined;
      reason?: string | undefined;
      proposalId?: string | undefined;
    }) => {
      const submissionId = detailState.candidate?.submission?.id;
      const trimmedReqId = requisitionId.trim();
      if (!submissionId || !trimmedReqId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await proposeInterviewForSubmission(trimmedReqId, submissionId, input);
        await reload();
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveCandidateErrorMessage(
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
    [detailState.candidate?.submission?.id, requisitionId, reload, timeline, loadTimeline],
  );

  const acceptInterview = useCallback(
    async (proposalId: string) => {
      const submissionId = detailState.candidate?.submission?.id;
      const trimmedReqId = requisitionId.trim();
      if (!submissionId || !trimmedReqId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await acceptInterviewProposal(trimmedReqId, submissionId, proposalId);
        await reload();
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveCandidateErrorMessage(err, 'Failed to accept interview proposal.'),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [detailState.candidate?.submission?.id, requisitionId, reload, timeline, loadTimeline],
  );

  const rejectInterview = useCallback(
    async (proposalId: string, reason: string) => {
      const submissionId = detailState.candidate?.submission?.id;
      const trimmedReqId = requisitionId.trim();
      if (!submissionId || !trimmedReqId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await rejectInterviewProposal(trimmedReqId, submissionId, proposalId, reason);
        await reload();
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(
          resolveCandidateErrorMessage(err, 'Failed to decline interview proposal.'),
        );
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [detailState.candidate?.submission?.id, requisitionId, reload, timeline, loadTimeline],
  );

  const completeInterviewAction = useCallback(
    async (proposalId: string) => {
      const submissionId = detailState.candidate?.submission?.id;
      const trimmedReqId = requisitionId.trim();
      if (!submissionId || !trimmedReqId) return;

      setIsInterviewLoading(true);
      setInterviewError(null);

      try {
        await completeInterview(trimmedReqId, submissionId, proposalId);
        await reload();
        if (timeline) {
          void loadTimeline();
        }
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setInterviewError(resolveCandidateErrorMessage(err, 'Failed to complete interview.'));
        throw err;
      } finally {
        if (mountedRef.current) {
          setIsInterviewLoading(false);
        }
      }
    },
    [detailState.candidate?.submission?.id, requisitionId, reload, timeline, loadTimeline],
  );

  return {
    status: detailState.status,
    error: detailState.error,
    candidate: detailState.candidate,
    extraction: detailState.extraction,
    extractionStatus: detailState.extractionStatus,
    extractionError: detailState.extractionError,
    resumeDetails: detailState.resumeDetails,
    fileStatus,
    fileError,
    fileBlobUrl,
    fileMimeType,
    fileName,
    hasInspectedOriginal: detailState.hasInspectedOriginal,
    isAssessing,
    assessmentError,
    isSubmittingReview,
    reviewError,
    isShortlisting,
    shortlistError,
    isSubmittingToClient,
    submissionError,
    isInterviewLoading,
    interviewError,
    timeline,
    isTimelineLoading,
    triggerAssessment,
    inspectOriginalFile,
    recordReview,
    shortlist,
    submitToClient,
    proposeInterview,
    acceptInterview,
    rejectInterview,
    completeInterviewAction,
    loadTimeline,
    reload,
  };
}
