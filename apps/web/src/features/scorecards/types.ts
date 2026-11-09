export type ScorecardStatus = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

export type CriterionCategory =
  'SKILL' | 'EXPERIENCE' | 'NOTICE' | 'COMPENSATION' | 'OTHER_JOB_RELATED';

export type RequirementType = 'MUST_HAVE' | 'PREFERRED';

export type EvidenceVerificationStatus =
  'PENDING_RECRUITER_REVIEW' | 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';

export interface ScorecardCriterionEvidence {
  sourceQuote: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  verificationStatus: EvidenceVerificationStatus;
}

export interface ScorecardCriterionRecord {
  id: string;
  key: string;
  label: string;
  description: string;
  category: CriterionCategory;
  requirementType: RequirementType;
  weight: number;
  displayOrder: number;
  active: boolean;
  evidence: ScorecardCriterionEvidence | null;
}

export interface ScorecardRecord {
  id: string;
  requisitionId: string;
  version: number;
  status: ScorecardStatus;
  weights: Record<string, unknown>;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  criteria: ScorecardCriterionRecord[];
}

export type ScorecardCreationMode = 'ai' | 'manual' | 'clone';

export interface CreateScorecardDraftInput {
  mode?: 'ai' | 'manual' | undefined;
  cloneFromVersionId?: string | undefined;
}

export interface CriterionInput {
  id?: string | undefined;
  key?: string | undefined;
  label: string;
  description?: string | undefined;
  category: CriterionCategory;
  requirementType: RequirementType;
  weight: number;
  displayOrder: number;
  active?: boolean | undefined;
  evidence?: ScorecardCriterionEvidence | undefined;
}

export interface UpdateScorecardInput {
  weights?: Record<string, number> | undefined;
  criteria?: CriterionInput[] | undefined;
}

export interface ScorecardResponseDto {
  scorecard: ScorecardRecord;
}

export interface ListScorecardsResponseDto {
  scorecards: ScorecardRecord[];
}

export interface ApprovalReadinessCheck {
  hasActiveCriteria: boolean;
  hasMustHaveCriterion: boolean;
  weightsSumTo100: boolean;
  totalActiveWeight: number;
  allActiveEvidenceVerified: boolean;
  unverifiedCount: number;
  isReady: boolean;
  blockingReasons: string[];
}
