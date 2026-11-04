import { describe, expect, it } from 'vitest';
import { redactResumeText } from './assessment.redactor.js';

describe('assessment.redactor', () => {
  it('preserves exact string length for 1:1 character offset alignment', () => {
    const raw =
      'Contact Jane Doe at jane.doe@example.com or +1-555-123-4567. Profile: https://linkedin.com/in/janedoe';
    const result = redactResumeText(raw);

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactionMap.length).toBe(3);
    expect(result.redactedText).not.toContain('jane.doe@example.com');
    expect(result.redactedText).not.toContain('+1-555-123-4567');
    expect(result.redactedText).not.toContain('https://linkedin.com/in/janedoe');
    expect(result.redactedText).toContain('[REDACTED_EMAIL');
    expect(result.redactedText).toContain('[REDACTED_PHONE');
    expect(result.redactedText).toContain('[REDACTED_URL');
  });

  it('redacts extra explicit identifiers while preserving string length', () => {
    const raw = 'Candidate CAND-987654 is an experienced engineer.';
    const result = redactResumeText(raw, ['CAND-987654']);

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('CAND-987654');
    expect(result.redactedText).toContain('[REDACTED_');
    expect(result.redactionMap.some((r) => r.type === 'IDENTIFIER')).toBe(true);
  });

  it('redacts known candidate names from profile/consent while preserving length', () => {
    const raw =
      'Senior Architect Jane Smith has 10 years of experience. Jane designed high scale systems.';
    const result = redactResumeText(raw, {
      candidateNames: ['Jane Smith'],
    });

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('Jane Smith');
    expect(result.redactedText).not.toContain('Jane');
    expect(result.redactedText).toContain('[REDACTED_');
    expect(result.redactionMap.some((r) => r.type === 'NAME')).toBe(true);
  });

  it('redacts physical street addresses, PO boxes, and ZIP codes', () => {
    const raw =
      'Resides at 742 Evergreen Terrace, Apt 2B. Secondary mailing: P.O. Box 789, Springfield, OR 97477.';
    const result = redactResumeText(raw);

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('742 Evergreen Terrace, Apt 2B');
    expect(result.redactedText).not.toContain('P.O. Box 789');
    expect(result.redactedText).not.toContain('OR 97477');
    expect(result.redactedText).toContain('[REDACTED_');
    expect(result.redactionMap.some((r) => r.type === 'ADDRESS')).toBe(true);
  });

  it('redacts explicit candidate profile address when supplied', () => {
    const raw = 'Location: 100 Innovation Blvd, Suite 400, Tech Park.';
    const result = redactResumeText(raw, {
      candidateAddress: '100 Innovation Blvd, Suite 400, Tech Park.',
    });

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('100 Innovation Blvd');
    expect(result.redactedText).toContain('[REDACTED_');
    expect(result.redactionMap.some((r) => r.type === 'ADDRESS')).toBe(true);
  });

  it('redacts explicitly labeled dates of birth while preserving length', () => {
    const raw = 'DOB: 1990-05-15. Candidate has been working in technology since 2012.';
    const result = redactResumeText(raw);

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).not.toContain('DOB: 1990-05-15');
    expect(result.redactedText).toContain('[REDACTED_');
    expect(result.redactionMap.some((r) => r.type === 'DATE_OF_BIRTH')).toBe(true);
    // Crucially preserves the employment milestone date "2012"
    expect(result.redactedText).toContain('since 2012');
  });

  it('does NOT corrupt technical skills, company names, or employment date ranges', () => {
    const raw =
      'Senior Lead Engineer with expertise in AWS Route 53, Java 17, Spring Boot, React Native, and PostgreSQL. Worked at Acme Corp from 2018 - 2022.';
    const result = redactResumeText(raw, {
      candidateNames: ['Lead Engineer'], // "lead" and "engineer" are in common tech stop words
    });

    expect(result.redactedText.length).toBe(raw.length);
    expect(result.redactedText).toContain('AWS Route 53');
    expect(result.redactedText).toContain('Java 17');
    expect(result.redactedText).toContain('Spring Boot');
    expect(result.redactedText).toContain('React Native');
    expect(result.redactedText).toContain('PostgreSQL');
    expect(result.redactedText).toContain('2018 - 2022');
    expect(result.redactedText).toContain('Senior Lead Engineer');
  });

  it('handles empty text gracefully', () => {
    const result = redactResumeText('');
    expect(result.redactedText).toBe('');
    expect(result.redactionMap).toEqual([]);
    expect(result.redactorVersion).toBe('2026-11-redactor-v2');
  });
});
