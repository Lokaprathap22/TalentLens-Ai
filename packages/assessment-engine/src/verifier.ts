import type { CriterionAssessmentStatus, VerificationMethod } from '@talentlens/database';
import type {
  AssessmentCriterionOutput,
  ScorecardCriterionDefinition,
  VerifiedCriterionResult,
  VerifiedEvidenceSnippet,
} from './types.js';

interface PageMapEntry {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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

  // 1. Exact verbatim match
  const exactIdx = sourceText.indexOf(quote);
  if (exactIdx !== -1) {
    return {
      startOffset: exactIdx,
      endOffset: exactIdx + quote.length,
      matchedQuote: sourceText.slice(exactIdx, exactIdx + quote.length),
    };
  }

  // 2. Case-insensitive match
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

  // 3. Normalized whitespace match
  const normalizedQuote = normalizeWhitespace(quote);
  const normalizedSource = normalizeWhitespace(sourceText);
  const normIdx = normalizedSource.indexOf(normalizedQuote);
  if (normIdx !== -1 && normalizedQuote.length > 15) {
    // Locate approximate window in source text
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
      // Missing criterion evaluation from AI
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

    // Verify evidence quotes
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

    // Determine final status and score
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
          // Validate against approved criterion minimum and maximum scale
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
        // AI claimed a match but provided zero verifiable evidence
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
