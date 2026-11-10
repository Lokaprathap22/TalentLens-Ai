import { ApiError, apiClient, isApiError } from '../../lib/api-client.js';
import type {
  ApprovalReadinessCheck,
  CreateScorecardDraftInput,
  CriterionCategory,
  EvidenceVerificationStatus,
  ListScorecardsResponseDto,
  RequirementType,
  ScorecardCriterionEvidence,
  ScorecardCriterionRecord,
  ScorecardRecord,
  ScorecardResponseDto,
  ScorecardStatus,
  UpdateScorecardInput,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_SCORECARD_STATUSES: ReadonlySet<ScorecardStatus> = new Set([
  'DRAFT',
  'APPROVED',
  'ARCHIVED',
]);

const VALID_CATEGORIES: ReadonlySet<CriterionCategory> = new Set([
  'SKILL',
  'EXPERIENCE',
  'NOTICE',
  'COMPENSATION',
  'OTHER_JOB_RELATED',
]);

const VALID_REQUIREMENT_TYPES: ReadonlySet<RequirementType> = new Set(['MUST_HAVE', 'PREFERRED']);

const VALID_VERIFICATION_STATUSES: ReadonlySet<EvidenceVerificationStatus> = new Set([
  'PENDING_RECRUITER_REVIEW',
  'VERIFIED',
  'UNVERIFIED',
  'REJECTED',
]);

export function isValidCriterionEvidence(value: unknown): value is ScorecardCriterionEvidence {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  return (
    typeof evidence['sourceQuote'] === 'string' &&
    (evidence['sourceStart'] === null || typeof evidence['sourceStart'] === 'number') &&
    (evidence['sourceEnd'] === null || typeof evidence['sourceEnd'] === 'number') &&
    typeof evidence['verificationStatus'] === 'string' &&
    VALID_VERIFICATION_STATUSES.has(evidence['verificationStatus'] as EvidenceVerificationStatus)
  );
}

export function isValidCriterionRecord(value: unknown): value is ScorecardCriterionRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const criterion = value as Record<string, unknown>;
  const validEvidence =
    criterion['evidence'] === null || isValidCriterionEvidence(criterion['evidence']);

  return (
    typeof criterion['id'] === 'string' &&
    criterion['id'].trim().length > 0 &&
    typeof criterion['key'] === 'string' &&
    typeof criterion['label'] === 'string' &&
    typeof criterion['description'] === 'string' &&
    typeof criterion['category'] === 'string' &&
    VALID_CATEGORIES.has(criterion['category'] as CriterionCategory) &&
    typeof criterion['requirementType'] === 'string' &&
    VALID_REQUIREMENT_TYPES.has(criterion['requirementType'] as RequirementType) &&
    typeof criterion['weight'] === 'number' &&
    Number.isFinite(criterion['weight']) &&
    typeof criterion['displayOrder'] === 'number' &&
    typeof criterion['active'] === 'boolean' &&
    validEvidence
  );
}

export function isValidScorecardRecord(value: unknown): value is ScorecardRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['requisitionId'] === 'string' &&
    record['requisitionId'].trim().length > 0 &&
    typeof record['version'] === 'number' &&
    record['version'] > 0 &&
    typeof record['status'] === 'string' &&
    VALID_SCORECARD_STATUSES.has(record['status'] as ScorecardStatus) &&
    typeof record['weights'] === 'object' &&
    record['weights'] !== null &&
    (record['approvedById'] === null || typeof record['approvedById'] === 'string') &&
    (record['approvedAt'] === null || typeof record['approvedAt'] === 'string') &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string' &&
    Array.isArray(record['criteria']) &&
    record['criteria'].every(isValidCriterionRecord)
  );
}

export const BACKEND_WEIGHT_TOLERANCE = 0.0001;

export function computeApprovalReadiness(scorecard: ScorecardRecord): ApprovalReadinessCheck {
  const activeCriteria = scorecard.criteria.filter((c) => c.active);
  const hasActiveCriteria = activeCriteria.length > 0;
  const hasMustHaveCriterion = activeCriteria.some((c) => c.requirementType === 'MUST_HAVE');

  const rawTotalWeight = activeCriteria.reduce((sum, c) => sum + c.weight, 0);
  const totalActiveWeight = Math.round(rawTotalWeight * 10000) / 10000;
  const allWeightsPositive = activeCriteria.length > 0 && activeCriteria.every((c) => c.weight > 0);
  const weightsSumTo100 =
    Math.abs(rawTotalWeight - 100) <= BACKEND_WEIGHT_TOLERANCE && allWeightsPositive;

  const unverifiedActiveCriteria = activeCriteria.filter((c) => {
    return !c.evidence || c.evidence.verificationStatus !== 'VERIFIED';
  });
  const unverifiedCount = unverifiedActiveCriteria.length;
  const allActiveEvidenceVerified = hasActiveCriteria && unverifiedCount === 0;

  const blockingReasons: string[] = [];

  if (!hasActiveCriteria) {
    blockingReasons.push('Scorecard must have at least one active criterion.');
  }
  if (!hasMustHaveCriterion) {
    blockingReasons.push('Scorecard must have at least one active "Must-Have" requirement.');
  }
  if (!weightsSumTo100) {
    if (Math.abs(rawTotalWeight - 100) > BACKEND_WEIGHT_TOLERANCE) {
      blockingReasons.push(
        `Active criteria weights must sum to exactly 100% (currently ${totalActiveWeight}%).`,
      );
    } else if (!allWeightsPositive) {
      blockingReasons.push('All active criteria must have a positive weight (> 0%).');
    }
  }
  if (!allActiveEvidenceVerified) {
    blockingReasons.push(
      `${unverifiedCount} active ${unverifiedCount === 1 ? 'criterion requires' : 'criteria require'} verified source evidence from the job description.`,
    );
  }

  const isReady =
    hasActiveCriteria && hasMustHaveCriterion && weightsSumTo100 && allActiveEvidenceVerified;

  return {
    hasActiveCriteria,
    hasMustHaveCriterion,
    weightsSumTo100,
    totalActiveWeight,
    allActiveEvidenceVerified,
    unverifiedCount,
    isReady,
    blockingReasons,
  };
}

export function resolveScorecardErrorMessage(
  error: unknown,
  fallbackMessage: string,
  context?: {
    action?: 'create' | 'update' | 'approve' | 'list' | 'get';
  },
): string {
  if (!isApiError(error)) {
    return fallbackMessage;
  }

  if (error.status === 400) {
    if (context?.action === 'approve') {
      return 'Scorecard approval criteria not met. Ensure active criteria weights sum to 100%, at least one must-have exists, and all active requirements have verified source quotes.';
    }
    if (context?.action === 'create') {
      return 'Unable to generate scorecard draft. Ensure the requisition has a valid job description.';
    }
    if (context?.action === 'update') {
      return 'Unable to save scorecard changes. Check criterion fields and weights.';
    }
    if (error.message.trim().length > 0 && error.message !== 'invalid_request') {
      return error.message;
    }
    return 'Invalid scorecard request. Please verify the criteria and try again.';
  }

  if (error.status === 403 || error.code === 'forbidden') {
    return 'Recruiter permissions required to manage scorecards.';
  }

  if (error.status === 404 || error.code === 'not_found') {
    return 'The requested scorecard or requisition could not be found.';
  }

  if (error.code === 'provider_not_configured') {
    return 'AI scorecard extraction is not configured on the server (missing GEMINI_API_KEY / GROQ_API_KEY). You can create a manual draft instead.';
  }

  if (error.code === 'provider_configuration_error') {
    return 'AI scorecard extraction configuration or model is invalid. Verify GEMINI_MODEL / GROQ_MODEL and API keys, or create a manual draft.';
  }

  if (error.code === 'provider_auth_error') {
    return 'AI provider authentication failed. Please verify the configured Gemini / Groq API keys and permissions, then retry or create a manual draft.';
  }

  if (
    error.status === 429 ||
    error.code === 'provider_rate_limited' ||
    error.code === 'too_many_requests'
  ) {
    return 'The AI extraction service is temporarily rate-limited or over quota. Wait a moment and retry, or create a manual draft.';
  }

  if (error.code === 'provider_content_blocked') {
    return 'AI extraction could not process this job description due to a safety or content policy block. Review the job description text or create a manual draft.';
  }

  if (error.code === 'provider_invalid_response') {
    return 'AI requirement extraction returned an invalid or incomplete structured response. You can retry or create a manual draft.';
  }

  if (error.code === 'provider_invalid_request') {
    return 'The AI extraction request or schema was rejected by the upstream provider. You can retry or create a manual draft.';
  }

  if (error.status === 502 || error.code === 'provider_unavailable') {
    return 'The AI requirement extraction provider is currently unreachable. You can retry or create a manual draft.';
  }

  if (error.status === 504 || error.code === 'provider_timeout') {
    return 'The AI extraction service timed out while analyzing the job description. Please retry or proceed with a manual draft.';
  }

  if (error.status === 503 || error.code === 'service_unavailable') {
    return 'The AI extraction service is not configured or temporarily unavailable. You can create a manual draft instead.';
  }

  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to connect to the server. Please check your network connection.';
  }

  return fallbackMessage;
}

export async function listScorecards(
  requisitionId: string,
  signal?: AbortSignal,
): Promise<ScorecardRecord[]> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId || !UUID_PATTERN.test(trimmedId)) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  const response = await apiClient.get<ListScorecardsResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedId)}/scorecards`,
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray(response.scorecards) ||
    !response.scorecards.every(isValidScorecardRecord)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected scorecard list response from the server.',
    });
  }

  return response.scorecards;
}

export async function getScorecard(
  requisitionId: string,
  scorecardVersionId: string,
  signal?: AbortSignal,
): Promise<ScorecardRecord> {
  const trimmedReqId = requisitionId.trim();
  const trimmedVersionId = scorecardVersionId.trim();

  if (
    !trimmedReqId ||
    !UUID_PATTERN.test(trimmedReqId) ||
    !trimmedVersionId ||
    !UUID_PATTERN.test(trimmedVersionId)
  ) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and scorecard identifiers are required.',
    });
  }

  const response = await apiClient.get<ScorecardResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedReqId)}/scorecards/${encodeURIComponent(trimmedVersionId)}`,
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidScorecardRecord(response.scorecard)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected scorecard response from the server.',
    });
  }

  return response.scorecard;
}

export async function createScorecardDraft(
  requisitionId: string,
  input?: CreateScorecardDraftInput,
): Promise<ScorecardRecord> {
  const trimmedReqId = requisitionId.trim();
  if (!trimmedReqId || !UUID_PATTERN.test(trimmedReqId)) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  const payload: CreateScorecardDraftInput = {};
  if (input?.mode !== undefined) {
    payload.mode = input.mode;
  }
  if (input?.cloneFromVersionId !== undefined) {
    payload.cloneFromVersionId = input.cloneFromVersionId;
  }

  const response = await apiClient.post<ScorecardResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedReqId)}/scorecards/drafts`,
    payload,
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidScorecardRecord(response.scorecard)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after creating scorecard draft.',
    });
  }

  return response.scorecard;
}

export async function updateScorecardDraft(
  requisitionId: string,
  scorecardVersionId: string,
  input: UpdateScorecardInput,
): Promise<ScorecardRecord> {
  const trimmedReqId = requisitionId.trim();
  const trimmedVersionId = scorecardVersionId.trim();

  if (
    !trimmedReqId ||
    !UUID_PATTERN.test(trimmedReqId) ||
    !trimmedVersionId ||
    !UUID_PATTERN.test(trimmedVersionId)
  ) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and scorecard identifiers are required.',
    });
  }

  const payload: UpdateScorecardInput = {};
  if (input.weights !== undefined) {
    payload.weights = input.weights;
  }
  if (input.criteria !== undefined) {
    payload.criteria = input.criteria;
  }

  const response = await apiClient.patch<ScorecardResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedReqId)}/scorecards/${encodeURIComponent(trimmedVersionId)}`,
    payload,
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidScorecardRecord(response.scorecard)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after updating scorecard draft.',
    });
  }

  return response.scorecard;
}

export async function approveScorecardDraft(
  requisitionId: string,
  scorecardVersionId: string,
): Promise<ScorecardRecord> {
  const trimmedReqId = requisitionId.trim();
  const trimmedVersionId = scorecardVersionId.trim();

  if (
    !trimmedReqId ||
    !UUID_PATTERN.test(trimmedReqId) ||
    !trimmedVersionId ||
    !UUID_PATTERN.test(trimmedVersionId)
  ) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and scorecard identifiers are required.',
    });
  }

  const response = await apiClient.post<ScorecardResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedReqId)}/scorecards/${encodeURIComponent(trimmedVersionId)}/approve`,
    {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidScorecardRecord(response.scorecard)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after approving scorecard draft.',
    });
  }

  return response.scorecard;
}
