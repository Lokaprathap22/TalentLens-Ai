import { describe, expect, it } from 'vitest';

import {
  containsDisallowedAttribute,
  criterionContainsDisallowedAttribute,
  DISALLOWED_ATTRIBUTE_WARNING,
} from './scorecard.policy.js';

describe('scorecard policy — protected attribute detection', () => {
  it('detects prohibited demographic and personal attributes in text', () => {
    expect(containsDisallowedAttribute('Candidate age must be 25')).toBe(true);
    expect(containsDisallowedAttribute('Preferred gender is female')).toBe(true);
    expect(containsDisallowedAttribute('No marital status restrictions')).toBe(true);
    expect(containsDisallowedAttribute('Must include a recent photograph')).toBe(true);
    expect(containsDisallowedAttribute('Disability status not evaluated')).toBe(true);
    expect(containsDisallowedAttribute('Caste and religion irrelevant')).toBe(true);
  });

  it('allows job-related technical and professional criteria', () => {
    expect(containsDisallowedAttribute('5+ years of TypeScript experience')).toBe(false);
    expect(containsDisallowedAttribute('Strong communication and leadership skills')).toBe(false);
    expect(containsDisallowedAttribute('Bachelor degree in Computer Science')).toBe(false);
    expect(containsDisallowedAttribute('Notice period 30 days')).toBe(false);
  });

  it('detects prohibited attributes across label, description, and source evidence', () => {
    // Discriminatory description with benign label
    expect(
      criterionContainsDisallowedAttribute({
        label: 'Team Culture',
        description: 'Candidate must be under age 30',
      }),
    ).toBe(true);

    // Discriminatory quote with benign label and description
    expect(
      criterionContainsDisallowedAttribute({
        label: 'Office Protocol',
        description: 'Professional presence',
        evidence: {
          sourceQuote: 'Please provide a passport photo with gender indicated',
        },
      }),
    ).toBe(true);

    // Pure job-related criterion
    expect(
      criterionContainsDisallowedAttribute({
        label: 'React Architecture',
        description: 'Experience building large React applications',
        evidence: {
          sourceQuote: 'Requires 4 years of React and Next.js',
        },
      }),
    ).toBe(false);
  });

  it('exports the standard disallowed attribute warning text', () => {
    expect(DISALLOWED_ATTRIBUTE_WARNING).toContain('Potentially protected or personal attribute');
  });
});
