import { describe, expect, it } from 'vitest';
import { verifyCriterionAssessments } from './assessment.verifier.js';
import type { ScorecardCriterionDefinition } from './assessment.types.js';

describe('assessment.verifier', () => {
  const criteria: ScorecardCriterionDefinition[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      key: 'typescript',
      label: 'TypeScript Experience',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      minScore: 0,
      maxScore: 10,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      key: 'docker',
      label: 'Docker & Containers',
      category: 'SKILL',
      requirementType: 'PREFERRED',
      weight: 40,
      minScore: 1,
      maxScore: 5,
    },
  ];

  const sourceText =
    'Experienced in TypeScript development for 5 years. Proficient in Node.js backend services.';
  const pageMapJson = {
    pages: [{ pageNumber: 1, startOffset: 0, endOffset: 150 }],
  };

  it('accepts exact evidence quotations and normalizes scores using approved scale', () => {
    const results = verifyCriterionAssessments(sourceText, pageMapJson, 'scorecard-v1', criteria, [
      {
        criterionId: criteria[0]!.id,
        status: 'MATCH',
        score: 8.0, // On [0, 10] scale -> 8 / 10 = 0.8
        explanation: 'Candidate has 5 years of TypeScript.',
        evidenceQuotes: ['TypeScript development for 5 years'],
      },
      {
        criterionId: criteria[1]!.id,
        status: 'NOT_FOUND',
        score: null,
        explanation: 'No container experience noted.',
        evidenceQuotes: [],
      },
    ]);

    expect(results).toHaveLength(2);
    const tsResult = results.find((r) => r.criterionId === criteria[0]!.id)!;
    expect(tsResult.status).toBe('MATCH');
    expect(tsResult.normalizedValue).toBe(0.8);
    expect(tsResult.evidenceSnippets).toHaveLength(1);
    expect(tsResult.evidenceSnippets[0]!.quote).toBe('TypeScript development for 5 years');
    expect(tsResult.evidenceSnippets[0]!.startOffset).toBe(
      sourceText.indexOf('TypeScript development for 5 years'),
    );
    expect(tsResult.evidenceSnippets[0]!.pageNumber).toBe(1);

    const dockerResult = results.find((r) => r.criterionId === criteria[1]!.id)!;
    expect(dockerResult.status).toBe('NOT_FOUND');
    expect(dockerResult.normalizedValue).toBeNull();
    expect(dockerResult.evidenceSnippets).toHaveLength(0);
  });

  it('normalizes arbitrary scale ranges (e.g. [1, 5]) correctly', () => {
    const results = verifyCriterionAssessments(
      sourceText,
      pageMapJson,
      'scorecard-v1',
      [criteria[1]!],
      [
        {
          criterionId: criteria[1]!.id,
          status: 'MATCH',
          score: 3.0, // On [1, 5] scale -> (3 - 1) / (5 - 1) = 2 / 4 = 0.5
          explanation: 'Candidate has moderate proficiency.',
          evidenceQuotes: ['Node.js backend services'],
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('MATCH');
    expect(results[0]!.normalizedValue).toBe(0.5);
  });

  it('rejects scores outside approved scale and flags UNCERTAIN with null score', () => {
    const results = verifyCriterionAssessments(
      sourceText,
      pageMapJson,
      'scorecard-v1',
      [criteria[1]!],
      [
        {
          criterionId: criteria[1]!.id,
          status: 'MATCH',
          score: 7.0, // Scale is [1, 5], 7.0 is out of bounds
          explanation: 'Claimed 7 on a 5-point scale.',
          evidenceQuotes: ['Node.js backend services'],
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('UNCERTAIN');
    expect(results[0]!.normalizedValue).toBeNull();
    expect(results[0]!.explanation).toContain('Scale Validation Error');
  });

  it('rejects invalid scale where maxScore <= minScore and flags UNCERTAIN', () => {
    const invalidScaleCriterion: ScorecardCriterionDefinition = {
      id: 'inv-scale-1',
      key: 'invalid_scale',
      label: 'Invalid Scale Criterion',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 50,
      minScore: 5,
      maxScore: 5, // Equal -> scaleRange is 0
    };

    const results = verifyCriterionAssessments(
      sourceText,
      pageMapJson,
      'scorecard-v1',
      [invalidScaleCriterion],
      [
        {
          criterionId: 'inv-scale-1',
          status: 'MATCH',
          score: 5.0,
          explanation: 'Matches',
          evidenceQuotes: ['Node.js backend services'],
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('UNCERTAIN');
    expect(results[0]!.normalizedValue).toBeNull();
    expect(results[0]!.explanation).toContain('Invalid Criterion Scale');
  });

  it('marks conflicting evidence as UNCERTAIN with null score', () => {
    const results = verifyCriterionAssessments(
      sourceText,
      pageMapJson,
      'scorecard-v1',
      [criteria[0]!],
      [
        {
          criterionId: criteria[0]!.id,
          status: 'UNCERTAIN',
          score: null,
          explanation: 'Conflicting dates in resume history regarding TypeScript.',
          evidenceQuotes: ['TypeScript development for 5 years'],
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('UNCERTAIN');
    expect(results[0]!.normalizedValue).toBeNull();
  });

  it('rejects fabricated / hallucinated quotations and downgrades status to UNVERIFIED', () => {
    const results = verifyCriterionAssessments(sourceText, pageMapJson, 'scorecard-v1', criteria, [
      {
        criterionId: criteria[0]!.id,
        status: 'MATCH',
        score: 10.0,
        explanation: 'Claimed match.',
        evidenceQuotes: ['This quotation does not exist anywhere in the resume text.'],
      },
    ]);

    const tsResult = results.find((r) => r.criterionId === criteria[0]!.id)!;
    expect(tsResult.status).toBe('UNVERIFIED');
    expect(tsResult.normalizedValue).toBeNull();
    expect(tsResult.evidenceSnippets).toHaveLength(0);
    expect(tsResult.explanation).toContain('Verification Note');
  });

  it('handles missing AI criterion output safely without zeroing out', () => {
    const results = verifyCriterionAssessments(
      sourceText,
      pageMapJson,
      'scorecard-v1',
      criteria,
      [],
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('NOT_FOUND');
    expect(results[0]!.normalizedValue).toBeNull();
    expect(results[1]!.status).toBe('NOT_FOUND');
    expect(results[1]!.normalizedValue).toBeNull();
  });
});
