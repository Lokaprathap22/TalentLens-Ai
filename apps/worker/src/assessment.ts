import { createHash } from 'node:crypto';
import type {
  CriterionAssessmentStatus,
  VerificationMethod,
  AssessmentStatus,
} from '@talentlens/database';

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

const STREET_ADDRESS_REGEX =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Circle|Cir\.?|Way|Parkway|Pkwy\.?|Terrace|Ter\.?)(?:\s*,?\s*(?:Apt|Suite|Ste|Unit|#)\s*[A-Za-z0-9-]+)?\b/gi;
const PO_BOX_REGEX = /\b(?:P\.?\s*O\.?\s*Box)\s+\d+\b/gi;
const ZIP_CODE_REGEX = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;

const DOB_REGEX =
  /\b(?:DOB|D\.O\.B\.|Date of Birth|Birthdate|Birth Date|Born on|Born)\s*[:-]?\s*(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+\d{4})\b/gi;

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

  const extraIdentifiers = options.extraIdentifiers ?? [];
  const candidateNames = options.candidateNames ?? [];
  const candidateAddress = options.candidateAddress;

  const spans: Array<{ start: number; end: number; type: RedactionEntry['type'] }> = [];

  let match: RegExpExecArray | null;

  const emailRegex = new RegExp(EMAIL_REGEX);
  while ((match = emailRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'EMAIL',
    });
  }

  const phoneRegex = new RegExp(PHONE_REGEX);
  while ((match = phoneRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'PHONE',
    });
  }

  const urlRegex = new RegExp(URL_REGEX);
  while ((match = urlRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'URL',
    });
  }

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

  const dobRegex = new RegExp(DOB_REGEX);
  while ((match = dobRegex.exec(sourceText)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'DATE_OF_BIRTH',
    });
  }

  for (const name of candidateNames) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;

    const parts = trimmed.split(/\s+/).filter((p) => p.length >= 3);
    const hasNonStopWord = parts.some((p) => !COMMON_TECH_STOP_WORDS.has(p.toLowerCase()));
    if (!hasNonStopWord) continue;

    for (const part of [trimmed, ...parts]) {
      const lowerPart = part.toLowerCase();
      if (COMMON_TECH_STOP_WORDS.has(lowerPart)) continue;

      const escaped = escapeRegex(part);
      const namePattern = new RegExp(`\\b${escaped}\\b`, 'gi');
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = namePattern.exec(sourceText)) !== null) {
        spans.push({
          start: nameMatch.index,
          end: nameMatch.index + nameMatch[0].length,
          type: 'NAME',
        });
      }
    }
  }

  if (candidateAddress) {
    const trimmedAddr = candidateAddress.trim();
    if (trimmedAddr.length >= 4) {
      const addrPattern = new RegExp(escapeRegex(trimmedAddr), 'gi');
      let addrMatch: RegExpExecArray | null;
      while ((addrMatch = addrPattern.exec(sourceText)) !== null) {
        spans.push({
          start: addrMatch.index,
          end: addrMatch.index + addrMatch[0].length,
          type: 'ADDRESS',
        });
      }
    }
  }

  for (const identifier of extraIdentifiers) {
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

  spans.sort((a, b) => a.start - b.start);

  const mergedSpans: Array<{ start: number; end: number; type: RedactionEntry['type'] }> = [];
  for (const span of spans) {
    if (mergedSpans.length === 0) {
      mergedSpans.push(span);
      continue;
    }
    const prev = mergedSpans[mergedSpans.length - 1];
    if (prev && span.start < prev.end) {
      prev.end = Math.max(prev.end, span.end);
    } else {
      mergedSpans.push(span);
    }
  }

  let result = '';
  let cursor = 0;
  const redactionMap: RedactionEntry[] = [];

  for (const span of mergedSpans) {
    result += sourceText.slice(cursor, span.start);
    const spanLength = span.end - span.start;
    const tag = `[REDACTED_${span.type}]`;
    const padded = padTag(tag, spanLength);
    result += padded;
    redactionMap.push({
      type: span.type,
      startOffset: span.start,
      endOffset: span.end,
    });
    cursor = span.end;
  }
  result += sourceText.slice(cursor);

  return {
    redactedText: result,
    redactionMap,
    redactorVersion: '2026-11-redactor-v2',
  };
}

export interface ScorecardCriterionDefinition {
  id: string;
  key: string;
  label: string;
  category: string;
  requirementType: 'MUST_HAVE' | 'PREFERRED';
  weight: number;
  minScore?: number | undefined;
  maxScore?: number | undefined;
}

export interface AssessmentCriterionOutput {
  criterionId: string;
  status: 'MATCH' | 'PARTIAL' | 'NOT_FOUND' | 'UNCERTAIN';
  score: number | null;
  explanation: string;
  evidenceQuotes: string[];
}

export interface AssessmentProviderInput {
  jobTitle: string;
  criteria: ScorecardCriterionDefinition[];
  resumeText: string;
}

export interface AssessmentProviderOutput {
  criteria: AssessmentCriterionOutput[];
  model: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AssessmentProvider {
  assess(input: AssessmentProviderInput): Promise<AssessmentProviderOutput>;
}

export interface VerifiedEvidenceSnippet {
  quote: string;
  pageNumber: number | null;
  startOffset: number;
  endOffset: number;
  verified: boolean;
  verificationMethod: VerificationMethod;
}

export interface VerifiedCriterionResult {
  criterionId: string;
  scorecardVersionId: string;
  status: CriterionAssessmentStatus;
  normalizedValue: number | null;
  explanation: string;
  weight: number;
  evidenceSnippets: VerifiedEvidenceSnippet[];
}

export interface CalculatedAssessmentSummary {
  score: number | null;
  coverage: number;
  isComplete: boolean;
  status: AssessmentStatus;
  formulaVersion: string;
  criterionResults: VerifiedCriterionResult[];
}

interface PageMapEntry {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

function extractPageMap(pageMapJson: unknown): PageMapEntry[] {
  if (!pageMapJson || typeof pageMapJson !== 'object') return [];
  const mapObj = pageMapJson as Record<string, unknown>;
  const pages = Array.isArray(mapObj['pages'])
    ? mapObj['pages']
    : Array.isArray(pageMapJson)
      ? pageMapJson
      : [];

  const entries: PageMapEntry[] = [];
  for (const p of pages) {
    if (
      p &&
      typeof p === 'object' &&
      typeof (p as Record<string, unknown>)['pageNumber'] === 'number' &&
      typeof (p as Record<string, unknown>)['startOffset'] === 'number' &&
      typeof (p as Record<string, unknown>)['endOffset'] === 'number'
    ) {
      entries.push({
        pageNumber: (p as Record<string, unknown>)['pageNumber'] as number,
        startOffset: (p as Record<string, unknown>)['startOffset'] as number,
        endOffset: (p as Record<string, unknown>)['endOffset'] as number,
      });
    }
  }
  return entries;
}

function resolvePageNumber(offset: number, pages: PageMapEntry[]): number | null {
  for (const page of pages) {
    if (offset >= page.startOffset && offset <= page.endOffset) {
      return page.pageNumber;
    }
  }
  return null;
}

function findExactOrFuzzyQuote(
  sourceText: string,
  rawQuote: string,
): { startOffset: number; endOffset: number; matchedQuote: string } | null {
  const quote = rawQuote.trim();
  if (quote.length < 3) return null;

  const exactIdx = sourceText.indexOf(quote);
  if (exactIdx !== -1) {
    return {
      startOffset: exactIdx,
      endOffset: exactIdx + quote.length,
      matchedQuote: sourceText.slice(exactIdx, exactIdx + quote.length),
    };
  }

  const lowerSource = sourceText.toLowerCase();
  const lowerQuote = quote.toLowerCase();
  const lowerIdx = lowerSource.indexOf(lowerQuote);
  if (lowerIdx !== -1) {
    return {
      startOffset: lowerIdx,
      endOffset: lowerIdx + quote.length,
      matchedQuote: sourceText.slice(lowerIdx, lowerIdx + quote.length),
    };
  }

  const normalizedQuote = quote.replace(/\s+/g, ' ');
  const normalizedSource = sourceText.replace(/\s+/g, ' ');
  const normIdx = normalizedSource.indexOf(normalizedQuote);
  if (normIdx !== -1 && normalizedQuote.length > 15) {
    const sample = normalizedQuote.slice(0, 15);
    const sampleIdx = sourceText.indexOf(sample);
    if (sampleIdx !== -1) {
      return {
        startOffset: sampleIdx,
        endOffset: Math.min(sourceText.length, sampleIdx + quote.length),
        matchedQuote: sourceText.slice(
          sampleIdx,
          Math.min(sourceText.length, sampleIdx + quote.length),
        ),
      };
    }
  }

  return null;
}

export function verifyCriterionAssessments(
  sourceText: string,
  pageMapJson: unknown,
  scorecardVersionId: string,
  approvedCriteria: ScorecardCriterionDefinition[],
  providerOutputs: AssessmentCriterionOutput[],
): VerifiedCriterionResult[] {
  const pages = extractPageMap(pageMapJson);
  const providerOutputMap = new Map<string, AssessmentCriterionOutput>();

  for (const out of providerOutputs) {
    providerOutputMap.set(out.criterionId, out);
  }

  const results: VerifiedCriterionResult[] = [];

  for (const criterion of approvedCriteria) {
    const aiOutput = providerOutputMap.get(criterion.id);

    if (!aiOutput) {
      results.push({
        criterionId: criterion.id,
        scorecardVersionId,
        status: 'NOT_FOUND',
        normalizedValue: null,
        explanation: 'No evidence evaluation returned for this criterion.',
        weight: criterion.weight,
        evidenceSnippets: [],
      });
      continue;
    }

    const verifiedSnippets: VerifiedEvidenceSnippet[] = [];
    const rawQuotes = Array.isArray(aiOutput.evidenceQuotes) ? aiOutput.evidenceQuotes : [];

    for (const rawQuote of rawQuotes) {
      if (typeof rawQuote !== 'string') continue;
      const match = findExactOrFuzzyQuote(sourceText, rawQuote);
      if (match) {
        const pageNumber = resolvePageNumber(match.startOffset, pages);
        verifiedSnippets.push({
          quote: match.matchedQuote,
          pageNumber,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          verified: true,
          verificationMethod: 'EXACT_QUOTE' as VerificationMethod,
        });
      }
    }

    let finalStatus: CriterionAssessmentStatus;
    let finalScore: number | null;
    let finalExplanation = aiOutput.explanation || '';

    // Validate approved criterion minimum and maximum scale
    const rawMin = criterion.minScore;
    const rawMax = criterion.maxScore;
    const minScore = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 0.0;
    const maxScore = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : 1.0;
    const scaleRange = maxScore - minScore;

    if (scaleRange <= 0 || !Number.isFinite(scaleRange)) {
      results.push({
        criterionId: criterion.id,
        scorecardVersionId,
        status: 'UNCERTAIN',
        normalizedValue: null,
        explanation:
          `${aiOutput?.explanation || ''} [Invalid Criterion Scale: maxScore (${maxScore}) must be strictly greater than minScore (${minScore}).]`.trim(),
        weight: criterion.weight,
        evidenceSnippets: [],
      });
      continue;
    }

    // Validate criterion weight (must be a finite, strictly positive number)
    const isWeightValid =
      typeof criterion.weight === 'number' &&
      Number.isFinite(criterion.weight) &&
      criterion.weight > 0;

    if (!isWeightValid) {
      finalStatus = 'UNCERTAIN';
      finalScore = null;
      finalExplanation =
        `${finalExplanation} [Weight Validation Error: Criterion weight (${criterion.weight}) must be a finite, strictly positive number.]`.trim();
    } else if (aiOutput.status === 'NOT_FOUND') {
      finalStatus = 'NOT_FOUND';
      finalScore = null;
    } else if (aiOutput.status === 'UNCERTAIN') {
      finalStatus = 'UNCERTAIN';
      finalScore = null;
    } else if (aiOutput.status === 'MATCH' || aiOutput.status === 'PARTIAL') {
      if (verifiedSnippets.length > 0) {
        if (typeof aiOutput.score === 'number' && Number.isFinite(aiOutput.score)) {
          if (aiOutput.score < minScore || aiOutput.score > maxScore) {
            finalStatus = 'UNCERTAIN';
            finalScore = null;
            finalExplanation = `${finalExplanation} [Scale Validation Error: Score ${aiOutput.score} is outside approved criterion range [${minScore}, ${maxScore}].]`;
          } else {
            finalStatus = aiOutput.status === 'MATCH' ? 'MATCH' : 'PARTIAL';
            finalScore = Math.max(0, Math.min(1, (aiOutput.score - minScore) / scaleRange));
          }
        } else {
          finalStatus = aiOutput.status === 'MATCH' ? 'MATCH' : 'PARTIAL';
          finalScore = aiOutput.status === 'MATCH' ? 1.0 : 0.5;
        }
      } else {
        finalStatus = 'UNVERIFIED';
        finalScore = null;
        finalExplanation = `${finalExplanation} [Verification Note: Supporting quotations could not be verified against the resume text.]`;
      }
    } else {
      finalStatus = 'NOT_ASSESSED';
      finalScore = null;
    }

    results.push({
      criterionId: criterion.id,
      scorecardVersionId,
      status: finalStatus,
      normalizedValue: finalScore !== null ? Number(finalScore.toFixed(4)) : null,
      explanation: finalExplanation,
      weight: criterion.weight,
      evidenceSnippets: verifiedSnippets,
    });
  }

  return results;
}

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
      if (res.status === 'NOT_FOUND' || res.status === 'UNVERIFIED' || res.status === 'UNCERTAIN') {
        hasMustHaveFailureOrMissing = true;
      }
    }

    if (res.status === 'UNCERTAIN' || res.status === 'UNVERIFIED' || res.status === 'NOT_FOUND') {
      hasUncertainOrUnverified = true;
    }
  }

  for (const def of approvedCriteria) {
    if (!evaluatedCriterionIds.has(def.id)) {
      hasMissingCriteria = true;
    }
  }

  const rawCoverage =
    !hasInvalidWeight && totalActiveWeight > 0 ? (scoredWeight / totalActiveWeight) * 100 : 0;
  const coverage = Number.isFinite(rawCoverage) ? Number(rawCoverage.toFixed(2)) : 0;

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

  const formulaVersion =
    'weighted_criteria_v2: normalized_score = (score - min) / (max - min); isComplete = (coverage == 100% && zero unverified/uncertain/missing && strictly positive finite weights); overallScore = isComplete ? (sum(normalized_score * weight) / total_weight) * 100 : null';

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
        weight: r.weight,
      };
    }
    return r;
  });

  return {
    score: overallScore,
    coverage,
    isComplete,
    status: overallStatus,
    formulaVersion,
    criterionResults: finalResults,
  };
}

export class AssessmentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentProviderError';
  }
}

export class AssessmentProviderNotConfiguredError extends AssessmentProviderError {
  constructor(
    message = 'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Assessment AI provider is not configured.',
  ) {
    super(message);
    this.name = 'AssessmentProviderNotConfiguredError';
  }
}

export function createDeterministicFakeAssessmentProvider(): AssessmentProvider {
  return {
    async assess(input: AssessmentProviderInput): Promise<AssessmentProviderOutput> {
      const criteriaOutputs: AssessmentCriterionOutput[] = input.criteria.map((c) => {
        const textLower = input.resumeText.toLowerCase();
        const keyLower = c.key.toLowerCase();
        const labelLower = c.label.toLowerCase();

        let foundWord: string | null = null;
        if (textLower.includes(keyLower)) {
          foundWord = c.key;
        } else if (textLower.includes(labelLower)) {
          foundWord = c.label;
        }

        if (foundWord) {
          const idx = textLower.indexOf(foundWord.toLowerCase());
          const quote = input.resumeText.slice(idx, idx + foundWord.length);
          return {
            criterionId: c.id,
            status: 'MATCH',
            score: c.maxScore ?? 1.0,
            explanation: `Found evidence for ${c.label}`,
            evidenceQuotes: [quote],
          };
        }

        return {
          criterionId: c.id,
          status: 'NOT_FOUND',
          score: null,
          explanation: `No evidence found in resume for ${c.label}`,
          evidenceQuotes: [],
        };
      });

      const payloadStr = JSON.stringify(criteriaOutputs);
      const inputHash = createHash('sha256').update(input.resumeText).digest('hex');
      const outputHash = createHash('sha256').update(payloadStr).digest('hex');

      return {
        criteria: criteriaOutputs,
        model: 'deterministic-fake-model-v2',
        promptVersion: '2026-11-assessment-v1',
        inputHash,
        outputHash,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
}

export interface AssessmentProviderFactoryOptions {
  providerType?: 'openai' | 'fake' | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export function createAssessmentProvider(
  options: AssessmentProviderFactoryOptions = {},
): AssessmentProvider {
  const nodeEnv = process.env['NODE_ENV'];
  const isTestEnv = nodeEnv === 'test';
  const isProdEnv = nodeEnv === 'production';
  const requestedType =
    options.providerType ?? process.env['ASSESSMENT_PROVIDER'] ?? (isTestEnv ? 'fake' : 'openai');

  if (requestedType === 'fake') {
    if (!isTestEnv) {
      throw new Error(
        `SECURITY_VIOLATION: DeterministicFakeAssessmentProvider is only permitted when NODE_ENV === 'test'. Current environment: ${nodeEnv || '(unset)'}`,
      );
    }
    return createDeterministicFakeAssessmentProvider();
  }

  if (isProdEnv) {
    const explicitProvider = options.providerType ?? process.env['ASSESSMENT_PROVIDER'];
    if (!explicitProvider) {
      return {
        async assess(): Promise<AssessmentProviderOutput> {
          throw new AssessmentProviderNotConfiguredError(
            'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Production environment requires explicit ASSESSMENT_PROVIDER configuration.',
          );
        },
      };
    }
  }

  const apiKey =
    options.apiKey ?? process.env['ASSESSMENT_OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  const model =
    options.model ?? process.env['ASSESSMENT_OPENAI_MODEL'] ?? process.env['OPENAI_MODEL'];

  if (!apiKey || !apiKey.trim() || !model || !model.trim()) {
    return {
      async assess(): Promise<AssessmentProviderOutput> {
        throw new AssessmentProviderNotConfiguredError(
          'ASSESSMENT_PROVIDER_NOT_CONFIGURED: Production AI provider requires ASSESSMENT_OPENAI_API_KEY and ASSESSMENT_OPENAI_MODEL.',
        );
      },
    };
  }

  return {
    async assess(): Promise<AssessmentProviderOutput> {
      throw new Error(
        'OpenAI provider execution in worker is configured via API package or custom client.',
      );
    },
  };
}
