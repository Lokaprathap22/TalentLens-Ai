import { Briefcase, ExternalLink, FileSearch, Pencil, Plus, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Pagination,
  SearchField,
  Skeleton,
  StatusBadge,
  Tab,
  TabList,
  Tabs,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { RequisitionFormDialog } from './RequisitionFormDialog.js';
import { RequisitionStatusDialog } from './RequisitionStatusDialog.js';
import { isRequisitionEditable } from './requisition.api.js';
import type {
  CreateRequisitionInput,
  RequisitionFilterStatus,
  RequisitionRecord,
  RequisitionSummaryCounts,
  TransitionTargetStatus,
} from './types.js';
import { filterRequisitions, useRequisitions } from './use-requisitions.js';

export const REQUISITIONS_PAGE_SIZE = 10;

function RequisitionSummaryStrip({
  summary,
}: {
  summary: RequisitionSummaryCounts;
}): React.JSX.Element {
  return (
    <Card as="section" labelledBy="requisitions-summary-heading">
      <h2 id="requisitions-summary-heading" className="sr-only">
        Requisitions summary
      </h2>
      <dl className="grid grid-cols-2 divide-y divide-border sm:grid-cols-5 sm:divide-y-0 sm:divide-x">
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="text-xs font-medium text-fg-subtle">Total</dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.total}
          </dd>
        </div>
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fg-disabled" />
            <span>Draft</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.draft}
          </dd>
        </div>
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success-solid" />
            <span>Open</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">{summary.open}</dd>
        </div>
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning-solid" />
            <span>Paused</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.paused}
          </dd>
        </div>
        <div className="col-span-2 px-4 py-3 sm:col-span-1 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent-solid" />
            <span>Closed / Filled</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.closedOrFilled}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function RequisitionsLoadingSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading requisitions directory" className="space-y-6">
      <Card>
        <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-5 sm:divide-y-0 sm:divide-x">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="space-y-2 px-4 py-3.5 sm:px-5">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-6 w-8" />
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="space-y-4 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-8 w-full sm:w-64" />
          </div>
          <Skeleton className="h-9 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </Card>
    </LoadingRegion>
  );
}

export function RequisitionsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const {
    state,
    requisitions,
    summary,
    reload,
    createRequisitionRecord,
    updateRequisitionDraft,
    transitionStatus,
  } = useRequisitions();

  const [statusFilter, setStatusFilter] = useState<RequisitionFilterStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingRequisition, setEditingRequisition] = useState<RequisitionRecord | null>(null);
  const [statusRequisition, setStatusRequisition] = useState<RequisitionRecord | null>(null);

  const filteredRequisitions = useMemo(
    () => filterRequisitions(requisitions, statusFilter, searchQuery),
    [requisitions, statusFilter, searchQuery],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRequisitions.length / REQUISITIONS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const paginatedRequisitions = useMemo(() => {
    const startIndex = (safePage - 1) * REQUISITIONS_PAGE_SIZE;
    return filteredRequisitions.slice(startIndex, startIndex + REQUISITIONS_PAGE_SIZE);
  }, [filteredRequisitions, safePage]);

  const hasActiveFilters = statusFilter !== 'ALL' || searchQuery.trim().length > 0;

  const handleClearFilters = (): void => {
    setStatusFilter('ALL');
    setSearchQuery('');
    setPage(1);
  };

  const handleCreateSubmit = async (input: CreateRequisitionInput): Promise<void> => {
    await createRequisitionRecord(input);
  };

  const handleEditSubmit = async (input: {
    clientId: string;
    title: string;
    jdText: string;
  }): Promise<void> => {
    if (!editingRequisition) {
      return;
    }
    await updateRequisitionDraft(editingRequisition.id, input);
  };

  const handleStatusConfirm = async (
    targetRequisition: RequisitionRecord,
    nextStatus: TransitionTargetStatus,
  ): Promise<void> => {
    await transitionStatus(targetRequisition.id, nextStatus);
  };

  const columns: Column<RequisitionRecord>[] = useMemo(
    () => [
      {
        id: 'title',
        header: 'Job title',
        cell: (item: RequisitionRecord) => (
          <div className="flex flex-col">
            <Link
              to={`/requisitions/${item.id}`}
              className="font-medium text-fg hover:text-accent hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
            >
              {item.title}
            </Link>
          </div>
        ),
      },
      {
        id: 'client',
        header: 'Client organization',
        cell: (item: RequisitionRecord) => <span className="text-fg-muted">{item.clientName}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        cell: (item: RequisitionRecord) => <StatusBadge kind="requisition" status={item.status} />,
      },
      {
        id: 'createdAt',
        header: 'Created',
        cell: (item: RequisitionRecord) => (
          <span className="tabular text-xs text-fg-subtle">{formatShortDate(item.createdAt)}</span>
        ),
      },
      {
        id: 'updatedAt',
        header: 'Updated',
        cell: (item: RequisitionRecord) => (
          <span className="tabular text-xs text-fg-subtle">{formatShortDate(item.updatedAt)}</span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        align: 'right',
        cell: (item: RequisitionRecord) => {
          const isEditable = isRequisitionEditable(item.status);
          const isTerminal = item.status === 'CLOSED' || item.status === 'FILLED';

          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(`/requisitions/${item.id}`)}
                aria-label={`View details for ${item.title}`}
              >
                <Icon icon={ExternalLink} size="xs" />
                <span className="hidden sm:inline">Details</span>
              </Button>

              {isEditable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingRequisition(item)}
                  aria-label={`Edit draft for ${item.title}`}
                >
                  <Icon icon={Pencil} size="xs" />
                  <span className="hidden sm:inline">Edit</span>
                </Button>
              ) : null}

              {!isTerminal ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setStatusRequisition(item)}
                  aria-label={`Change status for ${item.title}`}
                >
                  <Icon icon={SlidersHorizontal} size="xs" />
                  <span className="hidden sm:inline">Status</span>
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [navigate],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Requisitions"
        description="Manage job requisitions, job descriptions, and hiring criteria for AI candidate screening."
        breadcrumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Requisitions' }]}
        actions={
          <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
            <Icon icon={Plus} size="sm" />
            Create requisition
          </Button>
        }
      />

      {state.status === 'loading' ? (
        <RequisitionsLoadingSkeleton />
      ) : state.status === 'error' ? (
        <Card>
          <ErrorState
            title="Unable to load requisitions"
            description={state.message}
            onRetry={() => void reload()}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <RequisitionSummaryStrip summary={summary} />

          <Card labelledBy="requisitions-directory-heading" className="overflow-hidden">
            <CardHeader
              title="Requisitions directory"
              titleId="requisitions-directory-heading"
              description="Manage open positions, draft requirements, and scorecard readiness."
              actions={
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                  <div className="w-full sm:w-64">
                    <SearchField
                      label="Search requisitions by title or client"
                      placeholder="Search title or client…"
                      value={searchQuery}
                      onValueChange={(nextVal) => {
                        setSearchQuery(nextVal);
                        setPage(1);
                      }}
                    />
                  </div>
                  {hasActiveFilters ? (
                    <Button variant="ghost" size="sm" onClick={handleClearFilters}>
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              }
            />

            <Tabs
              value={statusFilter}
              defaultValue="ALL"
              onValueChange={(nextTab) => {
                setStatusFilter(nextTab as RequisitionFilterStatus);
                setPage(1);
              }}
            >
              <div className="px-5">
                <TabList label="Filter requisitions by status">
                  <Tab value="ALL" count={summary.total}>
                    All
                  </Tab>
                  <Tab value="DRAFT" count={summary.draft}>
                    Draft
                  </Tab>
                  <Tab value="OPEN" count={summary.open}>
                    Open
                  </Tab>
                  <Tab value="PAUSED" count={summary.paused}>
                    Paused
                  </Tab>
                  <Tab value="CLOSED_OR_FILLED" count={summary.closedOrFilled}>
                    Closed / Filled
                  </Tab>
                </TabList>
              </div>

              <DataTable<RequisitionRecord>
                caption="Organization requisitions"
                columns={columns}
                rows={paginatedRequisitions}
                getRowKey={(item) => item.id}
                empty={
                  requisitions.length === 0 ? (
                    <EmptyState
                      icon={Briefcase}
                      title="No requisitions yet"
                      description="Create your first job requisition to start intake, generate scorecards, and screen candidate resumes."
                      action={
                        <Button variant="primary" icon={Plus} onClick={() => setIsCreateOpen(true)}>
                          Create requisition
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={FileSearch}
                      title="No matching requisitions"
                      description={
                        searchQuery.trim()
                          ? `No requisitions match "${searchQuery.trim()}" in the selected status filter.`
                          : 'No requisitions found matching the selected status filter.'
                      }
                      action={
                        <Button variant="secondary" size="sm" onClick={handleClearFilters}>
                          Clear filters
                        </Button>
                      }
                    />
                  )
                }
              />

              {filteredRequisitions.length > 0 ? (
                <Pagination
                  page={safePage}
                  pageSize={REQUISITIONS_PAGE_SIZE}
                  total={filteredRequisitions.length}
                  onPageChange={setPage}
                  noun="requisitions"
                />
              ) : null}
            </Tabs>
          </Card>
        </div>
      )}

      {/* Create Dialog */}
      <RequisitionFormDialog
        open={isCreateOpen}
        mode="create"
        onClose={() => setIsCreateOpen(false)}
        onSubmit={handleCreateSubmit}
      />

      {/* Edit Dialog */}
      <RequisitionFormDialog
        open={Boolean(editingRequisition)}
        mode="edit"
        requisition={editingRequisition}
        onClose={() => setEditingRequisition(null)}
        onSubmit={handleEditSubmit}
      />

      {/* Status Transition Dialog */}
      <RequisitionStatusDialog
        open={Boolean(statusRequisition)}
        requisition={statusRequisition}
        onClose={() => setStatusRequisition(null)}
        onConfirm={handleStatusConfirm}
      />
    </div>
  );
}
