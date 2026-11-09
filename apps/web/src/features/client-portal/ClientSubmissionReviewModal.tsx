import {
  AlertCircle,
  AlertTriangle,
  Award,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Quote,
  ShieldAlert,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Skeleton } from '../../components/ui/states.js';
import type {
  ClientDecisionType,
  ClientFeedbackHistoryDecision,
  ClientFeedbackInput,
  ClientInterviewProposalInput,
  ClientSubmissionDetail,
  ClientSubmissionStatus,
} from './types.js';

export interface ClientSubmissionReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  detail: ClientSubmissionDetail | null;
  isLoading: boolean;
  error: string | null;
  onSubmitFeedback: (input: ClientFeedbackInput) => Promise<void>;
  isSubmittingFeedback: boolean;
  feedbackError: string | null;
  onProposeInterview?: (input: ClientInterviewProposalInput) => Promise<void>;
  onAcceptInterview?: (proposalId: string) => Promise<void>;
  onRejectInterview?: (proposalId: string, reason: string) => Promise<void>;
  isInterviewLoading?: boolean;
  interviewError?: string | null;
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

function getStatusBadge(status: ClientSubmissionStatus): React.JSX.Element {
  switch (status) {
    case 'SUBMITTED':
      return (
        <Badge tone="info" dot>
          Pending Review
        </Badge>
      );
    case 'CLIENT_SHORTLISTED':
      return (
        <Badge tone="success" dot>
          Shortlisted
        </Badge>
      );
    case 'CLIENT_REJECTED':
      return (
        <Badge tone="neutral" dot>
          Declined
        </Badge>
      );
    case 'INTERVIEW_PROPOSED':
      return (
        <Badge tone="accent" dot>
          Interview Proposed
        </Badge>
      );
    case 'WITHDRAWN':
      return (
        <Badge tone="danger" dot>
          Withdrawn
        </Badge>
      );
  }
}

function getFeedbackDecisionBadge(decision: ClientFeedbackHistoryDecision): React.JSX.Element {
  switch (decision) {
    case 'SHORTLIST':
      return (
        <Badge tone="success" dot>
          Shortlisted
        </Badge>
      );
    case 'PROPOSE_INTERVIEW':
      return (
        <Badge tone="accent" dot>
          Interview Proposed
        </Badge>
      );
    case 'REJECT':
      return (
        <Badge tone="neutral" dot>
          Declined
        </Badge>
      );
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

export function ClientSubmissionReviewModal(
  props: ClientSubmissionReviewModalProps,
): React.JSX.Element | null {
  if (!props.isOpen) return null;
  return (
    <ClientSubmissionReviewModalContent
      key={props.detail?.submissionId ?? '__loading__'}
      {...props}
    />
  );
}

function ClientSubmissionReviewModalContent({
  onClose,
  detail,
  isLoading,
  error,
  onSubmitFeedback,
  isSubmittingFeedback,
  feedbackError,
  onProposeInterview,
  onAcceptInterview,
  onRejectInterview,
  isInterviewLoading = false,
  interviewError = null,
}: ClientSubmissionReviewModalProps): React.JSX.Element {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const getDefaultDateTime = (): string => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  const [decision, setDecision] = useState<ClientDecisionType | null>(null);
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Interview state
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [interviewDatetime, setInterviewDatetime] = useState<string>(getDefaultDateTime);
  const [interviewDuration, setInterviewDuration] = useState<number>(45);
  const [interviewTimezone, setInterviewTimezone] = useState<string>(localTz);
  const [interviewFormat, setInterviewFormat] = useState<'VIDEO' | 'PHONE' | 'IN_PERSON'>('VIDEO');
  const [interviewNotes, setInterviewNotes] = useState<string>('');
  const [interviewValidationError, setInterviewValidationError] = useState<string | null>(null);
  const [interviewSuccessMsg, setInterviewSuccessMsg] = useState<string | null>(null);

  // Rejection prompt state
  const [rejectingProposalId, setRejectingProposalId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [rejectionValidationError, setRejectionValidationError] = useState<string | null>(null);

  const canRecordHiringDecision =
    detail?.status === 'SUBMITTED' || detail?.status === 'INTERVIEW_PROPOSED';
  const hasCompletedInterview = Boolean(
    detail?.interviews?.some((iv) => iv.status === 'COMPLETED'),
  );
  const canModifyInterviews =
    detail !== null && detail.status !== 'WITHDRAWN' && detail.status !== 'CLIENT_REJECTED';

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (isSubmittingFeedback || !canRecordHiringDecision) {
      return;
    }
    setValidationError(null);

    if (!decision) {
      setValidationError('Please select either Shortlist or Decline to record your feedback.');
      return;
    }

    if (decision === 'REJECT') {
      const trimmedReason = reason.trim();
      if (!trimmedReason || trimmedReason.length < 3) {
        setValidationError(
          'A specific decline reason of at least 3 characters is required to maintain auditable feedback.',
        );
        return;
      }
    }

    try {
      await onSubmitFeedback({
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setDecision(null);
      setReason('');
      setSuccessMessage(
        'Your feedback has been successfully recorded and shared with the recruiter.',
      );
      setTimeout(() => {
        setSuccessMessage(null);
      }, 5000);
    } catch {
      // Error handled via feedbackError prop
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-review-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs overflow-y-auto"
    >
      <div className="relative w-full max-w-3xl rounded-xl border border-border bg-surface shadow-2xl my-8 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-surface">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="client-review-title" className="text-base font-semibold text-fg">
                Candidate Submission Review
              </h2>
              {detail ? getStatusBadge(detail.status) : null}
            </div>
            {detail ? (
              <p className="mt-0.5 text-xs text-fg-subtle">
                {detail.requisitionTitle} · Candidate Ref:{' '}
                <span className="font-mono font-medium text-fg">{detail.candidateRef}</span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-fg-subtle hover:bg-surface-muted hover:text-fg transition-colors"
            aria-label="Close review dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-xs text-danger flex items-start gap-3"
            >
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Unable to load candidate details</p>
                <p className="mt-1 text-fg-subtle">{error}</p>
              </div>
            </div>
          ) : detail ? (
            <>
              {/* Privacy notice banner */}
              <div className="rounded-lg border border-info-border bg-info-soft/60 px-4 py-3 text-xs text-fg-subtle flex items-start gap-2.5">
                <ShieldCheck className="h-4 w-4 text-info shrink-0 mt-0.5" />
                <div>
                  <strong className="text-fg">Privacy-Preserving Candidate Profile:</strong> In
                  compliance with TalentLens data minimization standards, direct candidate contact
                  details and recruiter-internal notes are masked. You are evaluating candidate
                  qualifications against approved scorecard criteria.
                </div>
              </div>

              {/* Advisory Scorecard Assessment Card */}
              <Card className="p-5 border-border bg-surface space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2">
                    <Award className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-fg">Advisory Scorecard Assessment</h3>
                  </div>
                  {detail.assessment?.score !== null && detail.assessment?.score !== undefined ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-fg-subtle">Match Score:</span>
                      <span className="font-semibold text-fg text-sm">
                        {Math.round(detail.assessment.score)}%
                      </span>
                      <span className="text-2xs text-fg-subtle">
                        ({detail.assessment.criteria.length} criteria)
                      </span>
                    </div>
                  ) : null}
                </div>

                <p className="text-xs text-fg-subtle leading-relaxed">
                  Screening scores and criteria evidence are deterministic aids extracted from the
                  candidate&apos;s resume to inform your review. Final hiring decisions are made
                  exclusively by you.
                </p>

                {/* Criteria breakdown */}
                {detail.assessment && detail.assessment.criteria.length > 0 ? (
                  <div className="space-y-3 pt-2">
                    {detail.assessment.criteria.map((criterion, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border border-border bg-surface p-3.5 space-y-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-fg">{criterion.label}</span>
                            <Badge tone="neutral">{criterion.requirementType}</Badge>
                            <Badge tone="accent">{criterion.category}</Badge>
                          </div>
                          <Badge tone={criterion.status === 'MET' ? 'success' : 'neutral'} dot>
                            {criterion.status}
                          </Badge>
                        </div>

                        {criterion.reasoning ? (
                          <p className="text-fg-subtle leading-relaxed">{criterion.reasoning}</p>
                        ) : null}

                        {criterion.verifiedQuotes && criterion.verifiedQuotes.length > 0 ? (
                          <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
                            <span className="text-[11px] font-medium text-fg-subtle uppercase tracking-wider block">
                              Verified Evidence from Resume:
                            </span>
                            {criterion.verifiedQuotes.map((quote, qIdx) => (
                              <div
                                key={qIdx}
                                className="flex items-start gap-2 rounded bg-surface-muted p-2 text-fg italic text-[11px]"
                              >
                                <Quote className="h-3.5 w-3.5 text-accent shrink-0 mt-0.5" />
                                <span>&ldquo;{quote}&rdquo;</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-fg-subtle italic">
                    No criteria breakdown available for this submission.
                  </p>
                )}
              </Card>

              {/* Feedback History (if previously recorded) */}
              {detail.feedbackHistory && detail.feedbackHistory.length > 0 ? (
                <Card className="p-5 border-border bg-surface space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-fg-subtle" />
                    <h3 className="text-sm font-semibold text-fg">Recorded Feedback History</h3>
                  </div>

                  <div className="space-y-2">
                    {detail.feedbackHistory.map((fb) => (
                      <div
                        key={fb.id}
                        className="rounded-lg border border-border bg-surface p-3 text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          {getFeedbackDecisionBadge(fb.decision)}
                          <span className="text-fg-subtle">{formatDate(fb.createdAt)}</span>
                        </div>
                        {fb.reason ? (
                          <p className="text-fg italic text-[11px]">&ldquo;{fb.reason}&rdquo;</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}

              {/* Candidate Withdrawn Warning */}
              {detail.status === 'WITHDRAWN' ? (
                <div
                  role="alert"
                  className="rounded-lg border border-warning-border bg-warning-soft/60 p-4 text-xs text-fg flex items-start gap-3"
                >
                  <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                  <div>
                    <strong className="font-semibold text-fg">Candidate Consent Withdrawn:</strong>
                    <p className="mt-1 text-fg-subtle">
                      The candidate has withdrawn consent for recruitment processing. In accordance
                      with privacy regulations, this profile is inactive and no further evaluation
                      can be submitted.
                    </p>
                  </div>
                </div>
              ) : null}

              {/* Persistent feedback success confirmation banner (kept visible after transition to terminal status) */}
              {successMessage ? (
                <div
                  role="status"
                  className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{successMessage}</span>
                </div>
              ) : null}

              {/* Feedback Form (enabled for active pending review and post-interview states) */}
              {canRecordHiringDecision ? (
                <Card className="p-5 border-border bg-surface space-y-4">
                  <div className="flex items-center justify-between border-b border-border/60 pb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-fg">Record Hiring Decision</h3>
                      <p className="text-xs text-fg-subtle mt-0.5">
                        {detail.status === 'INTERVIEW_PROPOSED' && hasCompletedInterview
                          ? 'Interview has completed. Record your final decision to shortlist or decline this candidate.'
                          : 'Indicate whether you wish to shortlist this candidate or decline the submission.'}
                      </p>
                    </div>
                  </div>

                  <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                    {/* Decision selection buttons */}
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        disabled={isSubmittingFeedback}
                        onClick={() => {
                          setDecision('SHORTLIST');
                          setValidationError(null);
                        }}
                        className={`flex items-center justify-center gap-2 rounded-lg border p-3 text-xs font-semibold transition-all disabled:opacity-50 ${
                          decision === 'SHORTLIST'
                            ? 'border-success bg-success/15 text-success ring-1 ring-success'
                            : 'border-border bg-surface text-fg hover:border-success/50 hover:bg-surface-muted'
                        }`}
                      >
                        <ThumbsUp className="h-4 w-4" />
                        Shortlist Candidate
                      </button>

                      <button
                        type="button"
                        disabled={isSubmittingFeedback}
                        onClick={() => {
                          setDecision('REJECT');
                          setValidationError(null);
                        }}
                        className={`flex items-center justify-center gap-2 rounded-lg border p-3 text-xs font-semibold transition-all disabled:opacity-50 ${
                          decision === 'REJECT'
                            ? 'border-danger bg-danger/15 text-danger ring-1 ring-danger'
                            : 'border-border bg-surface text-fg hover:border-danger/50 hover:bg-surface-muted'
                        }`}
                      >
                        <ThumbsDown className="h-4 w-4" />
                        Decline Candidate
                      </button>
                    </div>

                    {/* Reason field */}
                    <div className="space-y-1.5">
                      <label htmlFor="client-reason" className="text-xs font-medium text-fg block">
                        {decision === 'REJECT' ? (
                          <>
                            Decline Reason <span className="text-danger">*</span> (required, min 3
                            chars)
                          </>
                        ) : (
                          'Decision Notes (optional)'
                        )}
                      </label>
                      <textarea
                        id="client-reason"
                        disabled={isSubmittingFeedback}
                        value={reason}
                        onChange={(e) => {
                          setReason(e.target.value);
                          if (validationError) setValidationError(null);
                        }}
                        rows={3}
                        maxLength={2000}
                        placeholder={
                          decision === 'REJECT'
                            ? 'Please provide specific job-related reasons for declining (e.g., requires more hands-on experience with Kubernetes)...'
                            : 'Add any specific feedback or notes for the recruiter...'
                        }
                        className="w-full rounded-md border border-border bg-surface p-2.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      />
                    </div>

                    {/* Bias prevention compliance reminder */}
                    <div className="rounded-lg border border-border bg-surface-muted p-3 text-[11px] text-fg-subtle flex items-start gap-2">
                      <ShieldAlert className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                      <span>
                        <strong className="text-fg">Compliance Reminder:</strong> Feedback must be
                        strictly job-relevant and based on verified qualifications. Do not reference
                        age, race, gender, religion, national origin, disability, or other protected
                        attributes. All feedback is audited.
                      </span>
                    </div>

                    {/* Validation error */}
                    {validationError ? (
                      <div
                        role="alert"
                        className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger flex items-center gap-2"
                      >
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{validationError}</span>
                      </div>
                    ) : null}

                    {/* Server error */}
                    {feedbackError ? (
                      <div
                        role="alert"
                        className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger flex items-start gap-2"
                      >
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold">Feedback Submission Error</p>
                          <p className="mt-0.5">{feedbackError}</p>
                        </div>
                      </div>
                    ) : null}

                    {/* Submit button */}
                    <div className="flex items-center justify-end gap-3 pt-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        onClick={onClose}
                        disabled={isSubmittingFeedback}
                      >
                        Cancel
                      </Button>

                      <Button
                        type="submit"
                        variant="primary"
                        size="md"
                        disabled={isSubmittingFeedback || !decision}
                      >
                        <Check className="h-4 w-4 mr-1.5" />
                        {isSubmittingFeedback
                          ? 'Recording Feedback...'
                          : decision === 'SHORTLIST'
                            ? 'Confirm Shortlist'
                            : decision === 'REJECT'
                              ? 'Confirm Decline'
                              : 'Submit Decision'}
                      </Button>
                    </div>
                  </form>
                </Card>
              ) : detail.status === 'CLIENT_SHORTLISTED' || detail.status === 'CLIENT_REJECTED' ? (
                <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-xs text-fg-subtle flex items-center justify-between gap-2">
                  <div>
                    <strong className="text-fg">Final Hiring Decision Recorded:</strong>{' '}
                    {detail.status === 'CLIENT_SHORTLISTED'
                      ? 'This candidate has been shortlisted.'
                      : 'This candidate submission has been declined.'}
                  </div>
                  {getStatusBadge(detail.status)}
                </div>
              ) : null}

              {/* Interview Coordination & Proposals */}
              {detail.status !== 'WITHDRAWN' ? (
                <Card className="p-5 border-border bg-surface space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/60 pb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-accent" />
                        Interview Schedule & Proposals
                      </h3>
                      <p className="text-xs text-fg-subtle mt-0.5">
                        Review recruiter proposals or suggest interview time windows directly.
                      </p>
                    </div>
                    {canModifyInterviews && onProposeInterview && !showProposalForm ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setInterviewDatetime(getDefaultDateTime());
                          setShowProposalForm(true);
                          setInterviewValidationError(null);
                        }}
                        disabled={isInterviewLoading}
                        className="text-xs"
                      >
                        <Clock className="h-3.5 w-3.5 mr-1" />
                        Propose Interview Slot
                      </Button>
                    ) : null}
                  </div>

                  {interviewSuccessMsg ? (
                    <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>{interviewSuccessMsg}</span>
                    </div>
                  ) : null}

                  {interviewError ? (
                    <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>{interviewError}</span>
                    </div>
                  ) : null}

                  {/* Proposal Form */}
                  {showProposalForm ? (
                    <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-accent">
                          Propose New Interview Window
                        </h4>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs px-2"
                          onClick={() => setShowProposalForm(false)}
                        >
                          Cancel
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-fg block">
                            Date & Start Time
                          </label>
                          <input
                            type="datetime-local"
                            value={interviewDatetime}
                            onChange={(e) => setInterviewDatetime(e.target.value)}
                            required
                            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-fg block">Duration</label>
                            <select
                              value={interviewDuration}
                              onChange={(e) => setInterviewDuration(Number(e.target.value))}
                              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                            >
                              <option value={30}>30 mins</option>
                              <option value={45}>45 mins</option>
                              <option value={60}>60 mins</option>
                              <option value={90}>90 mins</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-fg block">Timezone</label>
                            <select
                              value={interviewTimezone}
                              onChange={(e) => setInterviewTimezone(e.target.value)}
                              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                            >
                              <option value={localTz}>{localTz}</option>
                              <option value="UTC">UTC</option>
                              <option value="America/New_York">America/New_York</option>
                              <option value="America/Chicago">America/Chicago</option>
                              <option value="America/Denver">America/Denver</option>
                              <option value="America/Los_Angeles">America/Los_Angeles</option>
                              <option value="Europe/London">Europe/London</option>
                              <option value="Europe/Paris">Europe/Paris</option>
                              <option value="Asia/Kolkata">Asia/Kolkata</option>
                              <option value="Asia/Tokyo">Asia/Tokyo</option>
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* Format */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-fg block">Format</label>
                        <div className="flex gap-2">
                          {(['VIDEO', 'PHONE', 'IN_PERSON'] as const).map((fmt) => (
                            <button
                              key={fmt}
                              type="button"
                              onClick={() => setInterviewFormat(fmt)}
                              className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                                interviewFormat === fmt
                                  ? 'border-accent bg-accent/20 text-accent font-semibold'
                                  : 'border-border bg-surface text-fg-subtle hover:text-fg'
                              }`}
                            >
                              {fmt === 'VIDEO' ? 'Video' : fmt === 'PHONE' ? 'Phone' : 'In-person'}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-medium text-fg block">
                          Notes for Recruiter (optional)
                        </label>
                        <input
                          type="text"
                          value={interviewNotes}
                          onChange={(e) => setInterviewNotes(e.target.value)}
                          maxLength={500}
                          placeholder="e.g. Hiring manager and tech lead will attend..."
                          className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                        />
                      </div>

                      {interviewValidationError ? (
                        <p className="text-xs text-danger font-medium">
                          {interviewValidationError}
                        </p>
                      ) : null}

                      <div className="flex justify-end gap-2 pt-1">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setShowProposalForm(false)}
                          disabled={isInterviewLoading}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={isInterviewLoading}
                          onClick={async () => {
                            if (!interviewDatetime) {
                              setInterviewValidationError('Please specify a date and start time.');
                              return;
                            }
                            const start = new Date(interviewDatetime);
                            if (isNaN(start.getTime())) {
                              setInterviewValidationError('Invalid date/time.');
                              return;
                            }
                            const end = new Date(start.getTime() + interviewDuration * 60 * 1000);
                            try {
                              if (onProposeInterview) {
                                await onProposeInterview({
                                  startAt: start.toISOString(),
                                  endAt: end.toISOString(),
                                  timezone: interviewTimezone,
                                  format: interviewFormat,
                                  reason: interviewNotes.trim() || undefined,
                                });
                                setShowProposalForm(false);
                                setInterviewSuccessMsg(
                                  'Interview proposal submitted to recruiter.',
                                );
                                setTimeout(() => setInterviewSuccessMsg(null), 4000);
                              }
                            } catch {
                              // error handled via prop
                            }
                          }}
                        >
                          {isInterviewLoading ? 'Submitting...' : 'Submit Proposal'}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* Decline with reason form */}
                  {rejectingProposalId ? (
                    <div className="rounded-lg border border-danger/30 bg-danger/5 p-3.5 space-y-2.5">
                      <h4 className="text-xs font-semibold text-danger">
                        Decline Interview Proposal
                      </h4>
                      <p className="text-[11px] text-fg-subtle">
                        Please provide a mandatory reason (minimum 3 characters) for declining this
                        proposal.
                      </p>
                      <textarea
                        value={rejectionReason}
                        onChange={(e) => {
                          setRejectionReason(e.target.value);
                          if (rejectionValidationError) setRejectionValidationError(null);
                        }}
                        rows={2}
                        maxLength={500}
                        placeholder="e.g. Schedule conflict with client team, requesting an afternoon slot instead..."
                        className="w-full rounded-md border border-border bg-surface p-2 text-xs text-fg focus:border-danger focus:outline-none"
                      />
                      {rejectionValidationError ? (
                        <p className="text-xs text-danger">{rejectionValidationError}</p>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setRejectingProposalId(null);
                            setRejectionReason('');
                            setRejectionValidationError(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={isInterviewLoading}
                          onClick={async () => {
                            const trimmed = rejectionReason.trim();
                            if (!trimmed || trimmed.length < 3) {
                              setRejectionValidationError(
                                'Please provide a reason of at least 3 characters.',
                              );
                              return;
                            }
                            if (onRejectInterview) {
                              await onRejectInterview(rejectingProposalId, trimmed);
                              setRejectingProposalId(null);
                              setRejectionReason('');
                              setInterviewSuccessMsg('Interview proposal declined.');
                              setTimeout(() => setInterviewSuccessMsg(null), 4000);
                            }
                          }}
                        >
                          {isInterviewLoading ? 'Declining...' : 'Confirm Decline'}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* List of interviews */}
                  {detail.interviews && detail.interviews.length > 0 ? (
                    <div className="space-y-2">
                      {detail.interviews.map((iv) => (
                        <div
                          key={iv.id}
                          className="rounded-lg border border-border/80 bg-surface-muted p-3 space-y-2 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <Badge tone={getInterviewStatusTone(iv.status)} dot>
                              {iv.status}
                            </Badge>
                            <Badge tone="neutral" className="text-[10px]">
                              {iv.format}
                            </Badge>
                          </div>

                          <div className="text-xs text-fg font-medium">
                            {formatInterviewWindow(iv.startAt, iv.endAt, iv.timezone)}
                          </div>

                          {iv.reason ? (
                            <div className="text-[11px] text-fg-subtle italic bg-surface/50 p-2 rounded">
                              &ldquo;{iv.reason}&rdquo;
                            </div>
                          ) : null}

                          {canModifyInterviews && iv.status === 'PROPOSED' ? (
                            <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                              {onAcceptInterview ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="primary"
                                  className="h-6 text-xs px-2.5"
                                  disabled={isInterviewLoading}
                                  onClick={async () => {
                                    await onAcceptInterview(iv.id);
                                    setInterviewSuccessMsg('Interview proposal accepted.');
                                    setTimeout(() => setInterviewSuccessMsg(null), 4000);
                                  }}
                                >
                                  <Check className="h-3 w-3 mr-1" />
                                  Accept Window
                                </Button>
                              ) : null}

                              {onRejectInterview ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="danger"
                                  className="h-6 text-xs px-2.5"
                                  disabled={isInterviewLoading}
                                  onClick={() => {
                                    setRejectingProposalId(iv.id);
                                    setRejectionReason('');
                                    setRejectionValidationError(null);
                                  }}
                                >
                                  Decline
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/80 bg-surface/30 p-4 text-center text-xs text-fg-subtle">
                      No interviews scheduled or proposed yet.
                    </div>
                  )}
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
