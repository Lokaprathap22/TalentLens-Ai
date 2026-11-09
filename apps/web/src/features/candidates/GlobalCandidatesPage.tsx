import { ExternalLink, Filter, RefreshCw, Users } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';

import { Badge } from '../../components/ui/badge.js';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Pagination,
  SearchField,
  Tab,
  TabList,
  Tabs,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { useRequisitions } from '../requisitions/use-requisitions.js';
import type { GlobalCandidateStatusCategory, GlobalCandidateSummary } from './types.js';
import { getReviewStatusLabel, getReviewStatusTone } from './types.js';
import { useGlobalCandidates } from './use-global-candidates.js';

export function GlobalCandidatesPage(): React.JSX.Element {
  const navigate = useNavigate();

  const {
    state,
    filter,
    setSearch,
    setRequisitionId,
    setStatusCategory,
    setSort,
    setPage,
    resetFilters,
    reload,
  } = useGlobalCandidates();

  // Load available requisitions for the organization-scoped filter dropdown
  const { requisitions } = useRequisitions();

  const handleRowInspect = useCallback(
    (row: GlobalCandidateSummary): void => {
      if (row.requisitionId) {
        navigate(
          `/requisitions/${encodeURIComponent(row.requisitionId)}/candidates/${encodeURIComponent(row.candidateId)}`,
        );
      }
    },
    [navigate],
  );

  const columns = useMemo<Column<GlobalCandidateSummary>[]>(
    () => [
      {
        id: 'candidate',
        header: 'Candidate',
        cell: (row) => (
          <div className="space-y-0.5">
            {row.requisitionId ? (
              <button
                type="button"
                onClick={() => handleRowInspect(row)}
                className="font-mono text-xs font-semibold text-fg hover:text-accent hover:underline text-left cursor-pointer focus:outline-none focus:underline"
                title={`Inspect candidate ${row.candidateCode}`}
              >
                {row.candidateCode}
              </button>
            ) : (
              <span className="font-mono text-xs font-semibold text-fg">{row.candidateCode}</span>
            )}

            {row.currentRole ? (
              <p
                className="text-xs font-medium text-fg truncate max-w-[200px]"
                title={row.currentRole}
              >
                {row.currentRole}
              </p>
            ) : null}

            <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
              {row.experienceYears !== null ? <span>{row.experienceYears} yrs exp</span> : null}
              {row.experienceYears !== null && row.location ? <span>·</span> : null}
              {row.location ? (
                <span className="truncate max-w-[120px]" title={row.location}>
                  {row.location}
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: 'requisition',
        header: 'Requisition & Client',
        showFrom: 'md',
        cell: (row) => (
          <div className="space-y-0.5">
            {row.requisitionId && row.requisitionTitle ? (
              <Link
                to={`/requisitions/${encodeURIComponent(row.requisitionId)}`}
                className="text-xs font-medium text-fg hover:text-accent hover:underline line-clamp-1"
                title={row.requisitionTitle}
              >
                {row.requisitionTitle}
              </Link>
            ) : (
              <span className="text-xs text-fg-disabled">Unassigned</span>
            )}
            {row.clientName ? (
              <p
                className="text-[11px] text-fg-muted truncate max-w-[160px]"
                title={row.clientName}
              >
                {row.clientName}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'assessment',
        header: 'AI Assessment',
        showFrom: 'sm',
        cell: (row) => {
          if (row.statusCategory === 'ASSESSED' && row.overallScore !== null) {
            const tone =
              row.overallScore >= 70 ? 'success' : row.overallScore >= 50 ? 'warning' : 'danger';
            return (
              <div className="space-y-1">
                <Badge tone={tone} dot>
                  {row.overallScore}%
                </Badge>
                {row.criteriaCount > 0 ? (
                  <p className="text-[10px] text-fg-subtle">
                    {row.criteriaMetCount}/{row.criteriaCount} criteria met
                  </p>
                ) : null}
              </div>
            );
          }

          if (row.statusCategory === 'NEEDS_REVIEW') {
            return (
              <Badge tone="warning" dot>
                Review needed
              </Badge>
            );
          }

          if (row.statusCategory === 'FAILED') {
            return (
              <Badge tone="danger" dot>
                Failed
              </Badge>
            );
          }

          return (
            <Badge tone="neutral" dot>
              Awaiting assessment
            </Badge>
          );
        },
      },
      {
        id: 'review',
        header: 'Review & Shortlist',
        showFrom: 'lg',
        cell: (row) => {
          const tone = getReviewStatusTone(row.reviewStatus);
          const label = getReviewStatusLabel(row.reviewStatus);
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={tone} dot>
                {label}
              </Badge>
              {row.isShortlisted ? <Badge tone="accent">Shortlisted</Badge> : null}
            </div>
          );
        },
      },
      {
        id: 'submission',
        header: 'Client Status',
        showFrom: 'xl',
        cell: (row) => {
          if (!row.submissionStatus) {
            return <span className="text-xs text-fg-disabled">—</span>;
          }

          const tones: Record<
            string,
            'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'
          > = {
            SUBMITTED: 'info',
            CLIENT_SHORTLISTED: 'success',
            CLIENT_REJECTED: 'neutral',
            INTERVIEW_PROPOSED: 'accent',
            WITHDRAWN: 'danger',
          };

          const labels: Record<string, string> = {
            SUBMITTED: 'With client',
            CLIENT_SHORTLISTED: 'Client shortlisted',
            CLIENT_REJECTED: 'Client declined',
            INTERVIEW_PROPOSED: 'Interview proposed',
            WITHDRAWN: 'Withdrawn',
          };

          const tone = tones[row.submissionStatus] ?? 'neutral';
          const label = labels[row.submissionStatus] ?? row.submissionStatus;

          return (
            <Badge tone={tone} dot>
              {label}
            </Badge>
          );
        },
      },
      {
        id: 'lastActivity',
        header: 'Activity',
        align: 'right',
        cell: (row) => (
          <span className="tabular text-xs text-fg-subtle">
            {formatShortDate(row.lastActivityAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        align: 'right',
        cell: (row) => {
          if (!row.requisitionId) {
            return <span className="text-xs text-fg-disabled">—</span>;
          }

          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRowInspect(row)}
              aria-label={`Inspect candidate ${row.candidateCode}`}
            >
              <Icon icon={ExternalLink} size="xs" />
              <span className="hidden sm:inline">Inspect</span>
            </Button>
          );
        },
      },
    ],
    [handleRowInspect],
  );

  const isFiltering =
    Boolean(filter.search.trim()) ||
    Boolean(filter.requisitionId) ||
    filter.statusCategory !== 'ALL';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Candidate Directory"
        description="Search, filter, and inspect evaluated candidates across all requisitions within your organization."
        breadcrumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Candidates' }]}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void reload()}
            aria-label="Refresh candidate directory"
          >
            <Icon icon={RefreshCw} size="xs" />
            <span>Refresh</span>
          </Button>
        }
      />

      <Card>
        {/* Controls header: Search, Requisition filter, Sort selector */}
        <div className="p-4 sm:p-5 border-b border-border space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-center">
            {/* Search field */}
            <div className="sm:col-span-5">
              <SearchField
                label="Search candidates"
                value={filter.search}
                onValueChange={setSearch}
                placeholder="Search by code, role, skill, or resume name..."
              />
            </div>

            {/* Requisition dropdown filter */}
            <div className="sm:col-span-4">
              <label htmlFor="global-candidates-req-filter" className="sr-only">
                Filter by requisition
              </label>
              <select
                id="global-candidates-req-filter"
                value={filter.requisitionId}
                onChange={(e) => setRequisitionId(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg shadow-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">All requisitions ({requisitions.length})</option>
                {requisitions.map((req) => (
                  <option key={req.id} value={req.id}>
                    {req.title} {req.clientName ? `(${req.clientName})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Sort selector */}
            <div className="sm:col-span-3 flex items-center justify-end gap-2">
              <label
                htmlFor="global-candidates-sort"
                className="text-xs font-medium text-fg-subtle shrink-0"
              >
                Sort:
              </label>
              <select
                id="global-candidates-sort"
                value={`${filter.sortBy}:${filter.sortOrder}`}
                onChange={(e) => {
                  const [by, order] = e.target.value.split(':') as [
                    'activity' | 'score' | 'createdAt',
                    'asc' | 'desc',
                  ];
                  setSort(by, order);
                }}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg shadow-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="activity:desc">Recent activity</option>
                <option value="score:desc">Score: Highest first</option>
                <option value="score:asc">Score: Lowest first</option>
                <option value="createdAt:desc">Date added</option>
              </select>
            </div>
          </div>

          {/* Status category tabs */}
          <Tabs
            defaultValue="ALL"
            value={filter.statusCategory}
            onValueChange={(val) => setStatusCategory(val as 'ALL' | GlobalCandidateStatusCategory)}
          >
            <TabList label="Candidate assessment status filter">
              <Tab value="ALL">All candidates</Tab>
              <Tab value="ASSESSED">Assessed</Tab>
              <Tab value="NEEDS_REVIEW">Needs review</Tab>
              <Tab value="AWAITING_ASSESSMENT">Awaiting assessment</Tab>
              <Tab value="FAILED">Failed</Tab>
            </TabList>
          </Tabs>
        </div>

        {/* Directory content */}
        {state.status === 'loading' ? (
          <LoadingRegion label="Loading candidate directory" className="p-4 sm:p-6">
            <DataTable<GlobalCandidateSummary>
              caption="Candidate directory loading"
              columns={columns}
              rows={[]}
              getRowKey={(item) => item.candidateId}
              loading
              skeletonRows={8}
            />
          </LoadingRegion>
        ) : state.status === 'error' ? (
          <div className="p-6">
            <ErrorState
              title="Failed to load candidate directory"
              description={state.message}
              onRetry={() => void reload()}
            />
          </div>
        ) : state.items.length === 0 ? (
          <div className="p-6">
            {isFiltering ? (
              <EmptyState
                icon={Filter}
                title="No candidates match your criteria"
                description="Try broadening your search term, switching requisition, or clearing active status filters."
                action={
                  <Button variant="secondary" size="sm" onClick={resetFilters}>
                    Clear all filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                title="No candidates evaluated yet"
                description="Candidate resumes uploaded to requisitions within your organization will appear here for organization-wide search and screening."
                action={
                  <Button variant="primary" size="sm" onClick={() => navigate('/requisitions')}>
                    View Requisitions
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <div>
            <DataTable<GlobalCandidateSummary>
              caption="Organization candidate directory"
              columns={columns}
              rows={state.items}
              getRowKey={(item) => item.candidateId}
            />

            {state.total > 0 ? (
              <div className="p-4 sm:p-5 border-t border-border">
                <Pagination
                  page={state.page}
                  pageSize={state.pageSize}
                  total={state.total}
                  onPageChange={setPage}
                  noun="candidates"
                />
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

export default GlobalCandidatesPage;
