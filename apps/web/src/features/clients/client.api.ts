import { ApiError, apiClient, isApiError } from '../../lib/api-client.js';
import type {
  ClientDetailResponseDto,
  ClientMemberRecord,
  ClientMutationResponseDto,
  ClientRecord,
  ClientStatus,
  CreateClientInput,
  InviteClientMemberInput,
  InviteClientMemberResponseDto,
  ListClientMembersResponseDto,
  ListClientsResponseDto,
  MembershipRole,
  MembershipStatus,
  UpdateClientInput,
  UserStatus,
} from './types.js';

export const CLIENT_NAME_MAX_LENGTH = 200;
export const MEMBER_NAME_MAX_LENGTH = 200;
export const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DUPLICATE_CLIENT_NAME_MESSAGE = 'The client name already exists in your organization.';

const VALID_CLIENT_STATUSES: ReadonlySet<ClientStatus> = new Set(['ACTIVE', 'INACTIVE']);
const VALID_MEMBERSHIP_ROLES: ReadonlySet<MembershipRole> = new Set(['CLIENT_HIRING_MANAGER']);
const VALID_MEMBERSHIP_STATUSES: ReadonlySet<MembershipStatus> = new Set([
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
]);
const VALID_USER_STATUSES: ReadonlySet<UserStatus> = new Set([
  'ACTIVE',
  'INVITED',
  'SUSPENDED',
  'DEACTIVATED',
]);

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

export function validateMemberEmail(
  rawEmail: string,
): { valid: true; email: string } | { valid: false; error: string } {
  const trimmed = rawEmail.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Enter a work email address.' };
  }
  if (trimmed.length > EMAIL_MAX_LENGTH) {
    return { valid: false, error: `Email must be ${EMAIL_MAX_LENGTH} characters or fewer.` };
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Enter a valid work email address.' };
  }
  return { valid: true, email: trimmed };
}

export function validateMemberName(
  rawName?: string,
): { valid: true; name?: string | undefined } | { valid: false; error: string } {
  if (rawName === undefined || rawName === null) {
    return { valid: true, name: undefined };
  }
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return { valid: true, name: undefined };
  }
  if (trimmed.length > MEMBER_NAME_MAX_LENGTH) {
    return { valid: false, error: `Name must be ${MEMBER_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { valid: true, name: trimmed };
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

export function isValidClientMemberRecord(value: unknown): value is ClientMemberRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['membershipId'] === 'string' &&
    typeof record['userId'] === 'string' &&
    typeof record['clientId'] === 'string' &&
    typeof record['organizationId'] === 'string' &&
    (record['name'] === null || typeof record['name'] === 'string') &&
    typeof record['email'] === 'string' &&
    typeof record['role'] === 'string' &&
    VALID_MEMBERSHIP_ROLES.has(record['role'] as MembershipRole) &&
    typeof record['membershipStatus'] === 'string' &&
    VALID_MEMBERSHIP_STATUSES.has(record['membershipStatus'] as MembershipStatus) &&
    typeof record['userStatus'] === 'string' &&
    VALID_USER_STATUSES.has(record['userStatus'] as UserStatus) &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}

export function resolveMemberErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!isApiError(error)) {
    return fallbackMessage;
  }

  if (error.status === 409 || error.code === 'conflict') {
    if (error.code === 'role_conflict') {
      return 'A user with this email already exists as a recruiter or delivery head in your organization.';
    }
    if (error.code === 'duplicate_invitation') {
      return 'An invitation is already pending for this email address with this client.';
    }
    if (error.code === 'duplicate_membership') {
      return 'A member with this email address already exists for this client.';
    }
    if (error.code === 'existing_user_conflict') {
      return 'A user with this email address already exists in your organization.';
    }
    return 'A member or invitation with this email address already exists.';
  }

  if (error.status === 404 || error.code === 'not_found') {
    return 'This client could not be found in your organization.';
  }

  if (error.status === 403 || error.code === 'forbidden' || error.code === 'request_not_allowed') {
    return 'You do not have permission to invite members to this client.';
  }

  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to reach TalentLens AI. Check your connection and try again.';
  }

  if (error.status >= 500) {
    return 'The member invitation service is temporarily unavailable. Please try again shortly.';
  }

  if (error.status === 400 && error.message.trim().length > 0) {
    return error.message;
  }

  return fallbackMessage;
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

export async function getClient(clientId: string, signal?: AbortSignal): Promise<ClientRecord> {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid client identifier is required.',
    });
  }

  const response = await apiClient.get<ClientDetailResponseDto>(
    `/clients/${encodeURIComponent(trimmedId)}`,
    signal !== undefined ? { signal } : {},
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

export async function listClientMembers(
  clientId: string,
  signal?: AbortSignal,
): Promise<ClientMemberRecord[]> {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid client identifier is required.',
    });
  }

  const response = await apiClient.get<ListClientMembersResponseDto>(
    `/clients/${encodeURIComponent(trimmedId)}/members`,
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray(response.members) ||
    !response.members.every(isValidClientMemberRecord)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected client members response from the server.',
    });
  }

  return response.members;
}

export async function inviteClientMember(
  clientId: string,
  input: InviteClientMemberInput,
): Promise<ClientMemberRecord> {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid client identifier is required.',
    });
  }

  const emailVal = validateMemberEmail(input.email);
  if (!emailVal.valid) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: emailVal.error,
    });
  }

  const nameVal = validateMemberName(input.name);
  if (!nameVal.valid) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: nameVal.error,
    });
  }

  const payload: { email: string; name?: string } = {
    email: emailVal.email,
  };
  if (nameVal.name) {
    payload.name = nameVal.name;
  }

  const response = await apiClient.post<InviteClientMemberResponseDto>(
    `/clients/${encodeURIComponent(trimmedId)}/members`,
    payload,
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidClientMemberRecord(response.member)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected member invitation response from the server.',
    });
  }

  return response.member;
}
