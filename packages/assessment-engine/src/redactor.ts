export interface RedactionEntry {
  type: 'EMAIL' | 'PHONE' | 'URL' | 'IDENTIFIER' | 'NAME' | 'ADDRESS' | 'DATE_OF_BIRTH';
  startOffset: number;
  endOffset: number;
}

export interface RedactionOptions {
  extraIdentifiers?: string[] | undefined;
  candidateNames?: string[] | undefined;
  candidateAddress?: string | undefined;
}

export interface RedactionResult {
  redactedText: string;
  redactionMap: RedactionEntry[];
  redactorVersion: string;
}

function padTag(tag: string, targetLength: number): string {
  if (targetLength <= tag.length) {
    return tag.slice(0, targetLength);
  }
  return tag + '_'.repeat(targetLength - tag.length);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMMON_TECH_STOP_WORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'from',
  'lead',
  'tech',
  'data',
  'java',
  'rust',
  'ruby',
  'node',
  'react',
  'cloud',
  'stack',
  'staff',
  'senior',
  'junior',
  'principal',
  'engineer',
  'developer',
  'architect',
  'analyst',
  'manager',
  'director',
  'intern',
  'consultant',
  'post',
  'will',
  'may',
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX =
  /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10}\b|\+\d{1,3}\s?\d{9,12}\b/g;
const URL_REGEX =
  /https?:\/\/[^\s/$.?#].[^\s]*|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*|linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi;

// Physical address patterns: standard numbered streets, PO boxes, City/State/ZIP
const STREET_ADDRESS_REGEX =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Circle|Cir\.?|Way|Parkway|Pkwy\.?|Terrace|Ter\.?)(?:\s*,?\s*(?:Apt|Suite|Ste|Unit|#)\s*[A-Za-z0-9-]+)?\b/gi;
const PO_BOX_REGEX = /\b(?:P\.?\s*O\.?\s*Box)\s+\d+\b/gi;
const ZIP_CODE_REGEX = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;

// Explicitly labeled dates of birth (strictly excludes employment date ranges like 2018 - 2022)
const DOB_REGEX =
  /\b(?:DOB|D\.O\.B\.|Date of Birth|Birthdate|Birth Date|Born on|Born)\s*[:-]?\s*(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+\d{4})\b/gi;

/**
 * Deterministically redacts known candidate PII (names, contact details, explicit addresses, DOB)
 * while preserving exact 1:1 character length and offset alignment.
 *
 * LIMITATIONS & PRIVACY NOTICE:
 * We do NOT claim complete anonymization. Unstructured natural language biographical narrative,
 * unlabelled dates, or foreign/non-standard address formats cannot be deterministically redacted
 * without unacceptable risk of corrupting technical skills, company names, certifications, or
 * relevant employment evidence (e.g. AWS Route 53, Java 17, Spring Boot).
 * Only reliably identifiable attributes and known candidate profile identifiers are masked.
 */
export function redactResumeText(
  sourceText: string,
  optionsOrIdentifiers: string[] | RedactionOptions = {},
): RedactionResult {
  if (!sourceText) {
    return {
      redactedText: '',
      redactionMap: [],
      redactorVersion: '2026-11-redactor-v2',
    };
  }

  const options: RedactionOptions = Array.isArray(optionsOrIdentifiers)
    ? { extraIdentifiers: optionsOrIdentifiers }
    : optionsOrIdentifiers;

  // Collect all spans to redact: { start, end, type }
  const spans: Array<{ start: number; end: number; type: RedactionEntry['type'] }> = [];

  // 1. Emails
  let match: RegExpExecArray | null;
  const emailRegex = new RegExp(EMAIL_REGEX);
  while ((match = emailRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'EMAIL',
    });
  }

  // 2. Phone numbers
  const phoneRegex = new RegExp(PHONE_REGEX);
  while ((match = phoneRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'PHONE',
    });
  }

  // 3. URLs
  const urlRegex = new RegExp(URL_REGEX);
  while ((match = urlRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'URL',
    });
  }

  // 4. Physical Addresses (Street addresses, PO boxes, ZIP codes)
  const streetRegex = new RegExp(STREET_ADDRESS_REGEX);
  while ((match = streetRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'ADDRESS',
    });
  }

  const poBoxRegex = new RegExp(PO_BOX_REGEX);
  while ((match = poBoxRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'ADDRESS',
    });
  }

  const zipRegex = new RegExp(ZIP_CODE_REGEX);
  while ((match = zipRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'ADDRESS',
    });
  }

  if (options.candidateAddress) {
    const addr = options.candidateAddress.trim();
    if (addr.length >= 4) {
      let idx = sourceText.toLowerCase().indexOf(addr.toLowerCase());
      while (idx !== -1) {
        spans.push({
          start: idx,
          end: idx + addr.length,
          type: 'ADDRESS',
        });
        idx = sourceText.toLowerCase().indexOf(addr.toLowerCase(), idx + addr.length);
      }
    }
  }

  // 5. Explicitly labeled Date of Birth
  const dobRegex = new RegExp(DOB_REGEX);
  while ((match = dobRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'DATE_OF_BIRTH',
    });
  }

  // 6. Known candidate names (from candidate profile / consent confirmation)
  if (options.candidateNames) {
    for (const rawName of options.candidateNames) {
      const trimmed = rawName.trim();
      if (trimmed.length < 3) continue;

      const parts = trimmed.split(/\s+/).filter((p) => p.length >= 3);
      const hasNonStopWord = parts.some((p) => !COMMON_TECH_STOP_WORDS.has(p.toLowerCase()));
      if (!hasNonStopWord) continue;

      // A. Match full name
      const fullNameRegex = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'gi');
      while ((match = fullNameRegex.exec(sourceText)) !== null) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: 'NAME',
        });
      }

      // B. Match individual name parts (e.g. first name, last name) if >= 3 chars and not common word
      if (parts.length > 1) {
        for (const part of parts) {
          if (part.length < 3) continue;
          if (COMMON_TECH_STOP_WORDS.has(part.toLowerCase())) continue;
          const partRegex = new RegExp(`\\b${escapeRegex(part)}\\b`, 'gi');
          while ((match = partRegex.exec(sourceText)) !== null) {
            spans.push({
              start: match.index,
              end: match.index + match[0].length,
              type: 'NAME',
            });
          }
        }
      }
    }
  }

  // 7. Extra direct identifiers (e.g. candidateCode like CAN-123456)
  if (options.extraIdentifiers) {
    for (const identifier of options.extraIdentifiers) {
      const trimmed = identifier.trim();
      if (trimmed.length < 3) continue;
      let idx = sourceText.indexOf(trimmed);
      while (idx !== -1) {
        spans.push({
          start: idx,
          end: idx + trimmed.length,
          type: 'IDENTIFIER',
        });
        idx = sourceText.indexOf(trimmed, idx + trimmed.length);
      }
    }
  }

  // Sort spans by start offset ascending
  spans.sort((a, b) => a.start - b.start);

  // Merge overlapping or adjacent spans
  const mergedSpans: Array<{ start: number; end: number; type: RedactionEntry['type'] }> = [];
  for (const span of spans) {
    if (mergedSpans.length === 0) {
      mergedSpans.push(span);
      continue;
    }
    const prev = mergedSpans[mergedSpans.length - 1];
    if (prev && span.start < prev.end) {
      // Overlapping: extend end if needed
      prev.end = Math.max(prev.end, span.end);
    } else {
      mergedSpans.push(span);
    }
  }

  // Replace each span with an offset-preserving replacement of the exact same length
  let result = sourceText;
  const redactionMap: RedactionEntry[] = [];

  // Process from end to beginning to keep string indices intact
  for (let i = mergedSpans.length - 1; i >= 0; i--) {
    const span = mergedSpans[i]!;
    const len = span.end - span.start;
    const tag = `[REDACTED_${span.type}]`;
    const replacement = padTag(tag, len);

    result = result.slice(0, span.start) + replacement + result.slice(span.end);
    redactionMap.unshift({
      type: span.type,
      startOffset: span.start,
      endOffset: span.end,
    });
  }

  return {
    redactedText: result,
    redactionMap,
    redactorVersion: '2026-11-redactor-v2',
  };
}

export const redactCandidateIdentifiers = redactResumeText;
