import { Briefcase, ClipboardCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';

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
  Skeleton,
  StatusBadge,
} from '../../components/ui/index.js';
import type { Column } from '../../components/ui/index.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { formatShortDate } from '../../lib/format.js';
import { useRequisitions } from '../requisitions/use-requisitions.js';
import type { RequisitionRecord } from '../requisitions/types.js';

export function ScorecardIndexPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { state, requisitions, reload } = useRequisitions();

  const loading = state.status === 'loading';
  const error = state.status === 'error' ? state.message : null;

  const columns: Column<RequisitionRecord>[] = useMemo(
    () => [
      {
        id: 'title',
        header: 'Requisition',
        cell: (item: RequisitionRecord) => (
          <div className="space-y-0.5">
            <span className="font-semibold text-fg">{item.title}</span>
            <p className="text-xs text-fg-subtle">{item.clientName}</p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Requisition Status',
        cell: (item: RequisitionRecord) => <StatusBadge kind="requisition" status={item.status} />,
      },
      {
        id: 'updatedAt',
        header: 'Last Modified',
        cell: (item: RequisitionRecord) => (
          <span className="tabular text-xs text-fg-subtle">{formatShortDate(item.updatedAt)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (item: RequisitionRecord) => (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/requisitions/${item.id}/scorecards`)}
          >
            <Icon icon={ClipboardCheck} size="xs" />
            Manage scorecards
          </Button>
        ),
      },
    ],
    [navigate],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scorecards Directory"
        description="Select a requisition to review, create, or approve assessment scorecard versions."
        breadcrumbs={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Scorecards' }]}
      />

      {loading ? (
        <Card>
          <CardBody>
            <LoadingRegion label="Loading requisitions for scorecard management...">
              <div className="space-y-3 p-4">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </LoadingRegion>
          </CardBody>
        </Card>
      ) : error ? (
        <Card>
          <ErrorState
            title="Failed to load requisitions"
            description={error}
            onRetry={() => void reload()}
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Requisitions Requiring Scorecard Alignment"
            description="All active and draft requisitions managed by your recruiter workspace."
          />
          <CardBody className="p-0">
            {requisitions.length === 0 ? (
              <EmptyState
                icon={Briefcase}
                title="No requisitions available"
                description="Create a job requisition first before configuring scorecard screening criteria."
                action={
                  <Button variant="primary" onClick={() => navigate('/requisitions')}>
                    Go to Requisitions
                  </Button>
                }
              />
            ) : (
              <DataTable<RequisitionRecord>
                caption="Requisitions directory"
                columns={columns}
                rows={requisitions}
                getRowKey={(item) => item.id}
              />
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
