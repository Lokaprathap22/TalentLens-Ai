/**
 * API client for the Client Portal workspace.
 *
 * Implements client-facing endpoints defined in:
 *   apps/api/src/modules/workflow/workflow.routes.ts
 *
 * Security & Privacy invariants:
 *  - Client role authentication (CLIENT_HIRING_MANAGER) and client membership required.
 *  - Protected with CSRF tokens on state-changing endpoints (recordClientFeedback).
 *  - Strict tenant boundary: Client hiring managers can only access submissions scoped to their authorized client.
 *  - Candidate contact details and recruiter internal notes are never sent to the client portal.
 */

import { ApiError, apiClient, isApiError } from '../../lib/api-client.js';
import type {
  AuthorizedClient,
  ClientFeedbackInput,
  ClientFeedbackResponse,
  ClientSubmissionDetail,
  ClientSubmissionSummary,
} from './types.js';

export function resolveClientPortalErrorMessage(error: unknown, fallbackMessage: string): string {
  if (isApiError(error)) {
    if (error.status === 400) {
      if (error.message.includes('prohibited') || error.message.includes('discriminatory')) {
        return `Feedback rejected by compliance filter: ${error.message}`;
      }
      return error.message || 'Invalid request. Please check your submission.';
    }
    if (error.status === 401) {
      return 'Your session has expired. Please sign in again.';
    }
    if (error.status === 403) {
      return 'You do not have permission to view or manage submissions for this client.';
    }
    if (error.status === 404) {
      return 'The requested candidate submission could not be found.';
    }
    if (error.status === 409) {
      return 'A conflicting decision has already been recorded.';
    }
    return error.message || fallbackMessage;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallbackMessage;
}

/**
 * Lists all clients the authenticated principal is authorized to access.
 *
 * Route: GET /api/v1/clients
 * Auth: CLIENT_HIRING_MANAGER or RECRUITER session.
 */
export async function listAuthorizedClients(): Promise<AuthorizedClient[]> {
  const result = await apiClient.get<{ clients: AuthorizedClient[] }>('/clients');
  return result.clients;
}

/**
 * Lists all submissions for a client organization.
 *
 * Route: GET /api/v1/clients/:clientId/submissions
 * Auth: CLIENT_HIRING_MANAGER session + client membership.
 */
export async function listClientSubmissions(clientId: string): Promise<ClientSubmissionSummary[]> {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client identifier is required.',
    });
  }

  const result = await apiClient.get<{ submissions: ClientSubmissionSummary[] }>(
    `/clients/${encodeURIComponent(trimmedId)}/submissions`,
  );
  return result.submissions;
}

/**
 * Retrieves the masked submission detail for client review.
 *
 * Route: GET /api/v1/clients/:clientId/submissions/:submissionId
 * Auth: CLIENT_HIRING_MANAGER session + client membership.
 */
export async function getClientSubmission(
  clientId: string,
  submissionId: string,
): Promise<ClientSubmissionDetail> {
  const trimmedClientId = clientId.trim();
  const trimmedSubId = submissionId.trim();
  if (!trimmedClientId || !trimmedSubId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client and submission identifiers are required.',
    });
  }

  return apiClient.get<ClientSubmissionDetail>(
    `/clients/${encodeURIComponent(trimmedClientId)}/submissions/${encodeURIComponent(trimmedSubId)}`,
  );
}

/**
 * Records client feedback (shortlist or decline) on a candidate submission.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/feedback
 * Auth: CLIENT_HIRING_MANAGER session + CSRF token + same-origin + client membership.
 *
 * Note: If decision is 'REJECT', backend requires reason of >= 3 characters.
 * Enforces feedback fairness and bias prevention checks on reason text.
 */
export async function recordClientFeedback(
  clientId: string,
  submissionId: string,
  input: ClientFeedbackInput,
): Promise<ClientFeedbackResponse> {
  const trimmedClientId = clientId.trim();
  const trimmedSubId = submissionId.trim();
  if (!trimmedClientId || !trimmedSubId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client and submission identifiers are required.',
    });
  }

  if (input.decision === 'REJECT' && (!input.reason || input.reason.trim().length < 3)) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A rejection reason of at least 3 characters is required.',
    });
  }

  const payload: { decision: string; reason?: string } = {
    decision: input.decision,
  };
  if (input.reason && input.reason.trim()) {
    payload.reason = input.reason.trim();
  }

  return apiClient.post<ClientFeedbackResponse>(
    `/clients/${encodeURIComponent(trimmedClientId)}/submissions/${encodeURIComponent(trimmedSubId)}/feedback`,
    payload,
  );
}

/**
 * Proposes an interview time window for a candidate submission from the client portal.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/interviews
 * Auth: CLIENT_HIRING_MANAGER session + CSRF token + client membership.
 */
export async function clientProposeInterview(
  clientId: string,
  submissionId: string,
  input: {
    startAt: string;
    endAt?: string | undefined;
    timezone: string;
    format?: 'VIDEO' | 'PHONE' | 'IN_PERSON' | undefined;
    reason?: string | undefined;
  },
): Promise<{ id: string; status: string; proposedAt: string }> {
  const trimmedClientId = clientId.trim();
  const trimmedSubId = submissionId.trim();
  if (!trimmedClientId || !trimmedSubId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client and submission identifiers are required.',
    });
  }

  return apiClient.post(
    `/clients/${encodeURIComponent(trimmedClientId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews`,
    input,
  );
}

/**
 * Accepts an interview proposed by the recruiter.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/interviews/:proposalId/accept
 * Auth: CLIENT_HIRING_MANAGER session + CSRF token + client membership.
 */
export async function clientAcceptInterviewProposal(
  clientId: string,
  submissionId: string,
  proposalId: string,
): Promise<{ success: boolean; action: string; proposalId: string; status: string }> {
  const trimmedClientId = clientId.trim();
  const trimmedSubId = submissionId.trim();
  const trimmedPropId = proposalId.trim();
  if (!trimmedClientId || !trimmedSubId || !trimmedPropId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client, submission, and proposal identifiers are required.',
    });
  }

  return apiClient.post(
    `/clients/${encodeURIComponent(trimmedClientId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/${encodeURIComponent(trimmedPropId)}/accept`,
    {},
  );
}

/**
 * Rejects an interview proposed by the recruiter with mandatory reason.
 *
 * Route: POST /api/v1/clients/:clientId/submissions/:submissionId/interviews/:proposalId/reject
 * Auth: CLIENT_HIRING_MANAGER session + CSRF token + client membership.
 */
export async function clientRejectInterviewProposal(
  clientId: string,
  submissionId: string,
  proposalId: string,
  reason: string,
): Promise<{ success: boolean; action: string; proposalId: string; status: string }> {
  const trimmedClientId = clientId.trim();
  const trimmedSubId = submissionId.trim();
  const trimmedPropId = proposalId.trim();
  if (!trimmedClientId || !trimmedSubId || !trimmedPropId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Valid client, submission, and proposal identifiers are required.',
    });
  }

  return apiClient.post(
    `/clients/${encodeURIComponent(trimmedClientId)}/submissions/${encodeURIComponent(trimmedSubId)}/interviews/${encodeURIComponent(trimmedPropId)}/reject`,
    { reason: reason.trim() },
  );
}
