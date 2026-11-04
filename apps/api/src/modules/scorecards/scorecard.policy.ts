export const PROTECTED_ATTRIBUTES_REGEX =
  /\b(age|gender|sex|male|female|race|caste|religion|marital\s+status|photograph|photo|disability)\b/i;

export const DISALLOWED_ATTRIBUTE_WARNING =
  'Potentially protected or personal attribute was excluded from scoring.';

export function containsDisallowedAttribute(value: string): boolean {
  return PROTECTED_ATTRIBUTES_REGEX.test(value);
}

export interface CriterionWithPotentialProtectedAttributes {
  label: string;
  description?: string | null | undefined;
  evidence?:
    | {
        sourceQuote?: string | null | undefined;
      }
    | null
    | undefined;
}

export function criterionContainsDisallowedAttribute(
  criterion: CriterionWithPotentialProtectedAttributes,
): boolean {
  const parts: string[] = [criterion.label];
  if (typeof criterion.description === 'string' && criterion.description.length > 0) {
    parts.push(criterion.description);
  }
  if (
    criterion.evidence &&
    typeof criterion.evidence.sourceQuote === 'string' &&
    criterion.evidence.sourceQuote.length > 0
  ) {
    parts.push(criterion.evidence.sourceQuote);
  }
  return containsDisallowedAttribute(parts.join(' '));
}
