import { Mail, ShieldCheck } from 'lucide-react';
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

  const handleReset = useCallback(() => {
    setEmail('');
    setStatus('idle');
    setInvitation(null);
    setError(null);
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

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={status === 'success' ? 'Consent Invitation Dispatched' : 'Issue Consent Invitation'}
      description={
        status === 'success'
          ? `Consent invitation dispatched for candidate ${candidateCode}.`
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

            <div className="rounded-md border border-border bg-bg-subtle p-3.5 space-y-2 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-fg">
                <Mail className="h-4 w-4 text-accent" />
                <span>Email Invitation Dispatched</span>
              </div>
              <p className="text-fg-subtle">
                A secure, single-use authorization link has been sent directly to{' '}
                <span className="font-semibold text-fg">{invitation.email}</span>.
              </p>
              <div className="flex items-center justify-between pt-1 border-t border-border/50 text-[11px] text-fg-muted">
                <span>Delivery Status:</span>
                <span className="font-medium text-fg capitalize">
                  {invitation.deliveryStatus.toLowerCase()}
                </span>
              </div>
            </div>

            <div className="rounded border border-border p-3 text-xs text-fg-subtle space-y-1 bg-surface-muted/50">
              <div className="flex items-center gap-1 font-semibold text-fg">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Privacy &amp; Security Policy
              </div>
              <p>
                To protect candidate privacy and prevent unauthorized token delegation,
                authorization links are delivered solely to the candidate's verified email outbox
                and cannot be copied or viewed by recruiters.
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
