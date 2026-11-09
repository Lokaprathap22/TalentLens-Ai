import { ArrowLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';

import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { PageHeader } from '../../layouts/PageHeader.js';
import { useRequisitionDetail } from '../requisitions/use-requisition-detail.js';
import { CandidateDetailView } from './CandidateDetailView.js';

export function CandidateDetailPage(): React.JSX.Element {
  const { requisitionId, candidateId } = useParams<{
    requisitionId: string;
    candidateId: string;
  }>();
  const navigate = useNavigate();

  const safeRequisitionId = requisitionId ?? '';
  const safeCandidateId = candidateId ?? '';

  const { requisition } = useRequisitionDetail(safeRequisitionId);

  const backUrl = `/requisitions/${encodeURIComponent(safeRequisitionId)}/candidates`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Candidate Inspection"
        description="Inspect candidate extraction, original CV document, and AI screening criteria."
        breadcrumbs={[
          { label: 'Dashboard', to: '/dashboard' },
          { label: 'Requisitions', to: '/requisitions' },
          {
            label: requisition?.title ?? 'Requisition',
            to: `/requisitions/${safeRequisitionId}`,
          },
          {
            label: 'Candidates',
            to: backUrl,
          },
          { label: 'Inspection' },
        ]}
        actions={
          <Button variant="secondary" size="sm" onClick={() => navigate(backUrl)}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back to Candidates
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <CandidateDetailView
          requisitionId={safeRequisitionId}
          candidateId={safeCandidateId}
          onClose={() => navigate(backUrl)}
        />
      </Card>
    </div>
  );
}
