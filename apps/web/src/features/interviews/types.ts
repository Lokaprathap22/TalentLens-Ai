export type InterviewFormat = 'VIDEO' | 'PHONE' | 'IN_PERSON';

export type InterviewProposalStatus =
  'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED';

export type InterviewStatusCategory = 'ALL' | 'UPCOMING' | 'PENDING_ACTION' | 'COMPLETED' | 'PAST';

export interface InterviewItem {
  id: string;
  submissionId: string;
  requisitionId: string;
  requisitionTitle: string;
  clientId: string;
  clientName: string;
  candidateId: string;
  candidateCode: string;
  proposerUserId: string;
  proposerRole: 'RECRUITER' | 'CLIENT_HIRING_MANAGER';
  startAt: string;
  endAt: string;
  timezone: string;
  format: InterviewFormat;
  status: InterviewProposalStatus;
  reason?: string | null | undefined;
  expiresAt?: string | null | undefined;
  canAccept: boolean;
  canReject: boolean;
  canReschedule: boolean;
  canComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewCounts {
  total: number;
  upcoming: number;
  pendingAction: number;
  completed: number;
  rejected: number;
}

export interface ListInterviewsResponse {
  items: InterviewItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: InterviewCounts;
}

export interface ListInterviewsQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  search?: string | undefined;
  status?: InterviewProposalStatus | 'ALL' | undefined;
  statusCategory?: InterviewStatusCategory | undefined;
  clientId?: string | undefined;
  requisitionId?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  sortBy?: ('startAt' | 'createdAt' | 'status') | undefined;
  sortOrder?: ('asc' | 'desc') | undefined;
}

export function formatInterviewSchedule(
  startIso: string,
  endIso: string,
  timeZone: string,
): {
  dateStr: string;
  timeRangeStr: string;
} {
  try {
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);

    const dateStr = startDate.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: timeZone || undefined,
    });

    const timeStart = startDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timeZone || undefined,
    });

    const timeEnd = endDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timeZone || undefined,
    });

    return {
      dateStr,
      timeRangeStr: `${timeStart} – ${timeEnd}`,
    };
  } catch {
    return {
      dateStr: startIso.slice(0, 10),
      timeRangeStr: `${startIso.slice(11, 16)} – ${endIso.slice(11, 16)} (${timeZone})`,
    };
  }
}

export function formatInterviewFormatLabel(format: InterviewFormat): string {
  switch (format) {
    case 'VIDEO':
      return 'Video Call';
    case 'PHONE':
      return 'Phone Call';
    case 'IN_PERSON':
      return 'In Person';
    default:
      return format;
  }
}
