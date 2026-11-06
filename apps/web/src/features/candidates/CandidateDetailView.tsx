import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Info,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { EmptyState, LoadingRegion, Skeleton } from '../../components/ui/states.js';
import { Tab, TabList, TabPanel, Tabs } from '../../components/ui/tabs.js';
import { ConsentInvitationModal } from '../consent/ConsentInvitationModal.js';
import { InterviewDeclineModal } from './InterviewDeclineModal.js';
import { InterviewProposalModal } from './InterviewProposalModal.js';
import { getReviewStatusLabel, getReviewStatusTone } from './types.js';
import type { ReviewDecision } from './types.js';
import { useCandidateDetail } from './use-candidate-detail.js';

export interface CandidateDetailViewProps {
  requisitionId: string;
  candidateId: string;
  onClose?: () => void;
  headerAction?: ReactNode;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getSubmissionStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'SUBMITTED':
      return 'With client';
    case 'CLIENT_SHORTLISTED':
      return 'Client shortlisted';
    case 'CLIENT_REJECTED':
      return 'Client declined';
    case 'INTERVIEW_PROPOSED':
      return 'Interview proposed';
    case 'WITHDRAWN':
      return 'Withdrawn';
    default:
      return 'Not submitted';
  }
}

function getSubmissionStatusTone(
  status: string | null | undefined,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' {
  switch (status) {
    case 'SUBMITTED':
      return 'info';
    case 'CLIENT_SHORTLISTED':
      return 'success';
    case 'CLIENT_REJECTED':
      return 'neutral';
    case 'INTERVIEW_PROPOSED':
      return 'accent';
    case 'WITHDRAWN':
      return 'danger';
    default:
      return 'neutral';
  }
}

function getInterviewStatusTone(
  status: string,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' {
  switch (status) {
    case 'PROPOSED':
      return 'warning';
    case 'ACCEPTED':
      return 'success';
    case 'REJECTED':
      return 'neutral';
    case 'RESCHEDULED':
      return 'accent';
    case 'COMPLETED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function formatInterviewWindow(startIso: string, endIso: string, timezone: string): string {
  try {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const dateStr = s.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const startTimeStr = s.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const endTimeStr = e.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${dateStr}, ${startTimeStr} – ${endTimeStr} (${timezone})`;
  } catch {
    return `${startIso} (${timezone})`;
  }
}

export function CandidateDetailView({
  requisitionId,
  candidateId,
  onClose,
  headerAction,
}: CandidateDetailViewProps): React.JSX.Element {
  const {
    status,
    error,
    candidate,
    extraction,
    extractionStatus,
    extractionError,
    resumeDetails,
    fileStatus,
    fileError,
    fileBlobUrl,
    fileMimeType,
    fileName,
    hasInspectedOriginal,
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
  } = useCandidateDetail(requisitionId, candidateId);

  const [copiedCode, setCopiedCode] = useState(false);
  const [isConsentModalOpen, setIsConsentModalOpen] = useState(false);
  const [isInterviewProposalModalOpen, setIsInterviewProposalModalOpen] = useState(false);
  const [selectedRescheduleProposalId, setSelectedRescheduleProposalId] = useState<string | null>(
    null,
  );
  const [isInterviewDeclineModalOpen, setIsInterviewDeclineModalOpen] = useState(false);
  const [selectedDeclineProposalId, setSelectedDeclineProposalId] = useState<string | null>(null);
  const [interviewSuccessMessage, setInterviewSuccessMessage] = useState<string | null>(null);
  const [userSelectedDecision, setUserSelectedDecision] = useState<ReviewDecision | null>(null);
  const [userReviewNotes, setUserReviewNotes] = useState<string | null>(null);
  const [shortlistNotes, setShortlistNotes] = useState('');
  const [reviewSuccessMessage, setReviewSuccessMessage] = useState<string | null>(null);
  const [shortlistSuccessMessage, setShortlistSuccessMessage] = useState<string | null>(null);
  const [submissionSuccessMessage, setSubmissionSuccessMessage] = useState<string | null>(null);

  const selectedDecision = userSelectedDecision ?? candidate?.review?.decision ?? null;
  const reviewNotes = userReviewNotes ?? candidate?.review?.notesInternal ?? '';

  // Load timeline on mount
  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const handleCopyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Fallback if clipboard API is restricted
    }
  }, []);

  if (status === 'loading') {
    return (
      <LoadingRegion label="Loading candidate details" className="space-y-6 p-6">
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  }

  if (status === 'error' || !candidate) {
    return (
      <div className="p-6">
        <EmptyState
          icon={AlertCircle}
          title="Failed to load candidate"
          description={error ?? 'Candidate details could not be retrieved.'}
          action={
            <div className="flex gap-3">
              <Button variant="primary" onClick={() => void reload()}>
                Retry
              </Button>
              {onClose ? (
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
              ) : null}
            </div>
          }
        />
      </div>
    );
  }

  const isPdf =
    fileMimeType === 'application/pdf' || candidate.resume.fileName.toLowerCase().endsWith('.pdf');
  const wordCount = extraction?.extractedText
    ? extraction.extractedText.trim().split(/\s+/).filter(Boolean).length
    : 0;

  const isConsentActive = candidate.consent?.status === 'ACTIVE';
  const parseStatus = resumeDetails?.parseStatus;

  let processingBadge: {
    label: string;
    tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    title: string;
  };
  if (!isConsentActive) {
    processingBadge = {
      label: 'Held for Consent',
      tone: 'warning',
      title: 'Automated processing held: candidate consent is pending or withdrawn.',
    };
  } else if (!parseStatus || parseStatus === 'PENDING') {
    processingBadge = {
      label: 'Queued',
      tone: 'neutral',
      title: 'Resume is queued for text extraction.',
    };
  } else if (parseStatus === 'PROCESSING') {
    processingBadge = {
      label: 'Extracting Text',
      tone: 'info',
      title: 'Resume text extraction is currently processing.',
    };
  } else if (parseStatus === 'FAILED') {
    processingBadge = {
      label: 'Extraction Failed',
      tone: 'danger',
      title: 'Document text extraction failed.',
    };
  } else if (parseStatus === 'PARSED') {
    if (extraction?.qualityStatus === 'NEEDS_REVIEW') {
      processingBadge = {
        label: 'Extraction Needs Review',
        tone: 'warning',
        title: 'Extraction completed with potential formatting or character flags.',
      };
    } else if (extraction?.qualityStatus === 'FAILED') {
      processingBadge = {
        label: 'Extraction Failed',
        tone: 'danger',
        title: 'Extraction quality status failed.',
      };
    } else {
      processingBadge = {
        label: 'Extraction Complete',
        tone: 'success',
        title: 'Text extraction completed successfully.',
      };
    }
  } else {
    processingBadge = {
      label: parseStatus,
      tone: 'neutral',
      title: `Parse status: ${parseStatus}`,
    };
  }

  return (
    <div className="flex flex-col space-y-6 p-4 sm:p-6 text-fg">
      {/* ------------------------------------------------------------------- */}
      {/* Top Identity Header                                                 */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-xl font-bold tracking-tight text-fg">
              {candidate.candidateCode}
            </h2>
            <button
              type="button"
              onClick={() => void handleCopyCode(candidate.candidateCode)}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-fg-subtle hover:bg-bg-subtle hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent"
              title="Copy candidate code"
              aria-label="Copy candidate code to clipboard"
            >
              {copiedCode ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" />
                  <span className="text-success">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
            {hasInspectedOriginal ? (
              <Badge tone="success" dot>
                Original CV Inspected
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                Original CV Not Inspected
              </Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-fg-subtle">
            {candidate.requisitionTitle} &middot;{' '}
            <span className="font-medium text-fg">{candidate.client.name}</span>
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{candidate.resume.fileType}</Badge>
            <Badge tone="neutral">{formatBytes(candidate.resume.sizeBytes)}</Badge>
            <span title={processingBadge.title} className="inline-flex">
              <Badge tone={processingBadge.tone} dot>
                {processingBadge.label}
              </Badge>
            </span>
            {candidate.consent ? (
              <Badge tone={candidate.consent.status === 'ACTIVE' ? 'success' : 'warning'} dot>
                Consent {candidate.consent.status.toLowerCase()} (v{candidate.consent.policyVersion}
                )
              </Badge>
            ) : (
              <button
                type="button"
                onClick={() => setIsConsentModalOpen(true)}
                className="inline-flex items-center cursor-pointer focus:outline-none"
                title="Click to issue consent invitation"
              >
                <Badge tone="danger" dot>
                  Consent Pending &middot; Issue Invitation
                </Badge>
              </button>
            )}
            {candidate.assessment ? (
              <Badge tone={candidate.assessment.status === 'COMPLETE' ? 'success' : 'warning'} dot>
                Score: {candidate.assessment.score ?? '—'}% (
                {Math.round(candidate.assessment.coverage * 100)}% coverage)
              </Badge>
            ) : null}
          </div>
        </div>

        {headerAction ? <div className="self-start">{headerAction}</div> : null}
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Submission Gate Compliance Banner                                   */}
      {/* ------------------------------------------------------------------- */}
      {hasInspectedOriginal ? (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3.5 text-xs text-emerald-300"
        >
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
          <p>
            <span className="font-semibold">Recruiter inspection verified:</span> The original CV
            has been retrieved and verified for compliance. Candidate is eligible for client
            submission once reviews and shortlisting are completed.
          </p>
        </div>
      ) : (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <p>
              <span className="font-semibold">Compliance requirement:</span> Recruiter inspection of
              the original CV file is required before submitting this candidate to the client.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0 border-amber-500/40 text-amber-200 hover:bg-amber-500/20"
            onClick={() => void inspectOriginalFile()}
            disabled={fileStatus === 'loading'}
          >
            <Eye className="mr-1.5 h-3.5 w-3.5" />
            {fileStatus === 'loading' ? 'Loading CV...' : 'Inspect Original CV'}
          </Button>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* Recruiter Evaluation & Shortlist Action Workspace                   */}
      {/* ------------------------------------------------------------------- */}
      <Card className="p-5 border-border bg-surface-raised space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-border/60 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-fg">Recruiter Evaluation & Shortlisting</h3>
              <Badge tone="accent" dot>
                Human In The Loop
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-fg-subtle">
              AI screening scores are advisory aids. Human review decisions and shortlisting are
              required to progress candidates.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-fg-subtle">Decision:</span>
              <Badge
                tone={candidate.review ? getReviewStatusTone(candidate.review.decision) : 'neutral'}
                dot
              >
                {candidate.review
                  ? getReviewStatusLabel(candidate.review.decision)
                  : 'Not Reviewed'}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-fg-subtle">Shortlist:</span>
              <Badge tone={candidate.shortlist ? 'success' : 'neutral'} dot>
                {candidate.shortlist ? 'Shortlisted' : 'Not Shortlisted'}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-fg-subtle">Client:</span>
              <Badge tone={getSubmissionStatusTone(candidate.submission?.status)} dot>
                {getSubmissionStatusLabel(candidate.submission?.status)}
              </Badge>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Column 1: Record Review Decision */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                1. Recruiter Review Decision
              </h4>
              {candidate.review ? (
                <span className="text-[11px] text-fg-subtle">
                  Last: {candidate.review.decision} ({formatDate(candidate.review.reviewedAt)})
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                size="sm"
                variant={selectedDecision === 'REVIEWED' ? 'primary' : 'secondary'}
                disabled={isSubmittingReview}
                onClick={async () => {
                  setUserSelectedDecision('REVIEWED');
                  setReviewSuccessMessage(null);
                  await recordReview('REVIEWED', reviewNotes.trim() || undefined);
                  setReviewSuccessMessage('Review decision recorded as Reviewed.');
                  setTimeout(() => setReviewSuccessMessage(null), 4000);
                }}
                className="text-xs flex items-center justify-center gap-1"
              >
                <Check className="h-3.5 w-3.5" />
                Reviewed
              </Button>
              <Button
                type="button"
                size="sm"
                variant={selectedDecision === 'NEEDS_REVIEW' ? 'primary' : 'secondary'}
                disabled={isSubmittingReview}
                onClick={async () => {
                  setUserSelectedDecision('NEEDS_REVIEW');
                  setReviewSuccessMessage(null);
                  await recordReview('NEEDS_REVIEW', reviewNotes.trim() || undefined);
                  setReviewSuccessMessage('Candidate flagged for further review.');
                  setTimeout(() => setReviewSuccessMessage(null), 4000);
                }}
                className="text-xs flex items-center justify-center gap-1"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Flag / Needs Review
              </Button>
              <Button
                type="button"
                size="sm"
                variant={selectedDecision === 'CLOSED' ? 'danger' : 'secondary'}
                disabled={isSubmittingReview}
                onClick={async () => {
                  setUserSelectedDecision('CLOSED');
                  setReviewSuccessMessage(null);
                  await recordReview('CLOSED', reviewNotes.trim() || undefined);
                  setReviewSuccessMessage('Candidate application marked as Closed.');
                  setTimeout(() => setReviewSuccessMessage(null), 4000);
                }}
                className="text-xs flex items-center justify-center gap-1"
              >
                <XCircle className="h-3.5 w-3.5" />
                Decline / Closed
              </Button>
            </div>

            <div className="space-y-1">
              <label htmlFor="review-notes" className="text-xs text-fg-subtle block">
                Internal Recruiter Notes (optional, max 2000 chars)
              </label>
              <textarea
                id="review-notes"
                value={reviewNotes}
                onChange={(e) => setUserReviewNotes(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="Enter observations, interview recommendations, or context..."
                className="w-full rounded-md border border-border bg-bg-surface p-2 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <div className="flex items-center justify-between text-[11px] text-fg-subtle">
                <span>{reviewNotes.length}/2000 characters</span>
                {selectedDecision ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs px-2"
                    disabled={isSubmittingReview}
                    onClick={async () => {
                      setReviewSuccessMessage(null);
                      await recordReview(selectedDecision, reviewNotes.trim() || undefined);
                      setReviewSuccessMessage('Review notes updated successfully.');
                      setTimeout(() => setReviewSuccessMessage(null), 4000);
                    }}
                  >
                    Save Notes
                  </Button>
                ) : null}
              </div>
            </div>

            {reviewError ? (
              <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{reviewError}</span>
              </div>
            ) : null}

            {reviewSuccessMessage ? (
              <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{reviewSuccessMessage}</span>
              </div>
            ) : null}
          </div>

          {/* Column 2: Shortlisting Decision */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                2. Shortlist Candidate
              </h4>
              {candidate.shortlist ? (
                <Badge tone="success" dot>
                  Shortlisted
                </Badge>
              ) : null}
            </div>

            {candidate.shortlist ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs space-y-2">
                <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                  <Star className="h-4 w-4 fill-emerald-400 text-emerald-400" />
                  Candidate is Shortlisted
                </div>
                <p className="text-fg-subtle">
                  Shortlisted on {formatDate(candidate.shortlist.shortlistedAt)}. Candidate is
                  authorized for hiring client submission.
                </p>
                {candidate.shortlist.notesInternal ? (
                  <div className="rounded bg-bg-surface/50 p-2 text-fg-subtle text-[11px]">
                    <span className="font-semibold text-fg">Notes: </span>
                    {candidate.shortlist.notesInternal}
                  </div>
                ) : null}
                <p className="text-[11px] text-fg-subtle border-t border-border/40 pt-1.5">
                  Downgrading review decision to Flag or Decline will automatically invalidate this
                  shortlist.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded border border-border bg-bg-surface/40 p-2.5 text-xs space-y-1.5">
                  <div className="font-medium text-fg">Prerequisites for Shortlisting:</div>
                  <div className="space-y-1 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      {isConsentActive ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span className={isConsentActive ? 'text-fg' : 'text-fg-subtle'}>
                        Active candidate screening consent
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasInspectedOriginal ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span className={hasInspectedOriginal ? 'text-fg' : 'text-fg-subtle'}>
                        Original resume inspected by recruiter
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {candidate.review?.decision === 'REVIEWED' ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span
                        className={
                          candidate.review?.decision === 'REVIEWED' ? 'text-fg' : 'text-fg-subtle'
                        }
                      >
                        Recruiter recorded positive REVIEWED decision
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="shortlist-notes" className="text-xs text-fg-subtle block">
                    Shortlist Handover Notes (optional, max 2000 chars)
                  </label>
                  <textarea
                    id="shortlist-notes"
                    value={shortlistNotes}
                    onChange={(e) => setShortlistNotes(e.target.value)}
                    maxLength={2000}
                    rows={2}
                    placeholder="Enter notes for client submission..."
                    className="w-full rounded-md border border-border bg-bg-surface p-2 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>

                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    !isConsentActive ||
                    !hasInspectedOriginal ||
                    candidate.review?.decision !== 'REVIEWED' ||
                    isShortlisting
                  }
                  onClick={async () => {
                    setShortlistSuccessMessage(null);
                    await shortlist(shortlistNotes.trim() || undefined);
                    setShortlistSuccessMessage(
                      'Candidate successfully shortlisted for client submission.',
                    );
                    setTimeout(() => setShortlistSuccessMessage(null), 4000);
                  }}
                  className="w-full text-xs h-8 flex items-center justify-center gap-1.5"
                  title={
                    !isConsentActive
                      ? 'Active candidate consent required'
                      : !hasInspectedOriginal
                        ? 'Inspect original CV first'
                        : candidate.review?.decision !== 'REVIEWED'
                          ? "Candidate must have 'Reviewed' decision first"
                          : 'Shortlist candidate for client submission'
                  }
                >
                  <Star className="h-3.5 w-3.5" />
                  {isShortlisting ? 'Shortlisting...' : 'Shortlist Candidate'}
                </Button>

                {!isConsentActive ||
                !hasInspectedOriginal ||
                candidate.review?.decision !== 'REVIEWED' ? (
                  <p className="text-[11px] text-amber-300/90 text-center">
                    {!isConsentActive
                      ? 'Active candidate screening consent is required.'
                      : !hasInspectedOriginal
                        ? 'Recruiter must inspect the original CV before shortlisting.'
                        : "Candidate must have a 'Reviewed' decision before shortlisting."}
                  </p>
                ) : null}

                {shortlistError ? (
                  <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{shortlistError}</span>
                  </div>
                ) : null}

                {shortlistSuccessMessage ? (
                  <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{shortlistSuccessMessage}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Column 3: Submit to Hiring Client */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                3. Submit to Client
              </h4>
              <Badge tone={getSubmissionStatusTone(candidate.submission?.status)} dot>
                {getSubmissionStatusLabel(candidate.submission?.status)}
              </Badge>
            </div>

            {candidate.submission && candidate.submission.status !== 'WITHDRAWN' ? (
              <div className="space-y-2 rounded-lg border border-border bg-bg-surface p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Submitted To:</span>
                  <span className="font-medium text-fg">{candidate.client.name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Submitted At:</span>
                  <span className="text-fg">{formatDate(candidate.submission.submittedAt)}</span>
                </div>

                {candidate.clientFeedback && candidate.clientFeedback.length > 0 ? (
                  <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                    <span className="font-semibold text-fg-subtle text-[11px] uppercase tracking-wider">
                      Client Feedback
                    </span>
                    {candidate.clientFeedback.map((fb) => (
                      <div
                        key={fb.id}
                        className="rounded border border-border/80 bg-surface-muted p-2 space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <Badge tone={fb.decision === 'SHORTLIST' ? 'success' : 'neutral'} dot>
                            {fb.decision === 'SHORTLIST' ? 'Client Shortlisted' : 'Client Declined'}
                          </Badge>
                          <span className="text-[10px] text-fg-subtle">
                            {formatDate(fb.createdAt)}
                          </span>
                        </div>
                        {fb.reason ? (
                          <p className="text-[11px] text-fg italic">&ldquo;{fb.reason}&rdquo;</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded border border-info/30 bg-info/5 p-2 text-xs text-info flex items-center gap-2 mt-2">
                    <Info className="h-4 w-4 shrink-0" />
                    <span>Awaiting review by hiring manager in client portal.</span>
                  </div>
                )}

                {/* Interview Coordination & Proposals */}
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-fg-subtle text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-accent" />
                      Interview Coordination
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      className="h-6 text-[11px] px-2 flex items-center gap-1"
                      onClick={() => {
                        setSelectedRescheduleProposalId(null);
                        setIsInterviewProposalModalOpen(true);
                      }}
                      disabled={isInterviewLoading}
                    >
                      <Clock className="h-3 w-3" />
                      Propose Slot
                    </Button>
                  </div>

                  {interviewSuccessMessage ? (
                    <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>{interviewSuccessMessage}</span>
                    </div>
                  ) : null}

                  {interviewError ? (
                    <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>{interviewError}</span>
                    </div>
                  ) : null}

                  {candidate.interviews && candidate.interviews.length > 0 ? (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
                      {candidate.interviews.map((iv) => (
                        <div
                          key={iv.id}
                          className="rounded border border-border/80 bg-surface-muted p-2 space-y-1.5 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <Badge tone={getInterviewStatusTone(iv.status)} dot>
                              {iv.status}
                            </Badge>
                            <Badge tone="neutral" className="text-[10px]">
                              {iv.format}
                            </Badge>
                          </div>

                          <div className="text-[11px] text-fg font-medium">
                            {formatInterviewWindow(iv.startAt, iv.endAt, iv.timezone)}
                          </div>

                          {iv.reason ? (
                            <div className="text-[11px] text-fg-subtle italic bg-bg-surface/50 p-1.5 rounded">
                              &ldquo;{iv.reason}&rdquo;
                            </div>
                          ) : null}

                          {/* Action buttons */}
                          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/40">
                            {iv.status === 'PROPOSED' ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="primary"
                                  className="h-6 text-[10px] px-2"
                                  disabled={isInterviewLoading}
                                  onClick={async () => {
                                    setInterviewSuccessMessage(null);
                                    await acceptInterview(iv.id);
                                    setInterviewSuccessMessage('Interview proposal accepted.');
                                    setTimeout(() => setInterviewSuccessMessage(null), 4000);
                                  }}
                                >
                                  <Check className="h-3 w-3 mr-1" />
                                  Accept
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  className="h-6 text-[10px] px-2"
                                  disabled={isInterviewLoading}
                                  onClick={() => {
                                    setSelectedRescheduleProposalId(iv.id);
                                    setIsInterviewProposalModalOpen(true);
                                  }}
                                >
                                  Reschedule
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="danger"
                                  className="h-6 text-[10px] px-2"
                                  disabled={isInterviewLoading}
                                  onClick={() => {
                                    setSelectedDeclineProposalId(iv.id);
                                    setIsInterviewDeclineModalOpen(true);
                                  }}
                                >
                                  Decline
                                </Button>
                              </>
                            ) : null}

                            {iv.status === 'ACCEPTED' ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-6 text-[10px] px-2 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20"
                                disabled={isInterviewLoading}
                                onClick={async () => {
                                  setInterviewSuccessMessage(null);
                                  await completeInterviewAction(iv.id);
                                  setInterviewSuccessMessage('Interview marked as completed.');
                                  setTimeout(() => setInterviewSuccessMessage(null), 4000);
                                }}
                              >
                                <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" />
                                Mark Completed
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded border border-dashed border-border/80 bg-bg-surface/30 p-2 text-center text-[11px] text-fg-subtle">
                      No interviews scheduled or proposed yet.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-bg-surface p-3 space-y-2">
                  <span className="text-xs font-medium text-fg block">
                    Submission Prerequisites:
                  </span>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-1.5">
                      {candidate.shortlist ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span className={candidate.shortlist ? 'text-fg' : 'text-fg-subtle'}>
                        Candidate shortlisted by recruiter
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasInspectedOriginal ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span className={hasInspectedOriginal ? 'text-fg' : 'text-fg-subtle'}>
                        Original CV inspected by recruiter
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isConsentActive ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-danger" />
                      )}
                      <span className={isConsentActive ? 'text-fg' : 'text-fg-subtle'}>
                        Active candidate screening consent
                      </span>
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    !candidate.shortlist ||
                    !hasInspectedOriginal ||
                    !isConsentActive ||
                    isSubmittingToClient
                  }
                  onClick={async () => {
                    setSubmissionSuccessMessage(null);
                    await submitToClient();
                    setSubmissionSuccessMessage(
                      `Candidate successfully submitted to ${candidate.client.name}.`,
                    );
                    setTimeout(() => setSubmissionSuccessMessage(null), 4000);
                  }}
                  className="w-full text-xs h-8 flex items-center justify-center gap-1.5"
                >
                  <Send className="h-3.5 w-3.5" />
                  {isSubmittingToClient
                    ? 'Submitting to Client...'
                    : `Submit to ${candidate.client.name}`}
                </Button>

                {!candidate.shortlist || !hasInspectedOriginal || !isConsentActive ? (
                  <p className="text-[11px] text-amber-300/90 text-center">
                    {!candidate.shortlist
                      ? 'Candidate must be shortlisted first.'
                      : !hasInspectedOriginal
                        ? 'Original CV inspection is required before client submission.'
                        : 'Active candidate screening consent is required.'}
                  </p>
                ) : null}

                {submissionError ? (
                  <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{submissionError}</span>
                  </div>
                ) : null}

                {submissionSuccessMessage ? (
                  <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-success flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{submissionSuccessMessage}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------------- */}
      {/* Tabbed Inspection Workspace                                         */}
      {/* ------------------------------------------------------------------- */}
      <Tabs defaultValue="extraction" className="space-y-4">
        <TabList
          label="Candidate Inspection Tabs"
          className="w-full justify-start border-b border-border pb-px"
        >
          <Tab value="extraction">
            <FileText className="mr-1.5 h-3.5 w-3.5" />
            Extracted Text
          </Tab>
          <Tab value="inspection">
            <Eye className="mr-1.5 h-3.5 w-3.5" />
            Original CV Inspection
          </Tab>
          <Tab value="criteria">
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            Criteria & Assessment
          </Tab>
          <Tab value="metadata">
            <Clock className="mr-1.5 h-3.5 w-3.5" />
            Consent & Audit
          </Tab>
        </TabList>

        {/* ----------------------------------------------------------------- */}
        {/* TAB 1: Extracted Text                                             */}
        {/* ----------------------------------------------------------------- */}
        <TabPanel value="extraction" className="space-y-4 pt-2">
          {extractionStatus === 'loading' ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : extraction ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-surface px-4 py-2.5 text-xs text-fg-subtle border border-border">
                <div className="flex items-center gap-3">
                  <Badge
                    tone={
                      extraction.qualityStatus === 'COMPLETE'
                        ? 'success'
                        : extraction.qualityStatus === 'NEEDS_REVIEW'
                          ? 'warning'
                          : 'danger'
                    }
                    dot
                  >
                    Quality: {extraction.qualityStatus.toLowerCase()}
                  </Badge>
                  <span>
                    Parser: <span className="font-mono text-fg">{extraction.parser}</span> (v
                    {extraction.version})
                  </span>
                  <span>{extraction.ocrUsed ? 'OCR Engine Used' : 'Direct Text Extraction'}</span>
                </div>
                <div>
                  <span className="font-mono font-medium text-fg">
                    {wordCount.toLocaleString()}
                  </span>{' '}
                  words &middot;{' '}
                  <span className="font-mono font-medium text-fg">
                    {extraction.extractedText.length.toLocaleString()}
                  </span>{' '}
                  characters
                </div>
              </div>

              <div
                tabIndex={0}
                aria-label="Extracted candidate resume text"
                className="max-h-[550px] overflow-y-auto rounded-lg border border-border bg-bg-surface p-4 font-mono text-xs leading-relaxed text-fg select-text whitespace-pre-wrap focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {extraction.extractedText}
              </div>
            </div>
          ) : !isConsentActive ? (
            <Card className="p-8 text-center border-warning/30 bg-warning/5">
              <ShieldCheck className="mx-auto h-8 w-8 text-warning" />
              <h3 className="mt-3 text-sm font-semibold text-fg">
                Processing Held for Candidate Consent
              </h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                Text extraction and automated analysis are suspended because candidate consent is
                pending or has been withdrawn. Processing will resume automatically once valid
                consent is authorized.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="primary" onClick={() => setIsConsentModalOpen(true)}>
                  Issue Consent Invitation
                </Button>
              </div>
            </Card>
          ) : parseStatus === 'FAILED' ? (
            <Card className="p-8 text-center border-danger/30 bg-danger/5">
              <AlertCircle className="mx-auto h-8 w-8 text-danger" />
              <h3 className="mt-3 text-sm font-semibold text-fg">Document Extraction Failed</h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                {extractionError ||
                  'Automatic extraction processing failed for this resume file. Inspect the original document file directly or upload a valid replacement.'}
              </p>
              <div className="mt-4">
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-center">
              <Clock className="mx-auto h-8 w-8 text-fg-subtle" />
              <h3 className="mt-3 text-sm font-semibold text-fg">Text Extraction in Progress</h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                The resume document is currently queued or undergoing automated text extraction.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
            </Card>
          )}
        </TabPanel>

        {/* ----------------------------------------------------------------- */}
        {/* TAB 2: Original CV Inspection                                     */}
        {/* ----------------------------------------------------------------- */}
        <TabPanel value="inspection" className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-surface p-4">
            <div>
              <p className="text-sm font-medium text-fg truncate" title={candidate.resume.fileName}>
                {candidate.resume.fileName}
              </p>
              <p className="text-xs text-fg-subtle mt-0.5">
                Uploaded {formatDate(candidate.resume.uploadedAt)} &middot;{' '}
                {candidate.resume.fileType} ({formatBytes(candidate.resume.sizeBytes)})
              </p>
            </div>
            <div className="flex items-center gap-2">
              {fileStatus !== 'ready' ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void inspectOriginalFile()}
                  disabled={fileStatus === 'loading'}
                >
                  <Eye className="mr-1.5 h-3.5 w-3.5" />
                  {fileStatus === 'loading' ? 'Retrieving Document...' : 'Inspect Original File'}
                </Button>
              ) : (
                <a
                  href={fileBlobUrl ?? '#'}
                  download={fileName ?? candidate.resume.fileName}
                  className="inline-flex items-center gap-1.5 rounded-md bg-bg-subtle px-3 py-1.5 text-xs font-medium text-fg hover:bg-border transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download File
                </a>
              )}
            </div>
          </div>

          {fileStatus === 'loading' ? (
            <div className="p-12 text-center space-y-3">
              <Skeleton className="h-6 w-48 mx-auto" />
              <Skeleton className="h-96 w-full" />
            </div>
          ) : fileStatus === 'error' ? (
            <Card className="p-6 text-center border-danger/30 bg-danger/5">
              <AlertCircle className="mx-auto h-8 w-8 text-danger" />
              <p className="mt-2 text-sm font-semibold text-fg">Unable to load resume file</p>
              <p className="mt-1 text-xs text-fg-subtle">{fileError}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-4"
                onClick={() => void inspectOriginalFile()}
              >
                Retry Inspection
              </Button>
            </Card>
          ) : fileStatus === 'ready' && fileBlobUrl ? (
            isPdf ? (
              <div className="space-y-2">
                <object
                  data={fileBlobUrl}
                  type="application/pdf"
                  className="h-[650px] w-full rounded-lg border border-border bg-white"
                  aria-label="Original resume PDF viewer"
                >
                  <div className="p-8 text-center text-xs text-fg-subtle">
                    <p>PDF preview is not supported directly by your browser environment.</p>
                    <a
                      href={fileBlobUrl}
                      download={fileName ?? candidate.resume.fileName}
                      className="mt-3 inline-flex items-center gap-1 text-accent underline"
                    >
                      <Download className="h-3 w-3" />
                      Download {fileName ?? 'PDF'} directly
                    </a>
                  </div>
                </object>
              </div>
            ) : (
              <Card className="p-8 text-center space-y-4">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <FileText className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-fg">DOCX Document Inspected</h3>
                  <p className="mx-auto mt-1 max-w-md text-xs text-fg-subtle leading-relaxed">
                    DOCX files are binary package archives. To prevent exposure to unverified
                    third-party document renderers and preserve sandbox isolation, inspect the
                    original file locally.
                  </p>
                </div>
                <div>
                  <a
                    href={fileBlobUrl}
                    download={fileName ?? candidate.resume.fileName}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <Download className="h-4 w-4" />
                    Download & Inspect Original DOCX
                  </a>
                </div>
                <div className="flex items-center justify-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Inspection logged to compliance audit trail</span>
                </div>
              </Card>
            )
          ) : (
            <Card className="p-8 text-center">
              <Eye className="mx-auto h-8 w-8 text-fg-subtle" />
              <h3 className="mt-3 text-sm font-semibold text-fg">Original Resume Not Yet Loaded</h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                Click "Inspect Original File" above to fetch the authenticated CV buffer from
                storage and record mandatory recruiter inspection.
              </p>
              <Button
                size="sm"
                variant="primary"
                className="mt-4"
                onClick={() => void inspectOriginalFile()}
              >
                Inspect Now
              </Button>
            </Card>
          )}
        </TabPanel>

        {/* ----------------------------------------------------------------- */}
        {/* TAB 3: Criteria & Assessment                                      */}
        {/* ----------------------------------------------------------------- */}
        <TabPanel value="criteria" className="space-y-4 pt-2">
          {/* AI Governance & Human Control Notice */}
          <div
            role="region"
            aria-label="AI Assessment Governance Notice"
            className="flex items-start gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3.5 text-xs text-fg-subtle"
          >
            <Info className="h-4 w-4 shrink-0 text-accent mt-0.5" />
            <p className="leading-relaxed">
              <strong className="text-fg font-medium">AI-Assisted Evaluation Advisory:</strong>{' '}
              Scorecard assessment performs deterministic evidence extraction against the
              candidate&apos;s resume to assist recruiter evaluation. The system never automatically
              advances, shortlists, or rejects candidates. All consequential hiring decisions remain
              under human recruiter control.
            </p>
          </div>

          {candidate.assessment && candidate.assessment.criteria.length > 0 ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-surface p-4 text-xs text-fg-subtle">
                <div>
                  <span className="font-semibold text-fg">Formula Version:</span>{' '}
                  <span className="font-mono">{candidate.assessment.formulaVersion}</span>
                </div>
                <div>
                  <span className="font-semibold text-fg">Evidence Coverage:</span>{' '}
                  <span className="font-bold text-fg">
                    {Math.round(candidate.assessment.coverage * 100)}%
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-fg">Evaluation Status:</span>{' '}
                  <Badge
                    tone={
                      candidate.assessment.status === 'COMPLETE' ||
                      candidate.assessment.status === 'COMPLETED'
                        ? 'success'
                        : candidate.assessment.status === 'NEEDS_REVIEW'
                          ? 'warning'
                          : candidate.assessment.status === 'FAILED'
                            ? 'danger'
                            : 'info'
                    }
                    dot
                  >
                    {candidate.assessment.status === 'COMPLETE' ||
                    candidate.assessment.status === 'COMPLETED'
                      ? 'Assessment Complete'
                      : candidate.assessment.status === 'NEEDS_REVIEW'
                        ? 'Needs Recruiter Review'
                        : candidate.assessment.status === 'FAILED'
                          ? 'Assessment Failed'
                          : candidate.assessment.status}
                  </Badge>
                </div>
                <div>
                  <span className="font-semibold text-fg">Total Score:</span>{' '}
                  {candidate.assessment.score !== null ? (
                    <span className="font-bold text-fg">{candidate.assessment.score}%</span>
                  ) : (
                    <span className="font-semibold text-warning">Pending Review / Incomplete</span>
                  )}
                </div>
              </div>

              {candidate.assessment.status === 'NEEDS_REVIEW' ? (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    <strong>Recruiter Review Required:</strong> One or more criteria require manual
                    evaluation due to unverified, partial, or conflicting resume evidence.
                  </span>
                </div>
              ) : null}

              <div className="space-y-3">
                {candidate.assessment.criteria.map((criterion) => {
                  const isMustHave = criterion.requirementType === 'MUST_HAVE';
                  const isMatch = criterion.status === 'MATCH' || criterion.status === 'MET';
                  const isPartial =
                    criterion.status === 'PARTIAL' || criterion.status === 'PARTIALLY_MET';
                  const isUncertain = criterion.status === 'UNCERTAIN';

                  return (
                    <Card key={criterion.id} className="p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-fg">{criterion.label}</span>
                          <Badge tone="neutral">{criterion.category}</Badge>
                          <Badge tone={isMustHave ? 'danger' : 'neutral'}>
                            {isMustHave ? 'Must-Have' : 'Preferred / Nice-to-Have'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-fg-subtle">Weight: {criterion.weight}%</span>
                          <Badge
                            tone={
                              isMatch
                                ? 'success'
                                : isPartial
                                  ? 'warning'
                                  : isUncertain
                                    ? 'warning'
                                    : 'danger'
                            }
                            dot
                          >
                            {isMatch
                              ? `Match (${criterion.score ?? '—'}%)`
                              : isPartial
                                ? `Partial (${criterion.score ?? '—'}%)`
                                : isUncertain
                                  ? 'Uncertain / Conflicting'
                                  : `Not Found (${criterion.score ?? '0'}%)`}
                          </Badge>
                        </div>
                      </div>

                      <p className="text-xs text-fg-subtle leading-relaxed">
                        {criterion.reasoning}
                      </p>

                      {isUncertain ? (
                        <div className="flex items-center gap-1.5 rounded border border-warning/30 bg-warning/5 p-2 text-xs text-warning font-medium">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            Conflicting or ambiguous resume evidence detected. Recruiter
                            verification required.
                          </span>
                        </div>
                      ) : null}

                      {criterion.evidence.length > 0 ? (
                        <div className="space-y-2 pt-2 border-t border-border">
                          <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wider">
                            Extracted Evidence Quotes
                          </p>
                          {criterion.evidence.map((ev, idx) => (
                            <div
                              key={idx}
                              className="rounded border border-border bg-bg-subtle p-2.5 text-xs text-fg"
                            >
                              <p className="italic text-fg-subtle">&quot;{ev.quote}&quot;</p>
                              <div className="mt-1 flex items-center justify-between text-[10px] text-fg-subtle">
                                <span>
                                  {ev.pageNumber ? `Page ${ev.pageNumber}` : 'Document body'}
                                </span>
                                <Badge tone={ev.verified ? 'success' : 'warning'} dot>
                                  {ev.verified ? 'Verified Quote' : 'Pending Review'}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 rounded border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          <span>No verifiable evidence quote found in resume.</span>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : !isConsentActive ? (
            <Card className="p-8 text-center border-warning/30 bg-warning/5">
              <ShieldCheck className="mx-auto h-8 w-8 text-warning" />
              <h3 className="mt-3 text-sm font-semibold text-fg">
                Assessment Held for Candidate Consent
              </h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                Candidate consent for hiring use is mandatory before automated scorecard assessment
                can be performed.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="primary" onClick={() => setIsConsentModalOpen(true)}>
                  Issue Consent Invitation
                </Button>
              </div>
            </Card>
          ) : !extraction || extraction.qualityStatus === 'FAILED' || parseStatus !== 'PARSED' ? (
            <Card className="p-8 text-center">
              <Clock className="mx-auto h-8 w-8 text-fg-subtle" />
              <h3 className="mt-3 text-sm font-semibold text-fg">
                Awaiting Complete Resume Extraction
              </h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                Resume parsing and text extraction must finish successfully before scorecard
                criteria can be evaluated against the candidate&apos;s CV.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh Status
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-center">
              <Sparkles className="mx-auto h-8 w-8 text-accent" />
              <h3 className="mt-3 text-sm font-semibold text-fg">Ready for Scorecard Assessment</h3>
              <p className="mt-1 text-xs text-fg-subtle max-w-sm mx-auto">
                Candidate consent is authorized and resume extraction is complete. You can now
                execute deterministic AI scorecard evaluation.
              </p>
              <div className="mt-4">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void triggerAssessment()}
                  disabled={isAssessing}
                >
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  {isAssessing ? 'Initiating Assessment...' : 'Run Scorecard Assessment'}
                </Button>
              </div>
              {assessmentError ? (
                <p className="mt-3 text-xs text-danger font-medium">{assessmentError}</p>
              ) : null}
            </Card>
          )}
        </TabPanel>

        {/* ----------------------------------------------------------------- */}
        {/* TAB 4: Consent & Audit                                            */}
        {/* ----------------------------------------------------------------- */}
        <TabPanel value="metadata" className="space-y-4 pt-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Candidate Consent Status
              </h4>
              {candidate.consent ? (
                <div className="space-y-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-fg-subtle">Status:</span>
                      <Badge
                        tone={candidate.consent.status === 'ACTIVE' ? 'success' : 'warning'}
                        dot
                      >
                        {candidate.consent.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-fg-subtle">Policy Version:</span>
                      <span className="font-mono text-fg">{candidate.consent.policyVersion}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-fg-subtle">Captured At:</span>
                      <span className="text-fg">{formatDate(candidate.consent.capturedAt)}</span>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border flex items-center justify-between">
                    <span className="text-[11px] text-fg-subtle">Consent is active.</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setIsConsentModalOpen(true)}
                      className="text-xs h-7 px-2"
                    >
                      Re-issue Invitation
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded border border-warning/30 bg-warning/5 p-2.5 text-xs space-y-1">
                    <p className="font-semibold text-warning">Consent Required</p>
                    <p className="text-fg-subtle">
                      No active consent record captured for this candidate. Screening and AI
                      evaluations cannot proceed until consent is granted.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => setIsConsentModalOpen(true)}
                    className="w-full text-xs h-8 flex items-center justify-center gap-1.5"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    Issue Consent Invitation
                  </Button>
                </div>
              )}
            </Card>

            <Card className="p-4 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Resume Document Audit
              </h4>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Document ID:</span>
                  <span className="font-mono text-fg text-[11px] truncate max-w-[160px]">
                    {candidate.resume.id}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Format:</span>
                  <span className="text-fg">{candidate.resume.fileType}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Size:</span>
                  <span className="text-fg">{formatBytes(candidate.resume.sizeBytes)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Uploaded:</span>
                  <span className="text-fg">{formatDate(candidate.resume.uploadedAt)}</span>
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Recruiter Review Decision
              </h4>
              {candidate.review ? (
                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-fg-subtle">Decision:</span>
                    <Badge tone="success" dot>
                      {candidate.review.decision}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-fg-subtle">Reviewed:</span>
                    <span className="text-fg">{formatDate(candidate.review.reviewedAt)}</span>
                  </div>
                  {candidate.review.notesInternal ? (
                    <div className="mt-2 rounded bg-bg-subtle p-2 text-fg-subtle">
                      <span className="font-semibold text-fg">Notes: </span>
                      {candidate.review.notesInternal}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-fg-subtle">Candidate has not been reviewed yet.</p>
              )}
            </Card>

            <Card className="p-4 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Shortlist & Client Submission
              </h4>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Shortlist Status:</span>
                  <Badge tone={candidate.shortlist ? 'accent' : 'neutral'}>
                    {candidate.shortlist ? 'Shortlisted' : 'Not Shortlisted'}
                  </Badge>
                </div>
                {candidate.shortlist ? (
                  <div className="flex items-center justify-between">
                    <span className="text-fg-subtle">Shortlisted At:</span>
                    <span className="text-fg">{formatDate(candidate.shortlist.shortlistedAt)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-fg-subtle">Client Submission:</span>
                  <Badge tone={getSubmissionStatusTone(candidate.submission?.status)} dot>
                    {getSubmissionStatusLabel(candidate.submission?.status)}
                  </Badge>
                </div>
                {candidate.submission ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-fg-subtle">Submitted At:</span>
                      <span className="text-fg">
                        {formatDate(candidate.submission.submittedAt)}
                      </span>
                    </div>
                    {candidate.clientFeedback && candidate.clientFeedback.length > 0 ? (
                      <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                        <span className="font-semibold text-fg-subtle text-[11px] uppercase tracking-wider block">
                          Client Feedback History
                        </span>
                        {candidate.clientFeedback.map((fb) => (
                          <div
                            key={fb.id}
                            className="rounded border border-border/80 bg-surface-muted p-2 space-y-1"
                          >
                            <div className="flex items-center justify-between">
                              <Badge tone={fb.decision === 'SHORTLIST' ? 'success' : 'neutral'} dot>
                                {fb.decision === 'SHORTLIST'
                                  ? 'Client Shortlisted'
                                  : 'Client Declined'}
                              </Badge>
                              <span className="text-[10px] text-fg-subtle">
                                {formatDate(fb.createdAt)}
                              </span>
                            </div>
                            {fb.reason ? (
                              <p className="text-[11px] text-fg italic">
                                &ldquo;{fb.reason}&rdquo;
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Candidate Pipeline Timeline & Audit History
                </h4>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  onClick={() => void loadTimeline()}
                  disabled={isTimelineLoading}
                >
                  <RefreshCw
                    className={`mr-1.5 h-3 w-3 ${isTimelineLoading ? 'animate-spin' : ''}`}
                  />
                  Refresh Timeline
                </Button>
              </div>

              {isTimelineLoading && !timeline ? (
                <div className="space-y-2 py-2">
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : timeline && timeline.items.length > 0 ? (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {timeline.items.map((event) => (
                    <div
                      key={event.id}
                      className="flex flex-col gap-1 rounded-md border border-border/50 bg-bg-surface p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-fg">
                          {event.fromStage} &rarr; {event.toStage}
                        </span>
                        <span className="text-[11px] text-fg-subtle">
                          {formatDate(event.createdAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-fg-subtle text-[11px]">
                        <Badge tone="neutral" className="text-[10px] py-0 px-1.5">
                          {event.actorRole}
                        </Badge>
                        {event.reason ? <span className="truncate">{event.reason}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-fg-subtle">
                  No pipeline transition events recorded yet.
                </p>
              )}
            </Card>
          </div>
        </TabPanel>
      </Tabs>

      <ConsentInvitationModal
        open={isConsentModalOpen}
        onClose={() => {
          setIsConsentModalOpen(false);
          void reload();
        }}
        requisitionId={requisitionId}
        candidateId={candidateId}
        candidateCode={candidate.candidateCode}
      />

      <InterviewProposalModal
        open={isInterviewProposalModalOpen}
        onClose={() => {
          setIsInterviewProposalModalOpen(false);
          setSelectedRescheduleProposalId(null);
        }}
        onSubmit={async (input) => {
          await proposeInterview(input);
          setInterviewSuccessMessage(
            input.proposalId
              ? 'Alternative interview window proposed successfully.'
              : 'Interview proposal sent to client.',
          );
          setTimeout(() => setInterviewSuccessMessage(null), 4000);
        }}
        isLoading={isInterviewLoading}
        error={interviewError}
        rescheduleProposalId={selectedRescheduleProposalId}
        candidateCode={candidate.candidateCode}
      />

      <InterviewDeclineModal
        open={isInterviewDeclineModalOpen}
        onClose={() => {
          setIsInterviewDeclineModalOpen(false);
          setSelectedDeclineProposalId(null);
        }}
        onSubmit={async (reason) => {
          if (selectedDeclineProposalId) {
            await rejectInterview(selectedDeclineProposalId, reason);
            setInterviewSuccessMessage('Interview proposal declined.');
            setTimeout(() => setInterviewSuccessMessage(null), 4000);
          }
        }}
        isLoading={isInterviewLoading}
        error={interviewError}
        candidateCode={candidate.candidateCode}
      />
    </div>
  );
}
