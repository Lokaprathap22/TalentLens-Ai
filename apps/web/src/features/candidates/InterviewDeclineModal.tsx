import { AlertCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Dialog } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';

export interface InterviewDeclineModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  candidateCode: string;
}

export function InterviewDeclineModal({
  open,
  onClose,
  onSubmit,
  isLoading,
  error,
  candidateCode,
}: InterviewDeclineModalProps): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleClose = (): void => {
    setReason('');
    setValidationError(null);
    onClose();
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setValidationError(null);

    const trimmed = reason.trim();
    if (!trimmed || trimmed.length < 3) {
      setValidationError(
        'Please provide a reason of at least 3 characters for declining the proposal.',
      );
      return;
    }

    try {
      await onSubmit(trimmed);
      handleClose();
    } catch {
      // Handled via props
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Decline Interview Proposal"
      description={`Provide a reason for declining the interview proposal for candidate ${candidateCode}.`}
      size="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        <div className="space-y-1.5">
          <label htmlFor="decline-reason" className="text-xs font-medium text-fg block">
            Reason for Declining <span className="text-danger">*</span> (required, min 3 chars)
          </label>
          <textarea
            id="decline-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (validationError) setValidationError(null);
            }}
            rows={3}
            maxLength={1000}
            required
            placeholder="e.g., Conflict with candidate work schedule, requesting next week instead..."
            className="w-full rounded-md border border-border bg-surface p-2.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {validationError ? (
          <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{validationError}</span>
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="danger" size="sm" disabled={isLoading}>
            <XCircle className="h-3.5 w-3.5 mr-1.5" />
            {isLoading ? 'Declining...' : 'Decline Proposal'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
