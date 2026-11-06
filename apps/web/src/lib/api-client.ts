export const API_BASE_PATH = '/api/v1' as const;
export const CSRF_HEADER_NAME = 'x-csrf-token' as const;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';

export type UserRole = 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | 'DELIVERY_HEAD';

export interface AuthenticatedUserDto {
  userId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: UserRole;
}

export interface LoginRequestDto {
  organization: string;
  email: string;
  password: string;
}

export interface AuthenticatedUserResponseDto {
  user: AuthenticatedUserDto;
}

export interface CsrfTokenResponseDto {
  csrfToken: string;
}

export interface ApiErrorPayload {
  error: string;
  message?: string | undefined;
  details?: unknown;
}

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface ApiRequestOptions {
  method?: HttpMethod | undefined;
  body?: unknown;
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | undefined;
}

export type UnauthorizedHandler = () => void;

const STATE_CHANGING_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const DEFAULT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: 'Invalid organization, email, or password.',
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden: 'You do not have permission to perform this action.',
  request_not_allowed: 'This security-sensitive request could not be verified.',
  invalid_request: 'The request could not be processed. Please check your input.',
  not_found: 'The requested resource could not be found.',
  too_many_requests: 'Too many requests. Please wait a moment and try again.',
  authentication_unavailable:
    'Authentication is temporarily unavailable. Please try again shortly.',
  service_unavailable: 'The service is temporarily unavailable. Please try again shortly.',
  csrf_token_missing:
    'A security token is required to complete this action. Please refresh and try again.',
  network_error: 'Unable to reach the server. Please check your connection and try again.',
  invalid_response_format: 'Received an unexpected response from the server.',
};

let csrfTokenInMemory: string | null = null;
let csrfInFlightPromise: Promise<string> | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Stores a validated CSRF token in module memory only.
 * Never persists tokens in localStorage, sessionStorage, or cookies.
 */
export function setCsrfToken(token: string): void {
  const normalized = token.trim();
  if (!normalized) {
    throw new ApiError({
      status: 0,
      code: 'invalid_csrf_token',
      message: 'CSRF token must be a non-empty string.',
    });
  }
  csrfTokenInMemory = normalized;
}

/** Returns the current in-memory CSRF token, or null if none is stored. */
export function getCsrfToken(): string | null {
  return csrfTokenInMemory;
}

/** Clears the in-memory CSRF token and any in-flight retrieval state. */
export function clearCsrfToken(): void {
  csrfTokenInMemory = null;
  csrfInFlightPromise = null;
}

/**
 * Registers a callback invoked when a protected endpoint returns HTTP 401.
 * Returns an unsubscribe function that clears the handler if still registered.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

/** Alias for registering an unauthorized callback with an unsubscribe disposer. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  return setUnauthorizedHandler(handler);
}

/** Clears any registered unauthorized callback. */
export function clearUnauthorizedHandler(): void {
  unauthorizedHandler = null;
}

function extractPathWithoutQuery(path: string): string {
  const queryIndex = path.indexOf('?');
  const hashIndex = path.indexOf('#');
  let endIndex = path.length;
  if (queryIndex !== -1 && queryIndex < endIndex) {
    endIndex = queryIndex;
  }
  if (hashIndex !== -1 && hashIndex < endIndex) {
    endIndex = hashIndex;
  }
  return path.slice(0, endIndex);
}

/**
 * Validates a caller-supplied relative API path and prefixes `/api/v1`.
 * Rejects absolute URLs, protocol-relative URLs, path traversal, and duplicate `/api` prefixes.
 */
export function resolveApiUrl(path: string): string {
  const trimmed = path.trim();

  if (
    !trimmed ||
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
  ) {
    throw new ApiError({
      status: 0,
      code: 'invalid_api_path',
      message: 'API requests must use a relative path starting with "/".',
    });
  }

  const pathname = extractPathWithoutQuery(trimmed);
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new ApiError({
      status: 0,
      code: 'invalid_api_path',
      message: 'API path traversal segments are not allowed.',
    });
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    throw new ApiError({
      status: 0,
      code: 'invalid_api_path',
      message: 'Pass paths relative to /api/v1 (for example, "/auth/me").',
    });
  }

  return `${API_BASE_PATH}${trimmed}`;
}

const PUBLIC_UNAUTHENTICATED_POST_ROUTES: ReadonlySet<string> = new Set([
  '/auth/login',
  '/consent/inspect',
  '/consent/accept',
  '/consent/decline',
  '/consent/withdraw/request',
  '/consent/withdraw/confirm',
]);

function isCsrfExemptRequest(method: HttpMethod, path: string): boolean {
  if (method !== 'POST') {
    return false;
  }
  const pathname = extractPathWithoutQuery(path.trim());
  return PUBLIC_UNAUTHENTICATED_POST_ROUTES.has(pathname);
}

function isPublicUnauthenticatedEndpoint(method: HttpMethod, path: string): boolean {
  if (method !== 'POST') {
    return false;
  }
  const pathname = extractPathWithoutQuery(path.trim());
  return PUBLIC_UNAUTHENTICATED_POST_ROUTES.has(pathname);
}

function isSafeClientMessage(message: unknown): message is string {
  if (typeof message !== 'string') {
    return false;
  }
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 300) {
    return false;
  }
  // Reject multi-line stack traces or internal SQL/Prisma diagnostics
  if (trimmed.includes('\n') || /\bat\s+\S+\s*\(/.test(trimmed) || /prisma/i.test(trimmed)) {
    return false;
  }
  return true;
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 415:
      return 'invalid_request';
    case 429:
      return 'too_many_requests';
    default:
      return status >= 500 ? 'service_unavailable' : `http_${status}`;
  }
}

function resolveSafeErrorMessage(status: number, code: string, candidateMessage?: unknown): string {
  if (status < 500 && isSafeClientMessage(candidateMessage)) {
    return candidateMessage.trim();
  }

  const mapped = DEFAULT_ERROR_MESSAGES[code];
  if (mapped) {
    return mapped;
  }

  if (status === 401) {
    return DEFAULT_ERROR_MESSAGES['unauthenticated']!;
  }
  if (status === 403) {
    return DEFAULT_ERROR_MESSAGES['forbidden']!;
  }
  if (status === 404) {
    return DEFAULT_ERROR_MESSAGES['not_found']!;
  }
  if (status === 429) {
    return DEFAULT_ERROR_MESSAGES['too_many_requests']!;
  }
  if (status >= 500) {
    return DEFAULT_ERROR_MESSAGES['service_unavailable']!;
  }

  return 'The request could not be completed.';
}

async function parseErrorResponse(response: Response): Promise<ApiError> {
  const status = response.status;
  let rawText = '';

  try {
    rawText = await response.text();
  } catch {
    rawText = '';
  }

  if (rawText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const code =
          typeof record['error'] === 'string' && record['error'].trim().length > 0
            ? record['error'].trim()
            : defaultCodeForStatus(status);
        const message = resolveSafeErrorMessage(status, code, record['message']);
        const details = record['details'];

        return new ApiError({
          status,
          code,
          message,
          ...(details !== undefined ? { details } : {}),
        });
      }
    } catch {
      // Fall through to status-based safe error when response body is not valid JSON
    }
  }

  const fallbackCode = defaultCodeForStatus(status);
  return new ApiError({
    status,
    code: fallbackCode,
    message: resolveSafeErrorMessage(status, fallbackCode),
  });
}

/**
 * Executes a typed HTTP request against `/api/v1<path>` with same-origin cookie credentials,
 * automatic CSRF header injection for protected mutations, and safe error normalization.
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method: HttpMethod = options.method ?? 'GET';
  const url = resolveApiUrl(path);

  const headers = new Headers(options.headers);
  // Never allow manual Origin header overrides from client code
  headers.delete('origin');

  if (!headers.has('accept')) {
    headers.set('accept', 'application/json');
  }

  if (STATE_CHANGING_METHODS.has(method) && !isCsrfExemptRequest(method, path)) {
    const token = csrfTokenInMemory ?? (await fetchCsrfToken());
    headers.set(CSRF_HEADER_NAME, token);
  }

  let requestBody: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      requestBody = options.body;
      // Let the browser generate the multipart/form-data boundary header automatically
      headers.delete('content-type');
    } else {
      requestBody = JSON.stringify(options.body);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }
  }

  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers,
    ...(requestBody !== undefined ? { body: requestBody } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: DEFAULT_ERROR_MESSAGES['network_error']!,
    });
  }

  if (!response.ok) {
    if (response.status === 401 && !isPublicUnauthenticatedEndpoint(method, path)) {
      clearCsrfToken();
      unauthorizedHandler?.();
    }
    throw await parseErrorResponse(response);
  }

  if (response.status === 204 || method === 'HEAD') {
    return undefined as T;
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'invalid_response_format',
      message: DEFAULT_ERROR_MESSAGES['invalid_response_format']!,
    });
  }

  if (responseText.trim().length === 0) {
    return undefined as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'invalid_response_format',
      message: DEFAULT_ERROR_MESSAGES['invalid_response_format']!,
    });
  }
}

/**
 * Fetches a session-bound CSRF token from `GET /api/v1/auth/csrf`,
 * validates the response payload, stores it in module memory, and returns it.
 * Uses single-flight deduplication so concurrent callers share one request.
 */
export async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  if (csrfInFlightPromise) {
    return csrfInFlightPromise;
  }

  const requestPromise = (async (): Promise<string> => {
    const payload = await apiRequest<CsrfTokenResponseDto>('/auth/csrf', {
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
    });

    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof payload.csrfToken !== 'string' ||
      payload.csrfToken.trim().length === 0
    ) {
      throw new ApiError({
        status: 502,
        code: 'invalid_csrf_response',
        message: DEFAULT_ERROR_MESSAGES['invalid_response_format']!,
      });
    }

    const token = payload.csrfToken.trim();
    setCsrfToken(token);
    return token;
  })();

  csrfInFlightPromise = requestPromise;

  try {
    return await requestPromise;
  } finally {
    if (csrfInFlightPromise === requestPromise) {
      csrfInFlightPromise = null;
    }
  }
}

export type MethodRequestOptions = Omit<ApiRequestOptions, 'method' | 'body'>;

export const apiClient = {
  request: apiRequest,

  get<T = unknown>(path: string, options: MethodRequestOptions = {}): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'GET' });
  },

  head(path: string, options: MethodRequestOptions = {}): Promise<void> {
    return apiRequest<void>(path, { ...options, method: 'HEAD' });
  },

  post<T = unknown>(path: string, body?: unknown, options: MethodRequestOptions = {}): Promise<T> {
    return apiRequest<T>(path, {
      ...options,
      method: 'POST',
      ...(body !== undefined ? { body } : {}),
    });
  },

  patch<T = unknown>(path: string, body?: unknown, options: MethodRequestOptions = {}): Promise<T> {
    return apiRequest<T>(path, {
      ...options,
      method: 'PATCH',
      ...(body !== undefined ? { body } : {}),
    });
  },

  put<T = unknown>(path: string, body?: unknown, options: MethodRequestOptions = {}): Promise<T> {
    return apiRequest<T>(path, {
      ...options,
      method: 'PUT',
      ...(body !== undefined ? { body } : {}),
    });
  },

  delete<T = unknown>(
    path: string,
    options: MethodRequestOptions & { body?: unknown } = {},
  ): Promise<T> {
    return apiRequest<T>(path, { ...options, method: 'DELETE' });
  },
} as const;
