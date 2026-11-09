export type AssessmentStatusValue = 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED' | 'NOT_ASSESSED';
export type ConsentStatusValue = 'ACTIVE' | 'PENDING' | 'WITHDRAWN';
export type RequisitionStatusValue = 'OPEN' | 'PAUSED';
export type InterviewStatusValue = 'PROPOSED' | 'ACCEPTED';
export type InterviewFormatValue = 'VIDEO' | 'PHONE' | 'IN_PERSON';

export interface PipelineStage {
  key: string;
  label: string;
  count: number;
  hint: string;
}

export interface RequisitionSummary {
  id: string;
  title: string;
  clientName: string;
  status: RequisitionStatusValue;
  candidates: number;
  awaitingReview: number;
  withClient: number;
}

export interface ReviewQueueItem {
  candidateId?: string | undefined;
  requisitionId?: string | undefined;
  /** Recruiters see the internal candidate code, never client-facing references. */
  candidateCode: string;
  requisitionTitle: string;
  assessmentStatus: AssessmentStatusValue;
  /** Null when there is not enough evidence to score. Never substitute zero. */
  score: number | null;
  /** Share (0–100) of scorecard criteria with verified evidence. */
  coverage: number | null;
  consent: ConsentStatusValue;
  lastActivityAt: string;
}

export interface UpcomingInterview {
  id: string;
  candidateCode: string;
  requisitionTitle: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  format: InterviewFormatValue;
  status: InterviewStatusValue;
}

export type ActivityKind =
  | 'consent_withdrawn'
  | 'client_shortlisted'
  | 'interview_proposed'
  | 'review_recorded'
  | 'assessment_complete'
  | 'submitted'
  | 'general';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  summary: string;
  actor: string;
  createdAt: string;
}

export interface RecruiterDashboardMetrics {
  totalActiveRequisitions: number;
  requisitionsRequiringAttention: number;
  candidatesInPipeline: number;
  candidatesAwaitingAssessment: number;
  candidatesAwaitingReview: number;
  pendingClientDecisions: number;
  upcomingConfirmedInterviews: number;
}

export interface ClientHiringManagerMetrics {
  pendingCandidateReviews: number;
  submittedAwaitingDecisions: number;
  upcomingConfirmedInterviews: number;
  recentDecisionsCount: number;
  activeRequisitionsCount: number;
}

export interface ClientCandidateReviewItem {
  submissionId: string;
  candidateCode: string;
  requisitionId: string;
  requisitionTitle: string;
  clientId: string;
  clientName: string;
  submittedAt: string;
  advisoryScore: number | null;
  criteriaCount: number | null;
  status: 'SUBMITTED' | 'INTERVIEW_PROPOSED' | 'CLIENT_SHORTLISTED' | 'CLIENT_REJECTED';
}

export interface ClientRecentDecisionItem {
  id: string;
  decision: 'SHORTLIST' | 'REJECT' | 'PROPOSE_INTERVIEW';
  reason: string | null;
  candidateCode: string;
  requisitionTitle: string;
  createdAt: string;
}

export interface ClientRequisitionSummary {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  status: 'OPEN' | 'PAUSED';
  activeSubmissionsCount: number;
  interviewsCount: number;
}

export interface RecruiterDashboardData {
  role: 'RECRUITER';
  generatedAt: string;
  metrics: RecruiterDashboardMetrics;
  pipeline: PipelineStage[];
  requisitions: RequisitionSummary[];
  reviewQueue: ReviewQueueItem[];
  interviews: UpcomingInterview[];
  activity: ActivityItem[];
}

export interface ClientDashboardData {
  role: 'CLIENT_HIRING_MANAGER';
  generatedAt: string;
  metrics: ClientHiringManagerMetrics;
  pendingReviews: ClientCandidateReviewItem[];
  upcomingInterviews: UpcomingInterview[];
  recentDecisions: ClientRecentDecisionItem[];
  activeRequisitions: ClientRequisitionSummary[];
  activity: ActivityItem[];
}

export type DashboardData = RecruiterDashboardData | ClientDashboardData;
