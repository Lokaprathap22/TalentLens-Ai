import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';

import { Button, Dialog, Field, Icon, Input, Select, Textarea } from '../../components/ui/index.js';
import { listClients } from '../clients/client.api.js';
import type { ClientRecord } from '../clients/types.js';
import {
  REQUISITION_JD_MAX_LENGTH,
  REQUISITION_TITLE_MAX_LENGTH,
  resolveRequisitionErrorMessage,
  validateRequisitionInput,
} from './requisition.api.js';
import type { RequisitionRecord } from './types.js';

export interface RequisitionFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  requisition?: RequisitionRecord | null | undefined;
  onClose: () => void;
  onSubmit: (input: { clientId: string; title: string; jdText: string }) => Promise<void>;
}

interface RequisitionFormInnerProps {
  mode: 'create' | 'edit';
  requisition?: RequisitionRecord | null | undefined;
  onClose: () => void;
  onSubmit: (input: { clientId: string; title: string; jdText: string }) => Promise<void>;
}

function RequisitionFormDialogContent({
  mode,
  requisition,
  onClose,
  onSubmit,
}: RequisitionFormInnerProps): React.JSX.Element {
  const formId = useId();
  const [clientId, setClientId] = useState<string>(requisition?.clientId ?? '');
  const [title, setTitle] = useState<string>(requisition?.title ?? '');
  const [jdText, setJdText] = useState<string>(requisition?.jdText ?? '');

  const [activeClients, setActiveClients] = useState<ClientRecord[]>([]);
  const [clientsLoading, setClientsLoading] = useState<boolean>(true);
  const [clientsError, setClientsError] = useState<string | null>(null);

  const [fieldErrors, setFieldErrors] = useState<{
    clientId?: string | undefined;
    title?: string | undefined;
    jdText?: string | undefined;
  }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  const clearFieldError = (field: 'clientId' | 'title' | 'jdText'): void => {
    setFieldErrors((prev) => {
      if (prev[field] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    let isCancelled = false;

    async function loadActiveClients(): Promise<void> {
      setClientsLoading(true);
      setClientsError(null);
      try {
        const allClients = await listClients();
        if (isCancelled || !mountedRef.current) {
          return;
        }
        const active = allClients.filter((c) => c.status === 'ACTIVE');
        // Sort active clients alphabetically
        active.sort((a, b) => a.name.localeCompare(b.name));
        setActiveClients(active);
      } catch {
        if (isCancelled || !mountedRef.current) {
          return;
        }
        setClientsError('Unable to load client organizations. Please try again.');
      } finally {
        if (!isCancelled && mountedRef.current) {
          setClientsLoading(false);
        }
      }
    }

    void loadActiveClients();

    const frame = requestAnimationFrame(() => {
      if (mode === 'create') {
        formRef.current?.querySelector<HTMLSelectElement>('select[name="clientId"]')?.focus();
      } else {
        formRef.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
      }
    });

    return () => {
      isCancelled = true;
      mountedRef.current = false;
      cancelAnimationFrame(frame);
    };
  }, [mode]);

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

    const validation = validateRequisitionInput({ clientId, title, jdText }, mode);
    if (!validation.valid) {
      setFieldErrors(validation.errors);
      if (validation.errors.clientId) {
        formRef.current?.querySelector<HTMLSelectElement>('select[name="clientId"]')?.focus();
      } else if (validation.errors.title) {
        formRef.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
      } else if (validation.errors.jdText) {
        formRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="jdText"]')?.focus();
      }
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);

    try {
      await onSubmit({
        clientId: validation.sanitized.clientId!,
        title: validation.sanitized.title!,
        jdText: validation.sanitized.jdText!,
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
      const message = resolveRequisitionErrorMessage(
        error,
        mode === 'create'
          ? 'Unable to create requisition right now. Please try again.'
          : 'Unable to update requisition right now. Please try again.',
        { action: mode === 'create' ? 'create' : 'update' },
      );
      setSubmitError(message);
    }
  };

  const dialogTitle = mode === 'create' ? 'Create new requisition' : 'Edit requisition draft';
  const dialogDescription =
    mode === 'create'
      ? 'Define the client organization, job title, and complete job description requirements for AI screening.'
      : 'Update the job title, requirements, or client organization for this draft requisition.';

  const isNoClientsAvailable = !clientsLoading && !clientsError && activeClients.length === 0;

  return (
    <Dialog
      open
      onClose={handleRequestClose}
      title={dialogTitle}
      description={dialogDescription}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={handleRequestClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={isSubmitting || (mode === 'create' && isNoClientsAvailable)}
          >
            {isSubmitting
              ? mode === 'create'
                ? 'Creating...'
                : 'Saving...'
              : mode === 'create'
                ? 'Create requisition'
                : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} onSubmit={handleFormSubmit} className="space-y-4" noValidate>
        {submitError ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-danger-subtle bg-danger-subtle/30 p-3 text-sm text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Action could not be completed</p>
              <p className="mt-0.5 text-xs text-fg-subtle">{submitError}</p>
            </div>
          </div>
        ) : null}

        {isNoClientsAvailable ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-warning-subtle bg-warning-subtle/30 p-3 text-sm text-warning"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">No active clients found</p>
              <p className="mt-0.5 text-xs text-fg-subtle">
                A requisition must be associated with an active client. Please create or activate a
                client organization first.
              </p>
              <div className="mt-2">
                <Link
                  to="/clients"
                  onClick={onClose}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                >
                  Go to Clients directory
                  <Icon icon={ExternalLink} size="xs" />
                </Link>
              </div>
            </div>
          </div>
        ) : null}

        <Field
          label="Client organization"
          hint="Select the client company hiring for this role."
          error={fieldErrors.clientId}
        >
          {({ id, describedBy, invalid }) => (
            <div className="relative">
              <Select
                id={id}
                name="clientId"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  clearFieldError('clientId');
                }}
                disabled={isSubmitting || clientsLoading || isNoClientsAvailable}
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                required
              >
                <option value="">
                  {clientsLoading
                    ? 'Loading clients...'
                    : activeClients.length === 0
                      ? 'No active clients available'
                      : 'Select a client...'}
                </option>
                {activeClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
                {mode === 'edit' &&
                requisition?.clientId &&
                !activeClients.some((c) => c.id === requisition.clientId) ? (
                  <option value={requisition.clientId}>{requisition.clientName} (Current)</option>
                ) : null}
              </Select>
              {clientsLoading ? (
                <span className="pointer-events-none absolute inset-y-0 right-8 flex items-center text-fg-subtle">
                  <Icon icon={Loader2} size="xs" className="animate-spin" />
                </span>
              ) : null}
            </div>
          )}
        </Field>

        <Field
          label="Job title"
          hint={`Max ${REQUISITION_TITLE_MAX_LENGTH} characters. Be specific (e.g. Senior Backend Engineer - Python).`}
          error={fieldErrors.title}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              name="title"
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearFieldError('title');
              }}
              placeholder="e.g. Lead Distributed Systems Engineer"
              maxLength={REQUISITION_TITLE_MAX_LENGTH}
              disabled={isSubmitting}
              aria-describedby={describedBy}
              aria-invalid={invalid ? 'true' : undefined}
              required
            />
          )}
        </Field>

        <Field
          label="Job description requirements"
          hint={`Max ${REQUISITION_JD_MAX_LENGTH.toLocaleString()} characters. Paste the full job description. AI extraction will identify criteria from this text.`}
          error={fieldErrors.jdText}
        >
          {({ id, describedBy, invalid }) => (
            <div className="space-y-1">
              <Textarea
                id={id}
                name="jdText"
                rows={10}
                value={jdText}
                onChange={(e) => {
                  setJdText(e.target.value);
                  clearFieldError('jdText');
                }}
                placeholder="Paste the complete job description, responsibilities, must-have skills, preferred experience, and qualifications..."
                maxLength={REQUISITION_JD_MAX_LENGTH}
                disabled={isSubmitting}
                aria-describedby={describedBy}
                aria-invalid={invalid ? 'true' : undefined}
                required
              />
              <div className="flex justify-end text-right text-xs text-fg-subtle tabular">
                {jdText.length.toLocaleString()} / {REQUISITION_JD_MAX_LENGTH.toLocaleString()}{' '}
                characters
              </div>
            </div>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

export function RequisitionFormDialog({
  open,
  mode,
  requisition,
  onClose,
  onSubmit,
}: RequisitionFormDialogProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  const key = mode === 'edit' && requisition ? `edit-${requisition.id}` : 'create-new';

  return (
    <RequisitionFormDialogContent
      key={key}
      mode={mode}
      requisition={requisition}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}
