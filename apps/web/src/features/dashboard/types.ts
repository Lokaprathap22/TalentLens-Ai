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
  | 'submitted';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  summary: string;
  actor: string;
  createdAt: string;
}

export interface DashboardData {
  /** Reference instant used for relative times. */
  generatedAt: string;
  pipeline: PipelineStage[];
  requisitions: RequisitionSummary[];
  reviewQueue: ReviewQueueItem[];
  interviews: UpcomingInterview[];
  activity: ActivityItem[];
}
