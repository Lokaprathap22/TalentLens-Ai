import type { AssessmentStatus } from '@talentlens/database';
import type {
  CalculatedAssessmentSummary,
  ScorecardCriterionDefinition,
  VerifiedCriterionResult,
} from './types.js';

export const SCORING_FORMULA_VERSION =
  'weighted_criteria_v2: normalized_score = (score - min) / (max - min); isComplete = (coverage == 100% && zero unverified/uncertain/missing && strictly positive finite weights); overallScore = isComplete ? (sum(normalized_score * weight) / total_weight) * 100 : null';

export interface WeightValidationResult {
  valid: boolean;
  totalActiveWeight: number;
  offendingCriterion?: ScorecardCriterionDefinition | undefined;
  reason?: string | undefined;
}

export function validateScorecardCriterionWeights(
  criteria: ScorecardCriterionDefinition[],
): WeightValidationResult {
  let totalActiveWeight = 0;
  for (const criterion of criteria) {
    if (
      typeof criterion.weight !== 'number' ||
      !Number.isFinite(criterion.weight) ||
      criterion.weight <= 0
    ) {
      return {
        valid: false,
        totalActiveWeight: 0,
        offendingCriterion: criterion,
        reason: `Approved scorecard criterion "${criterion.label}" has an invalid weight (${criterion.weight}). Weights must be finite and strictly positive.`,
      };
    }
    totalActiveWeight += criterion.weight;
  }

  if (!Number.isFinite(totalActiveWeight) || totalActiveWeight <= 0) {
    return {
      valid: false,
      totalActiveWeight,
      reason: 'Total active scorecard weight must be finite and strictly positive.',
    };
  }

  return {
    valid: true,
    totalActiveWeight,
  };
}

/**
 * Calculates candidate assessment completeness, criterion coverage, and weighted score.
 *
 * SCORING & AGGREGATION SPECIFICATION:
 * 1. Criterion Normalization:
 *    Each verified criterion score is normalized to [0.0, 1.0] using its approved scale:
 *    normalized_score = (score - min_score) / (max_score - min_score)
 * 2. Missing & Unverified Evidence Guard:
 *    Missing (NOT_FOUND), unverified (UNVERIFIED), or conflicting (UNCERTAIN) evidence
 *    leaves the criterion normalizedValue as null. It NEVER silently becomes 0.
 * 3. Assessment Completeness Rule:
 *    An assessment is strictly complete (isComplete = true) if and only if:
 *    - All approved active criteria have been evaluated with verified evidence.
 *    - Coverage equals 100.0%.
 *    - Zero criteria have status NOT_FOUND, UNCERTAIN, or UNVERIFIED.
 *    - All MUST_HAVE criteria are satisfied.
 * 4. Aggregate Overall Score Rule:
 *    To prevent presenting incomplete candidate assessments as comparable:
 *    - If isComplete is true:
 *        overallScore = (sum(normalized_score * weight) / total_active_weight) * 100
 *    - If isComplete is false:
 *        overallScore = null (always null when any criterion is missing or unverified).
 *    - Overall status is COMPLETE if isComplete is true; otherwise NEEDS_REVIEW.
 */
export function calculateAssessmentSummary(
  approvedCriteria: ScorecardCriterionDefinition[],
  criterionResults: VerifiedCriterionResult[],
): CalculatedAssessmentSummary {
  const criteriaMap = new Map<string, ScorecardCriterionDefinition>();
  for (const c of approvedCriteria) {
    criteriaMap.set(c.id, c);
  }

  let totalActiveWeight = 0;
  let scoredWeight = 0;
  let weightedScoreSum = 0;
  let hasMustHaveFailureOrMissing = false;
  let hasUncertainOrUnverified = false;
  let hasMissingCriteria = false;
  let hasInvalidWeight = false;

  for (const def of approvedCriteria) {
    const rawWeight = def.weight;
    if (typeof rawWeight !== 'number' || !Number.isFinite(rawWeight) || rawWeight <= 0) {
      hasInvalidWeight = true;
    } else {
      totalActiveWeight += rawWeight;
    }
  }

  const evaluatedCriterionIds = new Set<string>();

  for (const res of criterionResults) {
    evaluatedCriterionIds.add(res.criterionId);
    const def = criteriaMap.get(res.criterionId);
    const rawWeight = def ? def.weight : res.weight;

    if (typeof rawWeight !== 'number' || !Number.isFinite(rawWeight) || rawWeight <= 0) {
      hasInvalidWeight = true;
    } else if (res.normalizedValue !== null && Number.isFinite(res.normalizedValue)) {
      scoredWeight += rawWeight;
      weightedScoreSum += res.normalizedValue * rawWeight;
    }

    if (def?.requirementType === 'MUST_HAVE') {
      if (res.status !== 'MATCH') {
        hasMustHaveFailureOrMissing = true;
      }
    }

    if (res.status === 'UNCERTAIN' || res.status === 'UNVERIFIED' || res.status === 'NOT_FOUND') {
      hasUncertainOrUnverified = true;
    }
  }

  // Check if all approved criteria were evaluated
  for (const def of approvedCriteria) {
    if (!evaluatedCriterionIds.has(def.id)) {
      hasMissingCriteria = true;
    }
  }

  // If any criterion has an invalid weight, or total active weight <= 0:
  // Completeness is strictly false and coverage cannot be 100%.
  const rawCoverage =
    !hasInvalidWeight && totalActiveWeight > 0 ? (scoredWeight / totalActiveWeight) * 100 : 0;
  const coverage = Number.isFinite(rawCoverage) ? Number(rawCoverage.toFixed(2)) : 0;

  // Strict completeness rule:
  // - Zero invalid weights
  // - Total active weight > 0
  // - 100% coverage
  // - Zero unverified/uncertain/missing
  // - All MUST_HAVE evaluated and satisfied
  const isComplete =
    !hasInvalidWeight &&
    totalActiveWeight > 0 &&
    coverage >= 100 &&
    !hasMustHaveFailureOrMissing &&
    !hasUncertainOrUnverified &&
    !hasMissingCriteria;

  let overallScore: number | null = null;
  if (isComplete && totalActiveWeight > 0 && Number.isFinite(weightedScoreSum)) {
    const rawScore = (weightedScoreSum / totalActiveWeight) * 100;
    if (Number.isFinite(rawScore) && !Number.isNaN(rawScore)) {
      overallScore = Number(rawScore.toFixed(2));
      overallScore = Math.max(0, Math.min(100, overallScore));
    }
  }

  const overallStatus: AssessmentStatus = isComplete ? 'COMPLETE' : 'NEEDS_REVIEW';

  // Ensure any result with an invalid weight preserves its explanation reason
  const finalResults: VerifiedCriterionResult[] = criterionResults.map((r) => {
    const def = criteriaMap.get(r.criterionId);
    const weight = def ? def.weight : r.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      const weightMsg = `[Weight Validation Error: Criterion weight (${weight}) must be a finite, strictly positive number.]`;
      return {
        ...r,
        status: 'UNCERTAIN',
        normalizedValue: null,
        explanation: r.explanation.includes('Weight Validation Error')
          ? r.explanation
          : `${r.explanation} ${weightMsg}`.trim(),
        weight: r.weight, // Preserve original offending weight without silently zeroing
      };
    }
    return r;
  });

  return {
    score: overallScore,
    coverage,
    isComplete,
    status: overallStatus,
    formulaVersion: SCORING_FORMULA_VERSION,
    criterionResults: finalResults,
  };
}
