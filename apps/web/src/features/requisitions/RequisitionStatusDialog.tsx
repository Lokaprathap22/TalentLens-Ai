import { AlertCircle, AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button, Dialog, Icon, StatusBadge } from '../../components/ui/index.js';
import {
  getAvailableStatusTransitions,
  resolveRequisitionErrorMessage,
} from './requisition.api.js';
import type { RequisitionRecord, TransitionTargetStatus } from './types.js';

export interface RequisitionStatusDialogProps {
  open: boolean;
  requisition: RequisitionRecord | null;
  onClose: () => void;
  onConfirm: (requisition: RequisitionRecord, nextStatus: TransitionTargetStatus) => Promise<void>;
}

interface RequisitionStatusInnerProps {
  requisition: RequisitionRecord;
  onClose: () => void;
  onConfirm: (requisition: RequisitionRecord, nextStatus: TransitionTargetStatus) => Promise<void>;
}

function getStatusTransitionDetails(
  currentStatus: RequisitionRecord['status'],
  targetStatus: TransitionTargetStatus,
): { title: string; explanation: string; isDestructive: boolean } {
  switch (targetStatus) {
    case 'OPEN':
      return {
        title: 'Open requisition for candidate screening',
        explanation:
          'Opening this requisition requires an approved scorecard version. If a scorecard has not yet been generated and approved, the server will prevent this transition.',
        isDestructive: false,
      };
    case 'PAUSED':
      return {
        title: 'Pause active screening',
        explanation:
          'Pausing this requisition will temporarily suspend candidate screening and candidate matching.',
        isDestructive: false,
      };
    case 'CLOSED':
      return {
        title: 'Close requisition (terminal)',
        explanation:
          'Closing this requisition is a terminal action. Once closed, candidate applications and edits cannot be resumed.',
        isDestructive: true,
      };
    case 'FILLED':
      return {
        title: 'Mark requisition as filled (terminal)',
        explanation:
          'Marking this requisition as filled is a terminal action indicating successful hiring. Once filled, further edits cannot be made.',
        isDestructive: false,
      };
  }
}

function RequisitionStatusDialogContent({
  requisition,
  onClose,
  onConfirm,
}: RequisitionStatusInnerProps): React.JSX.Element {
  const availableTransitions = getAvailableStatusTransitions(requisition.status);
  const [selectedStatus, setSelectedStatus] = useState<TransitionTargetStatus>(
    availableTransitions[0] ?? 'OPEN',
  );
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

  const handleConfirm = async (): Promise<void> => {
    if (inFlightRef.current || isSubmitting || !selectedStatus) {
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await onConfirm(requisition, selectedStatus);
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
        resolveRequisitionErrorMessage(
          error,
          'Unable to update requisition status right now. Please try again.',
          {
            action: 'transition',
            currentStatus: requisition.status,
            targetStatus: selectedStatus,
          },
        ),
      );
    }
  };

  const currentTransitionDetails = selectedStatus
    ? getStatusTransitionDetails(requisition.status, selectedStatus)
    : null;

  return (
    <Dialog
      open
      onClose={handleRequestClose}
      title={`Update status: ${requisition.title}`}
      description="Transition this requisition through its hiring lifecycle."
      size="md"
      role="alertdialog"
      footer={
        <>
          <Button variant="secondary" onClick={handleRequestClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant={currentTransitionDetails?.isDestructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={isSubmitting || !selectedStatus || availableTransitions.length === 0}
          >
            {isSubmitting
              ? 'Updating status...'
              : `Confirm transition to ${selectedStatus ?? 'new status'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitError ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-danger-subtle bg-danger-subtle/30 p-3 text-sm text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Transition blocked</p>
              <p className="mt-0.5 text-xs text-fg-subtle">{submitError}</p>
            </div>
          </div>
        ) : null}

        <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-subtle">Current status</span>
            <StatusBadge kind="requisition" status={requisition.status} />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
            <span>Client</span>
            <span className="font-medium text-fg">{requisition.clientName}</span>
          </div>
        </div>

        {availableTransitions.length === 0 ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-border bg-surface-muted p-3 text-sm text-fg-subtle"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <p className="text-xs">
              This requisition is in a terminal status ({requisition.status}) and cannot be
              transitioned to any other status.
            </p>
          </div>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-fg">Select target status</legend>
            <div className="space-y-2">
              {availableTransitions.map((target) => (
                <label
                  key={target}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors ${
                    selectedStatus === target
                      ? 'border-accent bg-accent/5 ring-1 ring-accent'
                      : 'border-border bg-surface hover:border-fg-disabled'
                  }`}
                >
                  <input
                    type="radio"
                    name="targetStatus"
                    value={target}
                    checked={selectedStatus === target}
                    onChange={() => {
                      setSelectedStatus(target);
                      setSubmitError(null);
                    }}
                    className="mt-0.5 text-accent focus:ring-accent"
                    disabled={isSubmitting}
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg">{target}</span>
                      <StatusBadge kind="requisition" status={target} />
                    </div>
                    <p className="text-xs text-fg-subtle">
                      {getStatusTransitionDetails(requisition.status, target).explanation}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {currentTransitionDetails?.isDestructive ? (
          <div className="flex items-start gap-2 rounded-md border border-warning-subtle bg-warning-subtle/20 p-2.5 text-xs text-warning">
            <Icon icon={AlertTriangle} size="xs" className="mt-0.5 shrink-0" />
            <span>
              This is a permanent state change. Once closed, you will not be able to edit or reopen
              this requisition.
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function RequisitionStatusDialog({
  open,
  requisition,
  onClose,
  onConfirm,
}: RequisitionStatusDialogProps): React.JSX.Element | null {
  if (!open || !requisition) {
    return null;
  }

  return (
    <RequisitionStatusDialogContent
      key={`status-${requisition.id}-${requisition.status}`}
      requisition={requisition}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
