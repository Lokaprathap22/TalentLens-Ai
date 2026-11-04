import type {
  AssessmentStatus,
  CriterionAssessmentStatus,
  ProcessingJobStatus,
  VerificationMethod,
} from '@talentlens/database';

export interface ScorecardCriterionDefinition {
  id: string;
  key: string;
  label: string;
  category: string;
  requirementType: 'MUST_HAVE' | 'PREFERRED';
  weight: number;
  minScore?: number | undefined;
  maxScore?: number | undefined;
  description?: string | undefined;
}

export interface AssessmentProviderInput {
  jobTitle: string;
  criteria: ScorecardCriterionDefinition[];
  resumeText: string;
}

export interface AssessmentCriterionOutput {
  criterionId: string;
  status: 'MATCH' | 'PARTIAL' | 'NOT_FOUND' | 'UNCERTAIN';
  score: number | null; // normalized 0.0 to 1.0 (or within criterion scale), or null if NOT_FOUND
  explanation: string;
  evidenceQuotes: string[]; // exact verbatim excerpts from resumeText
}

export interface AssessmentProviderOutput {
  criteria: AssessmentCriterionOutput[];
  model: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  tokenUsage?:
    | {
        promptTokens?: number | undefined;
        completionTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
}

export interface AssessmentProvider {
  assess(input: AssessmentProviderInput): Promise<AssessmentProviderOutput>;
}

export interface VerifiedEvidenceSnippet {
  quote: string;
  pageNumber: number | null;
  startOffset: number;
  endOffset: number;
  verified: boolean;
  verificationMethod: VerificationMethod;
}

export interface VerifiedCriterionResult {
  criterionId: string;
  scorecardVersionId: string;
  status: CriterionAssessmentStatus;
  normalizedValue: number | null;
  explanation: string;
  weight: number;
  evidenceSnippets: VerifiedEvidenceSnippet[];
}

export interface CalculatedAssessmentSummary {
  score: number | null; // 0.00 to 100.00, or null if incomplete
  coverage: number; // 0.00 to 100.00 percentage of criteria with evidence
  isComplete: boolean; // true only if all criteria are verified and complete
  status: AssessmentStatus; // COMPLETE, NEEDS_REVIEW, FAILED
  formulaVersion: string;
  criterionResults: VerifiedCriterionResult[];
}

export interface AssessmentModelMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  scoringFormula: string;
  consentId: string;
  consentNoticeHash: string;
  tokenUsage?:
    | {
        promptTokens?: number | undefined;
        completionTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
  startedAt: string;
  completedAt: string;
  limitations?: string[] | undefined;
}

export interface EvidenceSnippetDto {
  id: string;
  quote: string;
  pageNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  verified: boolean;
  verificationMethod: string | null;
}

export interface CriterionAssessmentDto {
  id: string;
  criterionId: string;
  criterionKey: string;
  criterionLabel: string;
  criterionCategory: string;
  requirementType: string;
  weight: number;
  status: CriterionAssessmentStatus;
  normalizedValue: number | null;
  explanation: string | null;
  evidence: EvidenceSnippetDto[];
}

export interface CandidateAssessmentDto {
  id: string;
  organizationId: string;
  requisitionId: string;
  candidateId: string;
  resumeDocumentId: string;
  scorecardVersionId: string;
  score: number | null;
  coverage: number | null;
  isComplete: boolean;
  status: AssessmentStatus;
  formulaVersion: string;
  modelMetadata: AssessmentModelMetadata;
  createdAt: string;
  updatedAt: string;
  criteria: CriterionAssessmentDto[];
  humanReviewRequired: boolean;
}

export interface AssessmentJobDto {
  jobId: string;
  batchId: string;
  requisitionId: string;
  candidateId: string;
  resumeDocumentId: string;
  jobType: 'ASSESS_CANDIDATE';
  status: ProcessingJobStatus;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
