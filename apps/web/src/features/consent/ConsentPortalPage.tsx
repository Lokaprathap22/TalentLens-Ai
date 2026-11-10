import { AlertCircle, AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Field, Input, Textarea } from '../../components/ui/form-controls.js';
import { LoadingRegion, Skeleton } from '../../components/ui/states.js';
import { isApiError } from '../../lib/api-client.js';
import * as consentApi from './consent.api.js';
import type { ConsentAcceptResult, ConsentDeclineResult, ConsentNoticeDto } from './types.js';

export function extractTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(clean);
  const token = params.get('token');
  return token?.trim() || null;
}

export function sanitizeUrlToken(): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  } catch {
    // Gracefully ignore history manipulation failure in test/sandboxed envs
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

export function ConsentPortalPage(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const extracted = extractTokenFromHash(window.location.hash);
      if (extracted) {
        sanitizeUrlToken();
      }
      return extracted;
    }
    return null;
  });

  const [status, setStatus] = useState<
    'idle' | 'inspecting' | 'ready' | 'accepting' | 'accepted' | 'declining' | 'declined' | 'error'
  >(token ? 'inspecting' : 'error');

  const [errorType, setErrorType] = useState<
    'missing_token' | 'expired_or_invalid' | 'server_error' | null
  >(token ? null : 'missing_token');
  const [actionError, setActionError] = useState<string | null>(null);

  const [notice, setNotice] = useState<ConsentNoticeDto | null>(null);
  const [acceptedResult, setAcceptedResult] = useState<ConsentAcceptResult | null>(null);
  const [, setDeclinedResult] = useState<ConsentDeclineResult | null>(null);

  const [confirmationName, setConfirmationName] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [showDeclineConfirm, setShowDeclineConfirm] = useState(false);

  // Sync token from URL hash if changed
  useEffect(() => {
    const handleHashChange = () => {
      const newToken = extractTokenFromHash(window.location.hash);
      if (!newToken) {
        return;
      }
      sanitizeUrlToken();
      setToken((prevToken) => {
        if (prevToken === newToken) {
          return prevToken;
        }
        setStatus('inspecting');
        setErrorType(null);
        setActionError(null);
        return newToken;
      });
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Inspect notice whenever token is available
  useEffect(() => {
    if (!token) {
      return;
    }
    consentApi
      .inspectConsentNotice(token)
      .then((data) => {
        setNotice(data);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        setStatus('error');
        if (
          isApiError(err) &&
          (err.status === 400 ||
            err.status === 404 ||
            err.status === 410 ||
            err.code === 'INVITATION_INVALID_OR_EXPIRED' ||
            err.code === 'token_invalid')
        ) {
          setErrorType('expired_or_invalid');
        } else {
          setErrorType('server_error');
        }
      });
  }, [token]);

  const handleAccept = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!token || !confirmationName.trim()) return;

      setStatus('accepting');
      setActionError(null);

      try {
        const result = await consentApi.acceptConsent(token, confirmationName.trim());
        setAcceptedResult(result);
        setStatus('accepted');
      } catch (err: unknown) {
        setStatus('ready');
        if (isApiError(err)) {
          if (
            err.status === 400 ||
            err.status === 404 ||
            err.status === 410 ||
            err.code === 'INVITATION_INVALID_OR_EXPIRED'
          ) {
            setStatus('error');
            setErrorType('expired_or_invalid');
            return;
          }
          setActionError(err.message || 'Failed to record consent. Please try again.');
        } else {
          setActionError('An unexpected error occurred. Please try again.');
        }
      }
    },
    [token, confirmationName],
  );

  const handleDecline = useCallback(async () => {
    if (!token) return;

    setStatus('declining');
    setActionError(null);

    try {
      const result = await consentApi.declineConsent(token, declineReason.trim() || undefined);
      setDeclinedResult(result);
      setStatus('declined');
    } catch (err: unknown) {
      setStatus('ready');
      if (isApiError(err)) {
        if (
          err.status === 400 ||
          err.status === 404 ||
          err.status === 410 ||
          err.code === 'INVITATION_INVALID_OR_EXPIRED'
        ) {
          setStatus('error');
          setErrorType('expired_or_invalid');
          return;
        }
        setActionError(err.message || 'Failed to decline consent. Please try again.');
      } else {
        setActionError('An unexpected error occurred. Please try again.');
      }
    }
  }, [token, declineReason]);

  return (
    <div className="min-h-screen bg-canvas p-4 sm:p-6 lg:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-2xl space-y-6">
        {/* TalentLens AI Branding */}
        <div className="flex items-center justify-between pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-on-accent font-bold text-sm">
              TL
            </div>
            <div>
              <h1 className="text-base font-semibold text-fg tracking-tight">TalentLens AI</h1>
              <p className="text-[11px] text-fg-subtle">Candidate Verification & Consent Portal</p>
            </div>
          </div>
          <Badge tone="accent" dot>
            Secure Portal
          </Badge>
        </div>

        {/* Loading state */}
        {status === 'inspecting' ? (
          <Card className="p-8">
            <LoadingRegion label="Loading consent policy and position details...">
              <div className="space-y-4">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-72" />
                <Skeleton className="h-32 w-full" />
              </div>
            </LoadingRegion>
          </Card>
        ) : null}

        {/* Error States */}
        {status === 'error' ? (
          <Card className="p-8 text-center space-y-4">
            <div className="flex justify-center">
              <AlertCircle className="h-12 w-12 text-danger" />
            </div>
            {errorType === 'missing_token' ? (
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-fg">Missing Invitation Token</h2>
                <p className="text-sm text-fg-subtle max-w-md mx-auto">
                  This consent portal requires a valid, secure invitation link provided by your
                  recruiter. Please check your invitation message and use the full link provided.
                </p>
              </div>
            ) : errorType === 'expired_or_invalid' ? (
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-fg">Invitation Expired or Invalid</h2>
                <p className="text-sm text-fg-subtle max-w-md mx-auto">
                  This consent invitation link is invalid, has expired (invitations are valid for 7
                  days), or has already been consumed. Please contact your hiring team to issue a
                  fresh consent invitation.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-fg">Unable to Load Consent Notice</h2>
                <p className="text-sm text-fg-subtle max-w-md mx-auto">
                  A network or server error occurred while retrieving your consent notice. Please
                  refresh the page or try again in a few moments.
                </p>
              </div>
            )}
          </Card>
        ) : null}

        {/* Success / Accepted State */}
        {status === 'accepted' ? (
          <Card className="p-8 text-center space-y-5">
            <div className="flex justify-center">
              <CheckCircle2 className="h-14 w-14 text-success" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-fg">Consent Recorded Successfully</h2>
              <p className="text-sm text-fg-subtle max-w-md mx-auto">
                Thank you, <strong className="text-fg">{confirmationName}</strong>. Your consent for
                automated AI-assisted screening has been captured and verified.
              </p>
            </div>

            <div className="rounded-md border border-border bg-bg-subtle p-4 text-xs text-left space-y-2">
              <div className="flex justify-between">
                <span className="text-fg-subtle">Position:</span>
                <span className="font-semibold text-fg">{notice?.requisitionTitle}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-subtle">Organization:</span>
                <span className="font-semibold text-fg">{notice?.organizationName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-subtle">Policy Version:</span>
                <span className="font-mono text-fg">
                  {acceptedResult?.policyVersion ?? notice?.policyVersion}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-subtle">Captured At:</span>
                <span className="text-fg">{formatDate(acceptedResult?.capturedAt)}</span>
              </div>
            </div>

            <div className="rounded border border-border p-3 text-xs text-fg-subtle text-left space-y-1">
              <p className="font-semibold text-fg">Your Rights Regarding Consent</p>
              <p>
                You may withdraw your consent at any time without recruiter approval by visiting our{' '}
                <a
                  href="/consent/withdraw"
                  className="text-accent underline hover:text-accent-hover font-medium"
                >
                  Consent Withdrawal Portal
                </a>
                .
              </p>
            </div>
          </Card>
        ) : null}

        {/* Declined State */}
        {status === 'declined' ? (
          <Card className="p-8 text-center space-y-4">
            <div className="flex justify-center">
              <XCircle className="h-12 w-12 text-fg-subtle" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-bold text-fg">Consent Declined</h2>
              <p className="text-sm text-fg-subtle max-w-md mx-auto">
                You have declined consent for AI screening for{' '}
                <strong className="text-fg">{notice?.requisitionTitle}</strong> at{' '}
                <strong className="text-fg">{notice?.organizationName}</strong>.
              </p>
              <p className="text-xs text-fg-subtle max-w-md mx-auto">
                Your decision has been logged. Automated processing and evaluation for this position
                will not proceed.
              </p>
            </div>
          </Card>
        ) : null}

        {/* Ready State: Notice & Decision Form */}
        {(status === 'ready' || status === 'accepting' || status === 'declining') && notice ? (
          <Card className="p-6 sm:p-8 space-y-6">
            {/* Header info */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone="accent">Hiring Use Consent</Badge>
                <Badge tone="neutral">Policy v{notice.policyVersion}</Badge>
                {notice.candidateCode ? (
                  <Badge tone="neutral">Candidate: {notice.candidateCode}</Badge>
                ) : null}
              </div>
              <h2 className="text-xl font-bold text-fg tracking-tight">
                Consent for AI-Assisted Resume Screening
              </h2>
              <p className="text-sm text-fg-subtle">
                Position: <strong className="text-fg">{notice.requisitionTitle}</strong>
                {notice.clientName ? ` (${notice.clientName})` : ''} at{' '}
                <strong className="text-fg">{notice.organizationName}</strong>.
              </p>
              <p className="text-xs text-fg-subtle flex items-center gap-1.5 pt-1">
                <ShieldCheck className="h-4 w-4 text-accent" />
                This invitation is valid until {formatDate(notice.expiresAt)}.
              </p>
            </div>

            {/* Unapproved Policy Warning */}
            {!notice.isPolicyApproved ? (
              <div className="rounded-md border border-warning bg-warning/10 p-3 text-xs text-warning flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong className="font-semibold">Notice:</strong> The legal policy version
                  referenced in this invitation is currently pending review by the organization's
                  compliance officer.
                </div>
              </div>
            ) : null}

            {/* Notice Text Display */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Screening Disclosure & Legal Notice
              </label>
              <div
                tabIndex={0}
                aria-label="Consent policy text"
                className="max-h-64 overflow-y-auto rounded-md border border-border bg-bg-subtle p-4 text-xs text-fg leading-relaxed whitespace-pre-wrap focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {notice.noticeText}
              </div>
            </div>

            {/* Action error */}
            {actionError ? (
              <div className="rounded-md border border-danger bg-danger/10 p-3 text-xs text-danger flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{actionError}</span>
              </div>
            ) : null}

            {/* Form */}
            {!showDeclineConfirm ? (
              <form onSubmit={handleAccept} className="space-y-4 pt-2 border-t border-border">
                <Field
                  label="Full Legal Name"
                  hint="Type your full legal name to electronically authorize screening under this policy."
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={confirmationName}
                      onChange={(e) => setConfirmationName(e.target.value)}
                      placeholder="e.g. Alex Morgan"
                      required
                      disabled={status === 'accepting'}
                    />
                  )}
                </Field>

                <p className="text-[11px] text-fg-subtle leading-normal">
                  By providing your legal name and clicking "Accept & Authorize Screening", you
                  confirm that you have read and understood the screening disclosure above and
                  consent to automated processing of your resume for this position.
                </p>

                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!confirmationName.trim() || status === 'accepting'}
                    className="w-full sm:w-auto"
                  >
                    {status === 'accepting' ? 'Authorizing...' : 'Accept & Authorize Screening'}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowDeclineConfirm(true)}
                    disabled={status === 'accepting'}
                    className="text-xs text-fg-subtle hover:text-danger"
                  >
                    Decline Screening
                  </Button>
                </div>
              </form>
            ) : (
              /* Decline confirmation section */
              <div className="rounded-md border border-danger/40 bg-danger/5 p-4 space-y-4 pt-2">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-danger">
                    Decline Consent for Screening
                  </h4>
                  <p className="text-xs text-fg-subtle">
                    If you decline, your application cannot be evaluated by automated screening.
                    This decision is recorded and cannot be undone via this link.
                  </p>
                </div>

                <Field
                  label="Reason for Declining (Optional)"
                  hint="You may optionally provide a reason for the recruiter."
                >
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      placeholder="e.g. Accepted another offer, role no longer relevant..."
                      rows={2}
                      disabled={status === 'declining'}
                    />
                  )}
                </Field>

                <div className="flex items-center gap-3 justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowDeclineConfirm(false)}
                    disabled={status === 'declining'}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={handleDecline}
                    disabled={status === 'declining'}
                  >
                    {status === 'declining' ? 'Declining...' : 'Confirm Decline'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
