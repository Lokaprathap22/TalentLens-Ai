export type CriterionCategory =
  'SKILL' | 'EXPERIENCE' | 'NOTICE' | 'COMPENSATION' | 'OTHER_JOB_RELATED';
export type RequirementType = 'MUST_HAVE' | 'PREFERRED';

export type VerificationStatus =
  'PENDING_RECRUITER_REVIEW' | 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';

export interface ExtractedEvidence {
  sourceQuote: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  verificationStatus: VerificationStatus;
}

export interface ExtractedRequirement {
  originalText: string;
  evidence: ExtractedEvidence;
}

export interface ExtractedCriterion {
  category: CriterionCategory;
  requirementType: RequirementType;
  label: string;
  description: string;
  weight: number;
  evidence: ExtractedEvidence;
}

export interface JdExtractionOutput {
  jobTitle: ExtractedRequirement | null;
  minimumExperienceYears: number | null;
  maximumExperienceYears: number | null;
  experienceRequirement: ExtractedRequirement | null;
  requiredSkills: ExtractedRequirement[];
  preferredSkills: ExtractedRequirement[];
  educationRequirements: ExtractedRequirement[];
  certifications: ExtractedRequirement[];
  domainExperience: ExtractedRequirement[];
  compensation: {
    minimum: number | null;
    maximum: number | null;
    currency: string | null;
    period: string | null;
    originalText: string;
    evidence: ExtractedEvidence;
  } | null;
  noticePeriod: {
    normalizedDays: number | null;
    originalUnit: string | null;
    originalText: string;
    evidence: ExtractedEvidence;
  } | null;
  otherRequirements: ExtractedRequirement[];
  warnings: string[];
  criteria: ExtractedCriterion[];
}
