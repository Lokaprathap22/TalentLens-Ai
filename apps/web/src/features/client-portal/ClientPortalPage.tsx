import {
  AlertCircle,
  Building2,
  Clock,
  Eye,
  Filter,
  LogOut,
  RefreshCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  Users,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import { useAuth } from '../../app/auth.js';
import { useWorkspace } from '../../app/workspace.js';
import { LogoMark, Wordmark } from '../../components/brand.js';
import { Avatar } from '../../components/ui/avatar.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardBody, CardHeader } from '../../components/ui/card.js';
import { DataTable } from '../../components/ui/data-table.js';
import type { Column } from '../../components/ui/data-table.js';
import { EmptyState, Skeleton } from '../../components/ui/states.js';
import { usePageTitle } from '../../lib/use-page-title.js';
import { ClientSubmissionReviewModal } from './ClientSubmissionReviewModal.js';
import type {
  ClientPortalStatusFilter,
  ClientSubmissionStatus,
  ClientSubmissionSummary,
} from './types.js';
import { useClientPortal } from './use-client-portal.js';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function getStatusBadge(status: ClientSubmissionStatus): React.JSX.Element {
  switch (status) {
    case 'SUBMITTED':
      return (
        <Badge tone="info" dot>
          Pending Review
        </Badge>
      );
    case 'CLIENT_SHORTLISTED':
      return (
        <Badge tone="success" dot>
          Shortlisted
        </Badge>
      );
    case 'CLIENT_REJECTED':
      return (
        <Badge tone="neutral" dot>
          Declined
        </Badge>
      );
    case 'INTERVIEW_PROPOSED':
      return (
        <Badge tone="accent" dot>
          Interview Proposed
        </Badge>
      );
    case 'WITHDRAWN':
      return (
        <Badge tone="danger" dot>
          Withdrawn
        </Badge>
      );
  }
}

export function ClientPortalPage(): React.JSX.Element {
  usePageTitle('Client Portal');

  const { user } = useWorkspace();
  const { logout, isLoggingOut } = useAuth();

  const {
    clients,
    selectedClient,
    selectedClientId,
    setSelectedClientId,
    filteredSubmissions,
    metrics,
    status,
    error,
    filter,
    setFilter,
    setSelectedSubmissionId,
    selectedDetail,
    isDetailLoading,
    detailError,
    isSubmittingFeedback,
    feedbackError,
    isInterviewLoading,
    interviewError,
    submitFeedback,
    proposeInterview,
    acceptInterview,
    rejectInterview,
    reload,
  } = useClientPortal();

  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleOpenReview = useCallback(
    (submissionId: string) => {
      setSelectedSubmissionId(submissionId);
      setIsModalOpen(true);
    },
    [setSelectedSubmissionId],
  );

  const handleCloseReview = useCallback(() => {
    setIsModalOpen(false);
    setSelectedSubmissionId(null);
  }, [setSelectedSubmissionId]);

  const handleSignOut = (): void => {
    void logout().catch(() => {
      // Ignored: auth context maintains state
    });
  };

  const columns: Array<Column<ClientSubmissionSummary>> = [
    {
      id: 'candidateRef',
      header: 'Candidate Reference',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-fg">{row.candidateRef}</span>
          <Badge tone="accent">Masked Profile</Badge>
        </div>
      ),
    },
    {
      id: 'requisitionTitle',
      header: 'Requisition / Role',
      cell: (row) => (
        <div className="space-y-0.5">
          <span className="font-medium text-xs text-fg">{row.requisitionTitle}</span>
        </div>
      ),
    },
    {
      id: 'advisoryScore',
      header: 'Advisory Match',
      cell: (row) => {
        if (!row.assessmentSummary || row.assessmentSummary.score === null) {
          return <span className="text-xs text-fg-subtle">Pending</span>;
        }
        return (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-semibold text-fg">
              {Math.round(row.assessmentSummary.score)}%
            </span>
            <span className="text-2xs text-fg-subtle">
              ({row.assessmentSummary.criteriaCount} criteria)
            </span>
          </div>
        );
      },
    },
    {
      id: 'submittedAt',
      header: 'Submitted',
      cell: (row) => <span className="text-xs text-fg-subtle">{formatDate(row.submittedAt)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => getStatusBadge(row.status),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (row) => (
        <Button
          type="button"
          size="sm"
          variant={row.status === 'SUBMITTED' ? 'primary' : 'secondary'}
          onClick={() => handleOpenReview(row.submissionId)}
          className="text-xs"
        >
          <Eye className="h-3.5 w-3.5 mr-1" />
          {row.status === 'SUBMITTED' ? 'Review Candidate' : 'View Decision'}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {/* Top Navigation Bar */}
      <header className="border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LogoMark className="size-8" />
            <div className="flex items-baseline gap-2">
              <Wordmark className="text-base text-fg" />
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent-fg uppercase tracking-wider">
                Client Portal
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Client selector (if multiple) or single client badge */}
            {clients.length > 1 ? (
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-fg-subtle" />
                <select
                  value={selectedClientId ?? ''}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="rounded-md border border-border bg-bg-surface px-2.5 py-1 text-xs text-fg focus:border-accent focus:outline-none"
                  aria-label="Select client organization"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : selectedClient ? (
              <div className="hidden sm:flex items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-fg">
                <Building2 className="h-3.5 w-3.5 text-accent" />
                <span className="font-medium">{selectedClient.name}</span>
              </div>
            ) : null}

            {/* User profile & Sign out */}
            <div className="flex items-center gap-3 border-l border-border pl-4">
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
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8 space-y-6">
        {/* Welcome & Overview Header */}
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg">
            Candidate Evaluation Workspace
          </h1>
          <p className="mt-1 text-xs text-fg-subtle">
            Review candidate submissions, inspect advisory scorecard criteria evaluations, and
            record hiring decisions.
          </p>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="p-4 border-border bg-surface-raised space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-subtle">Total Submissions</span>
              <Users className="h-4 w-4 text-fg-subtle" />
            </div>
            <p className="text-2xl font-bold text-fg">{metrics.total}</p>
          </Card>

          <Card className="p-4 border-border bg-surface-raised space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-subtle">Pending Review</span>
              <Clock className="h-4 w-4 text-info" />
            </div>
            <p className="text-2xl font-bold text-info">{metrics.pendingReview}</p>
          </Card>

          <Card className="p-4 border-border bg-surface-raised space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-subtle">Shortlisted</span>
              <ThumbsUp className="h-4 w-4 text-success" />
            </div>
            <p className="text-2xl font-bold text-success">{metrics.shortlisted}</p>
          </Card>

          <Card className="p-4 border-border bg-surface-raised space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-subtle">Declined</span>
              <ThumbsDown className="h-4 w-4 text-fg-subtle" />
            </div>
            <p className="text-2xl font-bold text-fg-subtle">{metrics.declined}</p>
          </Card>
        </div>

        {/* Submissions Directory Card */}
        <Card className="border-border">
          <CardHeader
            title="Candidate Submissions"
            description="All candidate submissions forwarded by your recruitment partners for hiring consideration."
            actions={
              <button
                type="button"
                onClick={() => void reload()}
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-fg-subtle hover:bg-surface-muted hover:text-fg transition-colors"
                aria-label="Refresh submissions"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            }
          />

          {/* Filters & Search Toolbar */}
          <div className="border-b border-border px-4 py-3 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* Status tabs */}
              <div
                role="tablist"
                aria-label="Filter submissions by status"
                className="flex flex-wrap gap-1"
              >
                {[
                  { value: 'ALL', label: 'All Submissions' },
                  { value: 'SUBMITTED', label: 'Pending Review' },
                  { value: 'CLIENT_SHORTLISTED', label: 'Shortlisted' },
                  { value: 'CLIENT_REJECTED', label: 'Declined' },
                ].map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={filter.status === tab.value}
                    onClick={() => setFilter({ status: tab.value as ClientPortalStatusFilter })}
                    className={
                      filter.status === tab.value
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
                  onChange={(e) => setFilter({ search: e.target.value })}
                  placeholder="Search by code or position…"
                  className="w-full rounded-md border border-border bg-bg-surface pl-8 pr-3 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>
          </div>

          {/* Table / State display */}
          <CardBody className="p-0">
            {status === 'loading' ? (
              <div className="space-y-3 p-6">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : error ? (
              <div className="p-8">
                <EmptyState
                  icon={AlertCircle}
                  title="Unable to load submissions"
                  description={error}
                  action={
                    <Button variant="secondary" onClick={() => void reload()}>
                      Try again
                    </Button>
                  }
                />
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  icon={Filter}
                  title={
                    metrics.total === 0 ? 'No submissions yet' : 'No matching submissions found'
                  }
                  description={
                    metrics.total === 0
                      ? 'When recruiters shortlist and submit candidates for your active requisitions, they will appear here for evaluation.'
                      : 'Try adjusting your search criteria or status filter to see submissions.'
                  }
                  action={
                    metrics.total > 0 ? (
                      <Button
                        variant="secondary"
                        onClick={() => setFilter({ search: '', status: 'ALL' })}
                      >
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <DataTable
                caption="Candidate submissions for client review"
                columns={columns}
                rows={filteredSubmissions}
                getRowKey={(row) => row.submissionId}
              />
            )}
          </CardBody>
        </Card>
      </main>

      {/* Review & Decision Modal */}
      <ClientSubmissionReviewModal
        isOpen={isModalOpen}
        onClose={handleCloseReview}
        detail={selectedDetail}
        isLoading={isDetailLoading}
        error={detailError}
        onSubmitFeedback={submitFeedback}
        isSubmittingFeedback={isSubmittingFeedback}
        feedbackError={feedbackError}
        onProposeInterview={proposeInterview}
        onAcceptInterview={acceptInterview}
        onRejectInterview={rejectInterview}
        isInterviewLoading={isInterviewLoading}
        interviewError={interviewError}
      />
    </div>
  );
}
