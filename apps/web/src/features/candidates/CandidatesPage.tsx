/**
 * CandidatesPage — Recruiter-facing candidate directory for a requisition.
 *
 * Route: /requisitions/:requisitionId/candidates
 * Protected: Recruiter role only (enforced by ProtectedRoute in App.tsx).
 *
 * Security invariants:
 * - Never displays or logs candidate PII (name, email, phone, etc.).
 * - Candidates are referenced by pseudonymous candidateCode only.
 * - Tenant isolation enforced server-side; no organizationId passed from frontend.
 * - Consent-aware: PENDING parse status is accurately labelled (not "processing").
 * - Resume download links are NOT provided here (out of scope for M9.5A).
 */

import {
  AlertCircle,
  ArrowLeft,
  ClipboardCheck,
  FileText,
  Filter,
  RefreshCcw,
  Upload,
  Users,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { Badge } from '../../components/ui/badge.js';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Pagination,
  SearchField,
  Skeleton,
} from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { useRequisitionDetail } from '../requisitions/use-requisition-detail.js';
import { CandidateDetailDrawer } from './CandidateDetailDrawer.js';
import type {
  AcceptedUploadItem,
  CandidateSummary,
  ListCandidatesQuery,
  ResumeBatchUploadResult,
} from './types.js';
import {
  getParseStatusLabel,
  getParseStatusTone,
  getReviewStatusLabel,
  getReviewStatusTone,
} from './types.js';
import { useCandidates } from './use-candidates.js';
import type { ProcessingFilter, SubmissionFilter, UseCandidatesFilter } from './use-candidates.js';
import { ResumeUploadDialog } from './ResumeUploadDialog.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Processing filter tab options
// ---------------------------------------------------------------------------

const PROCESSING_FILTER_OPTIONS: Array<{ value: ProcessingFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Queued' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'PARSED', label: 'Extracted' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'FAILED', label: 'Failed' },
];

const SUBMISSION_FILTER_OPTIONS: Array<{ value: SubmissionFilter; label: string }> = [
  { value: 'ALL', label: 'All Submissions' },
  { value: 'NOT_SUBMITTED', label: 'Not Submitted' },
  { value: 'SUBMITTED', label: 'With Client' },
  { value: 'CLIENT_SHORTLISTED', label: 'Client Shortlisted' },
  { value: 'CLIENT_REJECTED', label: 'Client Declined' },
];

// ---------------------------------------------------------------------------
// Candidate table columns
// ---------------------------------------------------------------------------

function candidateColumns(onInspect: (candidateId: string) => void): Array<{
  id: string;
  header: string;
  cell: (row: CandidateSummary) => React.JSX.Element;
  showFrom?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'left' | 'right';
}> {
  return [
    {
      id: 'candidate',
      header: 'Candidate',
      cell: (row) => (
        <div>
          <button
            type="button"
            onClick={() => onInspect(row.candidateId)}
            className="font-mono text-xs font-semibold text-fg hover:text-accent hover:underline text-left cursor-pointer focus:outline-none focus:underline"
            title={`Inspect candidate ${row.candidateCode}`}
          >
            {row.candidateCode}
          </button>
          <p
            className="mt-0.5 truncate text-xs text-fg-subtle max-w-[180px]"
            title={row.resumeFileName}
          >
            {row.resumeFileName}
          </p>
        </div>
      ),
    },
    {
      id: 'processing',
      header: 'Processing',
      cell: (row) => {
        const tone = getParseStatusTone(row.parseStatus);
        const label = getParseStatusLabel(row.parseStatus);
        // Consent-aware: PENDING means job may be HELD_FOR_AUTHORIZATION (awaiting consent).
        // We show the parse status label as-is; the UI does not misrepresent this as active processing.
        const isHeld = row.parseStatus === 'PENDING' && !row.assessmentId;
        return (
          <div className="space-y-1">
            <Badge tone={tone} dot>
              {label}
            </Badge>
            {isHeld ? <p className="text-[10px] text-fg-subtle">May be awaiting consent</p> : null}
          </div>
        );
      },
    },
    {
      id: 'assessment',
      header: 'Assessment',
      showFrom: 'md',
      cell: (row) => {
        if (!row.assessmentStatus) {
          return <span className="text-xs text-fg-disabled">—</span>;
        }
        const tone =
          row.assessmentStatus === 'COMPLETE'
            ? 'success'
            : row.assessmentStatus === 'NEEDS_REVIEW'
              ? 'warning'
              : 'danger';
        const label =
          row.assessmentStatus === 'COMPLETE'
            ? `${row.overallScore ?? '—'}%`
            : row.assessmentStatus === 'NEEDS_REVIEW'
              ? 'Review needed'
              : 'Failed';
        return (
          <div className="space-y-1">
            <Badge tone={tone} dot>
              {label}
            </Badge>
            {row.isComplete && row.criteriaCount > 0 ? (
              <p className="text-[10px] text-fg-subtle">
                {row.criteriaMetCount}/{row.criteriaCount} criteria met
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'review',
      header: 'Review',
      showFrom: 'lg',
      cell: (row) => {
        const tone = getReviewStatusTone(row.reviewStatus);
        const label = getReviewStatusLabel(row.reviewStatus);
        return (
          <div className="space-y-1">
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
      header: 'Submission',
      showFrom: 'xl',
      cell: (row) => {
        if (!row.submissionStatus) {
          return <span className="text-xs text-fg-disabled">Not submitted</span>;
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
      id: 'activity',
      header: 'Last activity',
      showFrom: 'lg',
      cell: (row) => (
        <span className="text-xs tabular text-fg-subtle">
          {formatShortDate(row.lastActivityAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (row) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onInspect(row.candidateId)}
          aria-label={`Inspect candidate ${row.candidateCode}`}
        >
          Inspect
        </Button>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Page skeleton
// ---------------------------------------------------------------------------

function CandidatesPageSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading candidates" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-80" />
      </div>
      <Card>
        <div className="space-y-3 p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full max-w-xs" />
          <Skeleton className="h-48 w-full" />
        </div>
      </Card>
    </LoadingRegion>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function CandidatesPage(): React.JSX.Element {
  const { requisitionId } = useParams<{ requisitionId: string }>();
  const navigate = useNavigate();
  const safeRequisitionId = requisitionId ?? '';

  // Load requisition metadata for breadcrumbs and header
  const { state: reqState, requisition } = useRequisitionDetail(safeRequisitionId);

  const [currentPage, setCurrentPage] = useState(1);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const serverQuery = useMemo<ListCandidatesQuery>(
    () => ({
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
    }),
    [currentPage],
  );

  // Candidate directory state
  const {
    state,
    filteredCandidates,
    total,
    reload,
    prependCandidates,
    filter,
    setFilter: rawSetFilter,
  } = useCandidates(safeRequisitionId, serverQuery);

  const setFilter = useCallback(
    (patch: Partial<UseCandidatesFilter>) => {
      setCurrentPage(1);
      rawSetFilter(patch);
    },
    [rawSetFilter],
  );

  // Deep-linkable inspection drawer driven by URL search params
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCandidateId = searchParams.get('candidateId');

  const handleInspectCandidate = useCallback(
    (candidateId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('candidateId', candidateId);
        return next;
      });
    },
    [setSearchParams],
  );

  const handleCloseDrawer = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('candidateId');
      return next;
    });
  }, [setSearchParams]);

  const handleUploadSuccess = useCallback(
    (accepted: AcceptedUploadItem[], _result: ResumeBatchUploadResult): void => {
      // Optimistically prepend accepted candidates as PENDING records.
      // The server reload in the background will reconcile the actual state.
      // We build minimal CandidateSummary objects from the accepted upload items.
      const now = new Date().toISOString();
      const optimisticCandidates: CandidateSummary[] = accepted.map((item) => ({
        candidateId: item.candidateId,
        candidateCode: item.candidateCode,
        resumeDocumentId: item.resumeDocumentId,
        resumeFileName: item.fileName,
        parseStatus: 'PENDING',
        assessmentId: null,
        assessmentStatus: null,
        overallScore: null,
        coverage: null,
        isComplete: false,
        criteriaCount: 0,
        criteriaMetCount: 0,
        reviewStatus: 'NOT_REVIEWED',
        reviewedAt: null,
        isShortlisted: false,
        shortlistedAt: null,
        submissionId: null,
        submissionStatus: null,
        submittedAt: null,
        lastActivityAt: now,
      }));

      prependCandidates(optimisticCandidates);
      setCurrentPage(1);

      // Schedule a server reload to reconcile state
      void reload();
    },
    [prependCandidates, reload],
  );

  // Support both server-paginated mode and client-sliced mode
  const isServerPaginated = total > filteredCandidates.length || serverQuery.offset !== undefined;
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const pageCandidates = isServerPaginated
    ? filteredCandidates
    : filteredCandidates.slice(pageStart, pageEnd);
  const paginationTotal = isServerPaginated ? total : filteredCandidates.length;

  const columns = candidateColumns(handleInspectCandidate);

  // -------------------------------------------------------------------------
  // Loading / error states for requisition
  // -------------------------------------------------------------------------

  if (reqState.status === 'loading') {
    return <CandidatesPageSkeleton />;
  }

  if (!safeRequisitionId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Invalid requisition"
          breadcrumbs={[
            { label: 'Dashboard', to: '/dashboard' },
            { label: 'Requisitions', to: '/requisitions' },
          ]}
        />
        <Card>
          <EmptyState
            icon={AlertCircle}
            title="Missing requisition"
            description="A valid requisition identifier is required to view candidates."
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

  // -------------------------------------------------------------------------
  // Build header breadcrumbs & title
  // -------------------------------------------------------------------------

  const reqTitle = requisition?.title ?? 'Requisition';
  const clientName = requisition?.clientName;

  const breadcrumbs = [
    { label: 'Dashboard', to: '/dashboard' },
    { label: 'Requisitions', to: '/requisitions' },
    { label: reqTitle, to: `/requisitions/${safeRequisitionId}` },
    { label: 'Candidates' },
  ];

  // -------------------------------------------------------------------------
  // Candidate directory content
  // -------------------------------------------------------------------------

  const renderCandidateTable = (): React.JSX.Element => {
    if (state.status === 'loading') {
      return (
        <DataTable
          caption="Loading candidates"
          columns={columns}
          rows={[]}
          getRowKey={(row) => row.candidateId}
          loading
          skeletonRows={6}
        />
      );
    }

    if (state.status === 'error') {
      return (
        <ErrorState
          title="Failed to load candidates"
          description={state.message}
          onRetry={() => {
            void reload();
          }}
        />
      );
    }

    if (filteredCandidates.length === 0 && total === 0) {
      return (
        <EmptyState
          icon={Users}
          title="No candidates yet"
          description="Upload resumes to start processing candidates for this requisition. Uploaded resumes will be queued for extraction and AI assessment once candidate consent is active."
          action={
            <Button
              variant="primary"
              onClick={() => {
                setIsUploadOpen(true);
              }}
            >
              <Icon icon={Upload} size="sm" />
              Upload resumes
            </Button>
          }
        />
      );
    }

    if (filteredCandidates.length === 0 && total > 0) {
      return (
        <EmptyState
          icon={Filter}
          title="No candidates match your filter"
          description="Try adjusting your search term or processing status filter to find candidates."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setFilter({ search: '', processing: 'ALL', submission: 'ALL' });
              }}
            >
              Clear filters
            </Button>
          }
        />
      );
    }

    return (
      <>
        <DataTable
          caption={`Candidates for ${reqTitle}`}
          columns={columns}
          rows={pageCandidates}
          getRowKey={(row) => row.candidateId}
        />
        <Pagination
          page={currentPage}
          pageSize={PAGE_SIZE}
          total={paginationTotal}
          onPageChange={(page) => {
            setCurrentPage(page);
          }}
          noun="candidates"
        />
      </>
    );
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader
        title="Candidates"
        description={
          clientName
            ? `${reqTitle} · ${clientName}${total > 0 ? ` · ${total} candidate${total !== 1 ? 's' : ''}` : ''}`
            : reqTitle
        }
        breadcrumbs={breadcrumbs}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                navigate(`/requisitions/${safeRequisitionId}`);
              }}
            >
              <Icon icon={ArrowLeft} size="sm" />
              Requisition
            </Button>

            <Button
              variant="secondary"
              onClick={() => {
                navigate(`/requisitions/${safeRequisitionId}/scorecards`);
              }}
            >
              <Icon icon={ClipboardCheck} size="sm" />
              Scorecards
            </Button>

            <Button
              variant="primary"
              onClick={() => {
                setIsUploadOpen(true);
              }}
            >
              <Icon icon={Upload} size="sm" />
              Upload resumes
            </Button>
          </div>
        }
      />

      {/* Directory card */}
      <Card>
        <CardHeader
          title="Candidate directory"
          description="Resume processing status, AI assessment scores, and recruiter review decisions."
          actions={
            state.status === 'ready' ? (
              <button
                type="button"
                onClick={() => {
                  void reload();
                }}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                aria-label="Refresh candidate list"
              >
                <Icon icon={RefreshCcw} size="xs" />
                Refresh
              </button>
            ) : undefined
          }
        />

        {/* Search and filter controls */}
        <div className="border-b border-border px-4 py-3 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Processing status filter tabs */}
            <div
              role="tablist"
              aria-label="Filter by processing status"
              className="flex flex-wrap gap-1"
            >
              {PROCESSING_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={filter.processing === option.value}
                  onClick={() => {
                    setFilter({ processing: option.value });
                    setCurrentPage(1);
                  }}
                  className={
                    filter.processing === option.value
                      ? 'rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-medium text-accent-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                      : 'rounded-full border border-border bg-surface-muted px-3 py-1 text-xs font-medium text-fg-subtle transition-colors hover:border-accent/50 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>

            {/* Search field */}
            <SearchField
              value={filter.search}
              onValueChange={(value) => {
                setFilter({ search: value });
                setCurrentPage(1);
              }}
              label="Search candidates by code or filename"
              placeholder="Search by code or filename…"
              className="w-full sm:max-w-xs"
            />
          </div>

          {/* Submission status filter tabs */}
          <div
            role="tablist"
            aria-label="Filter by client submission status"
            className="flex flex-wrap items-center gap-1 pt-1 border-t border-border/50"
          >
            <span className="text-[11px] font-medium text-fg-subtle mr-1.5 uppercase tracking-wider">
              Submission:
            </span>
            {SUBMISSION_FILTER_OPTIONS.map((option) => {
              const isSelected = (filter.submission ?? 'ALL') === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => {
                    setFilter({ submission: option.value });
                    setCurrentPage(1);
                  }}
                  className={
                    isSelected
                      ? 'rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                      : 'rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-fg-subtle transition-colors hover:border-primary/50 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Table / states */}
        <CardBody className="p-0">{renderCandidateTable()}</CardBody>
      </Card>

      {/* Consent notice for open requisitions */}
      {state.status === 'ready' && total > 0 ? (
        <div className="rounded-lg border border-info-border bg-info-soft/60 px-4 py-3 text-xs text-fg-subtle">
          <span className="mr-1">
            <Icon
              icon={FileText}
              size="xs"
              className="inline-block align-text-bottom text-info-solid"
            />
          </span>
          <strong className="text-fg">Processing held candidates:</strong> Candidates shown with
          "Queued" status may be awaiting consent. Processing will not begin until candidate consent
          is active. Consent invitation management arrives in a later milestone.
        </div>
      ) : null}

      {/* Upload dialog */}
      <ResumeUploadDialog
        open={isUploadOpen}
        requisitionId={safeRequisitionId}
        onClose={() => {
          setIsUploadOpen(false);
        }}
        onUploadSuccess={handleUploadSuccess}
      />

      {/* Candidate detail & resume inspection drawer */}
      <CandidateDetailDrawer
        open={Boolean(selectedCandidateId)}
        onClose={handleCloseDrawer}
        requisitionId={safeRequisitionId}
        candidateId={selectedCandidateId}
      />
    </div>
  );
}
