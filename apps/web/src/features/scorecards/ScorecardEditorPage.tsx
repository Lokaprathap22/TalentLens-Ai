import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCheck,
  Lock,
  Pencil,
  Plus,
  Power,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Skeleton,
  StatusBadge,
} from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { getRequisition } from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import { CriterionEvidencePanel } from './CriterionEvidencePanel.js';
import { CriterionFormDialog } from './CriterionFormDialog.js';
import { ScorecardApprovalDialog } from './ScorecardApprovalDialog.js';
import { ScorecardApprovalReadiness } from './ScorecardApprovalReadiness.js';
import { ScorecardCreationDialog } from './ScorecardCreationDialog.js';
import type { ScorecardCriterionEvidence, ScorecardCriterionRecord } from './types.js';
import { useScorecardDetail } from './use-scorecard-detail.js';

export function ScorecardEditorPage(): React.JSX.Element {
  const { requisitionId = '', versionId = '' } = useParams<{
    requisitionId: string;
    versionId: string;
  }>();
  const navigate = useNavigate();

  const [requisition, setRequisition] = useState<RequisitionRecord | null>(null);
  const [reqLoading, setReqLoading] = useState<boolean>(true);
  const [reqError, setReqError] = useState<string | null>(null);

  const [filter, setFilter] = useState<'ALL' | 'MUST_HAVE' | 'PREFERRED' | 'ACTIVE' | 'INACTIVE'>(
    'ALL',
  );
  const [showJd, setShowJd] = useState<boolean>(false);

  const [isApproveOpen, setIsApproveOpen] = useState<boolean>(false);
  const [isAddOpen, setIsAddOpen] = useState<boolean>(false);
  const [editingCriterion, setEditingCriterion] = useState<ScorecardCriterionRecord | null>(null);
  const [isCloneOpen, setIsCloneOpen] = useState<boolean>(false);

  const {
    scorecard,
    loading: scorecardLoading,
    error: scorecardError,
    isSaving,
    isApproving,
    saveError,
    approvalError,
    dirty,
    isEditable,
    readiness,
    reload,
    updateCriterion,
    addCriterion,
    toggleCriterionActive,
    verifyCriterionEvidence,
    saveDraft,
    approveDraft,
  } = useScorecardDetail(requisitionId, versionId);

  useEffect(() => {
    let cancelled = false;
    async function loadReq() {
      if (!requisitionId) return;
      setReqLoading(true);
      setReqError(null);
      try {
        const data = await getRequisition(requisitionId);
        if (!cancelled) setRequisition(data);
      } catch {
        if (!cancelled) setReqError('Failed to load requisition details.');
      } finally {
        if (!cancelled) setReqLoading(false);
      }
    }
    void loadReq();
    return () => {
      cancelled = true;
    };
  }, [requisitionId]);

  const filteredCriteria = useMemo(() => {
    if (!scorecard) return [];
    switch (filter) {
      case 'MUST_HAVE':
        return scorecard.criteria.filter((c) => c.requirementType === 'MUST_HAVE');
      case 'PREFERRED':
        return scorecard.criteria.filter((c) => c.requirementType === 'PREFERRED');
      case 'ACTIVE':
        return scorecard.criteria.filter((c) => c.active);
      case 'INACTIVE':
        return scorecard.criteria.filter((c) => !c.active);
      case 'ALL':
      default:
        return scorecard.criteria;
    }
  }, [filter, scorecard]);

  const initialLoading = reqLoading || scorecardLoading;
  const initialError = reqError || scorecardError;

  return (
    <div className="space-y-6">
      <PageHeader
        title={scorecard ? `Scorecard Version ${scorecard.version}` : 'Scorecard Editor'}
        description={
          requisition
            ? `Screening requirements and candidate assessment rubric for ${requisition.title} (${requisition.clientName}).`
            : 'Candidate screening requirements and assessment rubric.'
        }
        breadcrumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Requisitions', to: '/requisitions' },
          {
            label: requisition?.title ?? 'Requisition',
            to: `/requisitions/${requisitionId}`,
          },
          {
            label: 'Scorecards',
            to: `/requisitions/${requisitionId}/scorecards`,
          },
          {
            label: scorecard ? `Version ${scorecard.version}` : 'Version',
          },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => navigate(`/requisitions/${requisitionId}/scorecards`)}
            >
              <Icon icon={ArrowLeft} size="sm" />
              All versions
            </Button>

            {isEditable ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setIsAddOpen(true)}
                  disabled={isSaving || isApproving}
                >
                  <Icon icon={Plus} size="sm" />
                  Add criterion
                </Button>

                <Button
                  variant="secondary"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || isSaving || isApproving}
                >
                  <Icon icon={Save} size="sm" />
                  {isSaving ? 'Saving...' : 'Save draft'}
                </Button>

                <Button
                  variant="primary"
                  onClick={() => setIsApproveOpen(true)}
                  disabled={!readiness?.isReady || isSaving || isApproving}
                >
                  <Icon icon={ShieldCheck} size="sm" />
                  Approve scorecard
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => setIsCloneOpen(true)}>
                <Icon icon={Copy} size="sm" />
                Clone to new draft
              </Button>
            )}
          </div>
        }
      />

      {initialLoading ? (
        <Card>
          <CardBody>
            <LoadingRegion label="Loading scorecard details...">
              <div className="space-y-3 p-4">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            </LoadingRegion>
          </CardBody>
        </Card>
      ) : initialError ? (
        <Card>
          <ErrorState
            title="Failed to load scorecard"
            description={initialError}
            onRetry={() => void reload()}
          />
        </Card>
      ) : scorecard ? (
        <div className="space-y-6">
          {/* Status and Immutability Banner */}
          {!isEditable ? (
            <div
              className={`rounded-lg border p-4 flex items-start gap-3 text-xs leading-relaxed ${
                scorecard.status === 'APPROVED'
                  ? 'border-success/30 bg-success/5 text-fg'
                  : 'border-border bg-surface-muted/60 text-fg-muted'
              }`}
            >
              <Icon
                icon={scorecard.status === 'APPROVED' ? CheckCircle2 : Lock}
                size="sm"
                className={
                  scorecard.status === 'APPROVED'
                    ? 'text-success shrink-0 mt-0.5'
                    : 'text-fg-subtle shrink-0 mt-0.5'
                }
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-fg">
                  {scorecard.status === 'APPROVED'
                    ? `Version ${scorecard.version} is APPROVED and Active`
                    : `Version ${scorecard.version} is ARCHIVED`}
                </p>
                <p>
                  {scorecard.status === 'APPROVED'
                    ? `This scorecard is the active candidate screening standard approved on ${scorecard.approvedAt ? formatShortDate(scorecard.approvedAt) : 'record'}. Approved versions are strictly immutable. To modify criteria, clone this version into a new draft.`
                    : 'This version has been superseded by a newer approved scorecard and is preserved as an immutable audit record.'}
                </p>
              </div>
            </div>
          ) : dirty ? (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 flex items-center justify-between text-xs text-fg">
              <div className="flex items-center gap-2">
                <Icon icon={AlertCircle} size="xs" className="text-accent" />
                <span>You have unsaved changes in this draft.</span>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void saveDraft()}
                disabled={isSaving}
              >
                <Icon icon={Save} size="xs" />
                {isSaving ? 'Saving...' : 'Save draft'}
              </Button>
            </div>
          ) : null}

          {/* Feedback alerts */}
          {saveError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger flex items-center gap-2"
            >
              <Icon icon={AlertTriangle} size="xs" />
              <span>{saveError}</span>
            </div>
          ) : null}

          {approvalError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger flex items-center gap-2"
            >
              <Icon icon={AlertTriangle} size="xs" />
              <span>{approvalError}</span>
            </div>
          ) : null}

          {/* Editor Grid: Criteria on Left, Readiness & Context on Right */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Criteria Column */}
            <div className="space-y-5 lg:col-span-2">
              <Card>
                <CardHeader
                  title="Screening Criteria & Evidence"
                  description="Requirements evaluated during AI resume intake and candidate matching."
                  actions={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-fg-subtle">
                        {scorecard.criteria.filter((c) => c.active).length} of{' '}
                        {scorecard.criteria.length} active
                      </span>
                    </div>
                  }
                />
                <CardBody className="p-4 space-y-4">
                  {/* Category Filter Pills */}
                  <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-border text-xs">
                    {(
                      [
                        ['ALL', `All (${scorecard.criteria.length})`],
                        [
                          'MUST_HAVE',
                          `Must-Have (${scorecard.criteria.filter((c) => c.requirementType === 'MUST_HAVE').length})`,
                        ],
                        [
                          'PREFERRED',
                          `Preferred (${scorecard.criteria.filter((c) => c.requirementType === 'PREFERRED').length})`,
                        ],
                        ['ACTIVE', `Active (${scorecard.criteria.filter((c) => c.active).length})`],
                        [
                          'INACTIVE',
                          `Inactive (${scorecard.criteria.filter((c) => !c.active).length})`,
                        ],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                          filter === key
                            ? 'bg-accent text-accent-fg'
                            : 'bg-surface-muted text-fg-muted hover:bg-surface-muted/80 hover:text-fg'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Criteria List */}
                  {filteredCriteria.length === 0 ? (
                    <EmptyState
                      icon={FileCheck}
                      title="No criteria in this view"
                      description={
                        scorecard.criteria.length === 0
                          ? 'This draft currently has no criteria. Add your first requirement or extract criteria from the job description.'
                          : 'No criteria match the selected filter.'
                      }
                      action={
                        isEditable ? (
                          <Button variant="primary" onClick={() => setIsAddOpen(true)}>
                            <Icon icon={Plus} size="sm" />
                            Add requirement
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className="space-y-4">
                      {filteredCriteria.map((criterion) => {
                        return (
                          <div
                            key={criterion.id}
                            className={`rounded-lg border p-4 transition-colors space-y-3 ${
                              criterion.active
                                ? 'border-border bg-surface'
                                : 'border-border/50 bg-surface-muted/40 opacity-70'
                            }`}
                          >
                            {/* Criterion Header */}
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h4 className="font-semibold text-sm text-fg">
                                    {criterion.label}
                                  </h4>
                                  <Badge
                                    tone={
                                      criterion.requirementType === 'MUST_HAVE'
                                        ? 'accent'
                                        : 'neutral'
                                    }
                                  >
                                    {criterion.requirementType === 'MUST_HAVE'
                                      ? 'Must-Have'
                                      : 'Preferred'}
                                  </Badge>
                                  <Badge tone="neutral">{criterion.category}</Badge>
                                  {!criterion.active ? <Badge tone="danger">Inactive</Badge> : null}
                                </div>
                                {criterion.description ? (
                                  <p className="text-xs text-fg-muted leading-relaxed">
                                    {criterion.description}
                                  </p>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className="rounded-md border border-border bg-surface-muted px-2 py-0.5 text-xs font-semibold tabular text-fg">
                                  {criterion.weight}%
                                </span>
                              </div>
                            </div>

                            {/* Evidence Review Panel */}
                            <CriterionEvidencePanel
                              evidence={criterion.evidence}
                              isEditable={isEditable && criterion.active}
                              onVerify={() => verifyCriterionEvidence(criterion.id)}
                              onAttachQuote={() => setEditingCriterion(criterion)}
                            />

                            {/* Criterion Action Toolbar (if draft) */}
                            {isEditable ? (
                              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40 text-xs">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditingCriterion(criterion)}
                                >
                                  <Icon icon={Pencil} size="xs" />
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleCriterionActive(criterion.id)}
                                  className={
                                    criterion.active
                                      ? 'text-danger hover:text-danger'
                                      : 'text-success hover:text-success'
                                  }
                                >
                                  <Icon icon={Power} size="xs" />
                                  {criterion.active ? 'Deactivate' : 'Reactivate'}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>

            {/* Sidebar Column: Readiness & Job Description Preview */}
            <div className="space-y-6">
              {/* Approval Readiness Checklist */}
              {readiness ? (
                <ScorecardApprovalReadiness
                  readiness={readiness}
                  isEditable={isEditable}
                  onOpenApproveDialog={() => setIsApproveOpen(true)}
                  isApproving={isApproving}
                  version={scorecard.version}
                />
              ) : null}

              {/* Job Description Reference Drawer */}
              {requisition ? (
                <Card>
                  <CardHeader
                    title="Source Job Description"
                    description="Reference text used for grounding quotes and evidence."
                    actions={
                      <Button variant="ghost" size="sm" onClick={() => setShowJd((prev) => !prev)}>
                        <Icon icon={showJd ? ChevronUp : ChevronDown} size="xs" />
                        {showJd ? 'Hide' : 'Show JD'}
                      </Button>
                    }
                  />
                  {showJd ? (
                    <CardBody className="p-3">
                      <div className="max-h-[350px] overflow-y-auto rounded-md border border-border bg-surface-muted/30 p-3 font-mono text-xs leading-relaxed text-fg select-text">
                        <pre className="font-sans whitespace-pre-wrap">{requisition.jdText}</pre>
                      </div>
                    </CardBody>
                  ) : null}
                </Card>
              ) : null}

              {/* Version Metadata Audit Card */}
              <Card>
                <CardHeader title="Version Audit Info" />
                <CardBody className="space-y-2.5 text-xs text-fg-muted">
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Scorecard ID</span>
                    <span
                      className="font-mono text-2xs truncate max-w-[160px]"
                      title={scorecard.id}
                    >
                      {scorecard.id}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Version Number</span>
                    <span className="font-semibold text-fg">Version {scorecard.version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Status</span>
                    <StatusBadge kind="scorecard" status={scorecard.status} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Created</span>
                    <span className="tabular">{formatShortDate(scorecard.createdAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-fg-subtle">Last Updated</span>
                    <span className="tabular">{formatShortDate(scorecard.updatedAt)}</span>
                  </div>
                  {scorecard.approvedAt ? (
                    <div className="flex justify-between">
                      <span className="text-fg-subtle">Approved At</span>
                      <span className="tabular text-success font-medium">
                        {formatShortDate(scorecard.approvedAt)}
                      </span>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      {/* Add Criterion Modal */}
      <CriterionFormDialog
        open={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        mode="create"
        jdText={requisition?.jdText}
        onSubmit={(data) => {
          addCriterion(data);
        }}
      />

      {/* Edit Criterion Modal */}
      {editingCriterion ? (
        <CriterionFormDialog
          open={Boolean(editingCriterion)}
          onClose={() => setEditingCriterion(null)}
          mode="edit"
          initialCriterion={editingCriterion}
          jdText={requisition?.jdText}
          onSubmit={(data) => {
            const oldQuote = (editingCriterion.evidence?.sourceQuote ?? '').trim();
            const newQuote = data.sourceQuote?.trim() ?? '';
            const isQuoteChanged = newQuote !== oldQuote;

            const isMeaningChanged =
              data.label.trim() !== editingCriterion.label.trim() ||
              (data.description?.trim() ?? '') !== (editingCriterion.description?.trim() ?? '') ||
              data.category !== editingCriterion.category;

            let nextEvidence: ScorecardCriterionEvidence | null = editingCriterion.evidence;

            if (newQuote.length === 0) {
              // Quote removed or empty -> evidence is null
              nextEvidence = null;
            } else if (isQuoteChanged || isMeaningChanged) {
              // Quote modified or criterion meaning changed materially -> reset verification & offsets
              nextEvidence = {
                sourceQuote: newQuote,
                sourceStart: null,
                sourceEnd: null,
                verificationStatus: 'PENDING_RECRUITER_REVIEW',
              };
            }

            updateCriterion(editingCriterion.id, {
              label: data.label.trim(),
              description: data.description.trim(),
              category: data.category,
              requirementType: data.requirementType,
              weight: data.weight,
              evidence: nextEvidence,
            });
            setEditingCriterion(null);
          }}
        />
      ) : null}

      {/* Scorecard Approval Confirmation Dialog */}
      {scorecard ? (
        <ScorecardApprovalDialog
          open={isApproveOpen}
          onClose={() => setIsApproveOpen(false)}
          version={scorecard.version}
          activeCriteriaCount={scorecard.criteria.filter((c) => c.active).length}
          isApproving={isApproving}
          error={approvalError}
          onConfirm={async () => {
            const approved = await approveDraft();
            if (approved) {
              setIsApproveOpen(false);
            }
          }}
        />
      ) : null}

      {/* Clone Modal */}
      {requisition && scorecard ? (
        <ScorecardCreationDialog
          open={isCloneOpen}
          onClose={() => setIsCloneOpen(false)}
          requisitionId={requisitionId}
          requisitionTitle={requisition.title}
          existingScorecards={[scorecard]}
          onCreated={(created) => {
            setIsCloneOpen(false);
            navigate(`/requisitions/${requisitionId}/scorecards/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
