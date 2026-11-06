import { Check, Copy, Link as LinkIcon, ShieldCheck } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, Input } from '../../components/ui/form-controls.js';
import { isApiError } from '../../lib/api-client.js';
import { createConsentInvitation } from './consent.api.js';
import type { ConsentInvitationDto } from './types.js';

export interface ConsentInvitationModalProps {
  open: boolean;
  onClose: () => void;
  requisitionId: string;
  candidateId: string;
  candidateCode: string;
  onSuccess?: (invitation: ConsentInvitationDto) => void;
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

export function ConsentInvitationModal({
  open,
  onClose,
  requisitionId,
  candidateId,
  candidateCode,
  onSuccess,
}: ConsentInvitationModalProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [invitation, setInvitation] = useState<ConsentInvitationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleReset = useCallback(() => {
    setEmail('');
    setStatus('idle');
    setInvitation(null);
    setError(null);
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!email.trim()) return;

      setStatus('submitting');
      setError(null);

      try {
        const result = await createConsentInvitation(requisitionId, candidateId, email.trim());
        setInvitation(result);
        setStatus('success');
        onSuccess?.(result);
      } catch (err: unknown) {
        setStatus('error');
        if (isApiError(err)) {
          setError(err.message || 'Failed to create consent invitation.');
        } else {
          setError('An unexpected error occurred. Please try again.');
        }
      }
    },
    [requisitionId, candidateId, email, onSuccess],
  );

  const handleCopy = useCallback(async () => {
    if (!invitation?.invitationUrl) return;
    try {
      await navigator.clipboard.writeText(invitation.invitationUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, [invitation]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={status === 'success' ? 'Consent Invitation Link' : 'Issue Consent Invitation'}
      description={
        status === 'success'
          ? `Consent invitation ready for candidate ${candidateCode}.`
          : `Create a single-use consent invitation for candidate ${candidateCode}.`
      }
      size="md"
      footer={
        status === 'success' ? (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="primary" onClick={handleClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="consent-invitation-form"
              variant="primary"
              disabled={!email.trim() || status === 'submitting'}
            >
              {status === 'submitting' ? 'Generating...' : 'Generate Invitation'}
            </Button>
          </div>
        )
      }
    >
      <div className="p-5">
        {status === 'success' && invitation ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-bg-subtle p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Recipient Email:</span>
                <span className="font-semibold text-fg">{invitation.email}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Status:</span>
                <Badge tone="warning" dot>
                  {invitation.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Policy Version:</span>
                <span className="font-mono text-fg">v{invitation.policyVersion}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Expires At:</span>
                <span className="text-fg">{formatDate(invitation.expiresAt)}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-fg flex items-center gap-1.5">
                <LinkIcon className="h-3.5 w-3.5 text-accent" />
                Secure Candidate Invitation Link
              </label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={invitation.invitationUrl ?? ''}
                  className="font-mono text-xs bg-surface-muted select-all"
                  aria-label="Invitation URL"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleCopy}
                  className="shrink-0 flex items-center gap-1 text-xs"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-success" />
                      <span className="text-success font-medium">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy Link</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="rounded border border-border p-3 text-xs text-fg-subtle space-y-1">
              <div className="flex items-center gap-1 font-semibold text-fg">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Manual Link Sharing
              </div>
              <p>
                Email delivery is disabled in this environment. Copy the secure link above and share
                it directly with the candidate. Opening the link allows them to review the screening
                disclosure and grant authorization.
              </p>
            </div>
          </div>
        ) : (
          <form id="consent-invitation-form" onSubmit={handleSubmit} className="space-y-4">
            {error ? (
              <div className="rounded-md border border-danger bg-danger/10 p-3 text-xs text-danger">
                {error}
              </div>
            ) : null}

            <Field
              label="Candidate Email Address"
              hint="The invitation will be registered to this email address."
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
                  disabled={status === 'submitting'}
                  autoFocus
                />
              )}
            </Field>

            <div className="rounded border border-border bg-bg-subtle p-3 text-xs text-fg-subtle space-y-1">
              <p className="font-semibold text-fg">Compliance Notice</p>
              <p>
                Consent is mandatory before AI automated screening can evaluate this candidate's
                resume. Once created, any earlier pending invitations for this requisition will be
                automatically superseded.
              </p>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
