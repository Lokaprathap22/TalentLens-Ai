/**
 * Candidate API client for the recruiter-facing Candidate Directory workspace.
 *
 * All routes are verified against the actual backend implementations in:
 *   apps/api/src/modules/workflow/workflow.routes.ts
 *   apps/api/src/modules/resumes/resume.routes.ts
 *   apps/api/src/modules/workflow/workflow.dto.ts
 *   apps/api/src/modules/resumes/resume.types.ts
 *
 * Security invariants:
 *  - All requests use the existing apiClient (same-origin credentials, CSRF injection).
 *  - No candidate PII (fullNameEncrypted, emailEncrypted, etc.) is ever requested or logged.
 *  - FormData uploads never set Content-Type manually; the apiClient handles boundary generation.
 *  - Tenant isolation comes exclusively from the authenticated session on the backend.
 *  - organizationId is never accepted from the frontend caller as a parameter.
 */

import { ApiError, apiClient, isApiError, resolveApiUrl } from '../../lib/api-client.js';
import type {
  AssessmentEnqueueResult,
  CandidateDetail,
  CandidateReviewResponseDto,
  CandidateShortlistDto,
  CandidateSubmissionDto,
  CandidateSummary,
  CandidateTimelineDto,
  DocumentExtraction,
  GetDocumentExtractionResponse,
  GetResumeDetailsResponse,
  ListCandidatesQuery,
  ListCandidatesResponse,
  ResumeBatchUploadResult,
  ResumeDocumentDto,
  ReviewDecision,
  TriggerAssessmentApiResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Upload configuration constants (verified against resume.multipart.ts)
// ---------------------------------------------------------------------------
/** Maximum number of files per batch upload request. */
export const UPLOAD_MAX_FILES = 10;
/** Maximum size in bytes per individual file (10 MB). */
export const UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Accepted MIME types for client-side extension pre-filtering. */
export const UPLOAD_ACCEPTED_TYPES = ['.pdf', '.docx'] as const;
/** Human-readable accepted type description. */
export const UPLOAD_ACCEPTED_TYPES_LABEL = 'PDF or DOCX';

// ---------------------------------------------------------------------------
// Runtime DTO validation helpers
// ---------------------------------------------------------------------------

function isValidCandidateSummary(value: unknown): value is CandidateSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r['candidateId'] === 'string' &&
    r['candidateId'].trim().length > 0 &&
    typeof r['candidateCode'] === 'string' &&
    r['candidateCode'].trim().length > 0 &&
    typeof r['resumeDocumentId'] === 'string' &&
    typeof r['resumeFileName'] === 'string' &&
    typeof r['parseStatus'] === 'string' &&
    typeof r['isComplete'] === 'boolean' &&
    typeof r['criteriaCount'] === 'number' &&
    typeof r['criteriaMetCount'] === 'number' &&
    typeof r['reviewStatus'] === 'string' &&
    typeof r['isShortlisted'] === 'boolean' &&
    typeof r['lastActivityAt'] === 'string'
  );
}

function isValidListCandidatesResponse(value: unknown): value is ListCandidatesResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r['items']) &&
    r['items'].every(isValidCandidateSummary) &&
    typeof r['total'] === 'number'
  );
}

function isValidResumeBatchUploadResult(value: unknown): value is ResumeBatchUploadResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    (r['batchId'] === null || typeof r['batchId'] === 'string') &&
    typeof r['totalFiles'] === 'number' &&
    typeof r['acceptedCount'] === 'number' &&
    typeof r['duplicateCount'] === 'number' &&
    typeof r['rejectedCount'] === 'number' &&
    Array.isArray(r['accepted']) &&
    Array.isArray(r['duplicates']) &&
    Array.isArray(r['rejected'])
  );
}

function isValidCandidateDetail(value: unknown): value is CandidateDetail {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const client = r['client'] as Record<string, unknown> | undefined;
  const resume = r['resume'] as Record<string, unknown> | undefined;
  return (
    typeof r['candidateId'] === 'string' &&
    typeof r['candidateCode'] === 'string' &&
    typeof r['requisitionId'] === 'string' &&
    typeof r['requisitionTitle'] === 'string' &&
    typeof client === 'object' &&
    client !== null &&
    typeof client['id'] === 'string' &&
    typeof client['name'] === 'string' &&
    typeof resume === 'object' &&
    resume !== null &&
    typeof resume['id'] === 'string' &&
    typeof resume['fileName'] === 'string' &&
    typeof resume['fileType'] === 'string' &&
    typeof resume['sizeBytes'] === 'number' &&
    typeof resume['uploadedAt'] === 'string' &&
    typeof r['hasInspectedOriginalResume'] === 'boolean' &&
    Array.isArray(r['clientFeedback'])
  );
}

function isValidDocumentExtractionResponse(value: unknown): value is GetDocumentExtractionResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const ext = r['extraction'] as Record<string, unknown> | undefined;
  return (
    typeof ext === 'object' &&
    ext !== null &&
    typeof ext['id'] === 'string' &&
    typeof ext['resumeDocumentId'] === 'string' &&
    typeof ext['version'] === 'number' &&
    typeof ext['extractedText'] === 'string' &&
    typeof ext['parser'] === 'string' &&
    typeof ext['ocrUsed'] === 'boolean' &&
    typeof ext['qualityStatus'] === 'string' &&
    typeof ext['createdAt'] === 'string'
  );
}

function isValidResumeDetailsResponse(value: unknown): value is GetResumeDetailsResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const resume = r['resume'] as Record<string, unknown> | undefined;
  return (
    typeof resume === 'object' &&
    resume !== null &&
    typeof resume['id'] === 'string' &&
    typeof resume['candidateId'] === 'string' &&
    typeof resume['candidateCode'] === 'string' &&
    typeof resume['fileName'] === 'string' &&
    typeof resume['fileType'] === 'string' &&
    typeof resume['sizeBytes'] === 'number' &&
    typeof resume['sha256'] === 'string' &&
    typeof resume['parseStatus'] === 'string' &&
    typeof resume['uploadedAt'] === 'string'
  );
}

function isValidTriggerAssessmentResponse(value: unknown): value is TriggerAssessmentApiResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const data = r['data'] as Record<string, unknown> | undefined;
  return (
    typeof r['status'] === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    typeof data['isExisting'] === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Error message resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a human-safe error message for candidate listing failures.
 * Does not expose internal server details.
 */
export function resolveCandidateErrorMessage(error: unknown, fallback: string): string {
  if (!isApiError(error)) {
    return fallback;
  }
  if (error.status === 400 && error.message) {
    return error.message;
  }
  if (error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error.status === 403 || error.code === 'forbidden') {
    return 'You do not have permission to view candidates for this requisition.';
  }
  if (error.status === 404 || error.code === 'not_found') {
    return 'The requisition could not be found in your organization.';
  }
  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to reach TalentLens AI. Check your connection and try again.';
  }
  if (error.status >= 500) {
    return 'The candidate service is temporarily unavailable. Please try again shortly.';
  }
  return fallback;
}

/**
 * Resolves a human-safe error message for resume upload failures.
 * Does not expose file contents, stack traces, or internal paths.
 */
export function resolveUploadErrorMessage(error: unknown): string {
  if (!isApiError(error)) {
    return 'An unexpected error occurred during upload. Please try again.';
  }
  if (error.status === 400) {
    if (error.code === 'invalid_request' && error.message.trim().length > 0) {
      return error.message;
    }
    return 'The upload request was rejected. Check the files and try again.';
  }
  if (error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (error.status === 403 || error.code === 'forbidden') {
    return 'You do not have permission to upload resumes to this requisition.';
  }
  if (error.status === 404 || error.code === 'not_found') {
    return 'The requisition could not be found. It may have been removed.';
  }
  if (error.status === 413 || error.code === 'file_too_large') {
    return `One or more files exceed the maximum size of ${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MB.`;
  }
  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to reach TalentLens AI. Check your connection and try again.';
  }
  if (error.status >= 500) {
    return 'The upload service is temporarily unavailable. Please try again shortly.';
  }
  return 'An unexpected error occurred during upload. Please try again.';
}

// ---------------------------------------------------------------------------
// Client-side file validation (pre-flight only — backend validates definitively)
// ---------------------------------------------------------------------------

/**
 * Performs client-side pre-flight validation on a File object.
 * Returns null if valid, or a human-readable error string if invalid.
 *
 * IMPORTANT: Backend performs definitive magic-bytes MIME validation.
 * Client-side extension checks are UX assists only, not security controls.
 */
export function validateUploadFile(file: File): string | null {
  if (file.size === 0) {
    return `"${file.name}" is empty and cannot be uploaded.`;
  }
  if (file.size > UPLOAD_MAX_FILE_BYTES) {
    const maxMb = UPLOAD_MAX_FILE_BYTES / (1024 * 1024);
    const fileMb = (file.size / (1024 * 1024)).toFixed(1);
    return `"${file.name}" is ${fileMb} MB, which exceeds the ${maxMb} MB limit.`;
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith('.pdf') && !name.endsWith('.docx')) {
    return `"${file.name}" is not a supported format. Only PDF and DOCX files are accepted.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Lists candidates for a requisition.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/candidates
 * Auth: Recruiter session required (enforced by backend middleware).
 * Pagination: Backend supports offset-based pagination via limit/offset query params.
 */
export async function listCandidates(
  requisitionId: string,
  query: ListCandidatesQuery = {},
  signal?: AbortSignal,
): Promise<ListCandidatesResponse> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  if (query.processingStatus !== undefined) {
    params.set('processingStatus', query.processingStatus);
  }
  if (query.assessmentStatus !== undefined) {
    params.set('assessmentStatus', query.assessmentStatus);
  }
  if (query.reviewDecision !== undefined) {
    params.set('reviewDecision', query.reviewDecision);
  }
  if (query.submissionStatus !== undefined) {
    params.set('submissionStatus', query.submissionStatus);
  }

  const queryString = params.toString();
  const path = queryString
    ? `/requisitions/${encodeURIComponent(trimmedId)}/candidates?${queryString}`
    : `/requisitions/${encodeURIComponent(trimmedId)}/candidates`;

  const response = await apiClient.get<unknown>(path, signal !== undefined ? { signal } : {});

  if (!isValidListCandidatesResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected candidate directory response from the server.',
    });
  }

  return response;
}

/**
 * Uploads a batch of resume files for a requisition.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/resumes
 * Auth: Recruiter session + CSRF token (injected automatically by apiClient).
 * Content-Type: multipart/form-data (browser sets boundary — do NOT set manually).
 *
 * Backend constraints (verified in resume.multipart.ts):
 *   - Max 10 files per request
 *   - Max 10 MB per file
 *   - PDF (%PDF magic bytes) and DOCX (PK\x03\x04 magic bytes) only
 *
 * The FormData body is passed directly to apiClient.post which detects FormData
 * and clears Content-Type so the browser sets the correct multipart boundary.
 *
 * IMPORTANT: Never log file contents, candidate codes, or extracted text.
 */
export async function uploadResumes(
  requisitionId: string,
  files: File[],
  signal?: AbortSignal,
): Promise<ResumeBatchUploadResult> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  if (files.length === 0) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'At least one file must be selected before uploading.',
    });
  }

  if (files.length > UPLOAD_MAX_FILES) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: `Upload is limited to ${UPLOAD_MAX_FILES} files per batch. Please split your upload into smaller batches.`,
    });
  }

  const formData = new FormData();
  for (const file of files) {
    // Field name must match what the backend expects from multipart parsing.
    // The backend parser extracts any part that has a filename= attribute in
    // Content-Disposition, so the field name is not constrained — we use 'files'.
    formData.append('files', file);
  }

  // apiClient.post detects FormData and removes Content-Type so the browser
  // generates the correct multipart/form-data; boundary= header automatically.
  const response = await apiClient.post<unknown>(
    `/requisitions/${encodeURIComponent(trimmedId)}/resumes`,
    formData,
    signal !== undefined ? { signal } : {},
  );

  if (!isValidResumeBatchUploadResult(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected upload response from the server.',
    });
  }

  return response;
}

// ---------------------------------------------------------------------------
// Candidate detail & Resume inspection API functions
// ---------------------------------------------------------------------------

export interface ResumeFileResult {
  blob: Blob;
  mimeType: string;
  fileName: string;
}

/**
 * Retrieves the full candidate review detail for a requisition.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/candidates/:candidateId
 * Auth: Recruiter session required.
 */
export async function getCandidateDetail(
  requisitionId: string,
  candidateId: string,
  signal?: AbortSignal,
): Promise<CandidateDetail> {
  const trimmedReqId = requisitionId.trim();
  const trimmedCandId = candidateId.trim();
  if (!trimmedReqId || !trimmedCandId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and candidate identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}`;
  const response = await apiClient.get<unknown>(path, signal !== undefined ? { signal } : {});

  if (!isValidCandidateDetail(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected candidate detail response from the server.',
    });
  }

  return response;
}

/**
 * Retrieves the document extraction data (clean extracted text, quality status, metadata).
 *
 * Route: GET /api/v1/requisitions/:requisitionId/resumes/:resumeId/extraction
 * Auth: Recruiter session required.
 */
export async function getResumeExtraction(
  requisitionId: string,
  resumeId: string,
  signal?: AbortSignal,
): Promise<DocumentExtraction> {
  const trimmedReqId = requisitionId.trim();
  const trimmedResumeId = resumeId.trim();
  if (!trimmedReqId || !trimmedResumeId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and resume identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/resumes/${encodeURIComponent(trimmedResumeId)}/extraction`;
  const response = await apiClient.get<unknown>(path, signal !== undefined ? { signal } : {});

  if (!isValidDocumentExtractionResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected resume extraction response from the server.',
    });
  }

  return response.extraction;
}

/**
 * Retrieves resume document metadata including truthful server-backed parseStatus.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/resumes/:resumeId
 * Auth: Recruiter session required.
 */
export async function getResumeDetails(
  requisitionId: string,
  resumeId: string,
  signal?: AbortSignal,
): Promise<ResumeDocumentDto> {
  const trimmedReqId = requisitionId.trim();
  const trimmedResumeId = resumeId.trim();
  if (!trimmedReqId || !trimmedResumeId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and resume identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/resumes/${encodeURIComponent(trimmedResumeId)}`;
  const response = await apiClient.get<unknown>(path, signal !== undefined ? { signal } : {});

  if (!isValidResumeDetailsResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected resume details response from the server.',
    });
  }

  return response.resume;
}

/**
 * Triggers or idempotently retrieves deterministic AI assessment for a resume.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/resumes/:resumeId/assessments
 * Auth: Recruiter session required + CSRF token.
 * Preconditions enforced by server: Active candidate consent, complete resume extraction, approved scorecard.
 */
export async function triggerCandidateAssessment(
  requisitionId: string,
  resumeId: string,
  signal?: AbortSignal,
): Promise<AssessmentEnqueueResult> {
  const trimmedReqId = requisitionId.trim();
  const trimmedResumeId = resumeId.trim();
  if (!trimmedReqId || !trimmedResumeId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and resume identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/resumes/${encodeURIComponent(trimmedResumeId)}/assessments`;
  const response = await apiClient.post<unknown>(path, {}, signal !== undefined ? { signal } : {});

  if (!isValidTriggerAssessmentResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected assessment trigger response from the server.',
    });
  }

  return response.data;
}

/**
 * Retrieves the raw resume file as a Blob and marks the original CV as inspected in the audit log.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/resumes/:resumeId/file
 * Auth: Recruiter session required.
 * Side effect: Backend triggers repository.recordResumeInspection, creating an
 *              ORIGINAL_RESUME_INSPECTED audit log entry, enabling candidate submission.
 */
export async function getResumeFileBlob(
  requisitionId: string,
  resumeId: string,
  fallbackFileName = 'resume',
  signal?: AbortSignal,
): Promise<ResumeFileResult> {
  const trimmedReqId = requisitionId.trim();
  const trimmedResumeId = resumeId.trim();
  if (!trimmedReqId || !trimmedResumeId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and resume identifiers are required.',
    });
  }

  const url = resolveApiUrl(
    `/requisitions/${encodeURIComponent(trimmedReqId)}/resumes/${encodeURIComponent(trimmedResumeId)}/file`,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        accept: '*/*',
      },
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Unable to reach TalentLens AI. Check your connection and try again.',
    });
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError({
        status: 401,
        code: 'unauthorized',
        message: 'Your session has expired. Please sign in again.',
      });
    }
    if (response.status === 403) {
      throw new ApiError({
        status: 403,
        code: 'forbidden',
        message: 'You do not have permission to access this resume file.',
      });
    }
    if (response.status === 404) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resume document could not be found.',
      });
    }
    throw new ApiError({
      status: response.status,
      code: 'download_failed',
      message: 'Failed to retrieve the resume file from storage.',
    });
  }

  // Parse filename from Content-Disposition if present
  let fileName = fallbackFileName;
  const disposition = response.headers.get('content-disposition');
  if (disposition) {
    const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (filenameMatch && filenameMatch[1]) {
      fileName = decodeURIComponent(filenameMatch[1].trim());
    }
  }

  const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
  const blob = await response.blob();

  return { blob, mimeType, fileName };
}

/**
 * Records or updates a recruiter review decision for a candidate on a requisition.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/candidates/:candidateId/reviews
 * Auth: Recruiter session + CSRF token.
 * Note: If decision is downgraded to NEEDS_REVIEW or CLOSED, the backend automatically
 * invalidates any active shortlist record to maintain workflow integrity.
 */
export async function recordCandidateReview(
  requisitionId: string,
  candidateId: string,
  decision: ReviewDecision,
  notesInternal?: string,
): Promise<CandidateReviewResponseDto> {
  const trimmedReqId = requisitionId.trim();
  const trimmedCandId = candidateId.trim();
  if (!trimmedReqId || !trimmedCandId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and candidate identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}/reviews`;
  return apiClient.post<CandidateReviewResponseDto>(path, {
    decision,
    ...(notesInternal ? { notesInternal: notesInternal.trim() } : {}),
  });
}

/**
 * Shortlists a candidate for client submission under a requisition.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/candidates/:candidateId/shortlist
 * Auth: Recruiter session + CSRF token.
 * Prerequisites enforced server-side:
 *   - Requisition must not be CLOSED or FILLED
 *   - Active consent required
 *   - Recruiter must have inspected the original resume file
 *   - Latest candidate review decision must be REVIEWED
 */
export async function shortlistCandidate(
  requisitionId: string,
  candidateId: string,
  notesInternal?: string,
): Promise<CandidateShortlistDto> {
  const trimmedReqId = requisitionId.trim();
  const trimmedCandId = candidateId.trim();
  if (!trimmedReqId || !trimmedCandId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and candidate identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}/shortlist`;
  return apiClient.post<CandidateShortlistDto>(path, {
    ...(notesInternal ? { notesInternal: notesInternal.trim() } : {}),
  });
}

/**
 * Retrieves the complete pipeline timeline and audit trail for a candidate on a requisition.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/candidates/:candidateId/timeline
 * Auth: Recruiter session required.
 */
export async function getCandidateTimeline(
  requisitionId: string,
  candidateId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<CandidateTimelineDto> {
  const trimmedReqId = requisitionId.trim();
  const trimmedCandId = candidateId.trim();
  if (!trimmedReqId || !trimmedCandId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and candidate identifiers are required.',
    });
  }

  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options.offset !== undefined) {
    params.set('offset', String(options.offset));
  }
  const queryString = params.toString();
  const path = queryString
    ? `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}/timeline?${queryString}`
    : `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}/timeline`;

  return apiClient.get<CandidateTimelineDto>(path);
}

/**
 * Submits a shortlisted candidate to the hiring client for a requisition.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/candidates/:candidateId/submissions
 * Auth: Recruiter session + CSRF token + same-origin.
 * Prerequisites enforced server-side:
 *   - Requisition must not be CLOSED or FILLED and must be linked to an ACTIVE client
 *   - Candidate must have an explicit REVIEWED decision
 *   - Candidate must be shortlisted
 *   - Recruiter must have inspected the original resume file
 *   - Active consent with client sharing
 *   - Assessment must exist
 *   - No duplicate active submission
 */
export async function submitCandidateToClient(
  requisitionId: string,
  candidateId: string,
): Promise<CandidateSubmissionDto> {
  const trimmedReqId = requisitionId.trim();
  const trimmedCandId = candidateId.trim();
  if (!trimmedReqId || !trimmedCandId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and candidate identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/candidates/${encodeURIComponent(trimmedCandId)}/submissions`;
  return apiClient.post<CandidateSubmissionDto>(path, {});
}

/**
 * Lists all candidate submissions for a requisition.
 *
 * Route: GET /api/v1/requisitions/:requisitionId/submissions
 * Auth: Recruiter session required.
 */
export async function listSubmissionsForRequisition(
  requisitionId: string,
): Promise<CandidateSubmissionDto[]> {
  const trimmedReqId = requisitionId.trim();
  if (!trimmedReqId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition identifier is required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/submissions`;
  const result = await apiClient.get<{ submissions: CandidateSubmissionDto[] }>(path);
  return result.submissions;
}

/**
 * Proposes an interview or an alternative time window for a candidate submission.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/propose
 * Auth: Recruiter session + CSRF token + same-origin.
 */
export async function proposeInterviewForSubmission(
  requisitionId: string,
  submissionId: string,
  input: {
    startAt: string;
    endAt?: string | undefined;
    timezone: string;
    format?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | undefined;
    reason?: string | undefined;
    proposalId?: string | undefined;
  },
): Promise<{ success: boolean; action: string; proposalId: string }> {
  const trimmedReqId = requisitionId.trim();
  const trimmedSubId = submissionId.trim();
  if (!trimmedReqId || !trimmedSubId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and submission identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/propose`;
  return apiClient.post(path, input);
}

/**
 * Accepts a client-proposed interview window.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/accept
 * Auth: Recruiter session + CSRF token + same-origin.
 */
export async function acceptInterviewProposal(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean; action: string }> {
  const trimmedReqId = requisitionId.trim();
  const trimmedSubId = submissionId.trim();
  const trimmedPropId = proposalId.trim();
  if (!trimmedReqId || !trimmedSubId || !trimmedPropId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/${encodeURIComponent(trimmedPropId)}/accept`;
  return apiClient.post(path, {});
}

/**
 * Rejects a client-proposed interview window with a mandatory reason.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/reject
 * Auth: Recruiter session + CSRF token + same-origin.
 */
export async function rejectInterviewProposal(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
  reason: string,
): Promise<{ success: boolean; action: string }> {
  const trimmedReqId = requisitionId.trim();
  const trimmedSubId = submissionId.trim();
  const trimmedPropId = proposalId.trim();
  if (!trimmedReqId || !trimmedSubId || !trimmedPropId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/${encodeURIComponent(trimmedPropId)}/reject`;
  return apiClient.post(path, { reason: reason.trim() });
}

/**
 * Marks an accepted interview as completed.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/complete
 * Auth: Recruiter session + CSRF token + same-origin.
 */
export async function completeInterview(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean; action: string }> {
  const trimmedReqId = requisitionId.trim();
  const trimmedSubId = submissionId.trim();
  const trimmedPropId = proposalId.trim();
  if (!trimmedReqId || !trimmedSubId || !trimmedPropId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }

  const path = `/requisitions/${encodeURIComponent(trimmedReqId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/${encodeURIComponent(trimmedPropId)}/complete`;
  return apiClient.post(path, {});
}
