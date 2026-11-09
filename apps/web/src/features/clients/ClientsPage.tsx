import {
  Building2,
  CheckCircle2,
  FileSearch,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Users,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

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
  buttonStyles,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { ClientFormDialog } from './ClientFormDialog.js';
import { ClientStatusDialog } from './ClientStatusDialog.js';
import type {
  ClientFilterStatus,
  ClientRecord,
  ClientStatus,
  ClientSummaryCounts,
} from './types.js';
import { filterClients, useClients } from './use-clients.js';

export const CLIENTS_PAGE_SIZE = 10;

function ClientSummaryStrip({ summary }: { summary: ClientSummaryCounts }): React.JSX.Element {
  return (
    <Card as="section" labelledBy="clients-summary-heading">
      <h2 id="clients-summary-heading" className="sr-only">
        Client directory summary
      </h2>
      <dl className="grid grid-cols-3 divide-x divide-border">
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="text-xs font-medium text-fg-subtle">Total clients</dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.total}
          </dd>
        </div>
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success-solid" />
            <span>Active clients</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.active}
          </dd>
        </div>
        <div className="px-4 py-3 sm:px-5 sm:py-3.5">
          <dt className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fg-disabled" />
            <span>Inactive clients</span>
          </dt>
          <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
            {summary.inactive}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function ClientsLoadingSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading client directory" className="space-y-6">
      <Card>
        <div className="grid grid-cols-3 divide-x divide-border">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2 px-4 py-3.5 sm:px-5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-6 w-10" />
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
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    </LoadingRegion>
  );
}

export interface ClientsPageProps {
  pageSize?: number;
}

export function ClientsPage({
  pageSize = CLIENTS_PAGE_SIZE,
}: ClientsPageProps = {}): React.JSX.Element {
  const {
    state,
    clients,
    summary,
    reload,
    createClientRecord,
    updateClientName,
    updateClientStatus,
  } = useClients();

  const [statusFilter, setStatusFilter] = useState<ClientFilterStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientRecord | null>(null);
  const [statusTargetClient, setStatusTargetClient] = useState<ClientRecord | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  const hasActiveFilters = statusFilter !== 'ALL' || searchQuery.trim().length > 0;

  const filteredClients = useMemo(
    () => filterClients(clients, statusFilter, searchQuery),
    [clients, statusFilter, searchQuery],
  );

  const pageCount = Math.max(1, Math.ceil(filteredClients.length / pageSize));
  const safePage = Math.min(page, pageCount);

  const pagedClients = useMemo(
    () => filteredClients.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredClients, safePage, pageSize],
  );

  const clearFilters = (): void => {
    setStatusFilter('ALL');
    setSearchQuery('');
    setPage(1);
  };

  const handleCreateSubmit = async (name: string): Promise<void> => {
    const created = await createClientRecord(name);
    setFeedbackBanner(`Added client "${created.name}".`);
  };

  const handleEditSubmit = async (name: string): Promise<void> => {
    if (!editingClient) {
      return;
    }
    const updated = await updateClientName(editingClient.id, name);
    setFeedbackBanner(`Updated client name to "${updated.name}".`);
  };

  const handleStatusConfirm = async (
    targetClient: ClientRecord,
    nextStatus: ClientStatus,
  ): Promise<void> => {
    const updated = await updateClientStatus(targetClient.id, nextStatus);
    setFeedbackBanner(
      updated.status === 'ACTIVE'
        ? `Reactivated "${updated.name}". This client is selectable for new requisitions.`
        : `Deactivated "${updated.name}". This client can no longer be selected for new requisitions.`,
    );
  };

  const columns: Column<ClientRecord>[] = [
    {
      id: 'client',
      header: 'Client',
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="hidden size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-muted text-fg-subtle sm:flex"
          >
            <Icon icon={Building2} size="sm" />
          </span>
          <div className="min-w-0">
            <Link
              to={`/clients/${row.id}`}
              className="truncate font-semibold text-fg hover:text-accent focus:outline-none focus:underline"
            >
              {row.name}
            </Link>
            <p className="mt-0.5 tabular text-2xs text-fg-subtle sm:hidden">
              Updated {formatShortDate(row.updatedAt)}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge kind="client" status={row.status} />,
    },
    {
      id: 'created',
      header: 'Created',
      showFrom: 'md',
      cell: (row) => (
        <time dateTime={row.createdAt} className="tabular text-xs text-fg-subtle">
          {formatShortDate(row.createdAt)}
        </time>
      ),
    },
    {
      id: 'updated',
      header: 'Last updated',
      showFrom: 'sm',
      cell: (row) => (
        <time dateTime={row.updatedAt} className="tabular text-xs text-fg-subtle">
          {formatShortDate(row.updatedAt)}
        </time>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (row) => {
        const isActive = row.status === 'ACTIVE';
        return (
          <div className="inline-flex items-center justify-end gap-1.5">
            <Link
              to={`/clients/${row.id}`}
              className={buttonStyles('secondary', 'sm')}
              aria-label={`View ${row.name} members`}
            >
              <Icon icon={Users} size="sm" className="mr-1" />
              <span className="hidden sm:inline">Members</span>
            </Link>
            <Button
              variant="secondary"
              size="sm"
              icon={Pencil}
              aria-label={`Edit ${row.name}`}
              onClick={() => setEditingClient(row)}
            >
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={isActive ? PowerOff : Power}
              aria-label={`${isActive ? 'Deactivate' : 'Reactivate'} ${row.name}`}
              onClick={() => setStatusTargetClient(row)}
            >
              <span className="hidden md:inline">{isActive ? 'Deactivate' : 'Reactivate'}</span>
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Clients' }]}
        title="Clients"
        description="Manage client organizations and control which accounts are active for new requisitions."
        actions={
          <Button variant="primary" size="md" icon={Plus} onClick={() => setCreateDialogOpen(true)}>
            Add client
          </Button>
        }
      />

      {feedbackBanner ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-lg border border-success-border bg-success-soft/75 px-4 py-2.5 text-xs text-fg"
        >
          <div className="flex items-center gap-2">
            <Icon icon={CheckCircle2} size="sm" className="shrink-0 text-success" />
            <span className="font-medium">{feedbackBanner}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setFeedbackBanner(null)}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-muted hover:text-fg"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>
      ) : null}

      {state.status === 'loading' ? <ClientsLoadingSkeleton /> : null}

      {state.status === 'error' ? (
        <Card>
          <ErrorState
            title="Unable to load client directory"
            description={state.message}
            onRetry={() => void reload()}
          />
        </Card>
      ) : null}

      {state.status === 'ready' ? (
        <div className="space-y-6">
          <ClientSummaryStrip summary={summary} />

          <Card labelledBy="clients-directory-heading" className="overflow-hidden">
            <CardHeader
              title="Client directory"
              titleId="clients-directory-heading"
              description="Active clients can be assigned when opening new requisitions."
              actions={
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                  <div className="w-full sm:w-64">
                    <SearchField
                      label="Search clients by name"
                      placeholder="Search clients by name…"
                      value={searchQuery}
                      onValueChange={(nextValue) => {
                        setSearchQuery(nextValue);
                        setPage(1);
                      }}
                    />
                  </div>
                  {hasActiveFilters ? (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
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
                setStatusFilter(nextTab as ClientFilterStatus);
                setPage(1);
              }}
            >
              <div className="px-5">
                <TabList label="Filter clients by status">
                  <Tab value="ALL" count={summary.total}>
                    All
                  </Tab>
                  <Tab value="ACTIVE" count={summary.active}>
                    Active
                  </Tab>
                  <Tab value="INACTIVE" count={summary.inactive}>
                    Inactive
                  </Tab>
                </TabList>
              </div>

              <DataTable
                caption="Organization clients"
                columns={columns}
                rows={pagedClients}
                getRowKey={(row) => row.id}
                empty={
                  clients.length === 0 ? (
                    <EmptyState
                      icon={Building2}
                      title="No clients yet"
                      description="Add your first client organization to start creating requisitions and scorecards."
                      action={
                        <Button
                          variant="primary"
                          size="sm"
                          icon={Plus}
                          onClick={() => setCreateDialogOpen(true)}
                        >
                          Add client
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={FileSearch}
                      title="No matching clients"
                      description={
                        searchQuery.trim()
                          ? `No clients match "${searchQuery.trim()}" in the selected status filter.`
                          : statusFilter === 'ACTIVE'
                            ? 'There are currently no active clients in your organization.'
                            : 'There are currently no inactive clients in your organization.'
                      }
                      action={
                        <Button variant="secondary" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      }
                    />
                  )
                }
              />

              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={filteredClients.length}
                onPageChange={setPage}
                noun="clients"
              />
            </Tabs>
          </Card>
        </div>
      ) : null}

      <ClientFormDialog
        open={createDialogOpen}
        mode="create"
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={handleCreateSubmit}
      />

      <ClientFormDialog
        open={editingClient !== null}
        mode="edit"
        client={editingClient}
        onClose={() => setEditingClient(null)}
        onSubmit={handleEditSubmit}
      />

      <ClientStatusDialog
        open={statusTargetClient !== null}
        client={statusTargetClient}
        onClose={() => setStatusTargetClient(null)}
        onConfirm={handleStatusConfirm}
      />
    </div>
  );
}
