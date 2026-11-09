import { ApiError, apiClient } from '../../lib/api-client.js';
import type {
  ActivityItem,
  ActivityKind,
  ClientCandidateReviewItem,
  ClientDashboardData,
  ClientRecentDecisionItem,
  ClientRequisitionSummary,
  DashboardData,
  InterviewFormatValue,
  InterviewStatusValue,
  PipelineStage,
  RecruiterDashboardData,
  RequisitionSummary,
  ReviewQueueItem,
  UpcomingInterview,
} from './types.js';

interface RawInterviewProposalItem {
  id: string;
  candidateCode: string;
  requisitionTitle: string;
  startAt: string;
  endAt: string;
  timezone?: string | null | undefined;
  format: InterviewFormatValue;
  status: InterviewStatusValue | string;
}

interface RawAuditActivityItem {
  id: string;
  kind?: string | undefined;
  summary: string;
  actor: string;
  createdAt: string;
}

interface RawRecruiterSummaryResponse {
  role: 'RECRUITER';
  generatedAt: string;
  metrics: {
    totalActiveRequisitions: number;
    requisitionsRequiringAttention: number;
    candidatesInPipeline: number;
    candidatesAwaitingAssessment: number;
    candidatesAwaitingReview: number;
    pendingClientDecisions: number;
    upcomingConfirmedInterviews: number;
  };
  pipelineStages: Array<{
    key: string;
    label: string;
    count: number;
    hint: string;
  }>;
  recentRequisitions: Array<{
    id: string;
    title: string;
    clientName: string;
    status: 'OPEN' | 'PAUSED';
    candidatesCount: number;
    awaitingReviewCount: number;
    withClientCount: number;
    updatedAt: string;
  }>;
  reviewQueue: Array<{
    candidateId?: string | undefined;
    requisitionId?: string | undefined;
    candidateCode: string;
    requisitionTitle: string;
    assessmentStatus: 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED' | 'NOT_ASSESSED';
    score: number | null;
    coverage: number | null;
    consent: 'ACTIVE' | 'PENDING' | 'WITHDRAWN';
    lastActivityAt: string;
  }>;
  upcomingInterviews: RawInterviewProposalItem[];
  recentActivity: RawAuditActivityItem[];
}

interface RawClientSummaryResponse {
  role: 'CLIENT_HIRING_MANAGER';
  generatedAt: string;
  metrics: {
    pendingCandidateReviews: number;
    submittedAwaitingDecisions: number;
    upcomingConfirmedInterviews: number;
    recentDecisionsCount: number;
    activeRequisitionsCount: number;
  };
  pendingReviews: ClientCandidateReviewItem[];
  upcomingInterviews: RawInterviewProposalItem[];
  recentDecisions: ClientRecentDecisionItem[];
  activeRequisitions: ClientRequisitionSummary[];
  recentActivity: RawAuditActivityItem[];
}

type RawDashboardSummaryResponse = RawRecruiterSummaryResponse | RawClientSummaryResponse;

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

export function isDashboardSummaryResponse(value: unknown): value is RawDashboardSummaryResponse {
  if (!isObject(value)) {
    return false;
  }

  const role = value['role'];
  if (role !== 'RECRUITER' && role !== 'CLIENT_HIRING_MANAGER') {
    return false;
  }

  if (typeof value['generatedAt'] !== 'string') {
    return false;
  }

  if (!isObject(value['metrics'])) {
    return false;
  }

  if (role === 'RECRUITER') {
    return (
      Array.isArray(value['pipelineStages']) &&
      Array.isArray(value['recentRequisitions']) &&
      Array.isArray(value['reviewQueue']) &&
      Array.isArray(value['upcomingInterviews']) &&
      Array.isArray(value['recentActivity'])
    );
  }

  if (role === 'CLIENT_HIRING_MANAGER') {
    return (
      Array.isArray(value['pendingReviews']) &&
      Array.isArray(value['upcomingInterviews']) &&
      Array.isArray(value['recentDecisions']) &&
      Array.isArray(value['activeRequisitions']) &&
      Array.isArray(value['recentActivity'])
    );
  }

  return false;
}

function mapInterviewDtoToUpcomingInterview(dto: RawInterviewProposalItem): UpcomingInterview {
  return {
    id: dto.id,
    candidateCode: dto.candidateCode,
    requisitionTitle: dto.requisitionTitle,
    startAt: dto.startAt,
    endAt: dto.endAt,
    timeZone: dto.timezone || 'UTC',
    format: dto.format,
    status: dto.status === 'ACCEPTED' ? 'ACCEPTED' : 'PROPOSED',
  };
}

function mapActivityDtoToActivityItem(dto: RawAuditActivityItem): ActivityItem {
  const validKinds: ActivityKind[] = [
    'consent_withdrawn',
    'client_shortlisted',
    'interview_proposed',
    'review_recorded',
    'assessment_complete',
    'submitted',
    'general',
  ];
  const kind: ActivityKind =
    typeof dto.kind === 'string' && (validKinds as string[]).includes(dto.kind)
      ? (dto.kind as ActivityKind)
      : 'general';

  return {
    id: dto.id,
    kind,
    summary: dto.summary,
    actor: dto.actor,
    createdAt: dto.createdAt,
  };
}

/**
 * Fetches the authoritative, aggregated, role-aware dashboard summary from the backend:
 * GET /api/v1/dashboard/summary
 *
 * Avoids N+1 waterfalls by retrieving all operational metrics, review queue items,
 * upcoming interviews, and recent activity in a single optimized request.
 */
export async function fetchLiveDashboardData(signal?: AbortSignal): Promise<DashboardData> {
  const response = await apiClient.get<unknown>(
    '/dashboard/summary',
    signal !== undefined ? { signal } : {},
  );

  if (!isDashboardSummaryResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected dashboard summary response from the server.',
    });
  }

  if (response.role === 'CLIENT_HIRING_MANAGER') {
    const clientData: ClientDashboardData = {
      role: 'CLIENT_HIRING_MANAGER',
      generatedAt: response.generatedAt,
      metrics: response.metrics,
      pendingReviews: response.pendingReviews,
      upcomingInterviews: response.upcomingInterviews.map(mapInterviewDtoToUpcomingInterview),
      recentDecisions: response.recentDecisions,
      activeRequisitions: response.activeRequisitions,
      activity: response.recentActivity.map(mapActivityDtoToActivityItem),
    };
    return clientData;
  }

  const recruiterData: RecruiterDashboardData = {
    role: 'RECRUITER',
    generatedAt: response.generatedAt,
    metrics: response.metrics,
    pipeline: response.pipelineStages.map((s): PipelineStage => ({
      key: s.key,
      label: s.label,
      count: s.count,
      hint: s.hint,
    })),
    requisitions: response.recentRequisitions.map((r): RequisitionSummary => ({
      id: r.id,
      title: r.title,
      clientName: r.clientName,
      status: r.status,
      candidates: r.candidatesCount,
      awaitingReview: r.awaitingReviewCount,
      withClient: r.withClientCount,
    })),
    reviewQueue: response.reviewQueue.map((item): ReviewQueueItem => ({
      candidateId: item.candidateId,
      requisitionId: item.requisitionId,
      candidateCode: item.candidateCode,
      requisitionTitle: item.requisitionTitle,
      assessmentStatus: item.assessmentStatus,
      score: item.score,
      coverage: item.coverage,
      consent: item.consent,
      lastActivityAt: item.lastActivityAt,
    })),
    interviews: response.upcomingInterviews.map(mapInterviewDtoToUpcomingInterview),
    activity: response.recentActivity.map(mapActivityDtoToActivityItem),
  };

  return recruiterData;
}
