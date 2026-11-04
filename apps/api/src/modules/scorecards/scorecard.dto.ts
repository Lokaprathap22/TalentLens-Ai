import type { CriterionCategory, RequirementType } from './jd-extraction.types.js';
export type ScorecardStatus = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

export interface ScorecardCriterionDto {
  id: string;
  key: string;
  label: string;
  description: string;
  category: CriterionCategory;
  requirementType: RequirementType;
  weight: number;
  displayOrder: number;
  active: boolean;
  evidence: {
    sourceQuote: string;
    sourceStart: number | null;
    sourceEnd: number | null;
    verificationStatus: string;
  } | null;
}

export interface ScorecardDto {
  id: string;
  requisitionId: string;
  version: number;
  status: ScorecardStatus;
  weights: Record<string, unknown>;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  criteria: ScorecardCriterionDto[];
}
