export type ProhibitedCategory =
  | 'AGE'
  | 'PREGNANCY_OR_FAMILY'
  | 'GENDER_OR_SEX'
  | 'RACE_OR_ETHNICITY'
  | 'RELIGION_OR_FAITH'
  | 'DISABILITY_OR_HEALTH'
  | 'SEXUAL_ORIENTATION';

export interface FeedbackFairnessResult {
  isProhibited: boolean;
  category?: ProhibitedCategory | undefined;
  reason?: string | undefined;
}

const PROHIBITED_RULES: Array<{
  category: ProhibitedCategory;
  pattern: RegExp;
  reason: string;
}> = [
  // 1. Age
  {
    category: 'AGE',
    pattern:
      /\b(?:too\s+old|too\s+elderly|overage|over-age|past\s+retirement\s+age|prefer\s+(?:a\s+)?(?:younger|young)\s+(?:candidate|developer|engineer|person|applicant|hire|guy|girl)|needs?\s+someone\s+(?:younger|young)|look(?:ing)?\s+for\s+someone\s+young)\b/i,
    reason: 'Feedback contains explicit age-based preference or exclusion.',
  },
  // 2. Pregnancy & Family Planning / Marital Status
  {
    category: 'PREGNANCY_OR_FAMILY',
    pattern:
      /\b(?:pregnant|pregnancy|maternity\s+leave|paternity\s+leave|expecting\s+a\s+baby|planning\s+a\s+family|family\s+planning|planning\s+to\s+have\s+kids|has\s+(?:too\s+many|young)\s+kids)\b/i,
    reason: 'Feedback contains explicit pregnancy, maternity, or family status references.',
  },
  // 3. Gender / Sex Exclusion
  {
    category: 'GENDER_OR_SEX',
    pattern:
      /\b(?:prefer\s+(?:a\s+)?(?:male|female|man|woman)\s+(?:candidate|developer|engineer|only)?|do\s+not\s+hire\s+(?:women|men|females|males)|no\s+(?:women|men|females|males)\s+(?:candidates|engineers|developers)?|only\s+(?:male|female|men|women)\s+(?:candidates|engineers|developers)|wrong\s+gender)\b/i,
    reason: 'Feedback contains explicit gender or sex-based preference or exclusion.',
  },
  // 4. Race, Ethnicity, or Caste
  {
    category: 'RACE_OR_ETHNICITY',
    pattern:
      /\b(?:reject|not\s+hire|no)(?:\s+(?:a\s+)?(?:candidate|person|applicant|them|him|her))?\s+(?:based\s+on\s+|due\s+to\s+|because\s+of\s+)?(?:race|ethnicity|caste|skin\s+color|national\s+origin)|wrong\s+(?:race|ethnicity|caste)|prefer\s+(?:white|black|asian|indian|caucasian)\s+(?:only|candidates?|engineers?)\b/i,
    reason: 'Feedback contains explicit race, ethnicity, or caste-based exclusion.',
  },
  // 5. Religion or Faith
  {
    category: 'RELIGION_OR_FAITH',
    pattern:
      /\b(?:reject|not\s+hire)(?:\s+(?:a\s+)?(?:candidate|person|applicant|them|him|her))?\s+(?:due\s+to|because\s+of|because)\s+(?:religion|faith|beliefs|wearing\s+hijab|turban)|(?:prefer\s+(?:christian|muslim|hindu|jewish))\s+(?:only|candidates?|engineers?)|wrong\s+religion\b/i,
    reason: 'Feedback contains explicit religion or faith-based exclusion.',
  },
  // 6. Disability or Medical Condition
  {
    category: 'DISABILITY_OR_HEALTH',
    pattern:
      /\b(?:reject|not\s+hire|avoid)(?:\s+(?:a\s+)?(?:candidate|person|applicant|them|him|her))?\s+(?:because\s+(?:they\s+are|he\s+is|she\s+is)\s+|because\s+of\s+|due\s+to\s+)?(?:disabled|handicapped|in\s+a\s+wheelchair|chronic\s+illness|medical\s+condition)\b/i,
    reason: 'Feedback contains explicit disability or health-based exclusion.',
  },
  // 7. Sexual Orientation
  {
    category: 'SEXUAL_ORIENTATION',
    pattern:
      /\b(?:reject|not\s+hire|avoid)(?:\s+(?:a\s+)?(?:candidate|person|applicant|them|him|her))?\s+(?:because\s+(?:they\s+are|he\s+is|she\s+is)\s+|because\s+of\s+|due\s+to\s+)?(?:gay|lesbian|transgender|queer|homosexual)|wrong\s+sexual\s+orientation\b/i,
    reason: 'Feedback contains explicit sexual orientation or gender identity exclusion.',
  },
];

/**
 * Conservatively evaluates client feedback text for explicit prohibited non-job-related
 * or protected-characteristic discrimination without falsely flagging legitimate technical reviews.
 */
export function evaluateFeedbackFairness(text?: string | null): FeedbackFairnessResult {
  if (!text || !text.trim()) {
    return { isProhibited: false };
  }

  const normalized = text.trim();
  for (const rule of PROHIBITED_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        isProhibited: true,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { isProhibited: false };
}
