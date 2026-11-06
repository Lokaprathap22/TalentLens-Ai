import { AlertCircle, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Field, Input } from '../../components/ui/form-controls.js';
import { isApiError } from '../../lib/api-client.js';
import { confirmConsentWithdrawal, requestConsentWithdrawal } from './consent.api.js';
import type { ConsentWithdrawalConfirmResult } from './types.js';

export function extractTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(clean);
  const token = params.get('token');
  return token?.trim() || null;
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

export function ConsentWithdrawalPage(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return extractTokenFromHash(window.location.hash);
    }
    return null;
  });

  // Request flow state
  const [email, setEmail] = useState('');
  const [candidateCode, setCandidateCode] = useState('');
  const [requestStatus, setRequestStatus] = useState<'idle' | 'submitting' | 'submitted' | 'error'>(
    'idle',
  );
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  // Confirm flow state (when token is present)
  const [confirmStatus, setConfirmStatus] = useState<'idle' | 'confirming' | 'confirmed' | 'error'>(
    'idle',
  );
  const [confirmResult, setConfirmResult] = useState<ConsentWithdrawalConfirmResult | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => {
      const newToken = extractTokenFromHash(window.location.hash);
      setToken(newToken);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleRequest = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!email.trim()) return;

      setRequestStatus('submitting');
      setRequestError(null);

      try {
        const result = await requestConsentWithdrawal(
          email.trim(),
          candidateCode.trim() || undefined,
        );
        setRequestMessage(result.message);
        setRequestStatus('submitted');
      } catch (err: unknown) {
        setRequestStatus('error');
        if (isApiError(err)) {
          setRequestError(err.message || 'Failed to submit withdrawal request.');
        } else {
          setRequestError('An unexpected error occurred. Please try again.');
        }
      }
    },
    [email, candidateCode],
  );

  const handleConfirm = useCallback(async () => {
    if (!token) return;

    setConfirmStatus('confirming');
    setConfirmError(null);

    try {
      const result = await confirmConsentWithdrawal(token);
      setConfirmResult(result);
      setConfirmStatus('confirmed');
    } catch (err: unknown) {
      setConfirmStatus('error');
      if (isApiError(err)) {
        if (
          err.status === 400 ||
          err.status === 404 ||
          err.status === 410 ||
          err.code === 'INVITATION_INVALID_OR_EXPIRED'
        ) {
          setConfirmError(
            'This withdrawal verification link is invalid, has expired, or has already been used.',
          );
        } else {
          setConfirmError(err.message || 'Failed to confirm withdrawal. Please try again.');
        }
      } else {
        setConfirmError('An unexpected error occurred. Please try again.');
      }
    }
  }, [token]);

  return (
    <div className="min-h-screen bg-bg p-4 sm:p-6 lg:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg font-bold text-sm">
              TL
            </div>
            <div>
              <h1 className="text-base font-semibold text-fg tracking-tight">TalentLens AI</h1>
              <p className="text-[11px] text-fg-subtle">Consent Management & Withdrawal</p>
            </div>
          </div>
          <Badge tone="neutral">Candidate Rights</Badge>
        </div>

        {/* ================================================================= */}
        {/* FLOW 1: CONFIRM WITHDRAWAL (When token is in hash)               */}
        {/* ================================================================= */}
        {token ? (
          <div>
            {confirmStatus === 'confirmed' && confirmResult ? (
              <Card className="p-8 text-center space-y-5">
                <div className="flex justify-center">
                  <CheckCircle2 className="h-14 w-14 text-warning" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-bold text-fg">Consent Withdrawn Successfully</h2>
                  <p className="text-sm text-fg-subtle max-w-md mx-auto">
                    Your consent has been permanently withdrawn. All automated evaluation and AI
                    screening for this position have been halted immediately.
                  </p>
                </div>

                <div className="rounded-md border border-border bg-bg-subtle p-4 text-xs text-left space-y-2">
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Withdrawal Status:</span>
                    <Badge tone="warning" dot>
                      WITHDRAWN
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Effective At:</span>
                    <span className="text-fg">{formatDate(confirmResult.withdrawnAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Active Pipelines Placed on Hold:</span>
                    <span className="font-semibold text-fg">{confirmResult.heldJobCount}</span>
                  </div>
                </div>

                <p className="text-xs text-fg-subtle">
                  No further automated AI evaluation will occur on your submitted materials for this
                  position.
                </p>
              </Card>
            ) : confirmStatus === 'error' ? (
              <Card className="p-8 text-center space-y-4">
                <div className="flex justify-center">
                  <AlertCircle className="h-12 w-12 text-danger" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold text-fg">
                    Withdrawal Link Expired or Invalid
                  </h2>
                  <p className="text-sm text-fg-subtle max-w-md mx-auto">
                    {confirmError ||
                      'This withdrawal verification link is invalid, has expired, or has already been used.'}
                  </p>
                </div>
                <div className="pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setToken(null);
                      if (typeof window !== 'undefined') {
                        window.location.hash = '';
                      }
                    }}
                  >
                    Request a New Withdrawal Link
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-6 sm:p-8 space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-warning" />
                    <h2 className="text-lg font-bold text-fg">Confirm Consent Withdrawal</h2>
                  </div>
                  <p className="text-sm text-fg-subtle">
                    You have requested to withdraw your consent for automated resume evaluation.
                  </p>
                </div>

                <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-xs text-fg space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-warning">
                    <AlertTriangle className="h-4 w-4" />
                    Important Notice on Withdrawal Effects
                  </div>
                  <p className="text-fg-subtle leading-relaxed">
                    Under applicable data protection laws, withdrawing your consent halts all
                    automated screening, scorecard processing, and AI evaluations for this
                    requisition immediately. Active processing tasks will be placed on hold.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setToken(null);
                      if (typeof window !== 'undefined') {
                        window.location.hash = '';
                      }
                    }}
                    disabled={confirmStatus === 'confirming'}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={handleConfirm}
                    disabled={confirmStatus === 'confirming'}
                  >
                    {confirmStatus === 'confirming'
                      ? 'Withdrawing Consent...'
                      : 'Confirm Withdrawal of Consent'}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        ) : (
          /* ================================================================= */
          /* FLOW 2: REQUEST WITHDRAWAL LINK (When no token)                  */
          /* ================================================================= */
          <div>
            {requestStatus === 'submitted' ? (
              <Card className="p-8 text-center space-y-4">
                <div className="flex justify-center">
                  <CheckCircle2 className="h-12 w-12 text-success" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-bold text-fg">Verification Request Sent</h2>
                  <p className="text-sm text-fg-subtle max-w-md mx-auto">
                    {requestMessage ||
                      'If an active consent record is associated with this email, a verification link has been sent.'}
                  </p>
                  <p className="text-xs text-fg-subtle pt-2">
                    Please check your inbox. The link will remain valid for 24 hours.
                  </p>
                </div>
              </Card>
            ) : (
              <Card className="p-6 sm:p-8 space-y-6">
                <div className="space-y-2">
                  <h2 className="text-lg font-bold text-fg">Withdraw Candidate Consent</h2>
                  <p className="text-sm text-fg-subtle leading-relaxed">
                    If you previously granted consent for automated resume evaluation and wish to
                    revoke it, enter your email below to receive a secure confirmation link.
                  </p>
                </div>

                {requestError ? (
                  <div className="rounded-md border border-danger bg-danger/10 p-3 text-xs text-danger flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{requestError}</span>
                  </div>
                ) : null}

                <form onSubmit={handleRequest} className="space-y-4">
                  <Field
                    label="Email Address"
                    hint="Enter the email address associated with your job application."
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        type="email"
                        aria-describedby={describedBy}
                        aria-invalid={invalid}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="candidate@example.com"
                        required
                        disabled={requestStatus === 'submitting'}
                      />
                    )}
                  </Field>

                  <Field
                    label="Candidate Reference Code (Optional)"
                    hint="If known, enter your reference code (e.g. CAN-XXXX)."
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        aria-invalid={invalid}
                        value={candidateCode}
                        onChange={(e) => setCandidateCode(e.target.value)}
                        placeholder="e.g. CAN-0042"
                        disabled={requestStatus === 'submitting'}
                      />
                    )}
                  </Field>

                  <div className="pt-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!email.trim() || requestStatus === 'submitting'}
                      className="w-full sm:w-auto"
                    >
                      {requestStatus === 'submitting'
                        ? 'Sending Request...'
                        : 'Send Withdrawal Verification Link'}
                    </Button>
                  </div>
                </form>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
