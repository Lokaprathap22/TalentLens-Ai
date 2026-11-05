import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';

import { Badge, Button, Card, CardBody, CardHeader, Icon } from '../../components/ui/index.js';
import type { ApprovalReadinessCheck } from './types.js';

export interface ScorecardApprovalReadinessProps {
  readiness: ApprovalReadinessCheck;
  isEditable: boolean;
  onOpenApproveDialog: () => void;
  isApproving: boolean;
  version: number;
}

export function ScorecardApprovalReadiness({
  readiness,
  isEditable,
  onOpenApproveDialog,
  isApproving,
  version,
}: ScorecardApprovalReadinessProps): React.JSX.Element {
  const {
    hasActiveCriteria,
    hasMustHaveCriterion,
    weightsSumTo100,
    totalActiveWeight,
    allActiveEvidenceVerified,
    unverifiedCount,
    isReady,
    blockingReasons,
  } = readiness;

  // Visual weight meter calculation
  const weightPercentage = Math.min(100, Math.max(0, totalActiveWeight));
  const weightTone = weightsSumTo100
    ? 'bg-success-solid'
    : totalActiveWeight > 100
      ? 'bg-danger-solid'
      : 'bg-warning-solid';

  return (
    <Card>
      <CardHeader
        title="Approval Readiness"
        description="Verification checklist required before a scorecard draft can be approved."
        actions={
          <Badge tone={isReady ? 'success' : 'warning'} dot>
            {isReady ? 'Ready for approval' : 'Action required'}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        {/* Weight Allocation Meter */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-fg-subtle">Active Criteria Weight</span>
            <span
              className={`font-semibold tabular ${
                weightsSumTo100
                  ? 'text-success'
                  : totalActiveWeight > 100
                    ? 'text-danger'
                    : 'text-warning'
              }`}
            >
              {totalActiveWeight}% of 100%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted border border-border">
            <div
              className={`h-full transition-all duration-300 ${weightTone}`}
              style={{ width: `${weightPercentage}%` }}
            />
          </div>
        </div>

        {/* Requirements Checklist */}
        <div className="space-y-2.5 rounded-lg border border-border bg-surface-muted/30 p-3 text-xs">
          <div className="flex items-start gap-2">
            <Icon
              icon={hasActiveCriteria ? CheckCircle2 : XCircle}
              size="xs"
              className={
                hasActiveCriteria
                  ? 'text-success shrink-0 mt-0.5'
                  : 'text-fg-subtle shrink-0 mt-0.5'
              }
            />
            <span className={hasActiveCriteria ? 'text-fg' : 'text-fg-muted'}>
              At least one active criterion
            </span>
          </div>

          <div className="flex items-start gap-2">
            <Icon
              icon={hasMustHaveCriterion ? CheckCircle2 : XCircle}
              size="xs"
              className={
                hasMustHaveCriterion
                  ? 'text-success shrink-0 mt-0.5'
                  : 'text-fg-subtle shrink-0 mt-0.5'
              }
            />
            <span className={hasMustHaveCriterion ? 'text-fg' : 'text-fg-muted'}>
              At least one "Must-Have" mandatory criterion
            </span>
          </div>

          <div className="flex items-start gap-2">
            <Icon
              icon={weightsSumTo100 ? CheckCircle2 : XCircle}
              size="xs"
              className={
                weightsSumTo100 ? 'text-success shrink-0 mt-0.5' : 'text-fg-subtle shrink-0 mt-0.5'
              }
            />
            <span className={weightsSumTo100 ? 'text-fg' : 'text-fg-muted'}>
              Active weights sum to exactly 100% (positive weights only)
            </span>
          </div>

          <div className="flex items-start gap-2">
            <Icon
              icon={allActiveEvidenceVerified ? CheckCircle2 : XCircle}
              size="xs"
              className={
                allActiveEvidenceVerified
                  ? 'text-success shrink-0 mt-0.5'
                  : 'text-fg-subtle shrink-0 mt-0.5'
              }
            />
            <span className={allActiveEvidenceVerified ? 'text-fg' : 'text-fg-muted'}>
              {allActiveEvidenceVerified
                ? 'All active criteria evidence verified'
                : `${unverifiedCount} active ${unverifiedCount === 1 ? 'criterion requires' : 'criteria require'} evidence verification`}
            </span>
          </div>
        </div>

        {/* Blocking Reasons Summary */}
        {!isReady && blockingReasons.length > 0 ? (
          <div className="rounded-md border border-warning/20 bg-warning/5 p-3 text-xs text-warning">
            <p className="font-semibold text-warning mb-1">To enable approval:</p>
            <ul className="list-disc pl-4 space-y-1 text-fg-muted">
              {blockingReasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Approval Action */}
        {isEditable ? (
          <div className="pt-2">
            <Button
              variant="primary"
              className="w-full"
              disabled={!isReady || isApproving}
              onClick={onOpenApproveDialog}
            >
              <Icon icon={ShieldCheck} size="sm" />
              {isReady ? `Approve Scorecard Version ${version}` : 'Resolve Requirements to Approve'}
            </Button>
            {!isReady ? (
              <p className="mt-1.5 text-center text-2xs text-fg-subtle">
                AI extraction must be verified by a human recruiter before approval.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
