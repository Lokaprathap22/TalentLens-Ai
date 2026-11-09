import {
  AlertCircle,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Filter,
  LogOut,
  RefreshCw,
  Search,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { useAuth } from '../../app/auth.js';
import { useWorkspace } from '../../app/workspace.js';
import { LogoMark, Wordmark } from '../../components/brand.js';
import { Avatar } from '../../components/ui/avatar.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardBody } from '../../components/ui/card.js';
import { DataTable } from '../../components/ui/data-table.js';
import type { Column } from '../../components/ui/data-table.js';
import { Dialog } from '../../components/ui/dialog.js';
import { EmptyState, Skeleton } from '../../components/ui/states.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { usePageTitle } from '../../lib/use-page-title.js';
import { formatInterviewFormatLabel, formatInterviewSchedule } from './types.js';
import type { InterviewFormat, InterviewItem, InterviewStatusCategory } from './types.js';
import { useInterviews } from './use-interviews.js';

const STATUS_TABS: Array<{ label: string; value: InterviewStatusCategory }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Upcoming', value: 'UPCOMING' },
  { label: 'Action Required', value: 'PENDING_ACTION' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Past', value: 'PAST' },
];

export function InterviewsPage(): React.JSX.Element {
  const { user } = useWorkspace();
  const { logout, isLoggingOut } = useAuth();
  const isClient = user.role === 'CLIENT_HIRING_MANAGER';

  usePageTitle(isClient ? 'Interviews — Client Portal' : 'Interviews Workspace');

  const {
    state,
    filter,
    setSearch,
    setStatusCategory,
    setPage,
    resetFilters,
    reload,
    isActing,
    feedback,
    dismissFeedback,
    handleAccept,
    handleReject,
    handleReschedule,
    handleComplete,
  } = useInterviews();

  // Modal states
  const [rejectItem, setRejectItem] = useState<InterviewItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  const [rescheduleItem, setRescheduleItem] = useState<InterviewItem | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleStartTime, setRescheduleStartTime] = useState('');
  const [rescheduleEndTime, setRescheduleEndTime] = useState('');
  const [rescheduleTimezone, setRescheduleTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [rescheduleFormat, setRescheduleFormat] = useState<InterviewFormat>('VIDEO');
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);

  // Sign out for client hiring manager top bar
  const handleSignOut = (): void => {
    void logout().catch(() => { });
  };

  // Actions
  const onConfirmAccept = useCallback(
    async (item: InterviewItem): Promise<void> => {
      setAcceptingId(item.id);
      try {
        await handleAccept(item);
      } finally {
        setAcceptingId(null);
      }
    },
    [handleAccept],
  );

  const onConfirmComplete = useCallback(
    async (item: InterviewItem): Promise<void> => {
      setCompletingId(item.id);
      try {
        await handleComplete(item);
      } finally {
        setCompletingId(null);
      }
    },
    [handleComplete],
  );

  const openRejectModal = useCallback((item: InterviewItem): void => {
    setRejectItem(item);
    setRejectReason('');
    setRejectError(null);
  }, []);

  const closeRejectModal = useCallback((): void => {
    setRejectItem(null);
    setRejectReason('');
    setRejectError(null);
  }, []);

  const onConfirmReject = useCallback(async (): Promise<void> => {
    if (!rejectItem) return;
    if (!rejectReason.trim()) {
      setRejectError('Please provide a reason for declining.');
      return;
    }
    setRejectError(null);
    const ok = await handleReject(rejectItem, rejectReason.trim());
    if (ok) {
      closeRejectModal();
    }
  }, [closeRejectModal, handleReject, rejectItem, rejectReason]);

  const openRescheduleModal = useCallback((item: InterviewItem): void => {
    setRescheduleItem(item);
    setRescheduleError(null);
    try {
      const start = new Date(item.startAt);
      const end = new Date(item.endAt);
      setRescheduleDate(start.toISOString().split('T')[0] ?? '');
      setRescheduleStartTime(start.toTimeString().slice(0, 5));
      setRescheduleEndTime(end.toTimeString().slice(0, 5));
      setRescheduleTimezone(item.timezone || 'UTC');
      setRescheduleFormat(item.format || 'VIDEO');
    } catch {
      setRescheduleDate('');
      setRescheduleStartTime('10:00');
      setRescheduleEndTime('11:00');
      setRescheduleTimezone('UTC');
      setRescheduleFormat('VIDEO');
    }
  }, []);

  const closeRescheduleModal = useCallback((): void => {
    setRescheduleItem(null);
    setRescheduleError(null);
  }, []);

  const onConfirmReschedule = useCallback(async (): Promise<void> => {
    if (!rescheduleItem) return;
    if (!rescheduleDate || !rescheduleStartTime || !rescheduleEndTime) {
      setRescheduleError('Please choose date, start time, and end time.');
      return;
    }

    const startIso = new Date(`${rescheduleDate}T${rescheduleStartTime}:00`).toISOString();
    const endIso = new Date(`${rescheduleDate}T${rescheduleEndTime}:00`).toISOString();

    if (new Date(startIso) >= new Date(endIso)) {
      setRescheduleError('End time must be later than start time.');
      return;
    }

    setRescheduleError(null);
    const ok = await handleReschedule(rescheduleItem, {
      startAt: startIso,
      endAt: endIso,
      timezone: rescheduleTimezone,
      format: rescheduleFormat,
    });
    if (ok) {
      closeRescheduleModal();
    }
  }, [
    closeRescheduleModal,
    handleReschedule,
    rescheduleDate,
    rescheduleEndTime,
    rescheduleFormat,
    rescheduleItem,
    rescheduleStartTime,
    rescheduleTimezone,
  ]);

  const renderActionButtons = useCallback(
    (row: InterviewItem, layout: 'table' | 'card'): React.JSX.Element | null => {
      const hasAnyAction = row.canAccept || row.canReject || row.canReschedule || row.canComplete;
      if (!hasAnyAction) {
        return layout === 'table' ? <span className="text-2xs text-fg-subtle">—</span> : null;
      }

      return (
        <div
          className={
            layout === 'table'
              ? 'flex flex-wrap items-center justify-end gap-1.5'
              : 'flex flex-wrap items-center gap-2 border-t border-border/60 pt-3'
          }
        >
          {row.canAccept ? (
            <Button
              variant="primary"
              size="sm"
              icon={Check}
              loading={isActing && acceptingId === row.id}
              disabled={isActing}
              onClick={() => void onConfirmAccept(row)}
              className="text-xs whitespace-nowrap"
            >
              Accept
            </Button>
          ) : null}

          {row.canReject ? (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              disabled={isActing}
              onClick={() => openRejectModal(row)}
              className="text-xs whitespace-nowrap text-danger hover:bg-danger-soft"
            >
              Decline
            </Button>
          ) : null}

          {row.canReschedule ? (
            <Button
              variant="secondary"
              size="sm"
              icon={CalendarClock}
              disabled={isActing}
              onClick={() => openRescheduleModal(row)}
              className="text-xs whitespace-nowrap"
            >
              Propose Alt
            </Button>
          ) : null}

          {row.canComplete ? (
            <Button
              variant="secondary"
              size="sm"
              icon={CheckCircle2}
              loading={isActing && completingId === row.id}
              disabled={isActing}
              onClick={() => void onConfirmComplete(row)}
              className="text-xs whitespace-nowrap"
            >
              Mark Complete
            </Button>
          ) : null}
        </div>
      );
    },
    [
      acceptingId,
      completingId,
      isActing,
      onConfirmAccept,
      onConfirmComplete,
      openRejectModal,
      openRescheduleModal,
    ],
  );

  // Table columns (desktop lg+; secondary metadata collapses cleanly on lg and expands at xl)
  const columns = useMemo<Column<InterviewItem>[]>(
    () => [
      {
        id: 'candidate',
        header: 'Candidate',
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs font-semibold whitespace-nowrap text-fg">
              {row.candidateCode}
            </span>
            <Badge tone="accent">Masked</Badge>
          </div>
        ),
      },
      {
        id: 'requisition',
        header: 'Requisition & Client',
        cell: (row) => (
          <div className="min-w-[140px] max-w-[200px] space-y-0.5">
            <p className="truncate font-medium text-xs text-fg" title={row.requisitionTitle}>
              {row.requisitionTitle}
            </p>
            <p className="truncate text-2xs text-fg-subtle" title={row.clientName}>
              {row.clientName}
            </p>
          </div>
        ),
      },
      {
        id: 'schedule',
        header: 'Schedule & Timezone',
        cell: (row) => {
          const { dateStr, timeRangeStr } = formatInterviewSchedule(
            row.startAt,
            row.endAt,
            row.timezone,
          );
          return (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs font-medium whitespace-nowrap text-fg">
                <Calendar className="h-3 w-3 shrink-0 text-fg-subtle" />
                <span>{dateStr}</span>
              </div>
              <div className="flex items-center gap-1 text-2xs whitespace-nowrap text-fg-subtle">
                <Clock className="h-3 w-3 shrink-0 text-fg-subtle" />
                <span>{timeRangeStr}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-mono text-fg-subtle">
                  {row.timezone}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted xl:hidden">
                  <Video className="h-3 w-3 shrink-0 text-accent" />
                  <span>{formatInterviewFormatLabel(row.format)}</span>
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: 'format',
        header: 'Format',
        showFrom: 'xl',
        className: 'whitespace-nowrap',
        cell: (row) => (
          <div className="flex items-center gap-1 text-xs whitespace-nowrap text-fg-muted">
            <Video className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span>{formatInterviewFormatLabel(row.format)}</span>
          </div>
        ),
      },
      {
        id: 'proposer',
        header: 'Proposed By',
        showFrom: 'xl',
        cell: (row) => (
          <span className="block max-w-[115px] text-xs leading-tight text-fg-muted">
            {row.proposerRole === 'RECRUITER' ? 'Recruiter' : 'Client Hiring Manager'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (row) => (
          <div className="space-y-1">
            <StatusBadge kind="interview" status={row.status} />
            <p className="text-[11px] text-fg-subtle xl:hidden">
              By {row.proposerRole === 'RECRUITER' ? 'Recruiter' : 'Client Hiring Manager'}
            </p>
            {row.reason ? (
              <p
                className="max-w-[160px] truncate text-2xs text-fg-subtle italic"
                title={row.reason}
              >
                &ldquo;{row.reason}&rdquo;
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        align: 'right',
        cell: (row) => renderActionButtons(row, 'table'),
      },
    ],
    [renderActionButtons],
  );

  const counts = state.status === 'ready' ? state.counts : null;

  return (
    <div className={isClient ? 'flex min-h-dvh flex-col bg-canvas' : 'space-y-6'}>
      {/* Client Portal Header (only when viewed as client hiring manager) */}
      {isClient ? (
        <header className="border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center justify-between gap-3 py-2">
            <div className="flex flex-wrap items-center gap-4 sm:gap-6">
              <div className="flex items-center gap-2.5">
                <LogoMark className="size-8 shrink-0" />
                <div className="flex items-baseline gap-2">
                  <Wordmark className="text-base text-fg" />
                  <span className="hidden rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold tracking-wider text-accent-fg uppercase sm:inline-flex">
                    Client Portal
                  </span>
                </div>
              </div>

              {/* Navigation Tabs for Client Portal */}
              <nav
                className="flex flex-wrap items-center gap-1 sm:gap-2"
                aria-label="Client Portal Sections"
              >
                <a
                  href="/dashboard"
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-muted hover:text-fg"
                >
                  Dashboard
                </a>
                <a
                  href="/client-portal"
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-muted hover:text-fg"
                >
                  Submissions
                </a>
                <a
                  href="/interviews"
                  aria-current="page"
                  className="rounded-md bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent-fg"
                >
                  Interviews
                </a>
              </nav>
            </div>

            {/* Profile & Sign out */}
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 text-right">
                <Avatar name={user.email} size="sm" />
                <div>
                  <p className="text-xs font-medium text-fg">{user.email}</p>
                  <p className="text-2xs text-fg-subtle">Hiring Manager</p>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={LogOut}
                loading={isLoggingOut}
                onClick={handleSignOut}
              >
                {isLoggingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          </div>
        </header>
      ) : null}

      {/* Main Workspace Area */}
      <main
        className={
          isClient
            ? 'mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8 space-y-6'
            : 'space-y-6'
        }
      >
        {/* Page Header */}
        <PageHeader
          title={isClient ? 'Interviews & Scheduling' : 'Interviews Workspace'}
          description={
            isClient
              ? 'Review proposed interview windows, confirm times, and coordinate with recruiters.'
              : 'Manage candidate interview proposals, counter-proposals, confirmations, and completions across client requisitions.'
          }
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={() => void reload()}
              loading={state.status === 'loading'}
            >
              Refresh
            </Button>
          }
        />

        {/* User Feedback Alert Banner */}
        {feedback ? (
          <div
            role="alert"
            className={
              feedback.type === 'success'
                ? 'flex items-center justify-between rounded-lg border border-success/30 bg-success-soft p-3 text-xs text-success'
                : 'flex items-center justify-between rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger'
            }
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={dismissFeedback}
              className="ml-3 text-fg-subtle hover:text-fg"
              aria-label="Dismiss message"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {/* Metric Summary Cards Strip */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="border border-border transition-all duration-150 hover:border-fg-disabled hover:shadow-xs">
            <CardBody className="p-4">
              <p className="text-xs font-medium text-fg-subtle">Total Interviews</p>
              <p className="mt-1 text-2xl font-bold text-fg">{counts ? counts.total : '—'}</p>
            </CardBody>
          </Card>

          <Card className="border border-border transition-all duration-150 hover:border-fg-disabled hover:shadow-xs">
            <CardBody className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-fg-subtle">Upcoming Confirmed</p>
                <Badge tone="success">Active</Badge>
              </div>
              <p className="mt-1 text-2xl font-bold text-success">
                {counts ? counts.upcoming : '—'}
              </p>
            </CardBody>
          </Card>

          <Card className="border border-border transition-all duration-150 hover:border-fg-disabled hover:shadow-xs">
            <CardBody className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-fg-subtle">Action Required</p>
                {counts && counts.pendingAction > 0 ? <Badge tone="warning">Pending</Badge> : null}
              </div>
              <p className="mt-1 text-2xl font-bold text-warning">
                {counts ? counts.pendingAction : '—'}
              </p>
            </CardBody>
          </Card>

          <Card className="border border-border transition-all duration-150 hover:border-fg-disabled hover:shadow-xs">
            <CardBody className="p-4">
              <p className="text-xs font-medium text-fg-subtle">Completed</p>
              <p className="mt-1 text-2xl font-bold text-fg">{counts ? counts.completed : '—'}</p>
            </CardBody>
          </Card>
        </div>

        {/* Filter and Content Card */}
        <Card className="border border-border shadow-xs">
          <div className="border-b border-border p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              {/* Category Filter Tabs */}
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="tablist"
                aria-label="Interview status categories"
              >
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={filter.statusCategory === tab.value}
                    onClick={() => setStatusCategory(tab.value)}
                    className={
                      filter.statusCategory === tab.value
                        ? 'rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-medium text-accent-fg'
                        : 'rounded-full border border-border bg-surface-muted px-3 py-1 text-xs font-medium text-fg-subtle hover:text-fg hover:border-accent/40'
                    }
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Search input */}
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-subtle" />
                <input
                  type="text"
                  value={filter.search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by code, position, client…"
                  className="w-full rounded-md border border-border bg-surface pl-8 pr-3 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>
          </div>

          {/* Table / Content Display */}
          <CardBody className="p-0">
            {state.status === 'loading' ? (
              <div className="space-y-3 p-6">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : state.status === 'error' ? (
              <div className="p-8">
                <EmptyState
                  icon={AlertCircle}
                  title="Unable to load interviews"
                  description={state.message}
                  action={
                    <Button variant="secondary" onClick={() => void reload()}>
                      Try again
                    </Button>
                  }
                />
              </div>
            ) : state.items.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  icon={Filter}
                  title={state.total === 0 ? 'No interviews found' : 'No matching interviews'}
                  description={
                    state.total === 0
                      ? 'When candidates are shortlisted and interview windows are proposed, they will appear here.'
                      : 'Try adjusting your search criteria or status filter to see interviews.'
                  }
                  action={
                    state.total > 0 ? (
                      <Button variant="secondary" onClick={resetFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                {/* Desktop table view (lg+); prevents narrow-viewport horizontal clipping */}
                <div className="hidden lg:block" data-testid="interviews-desktop-table">
                  <DataTable
                    caption="Scheduled and proposed candidate interviews"
                    columns={columns}
                    rows={state.items}
                    getRowKey={(row) => row.id}
                  />
                </div>

                {/* Responsive mobile & tablet card view (< lg) */}
                <div
                  className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 lg:hidden"
                  data-testid="interviews-mobile-list"
                  aria-label="Scheduled and proposed candidate interviews list"
                >
                  {state.items.map((row) => {
                    const { dateStr, timeRangeStr } = formatInterviewSchedule(
                      row.startAt,
                      row.endAt,
                      row.timezone,
                    );
                    const actionsEl = renderActionButtons(row, 'card');
                    return (
                      <article
                        key={row.id}
                        className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-surface p-4"
                      >
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-xs font-semibold text-fg">
                                {row.candidateCode}
                              </span>
                              <Badge tone="accent">Masked</Badge>
                            </div>
                            <StatusBadge kind="interview" status={row.status} />
                          </div>

                          <div className="space-y-0.5">
                            <p className="text-sm font-medium text-fg break-words">
                              {row.requisitionTitle}
                            </p>
                            <p className="text-xs text-fg-subtle">{row.clientName}</p>
                          </div>

                          <dl className="grid grid-cols-1 gap-2 rounded-md bg-surface-muted/60 p-2.5 text-xs">
                            <div className="flex items-start gap-2">
                              <Calendar className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                              <div className="min-w-0">
                                <dt className="sr-only">Date and time</dt>
                                <dd className="font-medium text-fg">{dateStr}</dd>
                                <dd className="text-fg-subtle">
                                  {timeRangeStr}{' '}
                                  <span className="ml-1 inline-block rounded bg-surface px-1 py-0.5 font-mono text-[10px] text-fg-subtle">
                                    {row.timezone}
                                  </span>
                                </dd>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                              <div className="flex items-center gap-1.5">
                                <Video className="h-3.5 w-3.5 shrink-0 text-accent" />
                                <span>{formatInterviewFormatLabel(row.format)}</span>
                              </div>
                              <span className="text-fg-subtle">
                                Proposed by:{' '}
                                <strong className="font-medium text-fg">
                                  {row.proposerRole === 'RECRUITER'
                                    ? 'Recruiter'
                                    : 'Client Hiring Manager'}
                                </strong>
                              </span>
                            </div>
                          </dl>

                          {row.reason ? (
                            <p className="text-xs text-fg-subtle italic break-words">
                              &ldquo;{row.reason}&rdquo;
                            </p>
                          ) : null}
                        </div>

                        {actionsEl}
                      </article>
                    );
                  })}
                </div>

                {/* Pagination Controls */}
                {state.totalPages > 1 ? (
                  <div className="flex items-center justify-between border-t border-border px-4 py-3 sm:px-6">
                    <p className="text-xs text-fg-subtle">
                      Showing page <span className="font-semibold text-fg">{state.page}</span> of{' '}
                      <span className="font-semibold text-fg">{state.totalPages}</span> (
                      {state.total} interviews)
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={state.page <= 1}
                        onClick={() => setPage(state.page - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={state.page >= state.totalPages}
                        onClick={() => setPage(state.page + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      </main>

      {/* Decline Interview Dialog */}
      <Dialog
        open={rejectItem !== null}
        onClose={closeRejectModal}
        title="Decline Interview Proposal"
        description="Please provide a reason for declining this proposed interview window so the counterpart can coordinate alternative times."
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeRejectModal} disabled={isActing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={isActing}
              onClick={() => void onConfirmReject()}
              className="bg-danger hover:bg-danger-hover text-white border-transparent"
            >
              Confirm Decline
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {rejectItem ? (
            <div className="rounded-md border border-border bg-surface-muted p-3 text-xs">
              <p className="font-semibold text-fg">{rejectItem.candidateCode}</p>
              <p className="text-fg-subtle">{rejectItem.requisitionTitle}</p>
            </div>
          ) : null}

          <div>
            <label htmlFor="reject-reason" className="block text-xs font-medium text-fg mb-1">
              Reason for declining <span className="text-danger">*</span>
            </label>
            <textarea
              id="reject-reason"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g., Hiring team has a conflict at this time; candidate requested later window..."
              className="w-full rounded-md border border-border bg-bg-surface p-2.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {rejectError ? <p className="mt-1 text-xs text-danger">{rejectError}</p> : null}
          </div>
        </div>
      </Dialog>

      {/* Counter-Propose Alternative Window Dialog (Recruiter) */}
      <Dialog
        open={rescheduleItem !== null}
        onClose={closeRescheduleModal}
        title="Propose Alternative Interview Window"
        description="Propose a new date, time, and format for this candidate interview."
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={closeRescheduleModal}
              disabled={isActing}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={isActing}
              onClick={() => void onConfirmReschedule()}
            >
              Propose Window
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {rescheduleItem ? (
            <div className="rounded-md border border-border bg-surface-muted p-3 text-xs">
              <p className="font-semibold text-fg">{rescheduleItem.candidateCode}</p>
              <p className="text-fg-subtle">
                {rescheduleItem.requisitionTitle} · {rescheduleItem.clientName}
              </p>
            </div>
          ) : null}

          <div className="space-y-3">
            <div>
              <label htmlFor="reschedule-date" className="block text-xs font-medium text-fg mb-1">
                Interview Date
              </label>
              <input
                id="reschedule-date"
                type="date"
                value={rescheduleDate}
                onChange={(e) => setRescheduleDate(e.target.value)}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="reschedule-start"
                  className="block text-xs font-medium text-fg mb-1"
                >
                  Start Time
                </label>
                <input
                  id="reschedule-start"
                  type="time"
                  value={rescheduleStartTime}
                  onChange={(e) => setRescheduleStartTime(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="reschedule-end" className="block text-xs font-medium text-fg mb-1">
                  End Time
                </label>
                <input
                  id="reschedule-end"
                  type="time"
                  value={rescheduleEndTime}
                  onChange={(e) => setRescheduleEndTime(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="reschedule-tz" className="block text-xs font-medium text-fg mb-1">
                  Timezone
                </label>
                <input
                  id="reschedule-tz"
                  type="text"
                  value={rescheduleTimezone}
                  onChange={(e) => setRescheduleTimezone(e.target.value)}
                  placeholder="e.g. UTC, America/New_York"
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="reschedule-format"
                  className="block text-xs font-medium text-fg mb-1"
                >
                  Format
                </label>
                <select
                  id="reschedule-format"
                  value={rescheduleFormat}
                  onChange={(e) => setRescheduleFormat(e.target.value as InterviewFormat)}
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                >
                  <option value="VIDEO">Video Call</option>
                  <option value="PHONE">Phone Call</option>
                  <option value="IN_PERSON">In Person</option>
                </select>
              </div>
            </div>

            {rescheduleError ? <p className="text-xs text-danger">{rescheduleError}</p> : null}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
