import { AlertCircle, Bot, Copy, FilePlus, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button, Dialog, Field, Icon, Select } from '../../components/ui/index.js';
import { createScorecardDraft, resolveScorecardErrorMessage } from './scorecard.api.js';
import type { ScorecardCreationMode, ScorecardRecord } from './types.js';

export interface ScorecardCreationDialogProps {
  open: boolean;
  onClose: () => void;
  requisitionId: string;
  requisitionTitle: string;
  existingScorecards?: ScorecardRecord[];
  onCreated: (scorecard: ScorecardRecord) => void;
}

export function ScorecardCreationDialog({
  open,
  onClose,
  requisitionId,
  requisitionTitle,
  existingScorecards = [],
  onCreated,
}: ScorecardCreationDialogProps): React.JSX.Element | null {
  const [mode, setMode] = useState<ScorecardCreationMode>('ai');
  const [cloneVersionId, setCloneVersionId] = useState<string>(existingScorecards[0]?.id ?? '');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleCreate = async () => {
    setLoading(true);
    setError(null);

    try {
      let created: ScorecardRecord;
      if (mode === 'ai') {
        created = await createScorecardDraft(requisitionId, { mode: 'ai' });
      } else if (mode === 'manual') {
        created = await createScorecardDraft(requisitionId, { mode: 'manual' });
      } else {
        if (!cloneVersionId) {
          setError('Please select a scorecard version to clone.');
          setLoading(false);
          return;
        }
        created = await createScorecardDraft(requisitionId, {
          cloneFromVersionId: cloneVersionId,
        });
      }

      onCreated(created);
      onClose();
    } catch (err) {
      const message = resolveScorecardErrorMessage(err, 'Failed to create scorecard draft.', {
        action: 'create',
      });
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={loading ? () => {} : onClose}
      title="Create Scorecard Version"
      description={`Generate or construct candidate screening criteria for ${requisitionTitle}.`}
      size="lg"
    >
      <div className="space-y-5">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5 text-sm text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium text-danger">{error}</p>
              {mode === 'ai' ? (
                <p className="text-xs text-danger/80">
                  Tip: If AI extraction is currently unavailable or unconfigured, you can create a
                  manual draft instead.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Select Creation Method
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* AI Generation Mode */}
            <button
              type="button"
              aria-label="Mode: AI Assisted"
              onClick={() => {
                setMode('ai');
                setError(null);
              }}
              className={`relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors ${
                mode === 'ai'
                  ? 'border-accent bg-accent/5 ring-2 ring-accent/20'
                  : 'border-border bg-surface hover:border-border-strong hover:bg-surface-muted/50'
              }`}
            >
              <div className="mb-2 flex size-8 items-center justify-center rounded-md bg-accent/10 text-accent">
                <Icon icon={Sparkles} size="sm" />
              </div>
              <span className="font-semibold text-sm text-fg">AI Assisted</span>
              <span className="mt-1 text-xs text-fg-muted">
                Extract requirements grounded from the requisition job description.
              </span>
            </button>

            {/* Manual Mode */}
            <button
              type="button"
              aria-label="Mode: Manual Draft"
              onClick={() => {
                setMode('manual');
                setError(null);
              }}
              className={`relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors ${
                mode === 'manual'
                  ? 'border-accent bg-accent/5 ring-2 ring-accent/20'
                  : 'border-border bg-surface hover:border-border-strong hover:bg-surface-muted/50'
              }`}
            >
              <div className="mb-2 flex size-8 items-center justify-center rounded-md bg-surface-muted text-fg">
                <Icon icon={FilePlus} size="sm" />
              </div>
              <span className="font-semibold text-sm text-fg">Manual Draft</span>
              <span className="mt-1 text-xs text-fg-muted">
                Start with an empty draft and define custom scoring criteria.
              </span>
            </button>

            {/* Clone Mode */}
            <button
              type="button"
              aria-label="Mode: Clone Version"
              disabled={existingScorecards.length === 0}
              onClick={() => {
                if (existingScorecards.length > 0) {
                  setMode('clone');
                  setError(null);
                }
              }}
              className={`relative flex flex-col items-start rounded-lg border p-4 text-left transition-colors ${
                existingScorecards.length === 0
                  ? 'cursor-not-allowed border-border/50 bg-surface-muted/30 opacity-50'
                  : mode === 'clone'
                    ? 'border-accent bg-accent/5 ring-2 ring-accent/20'
                    : 'border-border bg-surface hover:border-border-strong hover:bg-surface-muted/50'
              }`}
            >
              <div className="mb-2 flex size-8 items-center justify-center rounded-md bg-surface-muted text-fg">
                <Icon icon={Copy} size="sm" />
              </div>
              <span className="font-semibold text-sm text-fg">Clone Version</span>
              <span className="mt-1 text-xs text-fg-muted">
                {existingScorecards.length > 0
                  ? 'Fork criteria and weights from a previous version.'
                  : 'No previous versions available to clone.'}
              </span>
            </button>
          </div>
        </div>

        {/* Mode-specific configurations */}
        {mode === 'ai' ? (
          <div className="rounded-lg border border-border bg-surface-muted/40 p-4 text-xs text-fg-muted">
            <div className="flex items-center gap-2 font-medium text-fg">
              <Icon icon={Bot} size="xs" className="text-accent" />
              <span>Human-in-the-loop AI Extraction</span>
            </div>
            <p className="mt-1.5 leading-relaxed">
              TalentLens will analyze the saved job description to extract verifiable skills,
              experience brackets, and requirements. The generated output will be saved as an
              editable <strong>DRAFT</strong>. Criteria are never automatically approved without
              recruiter review.
            </p>
          </div>
        ) : null}

        {mode === 'manual' ? (
          <div className="rounded-lg border border-border bg-surface-muted/40 p-4 text-xs text-fg-muted">
            <p className="leading-relaxed">
              Creates a blank scorecard draft. You will manually add criteria, assign weight
              percentages (must sum to 100%), and review evidence before human approval.
            </p>
          </div>
        ) : null}

        {mode === 'clone' ? (
          <div className="space-y-3">
            <Field
              label="Source Scorecard Version"
              hint="Select the version whose criteria and weights you want to duplicate."
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={cloneVersionId}
                  onChange={(e) => setCloneVersionId(e.target.value)}
                >
                  {existingScorecards.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      Version {sc.version} ({sc.status}) — {sc.criteria.length} criteria
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <p className="text-xs text-fg-subtle">
              Cloning copies criteria while re-evaluating evidence quotes against the current job
              description and resetting verification status for recruiter verification.
            </p>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleCreate()} disabled={loading}>
            {loading ? (
              mode === 'ai' ? (
                'Extracting criteria...'
              ) : (
                'Creating draft...'
              )
            ) : mode === 'ai' ? (
              <>
                <Icon icon={Sparkles} size="sm" />
                Generate draft criteria
              </>
            ) : mode === 'clone' ? (
              <>
                <Icon icon={Copy} size="sm" />
                Clone version
              </>
            ) : (
              <>
                <Icon icon={FilePlus} size="sm" />
                Create empty draft
              </>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
