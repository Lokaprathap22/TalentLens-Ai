import {
  Briefcase,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  Inbox,
  LogOut,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useAuthOptional } from '../../app/auth.js';
import { LogoMark, Wordmark } from '../../components/brand.js';
import { Avatar } from '../../components/ui/avatar.js';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DataTable,
  Dialog,
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
import { formatDateParts, formatRelative, formatTimeRange } from '../../lib/format.js';
import { LOW_COVERAGE_THRESHOLD, countByTab, evidenceState, filterQueue } from './review-queue.js';
import type { QueueTab } from './review-queue.js';
import type {
  ActivityItem,
  ActivityKind,
  ClientCandidateReviewItem,
  ClientDashboardData,
  ClientHiringManagerMetrics,
  ClientRecentDecisionItem,
  ClientRequisitionSummary,
  InterviewFormatValue,
  PipelineStage,
  RecruiterDashboardData,
  RecruiterDashboardMetrics,
  RequisitionSummary,
  ReviewQueueItem,
  UpcomingInterview,
} from './types.js';
import { useDashboardData } from './use-dashboard-data.js';

const RAMP_COLORS = [
  'bg-[var(--color-ramp-1)]',
  'bg-[var(--color-ramp-2)]',
  'bg-[var(--color-ramp-3)]',
  'bg-[var(--color-ramp-4)]',
  'bg-[var(--color-ramp-5)]',
  'bg-[var(--color-ramp-6)]',
] as const;

const INTERVIEW_FORMAT_LABELS: Record<InterviewFormatValue, string> = {
  VIDEO: 'Video call',
  PHONE: 'Phone screen',
  IN_PERSON: 'On-site',
};

const ACTIVITY_ICONS: Record<ActivityKind, { icon: LucideIcon; tone: string }> = {
  consent_withdrawn: {
    icon: ShieldAlert,
    tone: 'border-danger-border bg-danger-soft text-danger',
  },
  client_shortlisted: {
    icon: UserCheck,
    tone: 'border-success-border bg-success-soft text-success',
  },
  interview_proposed: {
    icon: Calendar,
    tone: 'border-accent-border bg-accent-soft text-accent-fg',
  },
  review_recorded: {
    icon: ClipboardCheck,
    tone: 'border-border bg-surface-muted text-fg-muted',
  },
  assessment_complete: {
    icon: FileSearch,
    tone: 'border-info-border bg-info-soft text-info',
  },
  submitted: {
    icon: Send,
    tone: 'border-info-border bg-info-soft text-info',
  },
  general: {
    icon: ClipboardCheck,
    tone: 'border-border bg-surface-muted text-fg-muted',
  },
};

const QUEUE_PAGE_SIZE = 4;

function ScoreCoverageCell({ item }: { item: ReviewQueueItem }): React.JSX.Element {
  const state = evidenceState(item);

  if (state === 'FAILED') {
    return <span className="text-xs text-danger">Extraction or scoring failed</span>;
  }

  if (state === 'NOT_ASSESSED') {
    return <span className="text-xs text-fg-subtle">Not scored · awaiting consent</span>;
  }

  if (item.score === null) {
    return (
      <div className="leading-tight">
        <span className="block text-xs font-medium text-warning">
          Insufficient evidence (not scored)
        </span>
        <span className="tabular text-2xs text-fg-subtle">
          {item.coverage !== null
            ? `${item.coverage}% criteria coverage (< ${LOW_COVERAGE_THRESHOLD}% threshold)`
            : 'No verified evidence quotes'}
        </span>
      </div>
    );
  }

  if (item.coverage === null || item.coverage < LOW_COVERAGE_THRESHOLD) {
    return (
      <div className="leading-tight">
        <span className="block text-xs font-medium text-warning">
          Thin evidence · manual check required
        </span>
        <span className="tabular text-2xs text-fg-subtle">
          {item.coverage ?? 0}% coverage · advisory {item.score}/100
        </span>
      </div>
    );
  }

  return (
    <div className="leading-tight">
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-sm font-semibold text-fg">{item.score}</span>
        <span className="text-xs text-fg-subtle">/ 100</span>
      </div>
      <span className="tabular text-2xs text-fg-subtle">{item.coverage}% evidence coverage</span>
    </div>
  );
}

function RecruiterMetricsStrip({
  metrics,
}: {
  metrics: RecruiterDashboardMetrics;
}): React.JSX.Element {
  const cards = [
    {
      label: 'Active requisitions',
      count: metrics.totalActiveRequisitions,
      hint: `${metrics.requisitionsRequiringAttention} requiring attention`,
      tone:
        metrics.requisitionsRequiringAttention > 0 ? 'text-warning font-medium' : 'text-fg-subtle',
    },
    {
      label: 'In pipeline',
      count: metrics.candidatesInPipeline,
      hint: 'Active candidate stages',
      tone: 'text-fg-subtle',
    },
    {
      label: 'Awaiting assessment',
      count: metrics.candidatesAwaitingAssessment,
      hint: 'Pending parsing/scoring',
      tone: 'text-fg-subtle',
    },
    {
      label: 'Awaiting review',
      count: metrics.candidatesAwaitingReview,
      hint:
        metrics.candidatesAwaitingReview > 0 ? 'Recruiter action required' : 'Review queue clear',
      tone: metrics.candidatesAwaitingReview > 0 ? 'text-accent font-medium' : 'text-fg-subtle',
    },
    {
      label: 'With client',
      count: metrics.pendingClientDecisions,
      hint: 'Pending client decision',
      tone: 'text-fg-subtle',
    },
    {
      label: 'Upcoming interviews',
      count: metrics.upcomingConfirmedInterviews,
      hint: 'Confirmed schedule',
      tone: 'text-fg-subtle',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Card
          key={card.label}
          className="p-3.5 transition-all duration-150 hover:border-fg-disabled hover:shadow-xs"
        >
          <p className="text-xs font-medium text-fg-muted truncate">{card.label}</p>
          <p className="mt-1.5 tabular text-2xl font-bold text-fg">{card.count}</p>
          <p className={`mt-0.5 text-2xs truncate ${card.tone}`}>{card.hint}</p>
        </Card>
      ))}
    </div>
  );
}

function PipelineOverview({ stages }: { stages: PipelineStage[] }): React.JSX.Element {
  const total = stages.reduce((sum, stage) => sum + stage.count, 0);

  return (
    <Card labelledBy="pipeline-heading">
      <CardHeader
        title="Hiring pipeline"
        titleId="pipeline-heading"
        description="Active candidate progression across open requisitions"
        actions={
          <span className="tabular text-xs font-medium text-fg-subtle">
            {total} total in active stages
          </span>
        }
      />
      <CardBody className="space-y-4">
        <div
          aria-hidden="true"
          className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
        >
          {total > 0 ? (
            stages.map((stage, index) =>
              stage.count > 0 ? (
                <div
                  key={stage.key}
                  style={{ width: `${(stage.count / total) * 100}%` }}
                  className={RAMP_COLORS[index % RAMP_COLORS.length]}
                />
              ) : null,
            )
          ) : (
            <div className="h-full w-full bg-surface-sunken" />
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {stages.map((stage, index) => (
            <div
              key={stage.key}
              className="rounded-md border border-border bg-surface-muted/45 px-3.5 py-3"
            >
              <dt className="flex items-center gap-2 text-xs font-medium text-fg-muted">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${RAMP_COLORS[index % RAMP_COLORS.length]}`}
                />
                <span className="truncate">{stage.label}</span>
              </dt>
              <dd className="mt-1.5">
                <span className="tabular block text-2xl font-semibold text-fg">{stage.count}</span>
                <span className="mt-0.5 block truncate text-2xs text-fg-subtle">{stage.hint}</span>
              </dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

function ReviewQueueCard({
  items,
  generatedAt,
  onInspect,
  onResetEmptyPreview,
}: {
  items: ReviewQueueItem[];
  generatedAt: string;
  onInspect: (item: ReviewQueueItem) => void;
  onResetEmptyPreview?: (() => void) | undefined;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<QueueTab>('ready');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const counts = useMemo(() => countByTab(items), [items]);
  const filtered = useMemo(() => filterQueue(items, activeTab, query), [items, activeTab, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / QUEUE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedRows = useMemo(
    () => filtered.slice((safePage - 1) * QUEUE_PAGE_SIZE, safePage * QUEUE_PAGE_SIZE),
    [filtered, safePage],
  );

  const columns: Column<ReviewQueueItem>[] = [
    {
      id: 'candidate',
      header: 'Candidate',
      cell: (row) => (
        <div className="min-w-0 space-y-1">
          <div>
            <span className="font-mono text-xs font-semibold text-fg">{row.candidateCode}</span>
            <span className="block max-w-48 truncate text-xs text-fg-subtle md:hidden">
              {row.requisitionTitle}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:hidden">
            <StatusBadge kind="assessment" status={evidenceState(row)} />
            {row.consent !== 'ACTIVE' ? <StatusBadge kind="consent" status={row.consent} /> : null}
          </div>
          <div className="sm:hidden">
            <ScoreCoverageCell item={row} />
          </div>
        </div>
      ),
    },
    {
      id: 'requisition',
      header: 'Requisition',
      showFrom: 'md',
      cell: (row) => <span className="font-medium text-fg">{row.requisitionTitle}</span>,
    },
    {
      id: 'evidence',
      header: 'Assessment & evidence',
      showFrom: 'sm',
      cell: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge kind="assessment" status={evidenceState(row)} />
          {row.consent !== 'ACTIVE' ? (
            <div className="lg:hidden">
              <StatusBadge kind="consent" status={row.consent} />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'score',
      header: 'Advisory score & coverage',
      showFrom: 'sm',
      cell: (row) => <ScoreCoverageCell item={row} />,
    },
    {
      id: 'consent',
      header: 'Consent',
      showFrom: 'lg',
      cell: (row) => <StatusBadge kind="consent" status={row.consent} />,
    },
    {
      id: 'updated',
      header: 'Last activity',
      showFrom: 'xl',
      cell: (row) => (
        <span className="tabular text-xs text-fg-subtle">
          {formatRelative(row.lastActivityAt, generatedAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Review',
      align: 'right',
      cell: (row) => (
        <Button variant="secondary" size="sm" onClick={() => onInspect(row)}>
          Inspect
        </Button>
      ),
    },
  ];

  const tabDescriptions: Record<QueueTab, string> = {
    ready:
      'Candidates with active requisition consent and verified scorecard evidence ready for human review.',
    gaps: 'Assessments with thin evidence (< 60% criteria coverage), missing scores, or failed resume extraction. Missing evidence is never treated as zero ability.',
    consent:
      'Candidates whose requisition-specific consent is still pending or has been withdrawn. Client submission is blocked.',
  };

  return (
    <Card labelledBy="review-queue-heading" className="overflow-hidden">
      <CardHeader
        title="Candidate review queue"
        titleId="review-queue-heading"
        description="AI assessments are advisory. Every shortlist or client submission requires recruiter verification."
        actions={
          <div className="w-full sm:w-64">
            <SearchField
              label="Filter review queue by candidate code or requisition"
              placeholder="Filter candidate or role…"
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
            />
          </div>
        }
      />

      <Tabs
        value={activeTab}
        defaultValue="ready"
        onValueChange={(value) => {
          setActiveTab(value as QueueTab);
          setPage(1);
        }}
      >
        <div className="px-5">
          <TabList label="Review queue categories">
            <Tab value="ready" count={counts.ready}>
              Ready for review
            </Tab>
            <Tab value="gaps" count={counts.gaps}>
              Evidence &amp; parsing gaps
            </Tab>
            <Tab value="consent" count={counts.consent}>
              Consent holds
            </Tab>
          </TabList>
        </div>

        <div className="border-b border-border bg-surface-muted/40 px-5 py-2.5 text-xs text-fg-subtle">
          {tabDescriptions[activeTab]}
        </div>

        <DataTable
          caption="Candidates awaiting recruiter review"
          columns={columns}
          rows={pagedRows}
          getRowKey={(row) => `${row.candidateCode}-${row.requisitionTitle}`}
          empty={
            items.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No candidates in the review queue"
                description="When resumes are uploaded and assessed against a requisition scorecard, they appear here for verification."
                action={
                  onResetEmptyPreview ? (
                    <Button variant="secondary" size="sm" onClick={onResetEmptyPreview}>
                      Load sample queue
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={FileSearch}
                title="No matching candidates in this view"
                description={
                  query.trim()
                    ? `No candidates in this tab match "${query}".`
                    : 'There are currently no candidates in this category.'
                }
                action={
                  query.trim() ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setQuery('');
                        setPage(1);
                      }}
                    >
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />

        <Pagination
          page={safePage}
          pageSize={QUEUE_PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
          noun="candidates"
        />
      </Tabs>
    </Card>
  );
}

function RequisitionsCard({
  requisitions,
}: {
  requisitions: RequisitionSummary[];
}): React.JSX.Element {
  const columns: Column<RequisitionSummary>[] = [
    {
      id: 'role',
      header: 'Requisition',
      cell: (row) => (
        <div>
          <a
            href={`/requisitions/${row.id}`}
            className="font-medium text-fg hover:text-accent hover:underline"
          >
            {row.title}
          </a>
          <p className="text-xs text-fg-subtle">{row.clientName}</p>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge kind="requisition" status={row.status} />,
    },
    {
      id: 'candidates',
      header: 'In pipeline',
      align: 'right',
      showFrom: 'sm',
      cell: (row) => <span className="tabular font-medium text-fg">{row.candidates}</span>,
    },
    {
      id: 'review',
      header: 'To review',
      align: 'right',
      cell: (row) => (
        <span
          className={
            row.awaitingReview > 0
              ? 'tabular font-semibold text-accent-fg'
              : 'tabular text-fg-subtle'
          }
        >
          {row.awaitingReview}
        </span>
      ),
    },
    {
      id: 'client',
      header: 'With client',
      align: 'right',
      showFrom: 'md',
      cell: (row) => <span className="tabular text-fg-muted">{row.withClient}</span>,
    },
  ];

  return (
    <Card labelledBy="requisitions-heading" className="overflow-hidden">
      <CardHeader
        title="Active requisitions"
        titleId="requisitions-heading"
        description="Assigned client roles and current review load"
      />
      <DataTable
        caption="Active requisitions summary"
        columns={columns}
        rows={requisitions}
        getRowKey={(row) => row.id}
        empty={
          <EmptyState
            icon={Briefcase}
            title="No active requisitions"
            description="Create a requisition and attach an approved scorecard to start evaluating candidates."
          />
        }
      />
      <CardFooter className="flex items-center justify-between">
        <span>Scorecards are version-locked per requisition assessment.</span>
        <Badge tone="neutral">Requisitions workspace</Badge>
      </CardFooter>
    </Card>
  );
}

function InterviewsCard({ interviews }: { interviews: UpcomingInterview[] }): React.JSX.Element {
  return (
    <Card labelledBy="interviews-heading">
      <CardHeader
        title="Upcoming interviews"
        titleId="interviews-heading"
        description="Displayed in each interview's stated IANA timezone"
      />
      {interviews.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No upcoming interviews"
          description="Proposed and confirmed client interviews will appear here with timezone-accurate schedules."
        />
      ) : (
        <CardBody className="divide-y divide-border pt-1">
          {interviews.map((interview) => {
            const parts = formatDateParts(interview.startAt, interview.timeZone);
            return (
              <div
                key={interview.id}
                className="flex items-start justify-between gap-3 py-3.5 first:pt-1 last:pb-0"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div
                    aria-hidden="true"
                    className="flex w-12 shrink-0 flex-col items-center rounded-md border border-border bg-surface-muted px-2 py-1.5 text-center"
                  >
                    <span className="text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
                      {parts.month}
                    </span>
                    <span className="tabular text-lg leading-tight font-semibold text-fg">
                      {parts.day}
                    </span>
                    <span className="text-2xs text-fg-subtle">{parts.weekday}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-fg">
                        {interview.candidateCode}
                      </span>
                      <span className="text-xs text-fg-subtle">·</span>
                      <span className="truncate text-sm font-medium text-fg">
                        {interview.requisitionTitle}
                      </span>
                    </div>
                    <p className="mt-1 tabular text-xs text-fg-muted">
                      {formatTimeRange(interview.startAt, interview.endAt, interview.timeZone)}
                      <span className="ml-1.5 text-fg-subtle">({interview.timeZone})</span>
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
                        <Icon icon={Video} size="xs" />
                        {INTERVIEW_FORMAT_LABELS[interview.format]}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="shrink-0">
                  <StatusBadge kind="interview" status={interview.status} />
                </div>
              </div>
            );
          })}
        </CardBody>
      )}
    </Card>
  );
}

function ActivityCard({
  activity,
  generatedAt,
}: {
  activity: ActivityItem[];
  generatedAt: string;
}): React.JSX.Element {
  return (
    <Card labelledBy="activity-heading">
      <CardHeader
        title="Recent workflow activity"
        titleId="activity-heading"
        description="Audit-logged consent, assessment, review, and client events"
        actions={
          activity.length > 0 ? (
            <span className="text-xs tabular text-fg-subtle">
              {activity.length} {activity.length === 1 ? 'event' : 'events'}
            </span>
          ) : undefined
        }
      />
      {activity.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No recent activity"
          description="Consent changes, completed assessments, recruiter reviews, and client decisions are logged here."
        />
      ) : (
        <CardBody className="pt-1 pr-2">
          <div
            tabIndex={0}
            aria-label="Recent workflow activity feed"
            className="max-h-[24rem] overflow-y-auto pr-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ol className="divide-y divide-border">
              {activity.map((entry) => {
                const descriptor = ACTIVITY_ICONS[entry.kind] ?? ACTIVITY_ICONS.general;
                return (
                  <li key={entry.id} className="flex items-start gap-3 py-3 first:pt-1 last:pb-1">
                    <span
                      className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border ${descriptor.tone}`}
                    >
                      <Icon icon={descriptor.icon} size="sm" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-fg break-words [overflow-wrap:anywhere]">
                        {entry.summary}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle break-words">
                        <span>{entry.actor}</span>
                        <span className="mx-1.5">·</span>
                        <span className="tabular">
                          {formatRelative(entry.createdAt, generatedAt)}
                        </span>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

function ClientMetricsStrip({
  metrics,
}: {
  metrics: ClientHiringManagerMetrics;
}): React.JSX.Element {
  const cards = [
    {
      label: 'Awaiting your review',
      count: metrics.pendingCandidateReviews,
      hint: metrics.pendingCandidateReviews > 0 ? 'Decision required' : 'Queue clear',
      icon: Users,
      tone: metrics.pendingCandidateReviews > 0 ? 'text-accent-fg font-medium' : 'text-fg-subtle',
    },
    {
      label: 'Upcoming interviews',
      count: metrics.upcomingConfirmedInterviews,
      hint: 'Confirmed candidate calls',
      icon: Calendar,
      tone: 'text-fg-subtle',
    },
    {
      label: 'Recent decisions',
      count: metrics.recentDecisionsCount,
      hint: 'Recorded candidate decisions',
      icon: CheckCircle2,
      tone: 'text-fg-subtle',
    },
    {
      label: 'Active positions',
      count: metrics.activeRequisitionsCount,
      hint: 'Open hiring roles',
      icon: Briefcase,
      tone: 'text-fg-subtle',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {cards.map((card) => {
        const IconComponent = card.icon;
        return (
          <Card
            key={card.label}
            className="p-4 border-border bg-surface space-y-1 transition-all duration-150 hover:border-fg-disabled hover:shadow-xs"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-subtle truncate">{card.label}</span>
              <IconComponent className="size-4 text-fg-subtle shrink-0" />
            </div>
            <p className="text-2xl font-bold text-fg tabular">{card.count}</p>
            <p className={`text-2xs truncate ${card.tone}`}>{card.hint}</p>
          </Card>
        );
      })}
    </div>
  );
}

function ClientPendingReviewsCard({
  reviews,
  generatedAt,
}: {
  reviews: ClientCandidateReviewItem[];
  generatedAt: string;
}): React.JSX.Element {
  const navigate = useNavigate();

  const columns: Column<ClientCandidateReviewItem>[] = [
    {
      id: 'candidate',
      header: 'Candidate',
      cell: (row) => (
        <div>
          <span className="font-mono text-xs font-semibold text-fg">{row.candidateCode}</span>
          <span className="block text-xs text-fg-subtle md:hidden">{row.requisitionTitle}</span>
        </div>
      ),
    },
    {
      id: 'requisition',
      header: 'Position',
      showFrom: 'md',
      cell: (row) => <span className="font-medium text-fg">{row.requisitionTitle}</span>,
    },
    {
      id: 'score',
      header: 'Advisory evaluation',
      showFrom: 'sm',
      cell: (row) =>
        row.advisoryScore !== null ? (
          <div className="leading-tight">
            <span className="tabular text-sm font-semibold text-fg">{row.advisoryScore}</span>
            <span className="text-xs text-fg-subtle"> / 100</span>
            {row.criteriaCount !== null ? (
              <span className="block tabular text-2xs text-fg-subtle">
                {row.criteriaCount} criteria evaluated
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-fg-subtle">Pending assessment</span>
        ),
    },
    {
      id: 'submitted',
      header: 'Submitted',
      showFrom: 'sm',
      cell: (row) => (
        <span className="tabular text-xs text-fg-subtle">
          {formatRelative(row.submittedAt, generatedAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Action',
      align: 'right',
      cell: () => (
        <Button variant="primary" size="sm" onClick={() => void navigate('/client-portal')}>
          Review submission
        </Button>
      ),
    },
  ];

  return (
    <Card labelledBy="client-reviews-heading" className="overflow-hidden">
      <CardHeader
        title="Candidates awaiting your decision"
        titleId="client-reviews-heading"
        description="Candidates submitted by your recruitment team with verified scorecard evidence."
        actions={
          <span className="tabular text-xs font-medium text-fg-subtle">
            {reviews.length} pending decision
          </span>
        }
      />
      <DataTable
        caption="Candidates submitted for client review"
        columns={columns}
        rows={reviews}
        getRowKey={(row) => row.submissionId}
        empty={
          <EmptyState
            icon={Inbox}
            title="No candidates awaiting review"
            description="When your recruitment partners submit evaluated candidates for your open positions, they will appear here."
            action={
              <Button variant="secondary" size="sm" onClick={() => void navigate('/client-portal')}>
                Go to Submissions
              </Button>
            }
          />
        }
      />
    </Card>
  );
}

function ClientRecentDecisionsCard({
  decisions,
  generatedAt,
}: {
  decisions: ClientRecentDecisionItem[];
  generatedAt: string;
}): React.JSX.Element {
  return (
    <Card labelledBy="recent-decisions-heading">
      <CardHeader
        title="Recent decisions"
        titleId="recent-decisions-heading"
        description="Your team's recorded shortlist, interview, and decline decisions"
      />
      {decisions.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No decisions recorded yet"
          description="Decisions you make on submitted candidates will be tracked here."
        />
      ) : (
        <CardBody className="divide-y divide-border pt-1">
          {decisions.map((item) => (
            <div key={item.id} className="py-3 first:pt-1 last:pb-0 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-fg">
                    {item.candidateCode}
                  </span>
                  <span className="text-xs text-fg-subtle">·</span>
                  <span className="truncate text-xs font-medium text-fg">
                    {item.requisitionTitle}
                  </span>
                </div>
                {item.decision === 'SHORTLIST' ? (
                  <Badge tone="success" dot>
                    Shortlisted
                  </Badge>
                ) : item.decision === 'PROPOSE_INTERVIEW' ? (
                  <Badge tone="accent" dot>
                    Interview
                  </Badge>
                ) : (
                  <Badge tone="neutral" dot>
                    Declined
                  </Badge>
                )}
              </div>
              {item.reason ? (
                <p className="text-xs text-fg-muted italic">&ldquo;{item.reason}&rdquo;</p>
              ) : null}
              <p className="tabular text-2xs text-fg-subtle">
                {formatRelative(item.createdAt, generatedAt)}
              </p>
            </div>
          ))}
        </CardBody>
      )}
    </Card>
  );
}

function ClientRequisitionsCard({
  requisitions,
}: {
  requisitions: ClientRequisitionSummary[];
}): React.JSX.Element {
  const navigate = useNavigate();

  const columns: Column<ClientRequisitionSummary>[] = [
    {
      id: 'title',
      header: 'Position',
      cell: (row) => <span className="font-medium text-fg">{row.title}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge kind="requisition" status={row.status} />,
    },
    {
      id: 'submissions',
      header: 'Active candidates',
      align: 'right',
      cell: (row) => (
        <span className="tabular font-medium text-fg">{row.activeSubmissionsCount}</span>
      ),
    },
    {
      id: 'interviews',
      header: 'Interviews',
      align: 'right',
      cell: (row) => <span className="tabular text-fg-muted">{row.interviewsCount}</span>,
    },
    {
      id: 'actions',
      header: 'View',
      align: 'right',
      cell: () => (
        <Button variant="secondary" size="sm" onClick={() => void navigate('/client-portal')}>
          View
        </Button>
      ),
    },
  ];

  return (
    <Card labelledBy="client-requisitions-heading" className="overflow-hidden">
      <CardHeader
        title="Active positions"
        titleId="client-requisitions-heading"
        description="Open roles currently engaged with your recruitment partners"
      />
      <DataTable
        caption="Active client requisitions"
        columns={columns}
        rows={requisitions}
        getRowKey={(row) => row.id}
        empty={
          <EmptyState
            icon={Briefcase}
            title="No active positions"
            description="Active hiring positions will appear here once opened by your recruitment partner."
          />
        }
      />
    </Card>
  );
}

function DashboardLoadingSkeleton(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading dashboard" className="space-y-6">
      <Card>
        <div className="space-y-4 p-5">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        </div>
      </Card>
      <Card>
        <div className="space-y-4 p-5">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    </LoadingRegion>
  );
}

function CandidatePreviewDialog({
  candidate,
  onClose,
}: {
  candidate: ReviewQueueItem | null;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const state = candidate ? evidenceState(candidate) : 'NOT_ASSESSED';
  const hasWorkspaceTarget = Boolean(candidate?.requisitionId && candidate?.candidateId);

  const handleOpenWorkspace = (): void => {
    onClose();
    if (candidate?.requisitionId && candidate?.candidateId) {
      void navigate(`/requisitions/${candidate.requisitionId}/candidates/${candidate.candidateId}`);
    }
  };

  return (
    <Dialog
      open={candidate !== null}
      onClose={onClose}
      title={candidate ? `Assessment preview · ${candidate.candidateCode}` : 'Assessment preview'}
      description={
        candidate
          ? `${candidate.requisitionTitle} · Recruiter verification checkpoint`
          : 'Recruiter verification checkpoint'
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close preview
          </Button>
          <Button
            variant="primary"
            onClick={hasWorkspaceTarget ? handleOpenWorkspace : onClose}
            title={
              hasWorkspaceTarget
                ? 'Open full candidate details and evidence evaluation workspace'
                : 'Active consent and verified scorecard evidence are required before shortlist or submission'
            }
          >
            {hasWorkspaceTarget ? 'Open candidate workspace' : 'Open full evidence review'}
          </Button>
        </>
      }
    >
      {candidate ? (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted/50 p-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-fg-subtle">Evidence status</p>
              <div className="mt-1">
                <StatusBadge kind="assessment" status={state} />
              </div>
            </div>
            <div>
              <p className="text-xs text-fg-subtle">Requisition consent</p>
              <div className="mt-1">
                <StatusBadge kind="consent" status={candidate.consent} />
              </div>
            </div>
            <div>
              <p className="text-xs text-fg-subtle">Advisory score &amp; coverage</p>
              <div className="mt-1">
                <ScoreCoverageCell item={candidate} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold text-fg">
              Mandatory human review &amp; fairness guardrails
            </h3>
            <ul className="mt-2 space-y-2 text-xs text-fg-muted">
              <li className="flex items-start gap-2">
                <Icon icon={CheckCircle2} size="sm" className="mt-0.5 shrink-0 text-accent" />
                <span>
                  <strong>No automated rejection:</strong> AI scores are strictly advisory. Only an
                  authenticated recruiter or admin can record a review decision or submit a
                  candidate to a client.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Icon icon={CheckCircle2} size="sm" className="mt-0.5 shrink-0 text-accent" />
                <span>
                  <strong>Missing evidence is never zero ability:</strong> Criteria without direct
                  resume quotes remain unscored so formatting gaps do not penalize candidates.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Icon icon={CheckCircle2} size="sm" className="mt-0.5 shrink-0 text-accent" />
                <span>
                  <strong>Consent-gated disclosure:</strong> Candidate processing and client
                  submission are enforced per requisition. Withdrawn or pending consent halts
                  downstream sharing immediately.
                </span>
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function GovernanceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="How TalentLens AI evaluation works"
      description="Core product invariants enforced across the recruiter, client, and candidate workflows"
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Understood
        </Button>
      }
    >
      <div className="space-y-3 text-sm text-fg-muted">
        <p>
          TalentLens AI is designed for explainable, evidence-backed recruitment where human
          recruiters remain accountable for every candidate decision.
        </p>
        <div className="space-y-2 rounded-lg border border-border bg-surface-muted/50 p-3.5 text-xs">
          <p className="font-semibold text-fg">1. Evidence before scores</p>
          <p>
            Every scorecard criterion requires verbatim evidence extracted from the candidate&apos;s
            resume. When coverage falls below {LOW_COVERAGE_THRESHOLD}%, the assessment is flagged
            as <strong>Insufficient evidence</strong> rather than substituting a zero score.
          </p>
          <p className="pt-1 font-semibold text-fg">2. Recruiter review before client visibility</p>
          <p>
            Clients never see unreviewed AI output or internal candidate contact details. Client
            portals display masked candidate references and recruiter-curated submission notes.
          </p>
          <p className="pt-1 font-semibold text-fg">3. Requisition-scoped candidate consent</p>
          <p>
            Consent is tracked per candidate and requisition. Withdrawing consent immediately stops
            assessment queuing and blocks client submission.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function RecruiterDashboardContent({
  data,
  onResetEmptyPreview,
}: {
  data: RecruiterDashboardData;
  onResetEmptyPreview?: (() => void) | undefined;
}): React.JSX.Element {
  const [selectedCandidate, setSelectedCandidate] = useState<ReviewQueueItem | null>(null);

  return (
    <div className="space-y-6">
      <RecruiterMetricsStrip metrics={data.metrics} />

      <PipelineOverview stages={data.pipeline} />

      <ReviewQueueCard
        items={data.reviewQueue}
        generatedAt={data.generatedAt}
        onInspect={setSelectedCandidate}
        onResetEmptyPreview={onResetEmptyPreview}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <RequisitionsCard requisitions={data.requisitions} />
        </div>
        <div className="space-y-6 xl:col-span-5">
          <InterviewsCard interviews={data.interviews} />
          <ActivityCard activity={data.activity} generatedAt={data.generatedAt} />
        </div>
      </div>

      <CandidatePreviewDialog
        candidate={selectedCandidate}
        onClose={() => setSelectedCandidate(null)}
      />
    </div>
  );
}

function ClientDashboardContent({ data }: { data: ClientDashboardData }): React.JSX.Element {
  return (
    <div className="space-y-6">
      <ClientMetricsStrip metrics={data.metrics} />

      <ClientPendingReviewsCard reviews={data.pendingReviews} generatedAt={data.generatedAt} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-7">
          <InterviewsCard interviews={data.upcomingInterviews} />
          <ClientRequisitionsCard requisitions={data.activeRequisitions} />
        </div>
        <div className="space-y-6 xl:col-span-5">
          <ClientRecentDecisionsCard
            decisions={data.recentDecisions}
            generatedAt={data.generatedAt}
          />
          <ActivityCard activity={data.activity} generatedAt={data.generatedAt} />
        </div>
      </div>
    </div>
  );
}

export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuthOptional();
  const user = auth?.state.status === 'authenticated' ? auth.state.user : null;
  const isLoggingOut = auth?.isLoggingOut ?? false;
  const { state, isSample, reload } = useDashboardData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [governanceOpen, setGovernanceOpen] = useState(false);

  const activePreview = searchParams.get('state') ?? 'sample';

  const setPreviewState = (next: string): void => {
    if (next === 'sample') {
      searchParams.delete('state');
      setSearchParams(searchParams, { replace: true });
    } else {
      setSearchParams({ state: next }, { replace: true });
    }
  };

  const handleSignOut = async (): Promise<void> => {
    try {
      if (auth?.logout) {
        await auth.logout();
      }
      void navigate('/login', { replace: true });
    } catch {
      // Handled in auth context
    }
  };

  const isClient =
    user?.role === 'CLIENT_HIRING_MANAGER' ||
    (state.status === 'ready' && state.data.role === 'CLIENT_HIRING_MANAGER');

  if (isClient) {
    return (
      <div className="flex min-h-dvh flex-col bg-canvas">
        {/* Client Portal Header */}
        <header className="border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-3">
                <LogoMark className="size-8" />
                <div className="flex items-baseline gap-2">
                  <Wordmark className="text-base text-fg" />
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent-fg uppercase tracking-wider">
                    Client Portal
                  </span>
                </div>
              </div>

              <nav className="flex items-center gap-2" aria-label="Client Portal Sections">
                <a
                  href="/dashboard"
                  aria-current="page"
                  className="rounded-md bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent-fg"
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
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-muted hover:text-fg"
                >
                  Interviews
                </a>
              </nav>
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 text-right">
                <Avatar name={user?.email ?? ''} size="sm" />
                <div>
                  <p className="text-xs font-medium text-fg">{user?.email}</p>
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

        {/* Main Client Container */}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8 space-y-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-fg">Client Dashboard</h1>
            <p className="mt-1 text-xs text-fg-subtle">
              Active candidate submissions, interview schedules, and hiring decisions for your
              organization.
            </p>
          </div>

          {state.status === 'loading' ? <DashboardLoadingSkeleton /> : null}

          {state.status === 'error' ? (
            <Card>
              <ErrorState
                title="Unable to load dashboard workspace"
                description="The dashboard summary could not be retrieved. Check your connection or retry loading the workspace."
                onRetry={reload}
              />
            </Card>
          ) : null}

          {state.status === 'ready' && state.data.role === 'CLIENT_HIRING_MANAGER' ? (
            <ClientDashboardContent data={state.data} />
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Evidence-backed candidate evaluation and workflow coordination. Recruiter review is required before shortlisting or client submission."
        actions={
          <>
            {isSample ? (
              <Badge tone="accent" icon={Sparkles}>
                Sample data · dev preview
              </Badge>
            ) : null}
            {import.meta.env.DEV ? (
              <div
                role="group"
                aria-label="Preview dashboard state"
                className="inline-flex items-center rounded-md border border-border bg-surface p-0.5 text-xs"
              >
                {(
                  [
                    { id: 'live', label: 'Live' },
                    { id: 'sample', label: 'Sample' },
                    { id: 'empty', label: 'Empty' },
                    { id: 'loading', label: 'Loading' },
                    { id: 'error', label: 'Error' },
                  ] as const
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={activePreview === mode.id}
                    onClick={() => setPreviewState(mode.id)}
                    className={`rounded-xs px-2 py-1 font-medium transition-colors ${
                      activePreview === mode.id
                        ? 'bg-accent-soft text-accent-fg'
                        : 'text-fg-subtle hover:text-fg'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={ShieldCheck}
              onClick={() => setGovernanceOpen(true)}
            >
              Review principles
            </Button>
          </>
        }
      />

      {state.status === 'ready' && isSample ? (
        <div
          role="note"
          aria-label="Sample data disclosure"
          className="mb-5 flex flex-col gap-1.5 rounded-lg border border-accent-border bg-accent-soft/60 px-4 py-2.5 text-xs text-accent-fg sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        >
          <p className="flex items-start gap-2 sm:items-center">
            <Icon icon={Sparkles} size="sm" className="mt-0.5 shrink-0 text-accent sm:mt-0" />
            <span>
              <strong>Sample demonstration data (development only):</strong> All pipeline figures,
              candidate codes (<span className="font-mono">CAN-xxxx</span>), advisory scores, and
              client organizations shown below are deterministic synthetic fixtures — never live
              production metrics.
            </span>
          </p>
          <span className="shrink-0 font-mono text-2xs text-fg-subtle">Dev preview</span>
        </div>
      ) : null}

      {state.status === 'loading' ? <DashboardLoadingSkeleton /> : null}

      {state.status === 'error' ? (
        <Card>
          <ErrorState
            title="Unable to load dashboard workspace"
            description="The dashboard summary could not be retrieved. Check your connection or retry loading the workspace."
            onRetry={reload}
          />
        </Card>
      ) : null}

      {state.status === 'ready' && state.data.role === 'RECRUITER' ? (
        <RecruiterDashboardContent
          data={state.data}
          onResetEmptyPreview={
            activePreview === 'empty' ? () => setPreviewState('sample') : undefined
          }
        />
      ) : null}

      <GovernanceDialog open={governanceOpen} onClose={() => setGovernanceOpen(false)} />
    </div>
  );
}
