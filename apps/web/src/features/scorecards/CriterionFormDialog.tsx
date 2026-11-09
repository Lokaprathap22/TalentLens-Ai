import { FileText } from 'lucide-react';
import { useState } from 'react';

import { Button, Dialog, Field, Icon, Input, Select, Textarea } from '../../components/ui/index.js';
import type { CriterionCategory, RequirementType, ScorecardCriterionRecord } from './types.js';

export interface CriterionFormData {
  label: string;
  description: string;
  category: CriterionCategory;
  requirementType: RequirementType;
  weight: number;
  sourceQuote?: string | undefined;
}

export interface CriterionFormDialogProps {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  initialCriterion?: ScorecardCriterionRecord | null;
  onSubmit: (data: CriterionFormData) => void;
  jdText?: string | undefined;
}

export function CriterionFormDialog({
  open,
  onClose,
  mode,
  initialCriterion,
  onSubmit,
  jdText,
}: CriterionFormDialogProps): React.JSX.Element | null {
  const [label, setLabel] = useState<string>(initialCriterion?.label ?? '');
  const [description, setDescription] = useState<string>(initialCriterion?.description ?? '');
  const [category, setCategory] = useState<CriterionCategory>(
    initialCriterion?.category ?? 'SKILL',
  );
  const [requirementType, setRequirementType] = useState<RequirementType>(
    initialCriterion?.requirementType ?? 'MUST_HAVE',
  );
  const [weight, setWeight] = useState<number>(initialCriterion?.weight ?? 15);
  const [sourceQuote, setSourceQuote] = useState<string>(
    initialCriterion?.evidence?.sourceQuote ?? '',
  );
  const [showJd, setShowJd] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError('Please provide a name or title for this criterion.');
      return;
    }

    if (isNaN(weight) || weight <= 0 || weight > 100) {
      setError('Weight must be a positive percentage between 1% and 100%.');
      return;
    }

    onSubmit({
      label: trimmedLabel,
      description: description.trim(),
      category,
      requirementType,
      weight: Math.round(weight),
      sourceQuote: sourceQuote.trim() || undefined,
    });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'Add Screening Criterion' : 'Edit Criterion'}
      description="Define the requirement criteria, priority level, and evaluation weight."
      size="md"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
          >
            {error}
          </div>
        ) : null}

        <Field label="Criterion Label" hint="e.g., Python Backend Architecture">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
              placeholder="e.g. Distributed Systems & Kafka"
              maxLength={200}
              required
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Category">
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={category}
                onChange={(e) => setCategory(e.target.value as CriterionCategory)}
              >
                <option value="SKILL">Technical / Core Skill</option>
                <option value="EXPERIENCE">Experience & Domain</option>
                <option value="NOTICE">Notice Period</option>
                <option value="COMPENSATION">Compensation</option>
                <option value="OTHER_JOB_RELATED">Other Job-Related</option>
              </Select>
            )}
          </Field>

          <Field label="Requirement Type">
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={requirementType}
                onChange={(e) => setRequirementType(e.target.value as RequirementType)}
              >
                <option value="MUST_HAVE">Must-Have (Mandatory)</option>
                <option value="PREFERRED">Preferred (Bonus)</option>
              </Select>
            )}
          </Field>
        </div>

        <Field
          label="Weight Percentage (%)"
          hint="Percentage contribution to candidate screening score (1 to 100)."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              type="number"
              min={1}
              max={100}
              value={weight}
              onChange={(e) => {
                setWeight(Number(e.target.value));
                setError(null);
              }}
              required
            />
          )}
        </Field>

        <Field
          label="Description / Evaluation Guide"
          hint="Specific indicators, technologies, or thresholds expected in candidate CVs."
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="e.g., Demonstrated track record designing fault-tolerant systems in AWS or GCP..."
              maxLength={2000}
            />
          )}
        </Field>

        <Field
          label="Source Job Description Quote (Required for approval)"
          hint="Copy the exact phrase or sentence from the job description that grounds and justifies this criterion."
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={sourceQuote}
              onChange={(e) => setSourceQuote(e.target.value)}
              rows={3}
              placeholder="e.g., 5+ years of experience in distributed backend architectures"
              maxLength={5000}
            />
          )}
        </Field>

        {jdText ? (
          <div className="rounded-lg border border-border bg-surface-muted/30 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-medium text-fg">
                <Icon icon={FileText} size="xs" className="text-accent" />
                <span>Job Description Reference</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setShowJd((prev) => !prev)}
                className="h-6 px-2 text-2xs"
              >
                {showJd ? 'Hide JD' : 'Inspect JD'}
              </Button>
            </div>
            {showJd ? (
              <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface p-2.5 font-mono text-2xs leading-relaxed text-fg whitespace-pre-wrap select-text">
                {jdText}
              </div>
            ) : (
              <p className="text-fg-subtle text-2xs">
                Inspect the job description text to copy exact quotes for grounding.
              </p>
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            {mode === 'create' ? 'Add Criterion' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
