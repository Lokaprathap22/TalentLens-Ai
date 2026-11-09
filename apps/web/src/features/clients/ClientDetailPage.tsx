import {
  AlertCircle,
  CheckCircle2,
  Pencil,
  Power,
  PowerOff,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Skeleton,
  StatusBadge,
  Tab,
  TabList,
  Tabs,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { usePageTitle } from '../../lib/use-page-title.js';
import { getClient, inviteClientMember, listClientMembers, updateClient } from './client.api.js';
import { ClientFormDialog } from './ClientFormDialog.js';
import { ClientStatusDialog } from './ClientStatusDialog.js';
import { InviteMemberDialog } from './InviteMemberDialog.js';
import type {
  ClientMemberRecord,
  ClientRecord,
  ClientStatus,
  InviteClientMemberInput,
} from './types.js';

function ClientDetailSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading client details" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Card>
        <div className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2 p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="space-y-4 p-5">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Card>
    </LoadingRegion>
  );
}

export function ClientDetailPage(): React.JSX.Element {
  const { clientId } = useParams<{ clientId: string }>();

  const [client, setClient] = useState<ClientRecord | null>(null);
  const [members, setMembers] = useState<ClientMemberRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INVITED'>('ALL');
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const versionRef = useRef(0);

  usePageTitle(client ? `${client.name} — Client Access` : 'Client Details');

  const executeFetch = useCallback(
    async (version: number) => {
      if (!clientId) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      try {
        const [clientData, membersData] = await Promise.all([
          getClient(clientId),
          listClientMembers(clientId),
        ]);
        if (!mountedRef.current || versionRef.current !== version) return;
        setClient(clientData);
        setMembers(membersData);
        setError(null);
        setNotFound(false);
      } catch (err: unknown) {
        if (!mountedRef.current || versionRef.current !== version) return;
        const is404 =
          typeof err === 'object' &&
          err !== null &&
          'status' in err &&
          (err as { status?: number }).status === 404;
        if (is404) {
          setNotFound(true);
        } else {
          setError('Unable to load client details and members. Please retry.');
        }
      } finally {
        if (mountedRef.current && versionRef.current === version) {
          setLoading(false);
        }
      }
    },
    [clientId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const currentVersion = ++versionRef.current;
    void executeFetch(currentVersion);

    return () => {
      mountedRef.current = false;
      versionRef.current += 1;
    };
  }, [executeFetch]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    const nextVersion = ++versionRef.current;
    void executeFetch(nextVersion);
  }, [executeFetch]);

  const handleInviteSubmit = async (input: InviteClientMemberInput): Promise<void> => {
    if (!clientId) return;
    const newMember = await inviteClientMember(clientId, input);
    setMembers((prev) => [newMember, ...prev]);
    setFeedbackBanner(
      `Invitation sent to ${newMember.email}. An activation link has been dispatched to their inbox.`,
    );
  };

  const handleEditSubmit = async (name: string): Promise<void> => {
    if (!clientId) return;
    const updated = await updateClient(clientId, { name });
    setClient(updated);
    setFeedbackBanner(`Client updated to "${updated.name}".`);
  };

  const handleStatusConfirm = async (
    targetClient: ClientRecord,
    nextStatus: ClientStatus,
  ): Promise<void> => {
    const updated = await updateClient(targetClient.id, { status: nextStatus });
    setClient(updated);
    setFeedbackBanner(
      updated.status === 'ACTIVE'
        ? `Reactivated "${updated.name}".`
        : `Deactivated "${updated.name}".`,
    );
  };

  const filteredMembers = useMemo(() => {
    if (statusFilter === 'ALL') return members;
    return members.filter((m) => m.userStatus === statusFilter);
  }, [members, statusFilter]);

  const memberCounts = useMemo(() => {
    const active = members.filter((m) => m.userStatus === 'ACTIVE').length;
    const invited = members.filter((m) => m.userStatus === 'INVITED').length;
    return { total: members.length, active, invited };
  }, [members]);

  if (loading) {
    return <ClientDetailSkeleton />;
  }

  if (notFound) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[
            { label: 'Dashboard', to: '/dashboard' },
            { label: 'Clients', to: '/clients' },
            { label: 'Not found' },
          ]}
          title="Client not found"
          description="The requested client organization could not be found or has been removed."
        />
        <Card>
          <EmptyState
            icon={AlertCircle}
            title="Client unavailable"
            description="The client organization you are looking for does not exist in your workspace."
            action={
              <Link to="/clients">
                <Button variant="secondary" size="md">
                  Back to clients
                </Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  if (error || !client) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumbs={[
            { label: 'Dashboard', to: '/dashboard' },
            { label: 'Clients', to: '/clients' },
            { label: 'Error' },
          ]}
          title="Error loading client"
        />
        <Card>
          <ErrorState
            title="Failed to load client details"
            description={error ?? 'An unexpected error occurred.'}
            onRetry={reload}
          />
        </Card>
      </div>
    );
  }

  const columns: Column<ClientMemberRecord>[] = [
    {
      id: 'member',
      header: 'Member',
      cell: (row) => (
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-fg-subtle border border-border"
          >
            <Icon icon={Users} size="sm" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-fg">
              {row.name ? row.name : <span className="text-fg-subtle italic">Unnamed</span>}
            </p>
            <p className="truncate text-2xs text-fg-subtle">{row.email}</p>
          </div>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Portal role',
      cell: () => (
        <Badge tone="accent" dot={false}>
          Client Hiring Manager
        </Badge>
      ),
    },
    {
      id: 'status',
      header: 'Account status',
      cell: (row) => <StatusBadge kind="member" status={row.userStatus} />,
    },
    {
      id: 'created',
      header: 'Added',
      showFrom: 'md',
      cell: (row) => (
        <time dateTime={row.createdAt} className="tabular text-xs text-fg-subtle">
          {formatShortDate(row.createdAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Clients', to: '/clients' },
          { label: client.name },
        ]}
        title={client.name}
        description="Client organization details, settings, and hiring manager portal access."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="md" icon={Pencil} onClick={() => setIsEditOpen(true)}>
              Edit name
            </Button>
            <Button
              variant="ghost"
              size="md"
              icon={client.status === 'ACTIVE' ? PowerOff : Power}
              onClick={() => setIsStatusOpen(true)}
            >
              {client.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={UserPlus}
              onClick={() => setIsInviteOpen(true)}
            >
              Invite member
            </Button>
          </div>
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

      {/* Client Overview Card */}
      <Card as="section" labelledBy="client-overview-heading">
        <h2 id="client-overview-heading" className="sr-only">
          Client Overview
        </h2>
        <dl className="grid grid-cols-2 divide-x divide-y sm:divide-y-0 divide-border sm:grid-cols-4">
          <div className="px-4 py-3 sm:px-5 sm:py-3.5">
            <dt className="text-xs font-medium text-fg-subtle">Client Status</dt>
            <dd className="mt-1">
              <StatusBadge kind="client" status={client.status} />
            </dd>
          </div>
          <div className="px-4 py-3 sm:px-5 sm:py-3.5">
            <dt className="text-xs font-medium text-fg-subtle">Hiring Managers</dt>
            <dd className="mt-1 tabular text-xl font-semibold text-fg sm:text-2xl">
              {memberCounts.total}
            </dd>
          </div>
          <div className="px-4 py-3 sm:px-5 sm:py-3.5">
            <dt className="text-xs font-medium text-fg-subtle">Active Accounts</dt>
            <dd className="mt-1 tabular text-xl font-semibold text-success sm:text-2xl">
              {memberCounts.active}
            </dd>
          </div>
          <div className="px-4 py-3 sm:px-5 sm:py-3.5">
            <dt className="text-xs font-medium text-fg-subtle">Created</dt>
            <dd className="mt-1 tabular text-xs text-fg-subtle">
              {formatShortDate(client.createdAt)}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Members / Client Access Section */}
      <Card labelledBy="client-members-heading" className="overflow-hidden">
        <CardHeader
          title="Members & Client Access"
          titleId="client-members-heading"
          description="Client hiring managers who are authorized to review candidate submissions and schedule interviews in the client portal."
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={UserPlus}
              onClick={() => setIsInviteOpen(true)}
            >
              Invite member
            </Button>
          }
        />

        <Tabs
          value={statusFilter}
          defaultValue="ALL"
          onValueChange={(val) => setStatusFilter(val as 'ALL' | 'ACTIVE' | 'INVITED')}
        >
          <div className="px-5">
            <TabList label="Filter members by account status">
              <Tab value="ALL" count={memberCounts.total}>
                All members
              </Tab>
              <Tab value="ACTIVE" count={memberCounts.active}>
                Active
              </Tab>
              <Tab value="INVITED" count={memberCounts.invited}>
                Pending invitation
              </Tab>
            </TabList>
          </div>

          <DataTable
            caption="Client hiring manager memberships"
            columns={columns}
            rows={filteredMembers}
            getRowKey={(row) => row.id}
            empty={
              members.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No client hiring managers yet"
                  description={`Invite hiring managers from ${client.name} to grant them portal access for reviewing submissions and proposing interviews.`}
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={UserPlus}
                      onClick={() => setIsInviteOpen(true)}
                    >
                      Invite first hiring manager
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Users}
                  title="No matching members"
                  description={
                    statusFilter === 'ACTIVE'
                      ? 'No active client hiring managers in this client organization.'
                      : 'No pending invitations for this client organization.'
                  }
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setStatusFilter('ALL')}>
                      Show all members
                    </Button>
                  }
                />
              )
            }
          />
        </Tabs>
      </Card>

      <InviteMemberDialog
        open={isInviteOpen}
        client={client}
        onClose={() => setIsInviteOpen(false)}
        onSubmit={handleInviteSubmit}
      />

      <ClientFormDialog
        open={isEditOpen}
        mode="edit"
        client={client}
        onClose={() => setIsEditOpen(false)}
        onSubmit={handleEditSubmit}
      />

      <ClientStatusDialog
        open={isStatusOpen}
        client={client}
        onClose={() => setIsStatusOpen(false)}
        onConfirm={handleStatusConfirm}
      />
    </div>
  );
}
