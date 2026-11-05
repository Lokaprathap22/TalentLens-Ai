import {
  AlertCircle,
  ArrowLeft,
  Briefcase,
  CheckCircle2,
  ClipboardCheck,
  Pencil,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import {
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
import { RequisitionFormDialog } from './RequisitionFormDialog.js';
import { RequisitionStatusDialog } from './RequisitionStatusDialog.js';
import { isRequisitionEditable } from './requisition.api.js';
import type { TransitionTargetStatus } from './types.js';
import { useRequisitionDetail } from './use-requisition-detail.js';

function RequisitionDetailSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading requisition details" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <div className="space-y-4 p-5">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <div className="space-y-3 p-5">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          </Card>
        </div>
      </div>
    </LoadingRegion>
  );
}

export function RequisitionDetailPage(): React.JSX.Element {
  const { requisitionId } = useParams<{ requisitionId: string }>();
  const navigate = useNavigate();

  const { state, requisition, reload, updateDraft, transitionStatus } = useRequisitionDetail(
    requisitionId ?? '',
  );

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);

  if (state.status === 'loading') {
    return <RequisitionDetailSkeleton />;
  }

  if (state.status === 'error') {
    if (state.notFound) {
      return (
        <div className="space-y-6">
          <PageHeader
            title="Requisition not found"
            description="The requested requisition does not exist or has been removed."
            breadcrumbs={[
              { label: 'Dashboard', to: '/dashboard' },
              { label: 'Requisitions', to: '/requisitions' },
              { label: 'Not found' },
            ]}
          />
          <Card>
            <EmptyState
              icon={AlertCircle}
              title="Requisition unavailable"
              description="The requisition you are looking for could not be found in your organization workspace."
              action={
                <Link to="/requisitions">
                  <Button variant="primary">
                    <Icon icon={ArrowLeft} size="sm" />
                    Back to requisitions
                  </Button>
                </Link>
              }
            />
          </Card>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <PageHeader
          title="Requisition details"
          breadcrumbs={[
            { label: 'Dashboard', to: '/dashboard' },
            { label: 'Requisitions', to: '/requisitions' },
            { label: 'Error' },
          ]}
        />
        <Card>
          <ErrorState
            title="Failed to load requisition"
            description={state.message}
            onRetry={() => void reload()}
          />
        </Card>
      </div>
    );
  }

  if (!requisition) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Requisition unavailable"
          breadcrumbs={[
            { label: 'Dashboard', to: '/dashboard' },
            { label: 'Requisitions', to: '/requisitions' },
          ]}
        />
        <Card>
          <EmptyState
            icon={Briefcase}
            title="No requisition data"
            description="No requisition details could be retrieved."
            action={
              <Link to="/requisitions">
                <Button variant="primary">Back to requisitions</Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const isEditable = isRequisitionEditable(requisition.status);
  const isTerminal = requisition.status === 'CLOSED' || requisition.status === 'FILLED';

  const handleEditSubmit = async (input: {
    clientId: string;
    title: string;
    jdText: string;
  }): Promise<void> => {
    await updateDraft(input);
  };

  const handleStatusConfirm = async (
    _record: typeof requisition,
    nextStatus: TransitionTargetStatus,
  ): Promise<void> => {
    await transitionStatus(nextStatus);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={requisition.title}
        description={`Requisition for ${requisition.clientName} • Created ${formatShortDate(requisition.createdAt)}`}
        breadcrumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Requisitions', to: '/requisitions' },
          { label: requisition.title },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('/requisitions')}>
              <Icon icon={ArrowLeft} size="sm" />
              All requisitions
            </Button>

            <Button
              variant="secondary"
              onClick={() => navigate(`/requisitions/${requisition.id}/scorecards`)}
            >
              <Icon icon={ClipboardCheck} size="sm" />
              Scorecards
            </Button>

            {isEditable ? (
              <Button variant="secondary" onClick={() => setIsEditOpen(true)}>
                <Icon icon={Pencil} size="sm" />
                Edit draft
              </Button>
            ) : null}

            {!isTerminal ? (
              <Button variant="primary" onClick={() => setIsStatusOpen(true)}>
                <Icon icon={SlidersHorizontal} size="sm" />
                Change status
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main Content: Job Description */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Job description requirements"
              description="Complete source text used for AI requirement extraction and candidate evaluation."
              actions={
                <span className="tabular text-xs text-fg-subtle">
                  {requisition.jdText.length.toLocaleString()} characters
                </span>
              }
            />
            <CardBody>
              <div className="max-h-[600px] overflow-y-auto rounded-md border border-border bg-surface-muted/30 p-4 font-mono text-sm leading-relaxed text-fg select-text">
                <pre className="font-sans whitespace-pre-wrap">{requisition.jdText}</pre>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Sidebar: Details & Workflow Readiness */}
        <div className="space-y-6">
          {/* Workflow Readiness Card */}
          <Card>
            <CardHeader
              title="Screening workflow readiness"
              description="Hiring pipeline progression and scorecard alignment."
            />
            <CardBody className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-fg-subtle">Lifecycle state</span>
                <StatusBadge kind="requisition" status={requisition.status} />
              </div>

              {requisition.status === 'DRAFT' ? (
                <div className="rounded-md border border-accent/20 bg-accent/5 p-3 text-xs text-fg">
                  <div className="flex items-center gap-1.5 font-semibold text-accent">
                    <Icon icon={Sparkles} size="xs" />
                    <span>Next milestone: Scorecard approval</span>
                  </div>
                  <p className="mt-1 text-fg-muted">
                    Before this requisition can be opened, an approved scorecard must be generated
                    from the job description. Opening without an approved scorecard is blocked by
                    the server.
                  </p>
                  <div className="mt-3 flex flex-col gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => navigate(`/requisitions/${requisition.id}/scorecards`)}
                      className="w-full"
                    >
                      <Icon icon={ClipboardCheck} size="xs" />
                      Manage scorecards
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setIsStatusOpen(true)}
                      className="w-full"
                    >
                      Attempt transition to OPEN
                    </Button>
                  </div>
                </div>
              ) : requisition.status === 'OPEN' ? (
                <div className="rounded-md border border-success-subtle bg-success-subtle/20 p-3 text-xs text-fg">
                  <div className="flex items-center gap-1.5 font-semibold text-success">
                    <Icon icon={CheckCircle2} size="xs" />
                    <span>Active screening in progress</span>
                  </div>
                  <p className="mt-1 text-fg-muted">
                    This requisition is active and accepting candidate submissions for review.
                  </p>
                </div>
              ) : requisition.status === 'PAUSED' ? (
                <div className="rounded-md border border-warning-subtle bg-warning-subtle/20 p-3 text-xs text-fg">
                  <div className="flex items-center gap-1.5 font-semibold text-warning">
                    <Icon icon={AlertCircle} size="xs" />
                    <span>Screening paused</span>
                  </div>
                  <p className="mt-1 text-fg-muted">
                    Candidate processing is temporarily suspended until this requisition is
                    reopened.
                  </p>
                </div>
              ) : (
                <div className="rounded-md border border-border bg-surface-muted p-3 text-xs text-fg-subtle">
                  <p className="font-semibold text-fg">Terminal state ({requisition.status})</p>
                  <p className="mt-1">
                    This requisition has concluded. No further changes or candidate submissions are
                    permitted.
                  </p>
                </div>
              )}

              {requisition.status !== 'DRAFT' ? (
                <div className="pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/requisitions/${requisition.id}/scorecards`)}
                    className="w-full"
                  >
                    <Icon icon={ClipboardCheck} size="xs" />
                    View scorecard criteria
                  </Button>
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* Requisition Metadata Card */}
          <Card>
            <CardHeader title="Requisition details" />
            <CardBody className="space-y-3.5 text-xs">
              <div className="flex items-start justify-between">
                <span className="text-fg-subtle">Client organization</span>
                <span className="font-medium text-fg text-right">{requisition.clientName}</span>
              </div>
              <div className="flex items-start justify-between">
                <span className="text-fg-subtle">Identifier</span>
                <span className="font-mono text-fg-subtle text-right text-[11px] select-all">
                  {requisition.id}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Created</span>
                <span className="tabular text-fg">{formatShortDate(requisition.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle">Last updated</span>
                <span className="tabular text-fg">{formatShortDate(requisition.updatedAt)}</span>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Edit Dialog */}
      <RequisitionFormDialog
        open={isEditOpen}
        mode="edit"
        requisition={requisition}
        onClose={() => setIsEditOpen(false)}
        onSubmit={handleEditSubmit}
      />

      {/* Status Dialog */}
      <RequisitionStatusDialog
        open={isStatusOpen}
        requisition={requisition}
        onClose={() => setIsStatusOpen(false)}
        onConfirm={handleStatusConfirm}
      />
    </div>
  );
}
