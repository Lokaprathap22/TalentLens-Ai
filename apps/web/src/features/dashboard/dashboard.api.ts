import { listClients } from '../clients/client.api.js';
import { listRequisitions } from '../requisitions/requisition.api.js';
import { listCandidates } from '../candidates/candidate.api.js';
import type {
  ActivityItem,
  AssessmentStatusValue,
  ConsentStatusValue,
  DashboardData,
  PipelineStage,
  RequisitionSummary,
  ReviewQueueItem,
} from './types.js';
import type { CandidateSummary } from '../candidates/types.js';

const CANDIDATE_PAGE_LIMIT = 100;

/**
 * Paginates across all candidate pages for a requisition to guarantee complete
 * dashboard metric aggregation rather than truncating at the first page.
 */
async function fetchAllCandidatesForRequisition(
  requisitionId: string,
  signal?: AbortSignal,
): Promise<CandidateSummary[]> {
  const allCandidates: CandidateSummary[] = [];
  let offset = 0;

  while (true) {
    const res = await listCandidates(
      requisitionId,
      { limit: CANDIDATE_PAGE_LIMIT, offset },
      signal,
    );
    allCandidates.push(...res.items);
    offset += res.items.length;

    if (res.items.length === 0 || offset >= res.total) {
      break;
    }
  }

  return allCandidates;
}

export async function fetchLiveDashboardData(signal?: AbortSignal): Promise<DashboardData> {
  const [clients, requisitions] = await Promise.all([
    listClients(signal),
    listRequisitions(signal),
  ]);

  const clientMap = new Map<string, string>();
  for (const client of clients) {
    clientMap.set(client.id, client.name);
  }

  // Load complete candidate summaries across all pages for each requisition
  const candidateResults = await Promise.all(
    requisitions.map(async (req) => {
      try {
        const candidates = await fetchAllCandidatesForRequisition(req.id, signal);
        return { req, candidates };
      } catch {
        return { req, candidates: [] as CandidateSummary[] };
      }
    }),
  );

  const allCandidatesWithReq: Array<{
    req: (typeof requisitions)[0];
    candidate: CandidateSummary;
  }> = [];
  const requisitionSummaries: RequisitionSummary[] = [];

  for (const { req, candidates } of candidateResults) {
    for (const candidate of candidates) {
      allCandidatesWithReq.push({ req, candidate });
    }

    requisitionSummaries.push({
      id: req.id,
      title: req.title,
      clientName: clientMap.get(req.clientId) ?? 'Unknown Client',
      status: req.status === 'OPEN' ? 'OPEN' : 'PAUSED',
      candidates: candidates.length,
      awaitingReview: candidates.filter(
        (c) =>
          c.reviewStatus === 'NOT_REVIEWED' &&
          (c.isComplete || c.assessmentStatus === 'COMPLETE' || c.assessmentStatus === 'COMPLETED'),
      ).length,
      withClient: candidates.filter((c) => Boolean(c.submissionId)).length,
    });
  }

  // Pipeline counts derived from actual candidates
  const newIntakeCount = allCandidatesWithReq.filter(
    ({ candidate }) =>
      candidate.parseStatus === 'PENDING' || candidate.parseStatus === 'PROCESSING',
  ).length;

  // Reconciled consent hold state: handles both HELD_FOR_AUTHORIZATION (Postgres job enum) and HELD_FOR_CONSENT
  const consentHoldCount = allCandidatesWithReq.filter(
    ({ candidate }) =>
      candidate.parseStatus === 'HELD_FOR_AUTHORIZATION' ||
      candidate.parseStatus === 'HELD_FOR_CONSENT',
  ).length;

  // Reconciled assessment state: handles COMPLETE (canonical Prisma enum) and COMPLETED
  const assessedCount = allCandidatesWithReq.filter(
    ({ candidate }) =>
      (candidate.assessmentStatus === 'COMPLETE' ||
        candidate.assessmentStatus === 'COMPLETED' ||
        candidate.assessmentStatus === 'NEEDS_REVIEW') &&
      candidate.reviewStatus === 'NOT_REVIEWED',
  ).length;

  // Active recruiter review stage: candidates with active review decision (REVIEWED or flagged NEEDS_REVIEW).
  // Closed applications are excluded from active pipeline progression.
  const reviewCount = allCandidatesWithReq.filter(
    ({ candidate }) =>
      (candidate.reviewStatus === 'REVIEWED' || candidate.reviewStatus === 'NEEDS_REVIEW') &&
      !candidate.isShortlisted,
  ).length;

  const shortlistedCount = allCandidatesWithReq.filter(
    ({ candidate }) => candidate.isShortlisted && !candidate.submissionId,
  ).length;

  const withClientCount = allCandidatesWithReq.filter(({ candidate }) =>
    Boolean(candidate.submissionId),
  ).length;

  const pipeline: PipelineStage[] = [
    {
      key: 'new',
      label: 'Intake & parsed',
      count: newIntakeCount,
      hint: 'Resumes awaiting assessment',
    },
    {
      key: 'consent',
      label: 'Consent holds',
      count: consentHoldCount,
      hint: 'Awaiting candidate consent',
    },
    {
      key: 'assessed',
      label: 'Assessed',
      count: assessedCount,
      hint: 'Scored against scorecard',
    },
    {
      key: 'review',
      label: 'Recruiter review',
      count: reviewCount,
      hint: 'Reviewed, pending shortlist',
    },
    {
      key: 'shortlisted',
      label: 'Shortlisted',
      count: shortlistedCount,
      hint: 'Approved for submission',
    },
    {
      key: 'client',
      label: 'With client',
      count: withClientCount,
      hint: 'Submitted for client review',
    },
  ];

  // Review Queue Items
  const reviewQueue: ReviewQueueItem[] = allCandidatesWithReq.map(({ req, candidate }) => {
    let assessmentStatus: AssessmentStatusValue = 'NOT_ASSESSED';
    if (candidate.assessmentStatus === 'COMPLETE' || candidate.assessmentStatus === 'COMPLETED') {
      assessmentStatus = 'COMPLETE';
    } else if (candidate.assessmentStatus === 'NEEDS_REVIEW') {
      assessmentStatus = 'NEEDS_REVIEW';
    } else if (candidate.assessmentStatus === 'FAILED' || candidate.parseStatus === 'FAILED') {
      assessmentStatus = 'FAILED';
    }

    const consent: ConsentStatusValue =
      candidate.parseStatus === 'HELD_FOR_AUTHORIZATION' ||
      candidate.parseStatus === 'HELD_FOR_CONSENT'
        ? 'PENDING'
        : 'ACTIVE';

    return {
      candidateId: candidate.candidateId,
      requisitionId: req.id,
      candidateCode: candidate.candidateCode,
      requisitionTitle: req.title,
      assessmentStatus,
      score: candidate.overallScore,
      coverage: candidate.coverage !== null ? Math.round(candidate.coverage * 100) : null,
      consent,
      lastActivityAt: candidate.lastActivityAt,
    };
  });

  // Recent workflow activity
  const activities: ActivityItem[] = [];
  for (const { req, candidate } of allCandidatesWithReq) {
    if (candidate.submissionStatus === 'CLIENT_SHORTLISTED') {
      activities.push({
        id: `act-${candidate.candidateId}-client-shortlist`,
        kind: 'client_shortlisted',
        summary: `${candidate.candidateCode} shortlisted by client for ${req.title}`,
        actor: 'Client Hiring Manager',
        createdAt: candidate.lastActivityAt,
      });
    } else if (candidate.submissionId) {
      activities.push({
        id: `act-${candidate.candidateId}-sub`,
        kind: 'submitted',
        summary: `${candidate.candidateCode} submitted to client for ${req.title}`,
        actor: 'Recruiter',
        createdAt: candidate.submittedAt ?? candidate.lastActivityAt,
      });
    } else if (candidate.isShortlisted) {
      activities.push({
        id: `act-${candidate.candidateId}-shortlist`,
        kind: 'client_shortlisted',
        summary: `${candidate.candidateCode} shortlisted for ${req.title}`,
        actor: 'Recruiter',
        createdAt: candidate.shortlistedAt ?? candidate.lastActivityAt,
      });
    } else if (
      candidate.reviewStatus === 'REVIEWED' ||
      candidate.reviewStatus === 'NEEDS_REVIEW' ||
      candidate.reviewStatus === 'CLOSED'
    ) {
      activities.push({
        id: `act-${candidate.candidateId}-review`,
        kind: 'review_recorded',
        summary: `Recruiter review recorded for ${candidate.candidateCode}`,
        actor: 'Recruiter',
        createdAt: candidate.reviewedAt ?? candidate.lastActivityAt,
      });
    } else if (
      candidate.isComplete ||
      candidate.assessmentStatus === 'COMPLETE' ||
      candidate.assessmentStatus === 'COMPLETED'
    ) {
      activities.push({
        id: `act-${candidate.candidateId}-assess`,
        kind: 'assessment_complete',
        summary: `Assessment complete for ${candidate.candidateCode} (${candidate.overallScore ?? 0}/100)`,
        actor: 'TalentLens AI',
        createdAt: candidate.lastActivityAt,
      });
    }
  }

  // Sort activities newest first and clamp to 10
  activities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    generatedAt: new Date().toISOString(),
    pipeline,
    requisitions: requisitionSummaries,
    reviewQueue,
    interviews: [],
    activity: activities.slice(0, 10),
  };
}
