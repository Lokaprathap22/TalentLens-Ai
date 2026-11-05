import { ApiError, apiClient, isApiError } from '../../lib/api-client.js';
import type {
  ClientMutationResponseDto,
  ClientRecord,
  ClientStatus,
  CreateClientInput,
  ListClientsResponseDto,
  UpdateClientInput,
} from './types.js';

export const CLIENT_NAME_MAX_LENGTH = 200;

export const DUPLICATE_CLIENT_NAME_MESSAGE = 'The client name already exists in your organization.';

const VALID_CLIENT_STATUSES: ReadonlySet<ClientStatus> = new Set(['ACTIVE', 'INACTIVE']);

export type ClientNameValidationResult =
  { valid: true; name: string } | { valid: false; error: string };

export function validateClientName(rawName: string): ClientNameValidationResult {
  const trimmed = rawName.trim();

  if (trimmed.length === 0) {
    return {
      valid: false,
      error: 'Enter a client name.',
    };
  }

  if (trimmed.length > CLIENT_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Client name must be ${CLIENT_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }

  return {
    valid: true,
    name: trimmed,
  };
}

export function isValidClientRecord(value: unknown): value is ClientRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['name'] === 'string' &&
    record['name'].trim().length > 0 &&
    typeof record['status'] === 'string' &&
    VALID_CLIENT_STATUSES.has(record['status'] as ClientStatus) &&
    typeof record['createdAt'] === 'string' &&
    record['createdAt'].trim().length > 0 &&
    typeof record['updatedAt'] === 'string' &&
    record['updatedAt'].trim().length > 0
  );
}

export function resolveClientErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!isApiError(error)) {
    return fallbackMessage;
  }

  if (error.status === 409 || error.code === 'conflict') {
    return DUPLICATE_CLIENT_NAME_MESSAGE;
  }

  if (error.status === 404 || error.code === 'not_found') {
    return 'This client could not be found in your organization. Refresh the directory and try again.';
  }

  if (error.status === 403 || error.code === 'forbidden' || error.code === 'request_not_allowed') {
    return 'You do not have permission to perform this action, or your security token could not be verified.';
  }

  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to reach TalentLens AI. Check your connection and try again.';
  }

  if (error.status >= 500) {
    return 'The client service is temporarily unavailable. Please try again shortly.';
  }

  if (error.status === 400 && error.message.trim().length > 0) {
    return error.message;
  }

  return fallbackMessage;
}

export async function listClients(signal?: AbortSignal): Promise<ClientRecord[]> {
  const response = await apiClient.get<ListClientsResponseDto>(
    '/clients?includeInactive=true',
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray(response.clients) ||
    !response.clients.every(isValidClientRecord)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected client directory response from the server.',
    });
  }

  return response.clients;
}

export async function createClient(input: CreateClientInput): Promise<ClientRecord> {
  const validation = validateClientName(input.name);
  if (!validation.valid) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: validation.error,
    });
  }

  const response = await apiClient.post<ClientMutationResponseDto>('/clients', {
    name: validation.name,
  });

  if (typeof response !== 'object' || response === null || !isValidClientRecord(response.client)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected client response from the server.',
    });
  }

  return response.client;
}

export async function updateClient(
  clientId: string,
  input: UpdateClientInput,
): Promise<ClientRecord> {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid client identifier is required.',
    });
  }

  const payload: { name?: string; status?: ClientStatus } = {};

  if (input.name !== undefined) {
    const validation = validateClientName(input.name);
    if (!validation.valid) {
      throw new ApiError({
        status: 400,
        code: 'invalid_request',
        message: validation.error,
      });
    }
    payload.name = validation.name;
  }

  if (input.status !== undefined) {
    if (!VALID_CLIENT_STATUSES.has(input.status)) {
      throw new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'Invalid client status.',
      });
    }
    payload.status = input.status;
  }

  if (payload.name === undefined && payload.status === undefined) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'At least one client field must be updated.',
    });
  }

  const response = await apiClient.patch<ClientMutationResponseDto>(
    `/clients/${encodeURIComponent(trimmedId)}`,
    payload,
  );

  if (typeof response !== 'object' || response === null || !isValidClientRecord(response.client)) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected client response from the server.',
    });
  }

  return response.client;
}
