import { ApiError, apiClient, isApiError } from '../../lib/api-client.js';
import type {
  CreateRequisitionInput,
  ListRequisitionsResponseDto,
  RequisitionRecord,
  RequisitionResponseDto,
  RequisitionStatus,
  TransitionStatusInput,
  TransitionTargetStatus,
  UpdateRequisitionInput,
} from './types.js';

export const REQUISITION_TITLE_MAX_LENGTH = 200;
export const REQUISITION_JD_MAX_LENGTH = 100_000;

const VALID_REQUISITION_STATUSES: ReadonlySet<RequisitionStatus> = new Set([
  'DRAFT',
  'OPEN',
  'PAUSED',
  'CLOSED',
  'FILLED',
]);

const VALID_TRANSITION_TARGETS: ReadonlySet<TransitionTargetStatus> = new Set([
  'OPEN',
  'PAUSED',
  'CLOSED',
  'FILLED',
]);

export function getAvailableStatusTransitions(
  currentStatus: RequisitionStatus,
): TransitionTargetStatus[] {
  switch (currentStatus) {
    case 'DRAFT':
      return ['OPEN'];
    case 'OPEN':
      return ['PAUSED', 'CLOSED', 'FILLED'];
    case 'PAUSED':
      return ['OPEN', 'CLOSED', 'FILLED'];
    case 'CLOSED':
    case 'FILLED':
      return [];
  }
}

export function isRequisitionEditable(status: RequisitionStatus): boolean {
  return status === 'DRAFT';
}

export interface RequisitionValidationResult {
  valid: boolean;
  errors: {
    clientId?: string | undefined;
    title?: string | undefined;
    jdText?: string | undefined;
  };
  sanitized: {
    clientId?: string | undefined;
    title?: string | undefined;
    jdText?: string | undefined;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRequisitionInput(
  input: { clientId?: string | undefined; title?: string | undefined; jdText?: string | undefined },
  mode: 'create' | 'edit',
): RequisitionValidationResult {
  const errors: {
    clientId?: string | undefined;
    title?: string | undefined;
    jdText?: string | undefined;
  } = {};
  const sanitized: {
    clientId?: string | undefined;
    title?: string | undefined;
    jdText?: string | undefined;
  } = {};

  if (mode === 'create' || input.clientId !== undefined) {
    const rawId = (input.clientId ?? '').trim();
    if (!rawId) {
      errors.clientId = 'Select a client organization.';
    } else if (!UUID_PATTERN.test(rawId)) {
      errors.clientId = 'A valid client selection is required.';
    } else {
      sanitized.clientId = rawId;
    }
  }

  if (mode === 'create' || input.title !== undefined) {
    const rawTitle = (input.title ?? '').trim();
    if (!rawTitle) {
      errors.title = 'Enter a requisition job title.';
    } else if (rawTitle.length > REQUISITION_TITLE_MAX_LENGTH) {
      errors.title = `Title must be ${REQUISITION_TITLE_MAX_LENGTH} characters or fewer.`;
    } else {
      sanitized.title = rawTitle;
    }
  }

  if (mode === 'create' || input.jdText !== undefined) {
    const rawJd = (input.jdText ?? '').trim();
    if (!rawJd) {
      errors.jdText = 'Enter the job description requirements.';
    } else if (rawJd.length > REQUISITION_JD_MAX_LENGTH) {
      errors.jdText = `Job description must be ${REQUISITION_JD_MAX_LENGTH.toLocaleString()} characters or fewer.`;
    } else {
      sanitized.jdText = rawJd;
    }
  }

  if (mode === 'edit' && Object.keys(sanitized).length === 0 && Object.keys(errors).length === 0) {
    errors.title = 'At least one field must be provided for update.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    sanitized,
  };
}

export function isValidRequisitionRecord(value: unknown): value is RequisitionRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['clientId'] === 'string' &&
    record['clientId'].trim().length > 0 &&
    typeof record['clientName'] === 'string' &&
    record['clientName'].trim().length > 0 &&
    typeof record['title'] === 'string' &&
    record['title'].trim().length > 0 &&
    typeof record['jdText'] === 'string' &&
    typeof record['status'] === 'string' &&
    VALID_REQUISITION_STATUSES.has(record['status'] as RequisitionStatus) &&
    typeof record['createdAt'] === 'string' &&
    record['createdAt'].trim().length > 0 &&
    typeof record['updatedAt'] === 'string' &&
    record['updatedAt'].trim().length > 0
  );
}

export function resolveRequisitionErrorMessage(
  error: unknown,
  fallbackMessage: string,
  context?: {
    action?: 'create' | 'update' | 'transition';
    currentStatus?: RequisitionStatus;
    targetStatus?: TransitionTargetStatus;
  },
): string {
  if (!isApiError(error)) {
    return fallbackMessage;
  }

  // Backend returns 400 for invalid state transition or missing approved scorecard on DRAFT -> OPEN
  if (error.status === 400) {
    if (context?.action === 'transition' && context.targetStatus === 'OPEN') {
      return 'This requisition cannot be opened yet because it requires an approved scorecard. Create and approve a scorecard before opening.';
    }
    if (context?.action === 'transition') {
      return `Unable to transition requisition from ${context.currentStatus ?? 'current state'} to ${context.targetStatus ?? 'target state'}.`;
    }
    if (error.message.trim().length > 0 && error.message !== 'invalid_request') {
      return error.message;
    }
    return 'Please check your requisition details and try again.';
  }

  if (error.status === 404 || error.code === 'not_found') {
    return 'The requested requisition or client could not be found in your organization.';
  }

  if (error.status === 403 || error.code === 'forbidden' || error.code === 'request_not_allowed') {
    return 'You do not have permission to perform this action, or your security token could not be verified.';
  }

  if (error.status === 0 || error.code === 'network_error') {
    return 'Unable to reach TalentLens AI. Check your connection and try again.';
  }

  if (error.status >= 500) {
    return 'The requisition service is temporarily unavailable. Please try again shortly.';
  }

  return fallbackMessage;
}

export async function listRequisitions(signal?: AbortSignal): Promise<RequisitionRecord[]> {
  const response = await apiClient.get<ListRequisitionsResponseDto>(
    '/requisitions',
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray(response.requisitions) ||
    !response.requisitions.every(isValidRequisitionRecord)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected requisition directory response from the server.',
    });
  }

  return response.requisitions;
}

export async function getRequisition(
  requisitionId: string,
  signal?: AbortSignal,
): Promise<RequisitionRecord> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  const response = await apiClient.get<RequisitionResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedId)}`,
    signal !== undefined ? { signal } : {},
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidRequisitionRecord(response.requisition)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected requisition response from the server.',
    });
  }

  return response.requisition;
}

export async function createRequisition(input: CreateRequisitionInput): Promise<RequisitionRecord> {
  const validation = validateRequisitionInput(input, 'create');
  if (!validation.valid) {
    const firstError = Object.values(validation.errors)[0] ?? 'Invalid requisition input.';
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: firstError,
    });
  }

  const payload = {
    clientId: validation.sanitized.clientId!,
    title: validation.sanitized.title!,
    jdText: validation.sanitized.jdText!,
  };

  const response = await apiClient.post<RequisitionResponseDto>('/requisitions', payload);

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidRequisitionRecord(response.requisition)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after creating the requisition.',
    });
  }

  return response.requisition;
}

export async function updateRequisition(
  requisitionId: string,
  input: UpdateRequisitionInput,
): Promise<RequisitionRecord> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  const validation = validateRequisitionInput(input, 'edit');
  if (!validation.valid) {
    const firstError = Object.values(validation.errors)[0] ?? 'Invalid requisition update.';
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: firstError,
    });
  }

  const payload: UpdateRequisitionInput = {};
  if (validation.sanitized.clientId !== undefined) {
    payload.clientId = validation.sanitized.clientId;
  }
  if (validation.sanitized.title !== undefined) {
    payload.title = validation.sanitized.title;
  }
  if (validation.sanitized.jdText !== undefined) {
    payload.jdText = validation.sanitized.jdText;
  }

  const response = await apiClient.patch<RequisitionResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedId)}`,
    payload,
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidRequisitionRecord(response.requisition)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after updating the requisition.',
    });
  }

  return response.requisition;
}

export async function transitionRequisitionStatus(
  requisitionId: string,
  status: TransitionTargetStatus,
): Promise<RequisitionRecord> {
  const trimmedId = requisitionId.trim();
  if (!trimmedId) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A valid requisition identifier is required.',
    });
  }

  if (!VALID_TRANSITION_TARGETS.has(status)) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Invalid target status transition.',
    });
  }

  const payload: TransitionStatusInput = { status };

  const response = await apiClient.post<RequisitionResponseDto>(
    `/requisitions/${encodeURIComponent(trimmedId)}/status`,
    payload,
  );

  if (
    typeof response !== 'object' ||
    response === null ||
    !isValidRequisitionRecord(response.requisition)
  ) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response_format',
      message: 'Received an unexpected response after updating requisition status.',
    });
  }

  return response.requisition;
}
