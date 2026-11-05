import { Badge } from './badge.js';
import type { BadgeTone } from './badge.js';

interface StatusDescriptor {
  label: string;
  tone: BadgeTone;
}

/**
 * Domain status → label/tone mapping. Status keys mirror the backend enums
 * (AssessmentStatus, SubmissionStatus, InterviewProposalStatus, RequisitionStatus,
 * ConsentStatus) so API wiring can pass values straight through.
 */
const catalogue = {
  assessment: {
    COMPLETE: { label: 'Assessed', tone: 'success' },
    NEEDS_REVIEW: { label: 'Evidence needs review', tone: 'warning' },
    FAILED: { label: 'Assessment failed', tone: 'danger' },
    INSUFFICIENT_EVIDENCE: { label: 'Insufficient evidence', tone: 'warning' },
    NOT_ASSESSED: { label: 'Not assessed', tone: 'neutral' },
  },
  consent: {
    ACTIVE: { label: 'Consent active', tone: 'success' },
    PENDING: { label: 'Awaiting consent', tone: 'info' },
    WITHDRAWN: { label: 'Consent withdrawn', tone: 'danger' },
    EXPIRED: { label: 'Consent expired', tone: 'neutral' },
  },
  submission: {
    SUBMITTED: { label: 'With client', tone: 'info' },
    CLIENT_SHORTLISTED: { label: 'Client shortlisted', tone: 'success' },
    CLIENT_REJECTED: { label: 'Client declined', tone: 'neutral' },
    INTERVIEW_PROPOSED: { label: 'Interview proposed', tone: 'accent' },
    WITHDRAWN: { label: 'Withdrawn', tone: 'danger' },
  },
  interview: {
    PROPOSED: { label: 'Awaiting response', tone: 'warning' },
    ACCEPTED: { label: 'Confirmed', tone: 'success' },
    REJECTED: { label: 'Declined', tone: 'neutral' },
    RESCHEDULED: { label: 'Rescheduled', tone: 'info' },
    COMPLETED: { label: 'Completed', tone: 'neutral' },
    CANCELLED: { label: 'Cancelled', tone: 'danger' },
  },
  requisition: {
    DRAFT: { label: 'Draft', tone: 'neutral' },
    OPEN: { label: 'Open', tone: 'success' },
    PAUSED: { label: 'Paused', tone: 'warning' },
    CLOSED: { label: 'Closed', tone: 'neutral' },
    FILLED: { label: 'Filled', tone: 'accent' },
  },
  client: {
    ACTIVE: { label: 'Active', tone: 'success' },
    INACTIVE: { label: 'Inactive', tone: 'neutral' },
  },
} as const satisfies Record<string, Record<string, StatusDescriptor>>;

type Catalogue = typeof catalogue;
export type StatusKind = keyof Catalogue;
export type StatusOf<K extends StatusKind> = keyof Catalogue[K];

export function describeStatus<K extends StatusKind>(
  kind: K,
  status: StatusOf<K>,
): StatusDescriptor {
  return catalogue[kind][status] as StatusDescriptor;
}

export function StatusBadge<K extends StatusKind>({
  kind,
  status,
}: {
  kind: K;
  status: StatusOf<K>;
}): React.JSX.Element {
  const { label, tone } = describeStatus(kind, status);
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}
