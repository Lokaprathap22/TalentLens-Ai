import { AlertCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button, Dialog, Icon, StatusBadge } from '../../components/ui/index.js';
import { resolveClientErrorMessage } from './client.api.js';
import type { ClientRecord, ClientStatus } from './types.js';

export interface ClientStatusDialogProps {
  open: boolean;
  client: ClientRecord | null;
  onClose: () => void;
  onConfirm: (client: ClientRecord, nextStatus: ClientStatus) => Promise<void>;
}

interface ClientStatusInnerProps {
  client: ClientRecord;
  onClose: () => void;
  onConfirm: (client: ClientRecord, nextStatus: ClientStatus) => Promise<void>;
}

function ClientStatusDialogContent({
  client,
  onClose,
  onConfirm,
}: ClientStatusInnerProps): React.JSX.Element {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleRequestClose = (): void => {
    if (inFlightRef.current || isSubmitting) {
      return;
    }
    onClose();
  };

  const isDeactivating = client.status === 'ACTIVE';
  const nextStatus: ClientStatus = isDeactivating ? 'INACTIVE' : 'ACTIVE';

  const handleConfirm = async (): Promise<void> => {
    if (inFlightRef.current || isSubmitting) {
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await onConfirm(client, nextStatus);
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
        resolveClientErrorMessage(
          error,
          isDeactivating
            ? 'Unable to deactivate client right now. Please try again.'
            : 'Unable to reactivate client right now. Please try again.',
        ),
      );
    }
  };

  const title = isDeactivating ? `Deactivate ${client.name}?` : `Reactivate ${client.name}?`;

  const description = isDeactivating
    ? 'This client will no longer be selectable for new requisitions. Existing requisitions, scorecards, and audit records remain intact.'
    : 'This client will become selectable again when creating new requisitions in your organization.';

  return (
    <Dialog
      open
      onClose={handleRequestClose}
      title={title}
      description={description}
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button variant="secondary" onClick={handleRequestClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant={isDeactivating ? 'danger' : 'primary'}
            loading={isSubmitting}
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting
              ? isDeactivating
                ? 'Deactivating…'
                : 'Reactivating…'
              : isDeactivating
                ? 'Deactivate client'
                : 'Reactivate client'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {submitError ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-soft p-3 text-xs text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-semibold text-fg">{client.name}</p>
            <p className="text-xs text-fg-subtle">
              Transitioning to {isDeactivating ? 'Inactive' : 'Active'}
            </p>
          </div>
          <StatusBadge kind="client" status={client.status} />
        </div>
      </div>
    </Dialog>
  );
}

export function ClientStatusDialog({
  open,
  client,
  onClose,
  onConfirm,
}: ClientStatusDialogProps): React.JSX.Element | null {
  if (!open || !client) {
    return null;
  }

  return (
    <ClientStatusDialogContent
      key={`${client.id}:${client.status}`}
      client={client}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
