import { AlertCircle, UserPlus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button, Dialog, Field, Icon, Input } from '../../components/ui/index.js';
import {
  EMAIL_MAX_LENGTH,
  MEMBER_NAME_MAX_LENGTH,
  resolveMemberErrorMessage,
  validateMemberEmail,
  validateMemberName,
} from './client.api.js';
import type { ClientRecord, InviteClientMemberInput } from './types.js';

export interface InviteMemberDialogProps {
  open: boolean;
  client: ClientRecord | null;
  onClose: () => void;
  onSubmit: (input: InviteClientMemberInput) => Promise<void>;
}

interface InviteMemberDialogContentProps {
  client: ClientRecord;
  onClose: () => void;
  onSubmit: (input: InviteClientMemberInput) => Promise<void>;
}

function InviteMemberDialogContent({
  client,
  onClose,
  onSubmit,
}: InviteMemberDialogContentProps): React.JSX.Element {
  const formId = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; name?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  const focusEmailInput = (): void => {
    formRef.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
  };

  useEffect(() => {
    mountedRef.current = true;
    const frame = requestAnimationFrame(() => {
      focusEmailInput();
    });
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const handleRequestClose = (): void => {
    if (inFlightRef.current || isSubmitting) {
      return;
    }
    onClose();
  };

  const handleFormSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (inFlightRef.current || isSubmitting) {
      return;
    }

    setFieldErrors({});
    setSubmitError(null);

    const emailValidation = validateMemberEmail(email);
    const nameValidation = validateMemberName(name);

    const errors: { email?: string; name?: string } = {};
    if (!emailValidation.valid) {
      errors.email = emailValidation.error;
    }
    if (!nameValidation.valid) {
      errors.name = nameValidation.error;
    }

    if (!emailValidation.valid || !nameValidation.valid) {
      setFieldErrors(errors);
      if (!emailValidation.valid) {
        focusEmailInput();
      }
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);

    try {
      await onSubmit({
        email: emailValidation.email,
        ...(nameValidation.name ? { name: nameValidation.name } : {}),
      });

      if (!mountedRef.current) {
        return;
      }
      inFlightRef.current = false;
      setIsSubmitting(false);
      onClose();
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      inFlightRef.current = false;
      setIsSubmitting(false);
      setSubmitError(
        resolveMemberErrorMessage(
          error,
          'Unable to send invitation right now. Please try again shortly.',
        ),
      );
      focusEmailInput();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs text-fg-subtle">
          Invite a hiring manager to review candidates and coordinate interviews for{' '}
          <strong className="text-fg">{client.name}</strong>.
        </p>
      </div>

      {submitError ? (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft/75 px-3.5 py-2.5 text-xs text-danger"
        >
          <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
          <span className="font-medium leading-relaxed">{submitError}</span>
        </div>
      ) : null}

      <form
        ref={formRef}
        id={formId}
        onSubmit={(e) => void handleFormSubmit(e)}
        className="space-y-4"
        noValidate
      >
        <Field
          label="Work email address"
          error={fieldErrors.email}
          hint={`Official client email (up to ${EMAIL_MAX_LENGTH} characters).`}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="e.g. alex.chen@acme.com"
              value={email}
              disabled={isSubmitting}
              maxLength={EMAIL_MAX_LENGTH}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => {
                setEmail(event.target.value);
                if (fieldErrors.email) {
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.email;
                    return next;
                  });
                }
                if (submitError) {
                  setSubmitError(null);
                }
              }}
            />
          )}
        </Field>

        <Field
          label="Full name"
          error={fieldErrors.name}
          hint={`Optional. Display name in client communications (up to ${MEMBER_NAME_MAX_LENGTH} characters).`}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              name="name"
              type="text"
              autoComplete="name"
              placeholder="e.g. Alex Chen"
              value={name}
              disabled={isSubmitting}
              maxLength={MEMBER_NAME_MAX_LENGTH}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => {
                setName(event.target.value);
                if (fieldErrors.name) {
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.name;
                    return next;
                  });
                }
              }}
            />
          )}
        </Field>

        <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-2xs text-fg-subtle">
          <p>
            An activation link with a 48-hour expiration will be securely emailed to this address.
            The recipient will choose their own password to activate their portal account.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button
            type="button"
            variant="secondary"
            size="md"
            disabled={isSubmitting}
            onClick={handleRequestClose}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" icon={UserPlus} loading={isSubmitting}>
            {isSubmitting ? 'Sending invitation…' : 'Send invitation'}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function InviteMemberDialog({
  open,
  client,
  onClose,
  onSubmit,
}: InviteMemberDialogProps): React.JSX.Element | null {
  if (!open || !client) {
    return null;
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Invite client hiring manager`} size="md">
      <InviteMemberDialogContent client={client} onClose={onClose} onSubmit={onSubmit} />
    </Dialog>
  );
}
