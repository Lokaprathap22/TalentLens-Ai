import { describe, expect, it } from 'vitest';
import { calculateAssessmentSummary } from './assessment.scoring.js';
import type { ScorecardCriterionDefinition, VerifiedCriterionResult } from './assessment.types.js';

describe('assessment.scoring', () => {
  const criteria: ScorecardCriterionDefinition[] = [
    {
      id: 'c1',
      key: 'ts',
      label: 'TypeScript',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      minScore: 0,
      maxScore: 10,
    },
    {
      id: 'c2',
      key: 'node',
      label: 'Node.js',
      category: 'SKILL',
      requirementType: 'PREFERRED',
      weight: 40,
      minScore: 1,
      maxScore: 5,
    },
  ];

  it('1. Calculates 100% complete score with different criterion weights and normalized values', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0, // (10-0)/(10-0)
        explanation: 'Perfect match',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 0.8, // (4.2-1)/4
        explanation: 'Strong match',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    expect(summary.coverage).toBe(100);
    expect(summary.isComplete).toBe(true);
    // (1.0 * 60 + 0.8 * 40) / 100 * 100 = 60 + 32 = 92
    expect(summary.score).toBe(92);
    expect(summary.status).toBe('COMPLETE');
    expect(summary.formulaVersion).toContain('weighted_criteria_v2');
  });

  it('2. Supports unequal custom weights across criteria', () => {
    const customCriteria: ScorecardCriterionDefinition[] = [
      {
        id: 'c1',
        key: 'ts',
        label: 'TypeScript',
        category: 'SKILL',
        requirementType: 'MUST_HAVE',
        weight: 75,
      },
      {
        id: 'c2',
        key: 'node',
        label: 'Node.js',
        category: 'SKILL',
        requirementType: 'PREFERRED',
        weight: 25,
      },
    ];

    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 0.8,
        explanation: 'Good',
        weight: 75,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 0.4,
        explanation: 'Basic',
        weight: 25,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(customCriteria, results);
    expect(summary.isComplete).toBe(true);
    // (0.8 * 75 + 0.4 * 25) / 100 * 100 = 60 + 10 = 70
    expect(summary.score).toBe(70);
    expect(summary.status).toBe('COMPLETE');
  });

  it('3. Sets overallScore to null when one criterion is insufficient (NOT_FOUND)', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Found',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'NOT_FOUND',
        normalizedValue: null,
        explanation: 'Missing evidence',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    expect(summary.coverage).toBe(60);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');
  });

  it('4. Sets overallScore to null when a criterion has conflicting evidence (UNCERTAIN)', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Found',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'UNCERTAIN',
        normalizedValue: null,
        explanation: 'Conflicting dates in resume history',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    expect(summary.coverage).toBe(60);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');
  });

  it('5. Handles zero scored criteria gracefully with null overallScore and 0% coverage', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'NOT_FOUND',
        normalizedValue: null,
        explanation: 'Missing evidence',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'NOT_FOUND',
        normalizedValue: null,
        explanation: 'Missing evidence',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    expect(summary.coverage).toBe(0);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');
  });

  it('6. Does not compute overallScore when out-of-scale score results in null normalizedValue', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Valid',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'UNCERTAIN',
        normalizedValue: null, // Out-of-scale rejected by verifier
        explanation: 'Scale Validation Error: Score 7 is outside approved criterion range [1, 5]',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');
  });

  it('7. Never defaults missing or unverified evidence scores to zero', () => {
    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'UNVERIFIED',
        normalizedValue: null,
        explanation: 'Hallucinated quotation',
        weight: 60,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'NOT_FOUND',
        normalizedValue: null,
        explanation: 'No mention',
        weight: 40,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(criteria, results);
    for (const res of summary.criterionResults) {
      expect(res.normalizedValue).toBeNull();
      expect(res.normalizedValue).not.toBe(0);
    }
    expect(summary.score).toBeNull();
  });

  it('8. Rejects negative weights without silently zeroing or omitting them', () => {
    const mixedCriteria: ScorecardCriterionDefinition[] = [
      {
        id: 'c1',
        key: 'ts',
        label: 'TypeScript',
        category: 'SKILL',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
      {
        id: 'c2',
        key: 'neg',
        label: 'Negative Criterion',
        category: 'SKILL',
        requirementType: 'PREFERRED',
        weight: -20,
      },
    ];

    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched TypeScript',
        weight: 50,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched Negative',
        weight: -20,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(mixedCriteria, results);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');
    expect(summary.coverage).toBe(0);

    // Offending criterion is preserved, NOT silently excluded
    expect(summary.criterionResults).toHaveLength(2);
    const negResult = summary.criterionResults.find((r) => r.criterionId === 'c2')!;
    expect(negResult.weight).toBe(-20); // Preserved, not zeroed
    expect(negResult.status).toBe('UNCERTAIN');
    expect(negResult.normalizedValue).toBeNull();
    expect(negResult.explanation).toContain('Weight Validation Error');
  });

  it('9. Rejects zero weights without silently zeroing or omitting them', () => {
    const zeroCriteria: ScorecardCriterionDefinition[] = [
      {
        id: 'c1',
        key: 'ts',
        label: 'TypeScript',
        category: 'SKILL',
        requirementType: 'MUST_HAVE',
        weight: 50,
      },
      {
        id: 'c2',
        key: 'zero',
        label: 'Zero Weight Criterion',
        category: 'SKILL',
        requirementType: 'PREFERRED',
        weight: 0,
      },
    ];

    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched TypeScript',
        weight: 50,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched Zero',
        weight: 0,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(zeroCriteria, results);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.status).toBe('NEEDS_REVIEW');

    const zeroResult = summary.criterionResults.find((r) => r.criterionId === 'c2')!;
    expect(zeroResult.weight).toBe(0);
    expect(zeroResult.status).toBe('UNCERTAIN');
    expect(zeroResult.normalizedValue).toBeNull();
    expect(zeroResult.explanation).toContain('Weight Validation Error');
  });

  it('10. Rejects NaN and Infinity weights without division by zero or NaN score', () => {
    const nanCriteria: ScorecardCriterionDefinition[] = [
      {
        id: 'c1',
        key: 'nan',
        label: 'NaN Weight Criterion',
        category: 'SKILL',
        requirementType: 'MUST_HAVE',
        weight: NaN,
      },
      {
        id: 'c2',
        key: 'inf',
        label: 'Infinity Weight Criterion',
        category: 'SKILL',
        requirementType: 'PREFERRED',
        weight: Infinity,
      },
    ];

    const results: VerifiedCriterionResult[] = [
      {
        criterionId: 'c1',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched NaN',
        weight: NaN,
        evidenceSnippets: [],
      },
      {
        criterionId: 'c2',
        scorecardVersionId: 'v1',
        status: 'MATCH',
        normalizedValue: 1.0,
        explanation: 'Matched Inf',
        weight: Infinity,
        evidenceSnippets: [],
      },
    ];

    const summary = calculateAssessmentSummary(nanCriteria, results);
    expect(summary.isComplete).toBe(false);
    expect(summary.score).toBeNull();
    expect(summary.coverage).toBe(0);
    expect(summary.status).toBe('NEEDS_REVIEW');

    expect(summary.criterionResults).toHaveLength(2);
    expect(summary.criterionResults[0]!.explanation).toContain('Weight Validation Error');
    expect(summary.criterionResults[1]!.explanation).toContain('Weight Validation Error');
  });
});
