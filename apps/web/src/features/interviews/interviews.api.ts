import { ApiError, apiClient } from '../../lib/api-client.js';
import type {
  InterviewFormat,
  InterviewItem,
  ListInterviewsQuery,
  ListInterviewsResponse,
} from './types.js';

function isValidInterviewItem(value: unknown): value is InterviewItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['submissionId'] === 'string' &&
    typeof r['requisitionId'] === 'string' &&
    typeof r['requisitionTitle'] === 'string' &&
    typeof r['clientId'] === 'string' &&
    typeof r['clientName'] === 'string' &&
    typeof r['candidateId'] === 'string' &&
    typeof r['candidateCode'] === 'string' &&
    typeof r['proposerUserId'] === 'string' &&
    (r['proposerRole'] === 'RECRUITER' || r['proposerRole'] === 'CLIENT_HIRING_MANAGER') &&
    typeof r['startAt'] === 'string' &&
    typeof r['endAt'] === 'string' &&
    typeof r['timezone'] === 'string' &&
    typeof r['format'] === 'string' &&
    typeof r['status'] === 'string' &&
    typeof r['canAccept'] === 'boolean' &&
    typeof r['canReject'] === 'boolean' &&
    typeof r['canReschedule'] === 'boolean' &&
    typeof r['canComplete'] === 'boolean' &&
    typeof r['createdAt'] === 'string' &&
    typeof r['updatedAt'] === 'string'
  );
}

function isValidListInterviewsResponse(value: unknown): value is ListInterviewsResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (
    !Array.isArray(r['items']) ||
    !r['items'].every(isValidInterviewItem) ||
    typeof r['total'] !== 'number' ||
    typeof r['page'] !== 'number' ||
    typeof r['pageSize'] !== 'number' ||
    typeof r['totalPages'] !== 'number' ||
    typeof r['counts'] !== 'object' ||
    r['counts'] === null
  ) {
    return false;
  }

  const c = r['counts'] as Record<string, unknown>;
  return (
    typeof c['total'] === 'number' &&
    typeof c['upcoming'] === 'number' &&
    typeof c['pendingAction'] === 'number' &&
    typeof c['completed'] === 'number' &&
    typeof c['rejected'] === 'number'
  );
}

/**
 * Fetches interviews accessible to the authenticated principal (Recruiter or Client Hiring Manager).
 *
 * Route: GET /api/v1/interviews
 * Auth: Recruiter or Client Hiring Manager session.
 */
export async function listInterviews(
  query: ListInterviewsQuery = {},
  signal?: AbortSignal,
): Promise<ListInterviewsResponse> {
  const params = new URLSearchParams();

  if (query.page !== undefined) {
    params.set('page', String(query.page));
  }
  if (query.pageSize !== undefined) {
    params.set('pageSize', String(query.pageSize));
  }
  if (query.search !== undefined && query.search.trim().length > 0) {
    params.set('search', query.search.trim());
  }
  if (query.status !== undefined && query.status !== 'ALL') {
    params.set('status', query.status);
  }
  if (query.statusCategory !== undefined && query.statusCategory !== 'ALL') {
    params.set('statusCategory', query.statusCategory);
  }
  if (query.clientId !== undefined && query.clientId.trim().length > 0) {
    params.set('clientId', query.clientId.trim());
  }
  if (query.requisitionId !== undefined && query.requisitionId.trim().length > 0) {
    params.set('requisitionId', query.requisitionId.trim());
  }
  if (query.fromDate !== undefined && query.fromDate.trim().length > 0) {
    params.set('fromDate', query.fromDate.trim());
  }
  if (query.toDate !== undefined && query.toDate.trim().length > 0) {
    params.set('toDate', query.toDate.trim());
  }
  if (query.sortBy !== undefined) {
    params.set('sortBy', query.sortBy);
  }
  if (query.sortOrder !== undefined) {
    params.set('sortOrder', query.sortOrder);
  }

  const queryString = params.toString();
  const path = queryString ? `/interviews?${queryString}` : '/interviews';

  const response = await apiClient.get<unknown>(path, signal !== undefined ? { signal } : {});

  if (!isValidListInterviewsResponse(response)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected interviews response from the server.',
    });
  }

  return response;
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

/**
 * Recruiter accepts a client hiring manager's proposed interview window.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/accept
 */
export async function recruiterAcceptInterview(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean }> {
  const reqId = requisitionId.trim();
  const subId = submissionId.trim();
  const propId = proposalId.trim();
  if (!reqId || !subId || !propId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }
  const path = `/requisitions/${encodeURIComponent(reqId)}/submissions/${encodeURIComponent(subId)}/interviews/${encodeURIComponent(propId)}/accept`;
  return apiClient.post(path, {});
}

/**
 * Recruiter declines a client hiring manager's proposed interview window with reason.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/reject
 */
export async function recruiterRejectInterview(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
  reason: string,
): Promise<{ success: boolean }> {
  const reqId = requisitionId.trim();
  const subId = submissionId.trim();
  const propId = proposalId.trim();
  if (!reqId || !subId || !propId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }
  if (!reason.trim()) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A rejection reason is required.',
    });
  }
  const path = `/requisitions/${encodeURIComponent(reqId)}/submissions/${encodeURIComponent(subId)}/interviews/${encodeURIComponent(propId)}/reject`;
  return apiClient.post(path, { reason: reason.trim() });
}

/**
 * Recruiter proposes an alternative interview window (counter-proposal).
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/propose
 */
export async function recruiterProposeAlternativeInterview(
  requisitionId: string,
  submissionId: string,
  input: {
    proposalId?: string | undefined;
    startAt: string;
    endAt: string;
    timezone: string;
    format?: InterviewFormat | undefined;
  },
): Promise<{ proposalId: string }> {
  const reqId = requisitionId.trim();
  const subId = submissionId.trim();
  if (!reqId || !subId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition and submission identifiers are required.',
    });
  }
  const path = `/requisitions/${encodeURIComponent(reqId)}/submissions/${encodeURIComponent(subId)}/interviews/propose`;
  return apiClient.post(path, input);
}

/**
 * Recruiter marks an accepted interview as completed.
 *
 * Route: POST /api/v1/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/complete
 */
export async function recruiterCompleteInterview(
  requisitionId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean }> {
  const reqId = requisitionId.trim();
  const subId = submissionId.trim();
  const propId = proposalId.trim();
  if (!reqId || !subId || !propId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid requisition, submission, and proposal identifiers are required.',
    });
  }
  const path = `/requisitions/${encodeURIComponent(reqId)}/submissions/${encodeURIComponent(subId)}/interviews/${encodeURIComponent(propId)}/complete`;
  return apiClient.post(path, {});
}

/**
 * Client Hiring Manager accepts a recruiter's proposed interview window.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/interviews/:proposalId/accept
 */
export async function clientAcceptInterview(
  clientId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean }> {
  const cId = clientId.trim();
  const subId = submissionId.trim();
  const propId = proposalId.trim();
  if (!cId || !subId || !propId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client, submission, and proposal identifiers are required.',
    });
  }
  const path = `/clients/${encodeURIComponent(cId)}/submissions/${encodeURIComponent(subId)}/interviews/${encodeURIComponent(propId)}/accept`;
  return apiClient.post(path, {});
}

/**
 * Client Hiring Manager declines a recruiter's proposed interview window with reason.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/interviews/:proposalId/reject
 */
export async function clientRejectInterview(
  clientId: string,
  submissionId: string,
  proposalId: string,
  reason: string,
): Promise<{ success: boolean }> {
  const cId = clientId.trim();
  const subId = submissionId.trim();
  const propId = proposalId.trim();
  if (!cId || !subId || !propId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client, submission, and proposal identifiers are required.',
    });
  }
  if (!reason.trim()) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A rejection reason is required.',
    });
  }
  const path = `/clients/${encodeURIComponent(cId)}/submissions/${encodeURIComponent(subId)}/interviews/${encodeURIComponent(propId)}/reject`;
  return apiClient.post(path, { reason: reason.trim() });
}
