import { Check, CheckCircle2, FileSearch, Quote } from 'lucide-react';

import { Button, Icon, StatusBadge } from '../../components/ui/index.js';
import type { ScorecardCriterionEvidence } from './types.js';

export interface CriterionEvidencePanelProps {
  evidence: ScorecardCriterionEvidence | null;
  isEditable: boolean;
  onVerify: () => void;
  onAttachQuote?: () => void;
}

export function CriterionEvidencePanel({
  evidence,
  isEditable,
  onVerify,
  onAttachQuote,
}: CriterionEvidencePanelProps): React.JSX.Element {
  if (!evidence) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border bg-surface-muted/20 p-2.5 text-xs text-fg-subtle">
        <p className="italic">
          No extracted job description quote linked. This criterion requires a verified JD quote
          before scorecard approval.
        </p>
        {isEditable && onAttachQuote ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onAttachQuote}
            className="h-6 shrink-0 px-2 text-2xs"
          >
            Attach JD quote
          </Button>
        ) : null}
      </div>
    );
  }

  const isVerified = evidence.verificationStatus === 'VERIFIED';
  const hasRange = evidence.sourceStart !== null && evidence.sourceEnd !== null;

  return (
    <div className="rounded-md border border-border bg-surface-muted/30 p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-fg-subtle">
          <Icon icon={Quote} size="xs" className="text-accent" />
          <span>Grounded Job Description Source</span>
        </div>
        <StatusBadge kind="evidenceVerification" status={evidence.verificationStatus} />
      </div>

      {/* Quote text */}
      <blockquote className="border-l-2 border-accent/40 pl-2.5 py-0.5 text-fg font-sans italic leading-relaxed select-text">
        "{evidence.sourceQuote}"
      </blockquote>

      {/* Offsets & Verification controls */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50 text-2xs text-fg-subtle">
        <div className="flex items-center gap-1 font-mono">
          <Icon icon={FileSearch} size="xs" />
          <span>
            {hasRange
              ? `Characters [${evidence.sourceStart}..${evidence.sourceEnd}]`
              : 'Unindexed quote'}
          </span>
        </div>

        {isEditable ? (
          <div>
            {isVerified ? (
              <span className="flex items-center gap-1 text-success font-medium">
                <Icon icon={CheckCircle2} size="xs" />
                Verified by recruiter
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={onVerify}
                className="h-6 px-2 text-2xs"
              >
                <Icon icon={Check} size="xs" />
                Verify source quote
              </Button>
            )}
          </div>
        ) : (
          isVerified && (
            <span className="flex items-center gap-1 text-success font-medium">
              <Icon icon={CheckCircle2} size="xs" />
              Verified
            </span>
          )
        )}
      </div>
    </div>
  );
}
