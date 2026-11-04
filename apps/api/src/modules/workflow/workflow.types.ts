import type {
  ClientDecisionType,
  InterviewFormat,
  InterviewProposalStatus,
  PipelineStage,
  ReviewDecision,
  SubmissionStatus,
  UserRole,
} from '@talentlens/database';

export type {
  ClientDecisionType,
  InterviewFormat,
  InterviewProposalStatus,
  PipelineStage,
  ReviewDecision,
  SubmissionStatus,
  UserRole,
};

export interface WorkflowErrorDetails {
  code: string;
  message: string;
  statusCode: number;
}
