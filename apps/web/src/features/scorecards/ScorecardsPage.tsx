import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRegion,
  Skeleton,
  StatusBadge,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { getRequisition } from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import { ScorecardCreationDialog } from './ScorecardCreationDialog.js';
import type { ScorecardRecord } from './types.js';
import { useScorecards } from './use-scorecards.js';

export function ScorecardsPage(): React.JSX.Element {
  const { requisitionId = '' } = useParams<{ requisitionId: string }>();
  const navigate = useNavigate();

  const [requisition, setRequisition] = useState<RequisitionRecord | null>(null);
  const [reqLoading, setReqLoading] = useState<boolean>(true);
  const [reqError, setReqError] = useState<string | null>(null);

  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);

  const {
    scorecards,
    loading: scorecardsLoading,
    error: scorecardsError,
    reload: reloadScorecards,
    approvedScorecard,
  } = useScorecards(requisitionId);

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
        if (!cancelled) {
          setReqError('Failed to load requisition details.');
        }
      } finally {
        if (!cancelled) setReqLoading(false);
      }
    }
    void loadReq();
    return () => {
      cancelled = true;
    };
  }, [requisitionId]);

  const columns: Column<ScorecardRecord>[] = useMemo(
    () => [
      {
        id: 'version',
        header: 'Version',
        cell: (item: ScorecardRecord) => (
          <div className="flex items-center gap-2">
            <span className="font-semibold text-fg">Version {item.version}</span>
            {item.status === 'APPROVED' ? <Badge tone="success">Active</Badge> : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (item: ScorecardRecord) => <StatusBadge kind="scorecard" status={item.status} />,
      },
      {
        id: 'criteriaCount',
        header: 'Criteria',
        cell: (item: ScorecardRecord) => {
          const activeCount = item.criteria.filter((c) => c.active).length;
          return (
            <span className="tabular text-fg-muted">
              {activeCount} active ({item.criteria.length} total)
            </span>
          );
        },
      },
      {
        id: 'totalWeight',
        header: 'Total Weight',
        cell: (item: ScorecardRecord) => {
          const sum = item.criteria.filter((c) => c.active).reduce((acc, c) => acc + c.weight, 0);
          return (
            <span
              className={`tabular font-medium ${sum === 100 ? 'text-success' : 'text-fg-subtle'}`}
            >
              {sum}%
            </span>
          );
        },
      },
      {
        id: 'updatedAt',
        header: 'Last Updated',
        cell: (item: ScorecardRecord) => (
          <span className="tabular text-xs text-fg-subtle">{formatShortDate(item.updatedAt)}</span>
        ),
      },
      {
        id: 'approvedAt',
        header: 'Approved Date',
        cell: (item: ScorecardRecord) => (
          <span className="tabular text-xs text-fg-subtle">
            {item.approvedAt ? formatShortDate(item.approvedAt) : '—'}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (item: ScorecardRecord) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/requisitions/${requisitionId}/scorecards/${item.id}`)}
          >
            {item.status === 'DRAFT' ? 'Edit draft' : 'View criteria'}
            <Icon icon={ExternalLink} size="xs" />
          </Button>
        ),
      },
    ],
    [navigate, requisitionId],
  );

  const initialLoading = reqLoading || scorecardsLoading;
  const initialError = reqError || scorecardsError;

  return (
    <div className="space-y-6">
      <PageHeader
        title={requisition ? `Scorecard Workspace — ${requisition.title}` : 'Scorecard Workspace'}
        description={
          requisition
            ? `Screening requirements and candidate assessment scorecards for ${requisition.clientName}.`
            : 'Screening requirements and candidate assessment criteria.'
        }
        breadcrumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Requisitions', to: '/requisitions' },
          {
            label: requisition?.title ?? 'Requisition',
            to: `/requisitions/${requisitionId}`,
          },
          { label: 'Scorecards' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate(`/requisitions/${requisitionId}`)}>
              <Icon icon={ArrowLeft} size="sm" />
              Requisition
            </Button>
            <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
              <Icon icon={Plus} size="sm" />
              New scorecard version
            </Button>
          </div>
        }
      />

      {initialLoading ? (
        <Card>
          <CardBody>
            <LoadingRegion label="Loading scorecard versions...">
              <div className="space-y-3 p-4">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </LoadingRegion>
          </CardBody>
        </Card>
      ) : initialError ? (
        <Card>
          <ErrorState
            title="Unable to load scorecards"
            description={initialError}
            onRetry={() => void reloadScorecards()}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Active Approved Scorecard Banner */}
          {approvedScorecard ? (
            <Card className="border-success/30 bg-success/5">
              <CardBody className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Icon icon={CheckCircle2} size="sm" className="text-success" />
                    <span className="font-semibold text-fg">
                      Active Approved Scorecard (Version {approvedScorecard.version})
                    </span>
                    <Badge tone="success">In effect</Badge>
                  </div>
                  <p className="text-xs text-fg-muted">
                    Approved{' '}
                    {approvedScorecard.approvedAt
                      ? formatShortDate(approvedScorecard.approvedAt)
                      : 'recently'}{' '}
                    • {approvedScorecard.criteria.filter((c) => c.active).length} active criteria
                    configured for AI candidate screening.
                  </p>
                </div>

                <Button
                  variant="primary"
                  onClick={() =>
                    navigate(`/requisitions/${requisitionId}/scorecards/${approvedScorecard.id}`)
                  }
                >
                  View approved criteria
                  <Icon icon={ExternalLink} size="sm" />
                </Button>
              </CardBody>
            </Card>
          ) : (
            <Card className="border-warning/30 bg-warning/5">
              <CardBody className="p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                    <Icon icon={Sparkles} size="sm" />
                  </div>
                  <div>
                    <p className="font-medium text-xs text-fg">No approved scorecard yet</p>
                    <p className="text-xs text-fg-muted">
                      This requisition cannot be opened for screening until a scorecard version is
                      verified and approved.
                    </p>
                  </div>
                </div>

                <Button variant="secondary" size="sm" onClick={() => setIsCreateOpen(true)}>
                  Generate scorecard
                </Button>
              </CardBody>
            </Card>
          )}

          {/* Scorecard Version History */}
          <Card>
            <CardHeader
              title="Version History"
              description="Historical record of draft, approved, and archived scorecards for this requisition."
            />
            <CardBody className="p-0">
              {scorecards.length === 0 ? (
                <EmptyState
                  icon={ClipboardCheck}
                  title="No scorecards created yet"
                  description="Generate a draft from the job description using AI or build one manually to establish candidate assessment criteria."
                  action={
                    <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
                      <Icon icon={Sparkles} size="sm" />
                      Create first scorecard
                    </Button>
                  }
                />
              ) : (
                <DataTable<ScorecardRecord>
                  caption="Scorecard version history"
                  columns={columns}
                  rows={scorecards}
                  getRowKey={(item) => item.id}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {/* Creation Modal */}
      {requisition ? (
        <ScorecardCreationDialog
          open={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          requisitionId={requisitionId}
          requisitionTitle={requisition.title}
          existingScorecards={scorecards}
          onCreated={(created) => {
            navigate(`/requisitions/${requisitionId}/scorecards/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
