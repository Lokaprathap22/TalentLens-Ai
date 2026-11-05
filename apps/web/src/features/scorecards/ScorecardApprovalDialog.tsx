import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';

import { Button, Dialog, Icon } from '../../components/ui/index.js';

export interface ScorecardApprovalDialogProps {
  open: boolean;
  onClose: () => void;
  version: number;
  activeCriteriaCount: number;
  onConfirm: () => Promise<void>;
  isApproving: boolean;
  error?: string | null;
}

export function ScorecardApprovalDialog({
  open,
  onClose,
  version,
  activeCriteriaCount,
  onConfirm,
  isApproving,
  error,
}: ScorecardApprovalDialogProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={isApproving ? () => {} : onClose}
      title={`Approve Scorecard Version ${version}`}
      description="Review the approval requirements and lifecycle immutability commitments."
      size="md"
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
          >
            <Icon icon={AlertTriangle} size="sm" className="mt-0.5 shrink-0" />
            <p className="font-medium text-danger">{error}</p>
          </div>
        ) : null}

        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-xs text-warning-content space-y-2">
          <div className="flex items-center gap-2 font-semibold text-warning">
            <Icon icon={ShieldAlert} size="sm" />
            <span>Permanent Version Immutability Notice</span>
          </div>
          <p className="leading-relaxed text-fg">
            Once approved, <strong>Version {version}</strong> will become permanently read-only and
            immutable. You will not be able to edit criteria, rebalance weights, or modify source
            evidence for this version.
          </p>
          <p className="leading-relaxed text-fg-muted">
            Any currently active approved scorecard for this requisition will be automatically
            archived in the version history.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface-muted/40 p-4 space-y-2 text-xs">
          <p className="font-semibold text-fg">Approval Verification Summary:</p>
          <ul className="space-y-1.5 text-fg-muted">
            <li className="flex items-center gap-2">
              <Icon icon={CheckCircle2} size="xs" className="text-success" />
              <span>{activeCriteriaCount} active screening criteria validated</span>
            </li>
            <li className="flex items-center gap-2">
              <Icon icon={CheckCircle2} size="xs" className="text-success" />
              <span>Criteria weights sum to exactly 100%</span>
            </li>
            <li className="flex items-center gap-2">
              <Icon icon={CheckCircle2} size="xs" className="text-success" />
              <span>Mandatory "Must-Have" requirements present</span>
            </li>
            <li className="flex items-center gap-2">
              <Icon icon={CheckCircle2} size="xs" className="text-success" />
              <span>All active criteria evidence verified against job description</span>
            </li>
          </ul>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={isApproving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onConfirm()} disabled={isApproving}>
            {isApproving ? (
              'Approving...'
            ) : (
              <>
                <Icon icon={CheckCircle2} size="sm" />
                Approve and Lock Version {version}
              </>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
