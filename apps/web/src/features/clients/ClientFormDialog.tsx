import { AlertCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button, Dialog, Field, Icon, Input } from '../../components/ui/index.js';
import { isApiError } from '../../lib/api-client.js';
import {
  CLIENT_NAME_MAX_LENGTH,
  resolveClientErrorMessage,
  validateClientName,
} from './client.api.js';
import type { ClientRecord } from './types.js';

export interface ClientFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  client?: ClientRecord | null | undefined;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

interface ClientFormInnerProps {
  mode: 'create' | 'edit';
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

function ClientFormDialogContent({
  mode,
  initialName,
  onClose,
  onSubmit,
}: ClientFormInnerProps): React.JSX.Element {
  const formId = useId();
  const [name, setName] = useState(initialName);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isConflictError, setIsConflictError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  const focusNameInput = (): void => {
    formRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
  };

  useEffect(() => {
    mountedRef.current = true;
    const frame = requestAnimationFrame(() => {
      focusNameInput();
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

    setFieldError(undefined);
    setSubmitError(null);
    setIsConflictError(false);

    const validation = validateClientName(name);
    if (!validation.valid) {
      setFieldError(validation.error);
      focusNameInput();
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);

    try {
      await onSubmit(validation.name);
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
      const conflict = isApiError(error) && (error.status === 409 || error.code === 'conflict');
      setIsConflictError(conflict);
      setSubmitError(
        resolveClientErrorMessage(
          error,
          mode === 'create'
            ? 'Unable to create client right now. Please try again.'
            : 'Unable to update client right now. Please try again.',
        ),
      );
      focusNameInput();
    }
  };

  const isCreate = mode === 'create';
  const dialogTitle = isCreate ? 'Add client' : 'Edit client';
  const dialogDescription = isCreate
    ? 'Add a client organization to scope requisitions, scorecards, and candidate submissions.'
    : 'Update the client organization name shown across requisitions and submissions.';

  return (
    <Dialog
      open
      onClose={handleRequestClose}
      title={dialogTitle}
      description={dialogDescription}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={handleRequestClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={isSubmitting}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? isCreate
                ? 'Adding client…'
                : 'Saving changes…'
              : isCreate
                ? 'Add client'
                : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        id={formId}
        noValidate
        onSubmit={(event) => void handleFormSubmit(event)}
        className="space-y-4"
      >
        {submitError ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-soft p-3 text-xs text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        ) : null}

        <Field
          label="Client name"
          hint={`1–${CLIENT_NAME_MAX_LENGTH} characters. Must be unique within your organization.`}
          {...(fieldError !== undefined ? { error: fieldError } : {})}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              name="name"
              type="text"
              required
              autoComplete="organization"
              placeholder="e.g. Acme Financial Services"
              value={name}
              disabled={isSubmitting}
              aria-describedby={describedBy}
              aria-invalid={invalid || isConflictError || undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (fieldError) {
                  setFieldError(undefined);
                }
                if (submitError) {
                  setSubmitError(null);
                  setIsConflictError(false);
                }
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

export function ClientFormDialog({
  open,
  mode,
  client,
  onClose,
  onSubmit,
}: ClientFormDialogProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  const initialName = mode === 'edit' && client ? client.name : '';
  const instanceKey = `${mode}:${client?.id ?? 'new'}`;

  return (
    <ClientFormDialogContent
      key={instanceKey}
      mode={mode}
      initialName={initialName}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}
