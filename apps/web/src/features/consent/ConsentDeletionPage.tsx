import { AlertCircle, AlertTriangle, CheckCircle2, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Field, Input } from '../../components/ui/form-controls.js';
import { isApiError } from '../../lib/api-client.js';
import { confirmCandidateDeletion, requestCandidateDeletion } from './consent.api.js';
import type { CandidateDeletionConfirmResult } from './types.js';

export function extractTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 1. Check URL fragment (#token=...)
  if (window.location.hash) {
    const cleanHash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const hashParams = new URLSearchParams(cleanHash);
    const token = hashParams.get('token');
    if (token?.trim()) {
      return token.trim();
    }
  }

  // 2. Fallback to query params (?token=...)
  if (window.location.search) {
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get('token');
    if (token?.trim()) {
      return token.trim();
    }
  }

  return null;
}

export function sanitizeUrlToken(): void {
  if (typeof window === 'undefined') return;
  try {
    // Scrub token from URL history to prevent bearer token leakage via referrer or browser history
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  } catch {
    // Gracefully ignore history manipulation failure in test/sandboxed envs
  }
}

export function ConsentDeletionPage(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => {
    const extracted = extractTokenFromUrl();
    if (extracted) {
      sanitizeUrlToken();
    }
    return extracted;
  });

  // Request mode state
  const [email, setEmail] = useState('');
  const [candidateCode, setCandidateCode] = useState('');
  const [requestStatus, setRequestStatus] = useState<'idle' | 'submitting' | 'submitted' | 'error'>(
    'idle',
  );
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  // Confirm mode state (when token was extracted)
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<
    'idle' | 'confirming' | 'confirmed' | 'error' | 'invalid_token'
  >('idle');
  const [confirmResult, setConfirmResult] = useState<CandidateDeletionConfirmResult | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => {
      const newToken = extractTokenFromUrl();
      if (newToken) {
        sanitizeUrlToken();
        setToken(newToken);
      }
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
        const result = await requestCandidateDeletion(
          email.trim(),
          candidateCode.trim() || undefined,
        );
        setRequestMessage(result.message);
        setRequestStatus('submitted');
      } catch (err: unknown) {
        setRequestStatus('error');
        if (isApiError(err)) {
          setRequestError(err.message || 'Failed to submit data deletion request.');
        } else {
          setRequestError('An unexpected network error occurred. Please try again.');
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
      const result = await confirmCandidateDeletion(token);
      setConfirmResult(result);
      setConfirmStatus('confirmed');
    } catch (err: unknown) {
      if (isApiError(err)) {
        if (
          err.status === 400 ||
          err.status === 404 ||
          err.status === 410 ||
          err.code === 'INVITATION_INVALID_OR_EXPIRED' ||
          err.code === 'WITHDRAWAL_INVALID_OR_EXPIRED'
        ) {
          setConfirmStatus('invalid_token');
          setConfirmError(
            'This data deletion verification link is invalid, has expired, or has already been used.',
          );
          return;
        }
        setConfirmStatus('error');
        setConfirmError(err.message || 'Server error while executing permanent data deletion.');
      } else {
        setConfirmStatus('error');
        setConfirmError('A network error occurred while communicating with the deletion service.');
      }
    }
  }, [token]);

  return (
    <div className="min-h-screen bg-canvas px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-subtle text-danger">
            <Trash2 className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-default sm:text-3xl">
            Candidate Data Deletion Portal
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Exercise your right to erasure under applicable data privacy regulations (GDPR / DPDP).
          </p>
        </div>

        {/* Mode 1: Confirmation Flow (token present) */}
        {token ? (
          <div className="space-y-6">
            {confirmStatus === 'confirmed' && confirmResult ? (
              <Card className="border-success/30 p-6 sm:p-8">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle text-success">
                    <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <Badge tone="success" className="mb-2">
                    Data Erasure Completed
                  </Badge>
                  <h2 className="text-xl font-semibold text-fg-default">
                    Your Data Has Been Permanently Erased
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                    All candidate records, stored resume documents, AI evaluations, criteria
                    assessments, and profile information have been permanently purged from our
                    databases and object storage.
                  </p>
                  <div className="mt-6 rounded-lg bg-canvas-subtle p-4 text-left text-xs text-fg-subtle">
                    <div className="font-medium text-fg-default">Erasure Summary</div>
                    <ul className="mt-2 list-inside list-disc space-y-1">
                      <li>Candidate identity cryptographically redacted</li>
                      <li>Uploaded CV documents deleted from secure cloud storage</li>
                      <li>Extracted skills, assessments, and submission pipelines purged</li>
                      <li>Associated processing jobs and scheduled interviews terminated</li>
                    </ul>
                  </div>
                  <div className="mt-6">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setToken(null);
                        setConfirmStatus('idle');
                      }}
                    >
                      Return to Request Form
                    </Button>
                  </div>
                </div>
              </Card>
            ) : confirmStatus === 'invalid_token' ? (
              <Card className="border-danger/30 p-6 sm:p-8">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-subtle text-danger">
                    <AlertCircle className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <Badge tone="danger" className="mb-2">
                    Link Expired or Invalid
                  </Badge>
                  <h2 className="text-xl font-semibold text-fg-default">
                    Verification Link Unavailable
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                    {confirmError ??
                      'This deletion link is invalid, has expired, or has already been used to erase records.'}
                  </p>
                  <p className="mt-2 text-xs text-fg-subtle">
                    For your security, verification links expire after 24 hours and can only be used
                    once.
                  </p>
                  <div className="mt-6">
                    <Button
                      variant="primary"
                      onClick={() => {
                        setToken(null);
                        setConfirmStatus('idle');
                        setConfirmError(null);
                      }}
                    >
                      Request a New Verification Link
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="p-6 sm:p-8">
                <div className="space-y-6">
                  {/* Warning Box */}
                  <div
                    className="rounded-xl border border-warning/40 bg-warning-subtle/50 p-4"
                    role="alert"
                  >
                    <div className="flex gap-3">
                      <AlertTriangle className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                      <div className="text-xs text-fg-default sm:text-sm">
                        <span className="font-semibold text-fg-default">Irreversible Action:</span>{' '}
                        Once confirmed, all your personal information, resumes, and evaluation
                        records will be permanently destroyed. This cannot be undone or recovered.
                      </div>
                    </div>
                  </div>

                  <div>
                    <h2 className="text-lg font-semibold text-fg-default">
                      Confirm Permanent Candidate Erasure
                    </h2>
                    <p className="mt-1 text-sm text-fg-muted">
                      Please review the consequences of permanent deletion below before proceeding.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border-subtle bg-canvas-subtle p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                      Scope of Erasure
                    </div>
                    <ul className="mt-3 space-y-2 text-sm text-fg-muted">
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                        <span>
                          <strong>Resume files:</strong> All uploaded CV documents will be deleted
                          from object storage.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                        <span>
                          <strong>Assessments & Notes:</strong> AI criteria evaluations, scores, and
                          recruiter notes are purged.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                        <span>
                          <strong>Client Submissions:</strong> Active client shortlists and
                          interviews will be cancelled.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                        <span>
                          <strong>Identity Redaction:</strong> Contact details (email, phone, name)
                          will be irreversibly redacted.
                        </span>
                      </li>
                    </ul>
                  </div>

                  {confirmError && (
                    <div
                      className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-xs text-danger"
                      role="alert"
                    >
                      {confirmError}
                    </div>
                  )}

                  <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <input
                      type="checkbox"
                      id="confirm-ack"
                      checked={confirmAcknowledged}
                      onChange={(e) => setConfirmAcknowledged(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-border text-danger focus:ring-danger"
                      disabled={confirmStatus === 'confirming'}
                    />
                    <label
                      htmlFor="confirm-ack"
                      className="cursor-pointer text-xs leading-normal text-fg-default"
                    >
                      I understand that this action is irreversible and will permanently delete all
                      my records, evaluations, and uploaded resumes.
                    </label>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setToken(null);
                        setConfirmStatus('idle');
                      }}
                      disabled={confirmStatus === 'confirming'}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={handleConfirm}
                      disabled={!confirmAcknowledged || confirmStatus === 'confirming'}
                    >
                      {confirmStatus === 'confirming'
                        ? 'Deleting Records...'
                        : 'Permanently Delete My Data'}
                    </Button>
                  </div>
                </div>
              </Card>
            )}
          </div>
        ) : (
          /* Mode 2: Request Flow (no token) */
          <div className="space-y-6">
            <Card className="p-6 sm:p-8">
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-fg-default">
                    Request Data Deletion Verification
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    To protect candidate privacy and prevent unauthorized data destruction, we send
                    a secure confirmation link to the email associated with your candidate record.
                  </p>
                </div>

                {/* Information Callout: Difference between Withdrawal vs Erasure */}
                <div className="rounded-xl border border-border-subtle bg-canvas-subtle p-4 text-xs text-fg-muted space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-fg-default">
                    <ShieldAlert className="h-4 w-4 text-primary" aria-hidden="true" />
                    Consent Withdrawal vs. Right to Erasure
                  </div>
                  <p>
                    <strong>Consent Withdrawal:</strong> Revokes permission for future candidate
                    screening while preserving application history for audits.
                  </p>
                  <p>
                    <strong>Data Deletion (Right to Erasure):</strong> Permanently purges all CV
                    files, assessments, and candidate records from all databases and storage.
                  </p>
                </div>

                {requestStatus === 'submitted' ? (
                  <div className="rounded-xl border border-success/30 bg-success-subtle p-5">
                    <div className="flex gap-3">
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                      <div className="space-y-2">
                        <div className="text-sm font-semibold text-fg-default">
                          Verification Email Sent
                        </div>
                        <p className="text-xs text-fg-muted">
                          {requestMessage ??
                            'If an active candidate record is associated with this email, a verification link has been sent.'}
                        </p>
                        <p className="text-xs text-fg-subtle">
                          Please check your inbox (and spam folder). The link will remain active for
                          24 hours.
                        </p>
                        <div className="pt-2">
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setRequestStatus('idle');
                              setEmail('');
                              setCandidateCode('');
                            }}
                          >
                            Send Another Request
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleRequest} noValidate className="space-y-4">
                    {requestError && (
                      <div
                        className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-xs text-danger"
                        role="alert"
                      >
                        {requestError}
                      </div>
                    )}

                    <Field label="Candidate Email">
                      {({ id, describedBy, invalid }) => (
                        <Input
                          id={id}
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          required
                          aria-describedby={describedBy}
                          aria-invalid={invalid}
                          disabled={requestStatus === 'submitting'}
                        />
                      )}
                    </Field>

                    <Field
                      label="Candidate Reference Code (Optional)"
                      hint="If provided by your recruiter (e.g. CAND-XXXXX)"
                    >
                      {({ id, describedBy, invalid }) => (
                        <Input
                          id={id}
                          type="text"
                          value={candidateCode}
                          onChange={(e) => setCandidateCode(e.target.value)}
                          placeholder="CAND-00123"
                          aria-describedby={describedBy}
                          aria-invalid={invalid}
                          disabled={requestStatus === 'submitting'}
                        />
                      )}
                    </Field>

                    <div className="pt-2">
                      <Button
                        type="submit"
                        variant="danger"
                        className="w-full"
                        disabled={!email.trim() || requestStatus === 'submitting'}
                      >
                        {requestStatus === 'submitting'
                          ? 'Sending Verification Link...'
                          : 'Send Deletion Verification Link'}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
