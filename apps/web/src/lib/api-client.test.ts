import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_BASE_PATH,
  ApiError,
  CSRF_HEADER_NAME,
  apiClient,
  clearCsrfToken,
  clearUnauthorizedHandler,
  fetchCsrfToken,
  getCsrfToken,
  isApiError,
  onUnauthorized,
  resolveApiUrl,
  setCsrfToken,
  setUnauthorizedHandler,
} from './api-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers,
  });
}

describe('api-client foundation (M9.2A Step 2)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearCsrfToken();
    clearUnauthorizedHandler();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearCsrfToken();
    clearUnauthorizedHandler();
    vi.unstubAllGlobals();
  });

  it('1. prefixes valid relative paths with the /api/v1 base path', async () => {
    expect(API_BASE_PATH).toBe('/api/v1');
    expect(resolveApiUrl('/auth/me')).toBe('/api/v1/auth/me');
    expect(resolveApiUrl('/requisitions?status=OPEN')).toBe('/api/v1/requisitions?status=OPEN');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        user: {
          userId: 'user-1',
          organizationId: 'org-1',
          organizationName: 'Northwind Talent',
          email: 'recruiter@northwind.example',
          role: 'RECRUITER',
        },
      }),
    );

    await apiClient.get('/auth/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
  });

  it('2. enforces relative URLs and rejects external, protocol-relative, traversal, or duplicate /api paths', async () => {
    const invalidPaths = [
      '',
      '   ',
      'auth/login',
      'http://localhost:4000/api/v1/auth/me',
      'https://evil.example/api/v1/auth/login',
      '//evil.example/auth/login',
      'javascript:alert(1)',
      '/auth/../admin',
      '/..',
      '/auth\\login',
      '/api/v1/auth/me',
      '/api/auth/me',
    ];

    for (const badPath of invalidPaths) {
      expect(() => resolveApiUrl(badPath)).toThrow(ApiError);
      await expect(apiClient.get(badPath)).rejects.toMatchObject({
        name: 'ApiError',
        status: 0,
        code: 'invalid_api_path',
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3. always sends credentials: "same-origin" and strips any caller-supplied Origin header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiClient.get('/auth/me', {
      headers: {
        Origin: 'https://spoofed.example',
        'X-Custom-Trace': 'trace-123',
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');

    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBeNull();
    expect(headers.get('x-custom-trace')).toBe('trace-123');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('4. serializes plain JavaScript object bodies as JSON with Content-Type: application/json', async () => {
    setCsrfToken('csrf-token-123');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'req-1' }, { status: 201 }));

    const payload = {
      clientId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Principal Distributed Systems Engineer',
      jdText: 'Design high-availability services.',
    };

    const result = await apiClient.post<{ id: string }>('/requisitions', payload);

    expect(result).toEqual({ id: 'req-1' });
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify(payload));
  });

  it('5. passes FormData bodies unchanged and omits Content-Type so the browser sets the multipart boundary', async () => {
    setCsrfToken('csrf-token-multipart');
    fetchMock.mockResolvedValueOnce(jsonResponse({ batchId: 'batch-1' }, { status: 202 }));

    const formData = new FormData();
    formData.append('files', new Blob(['%PDF-1.7'], { type: 'application/pdf' }), 'resume.pdf');

    await apiClient.post('/requisitions/req-1/resumes', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.body).toBe(formData);
    expect(headers.get('content-type')).toBeNull();
    expect(headers.get(CSRF_HEADER_NAME)).toBe('csrf-token-multipart');
  });

  it('6. executes GET and HEAD requests without requiring or attaching a CSRF token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await apiClient.get<{ items: unknown[] }>('/requisitions');
    expect(result).toEqual({ items: [] });

    await apiClient.head('/requisitions');

    const getHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const headHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(getHeaders.get(CSRF_HEADER_NAME)).toBeNull();
    expect(headHeaders.get(CSRF_HEADER_NAME)).toBeNull();
  });

  it('7. attaches x-csrf-token to authenticated POST requests', async () => {
    setCsrfToken('csrf-post-token');
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

    await apiClient.post('/auth/logout');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/auth/logout');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get(CSRF_HEADER_NAME)).toBe('csrf-post-token');
  });

  it('8. attaches x-csrf-token to PATCH requests', async () => {
    setCsrfToken('csrf-patch-token');
    fetchMock.mockResolvedValueOnce(jsonResponse({ updated: true }));

    await apiClient.patch('/requisitions/req-1', { title: 'Staff Engineer' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/requisitions/req-1');
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get(CSRF_HEADER_NAME)).toBe('csrf-patch-token');
  });

  it('9. attaches x-csrf-token to DELETE and PUT requests', async () => {
    setCsrfToken('csrf-delete-put-token');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ deleted: true }))
      .mockResolvedValueOnce(jsonResponse({ replaced: true }));

    await apiClient.delete('/candidates/cand-1/consent');
    await apiClient.put('/requisitions/req-1/scorecards/sc-1', { weights: {} });

    const deleteInit = fetchMock.mock.calls[0]?.[1];
    const putInit = fetchMock.mock.calls[1]?.[1];

    expect(deleteInit?.method).toBe('DELETE');
    expect(new Headers(deleteInit?.headers).get(CSRF_HEADER_NAME)).toBe('csrf-delete-put-token');

    expect(putInit?.method).toBe('PUT');
    expect(new Headers(putInit?.headers).get(CSRF_HEADER_NAME)).toBe('csrf-delete-put-token');
  });

  it('10. exempts POST /auth/login from CSRF retrieval and header attachment', async () => {
    expect(getCsrfToken()).toBeNull();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        user: {
          userId: 'user-1',
          organizationId: 'org-1',
          organizationName: 'Northwind Talent',
          email: 'recruiter@northwind.example',
          role: 'RECRUITER',
        },
      }),
    );

    const response = await apiClient.post('/auth/login', {
      organization: 'Northwind Talent',
      email: 'recruiter@northwind.example',
      password: 'correct-horse-battery-staple',
    });

    expect(response).toMatchObject({
      user: {
        userId: 'user-1',
        organizationName: 'Northwind Talent',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBeNull();
    expect(getCsrfToken()).toBeNull();
  });

  it('11. lazily retrieves a missing CSRF token before a protected mutation, stores it in memory, and attaches it', async () => {
    expect(getCsrfToken()).toBeNull();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'lazy-csrf-token-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'req-created' }, { status: 201 }));

    const created = await apiClient.post<{ id: string }>('/requisitions', {
      title: 'Staff Security Engineer',
    });

    expect(created).toEqual({ id: 'req-created' });
    expect(getCsrfToken()).toBe('lazy-csrf-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [csrfUrl, csrfInit] = fetchMock.mock.calls[0]!;
    expect(csrfUrl).toBe('/api/v1/auth/csrf');
    expect(csrfInit?.method).toBe('GET');

    const [mutationUrl, mutationInit] = fetchMock.mock.calls[1]!;
    expect(mutationUrl).toBe('/api/v1/requisitions');
    expect(mutationInit?.method).toBe('POST');
    expect(new Headers(mutationInit?.headers).get(CSRF_HEADER_NAME)).toBe('lazy-csrf-token-1');
  });

  it('12. deduplicates concurrent mutations without a cached token into a single-flight CSRF retrieval request', async () => {
    expect(getCsrfToken()).toBeNull();

    let resolveCsrfResponse!: (value: Response) => void;
    const csrfResponsePromise = new Promise<Response>((resolve) => {
      resolveCsrfResponse = resolve;
    });

    fetchMock.mockImplementation((input, init) => {
      if (input === '/api/v1/auth/csrf') {
        return csrfResponsePromise;
      }
      return Promise.resolve(
        jsonResponse({
          url: input,
          method: init?.method,
          csrfHeader: new Headers(init?.headers).get(CSRF_HEADER_NAME),
        }),
      );
    });

    const firstMutation = apiClient.post<{ csrfHeader: string }>('/requisitions', {
      title: 'Role A',
    });
    const secondMutation = apiClient.patch<{ csrfHeader: string }>('/requisitions/req-1', {
      title: 'Role B',
    });
    const thirdMutation = apiClient.delete<{ csrfHeader: string }>('/candidates/cand-1/consent');

    // Only the single GET /api/v1/auth/csrf request should be in flight so far
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/csrf');

    resolveCsrfResponse(jsonResponse({ csrfToken: 'shared-single-flight-csrf' }));

    const [firstResult, secondResult, thirdResult] = await Promise.all([
      firstMutation,
      secondMutation,
      thirdMutation,
    ]);

    expect(getCsrfToken()).toBe('shared-single-flight-csrf');
    expect(firstResult.csrfHeader).toBe('shared-single-flight-csrf');
    expect(secondResult.csrfHeader).toBe('shared-single-flight-csrf');
    expect(thirdResult.csrfHeader).toBe('shared-single-flight-csrf');

    const csrfCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/csrf');
    expect(csrfCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('13. fails closed when lazy CSRF retrieval fails, notifies unauthorized on 401, and allows subsequent retries', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);

    // First attempt: CSRF retrieval fails with 401 unauthenticated
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthenticated' }, { status: 401 }));

    await expect(apiClient.post('/requisitions', { title: 'Blocked' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'unauthenticated',
    });

    // Original mutation was never sent, and 401 from /auth/csrf notified the unauthorized handler
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/csrf');
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBeNull();

    // Second attempt: CSRF retrieval fails with 503 service_unavailable
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'service_unavailable' }, { status: 503 }),
    );

    await expect(
      apiClient.patch('/requisitions/req-1', { title: 'Still blocked' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'service_unavailable',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCsrfToken()).toBeNull();

    // Third attempt: failed promise is not stuck in cache; retry succeeds and completes mutation
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'recovered-csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }));

    const result = await apiClient.patch<{ updated: boolean }>('/requisitions/req-1', {
      title: 'Recovered',
    });

    expect(result).toEqual({ updated: true });
    expect(getCsrfToken()).toBe('recovered-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/auth/csrf');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/requisitions/req-1');
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get(CSRF_HEADER_NAME)).toBe(
      'recovered-csrf-token',
    );
  });

  it('14. fetches, validates, and stores the CSRF token in module memory only', async () => {
    const localStorageSetItem = vi.spyOn(Storage.prototype, 'setItem');
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'derived-hmac-csrf-token' }));

    const token = await fetchCsrfToken();

    expect(token).toBe('derived-hmac-csrf-token');
    expect(getCsrfToken()).toBe('derived-hmac-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/csrf');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(localStorageSetItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('derived-hmac-csrf-token');

    // Rejects malformed / empty CSRF payloads
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: '   ' }));
    await expect(fetchCsrfToken()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'invalid_csrf_response',
    });

    expect(() => setCsrfToken('   ')).toThrow(ApiError);
    localStorageSetItem.mockRestore();
  });

  it('15. clears the in-memory CSRF token and re-fetches lazily on the next protected mutation', async () => {
    setCsrfToken('active-csrf-token');
    expect(getCsrfToken()).toBe('active-csrf-token');

    clearCsrfToken();
    expect(getCsrfToken()).toBeNull();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'refetched-csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

    await apiClient.post('/auth/logout');

    expect(getCsrfToken()).toBe('refetched-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/csrf');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(CSRF_HEADER_NAME)).toBe(
      'refetched-csrf-token',
    );
  });

  it('16. notifies the registered unauthorized callback and clears CSRF on HTTP 401 from protected endpoints without retrying mutations', async () => {
    const onExpired = vi.fn();
    const unsubscribe = onUnauthorized(onExpired);
    setCsrfToken('session-csrf-token');

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthenticated' }, { status: 401 }));

    await expect(
      apiClient.post('/requisitions', { title: 'Expired session' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'unauthenticated',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBeNull();

    // Unsubscribing prevents further notifications
    unsubscribe();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthenticated' }, { status: 401 }));
    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('17. does not trigger the session-expiry unauthorized callback on HTTP 401 from POST /auth/login', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_credentials' }, { status: 401 }),
    );

    await expect(
      apiClient.post('/auth/login', {
        organization: 'Northwind Talent',
        email: 'recruiter@northwind.example',
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'invalid_credentials',
      message: 'Invalid organization, email, or password.',
    });

    expect(onExpired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('18. preserves HTTP 403 as forbidden without triggering the HTTP 401 unauthorized callback or retrying', async () => {
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);
    setCsrfToken('valid-csrf');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'forbidden',
          message: 'You do not have access to this requisition.',
        },
        { status: 403 },
      ),
    );

    await expect(apiClient.post('/requisitions/req-1/scorecards/drafts', {})).rejects.toMatchObject(
      {
        name: 'ApiError',
        status: 403,
        code: 'forbidden',
        message: 'You do not have access to this requisition.',
      },
    );

    expect(onExpired).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBe('valid-csrf');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('19. parses typed backend errors with details and sanitizes stack traces or 5xx internal diagnostics', async () => {
    const validationIssues = [{ path: ['title'], message: 'String must contain at least 1 char' }];
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'invalid_request',
          message: 'Invalid requisition parameters.',
          details: validationIssues,
        },
        { status: 400 },
      ),
    );

    try {
      await apiClient.get('/requisitions/bad-id');
      expect.unreachable('Expected ApiError to be thrown');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      if (isApiError(error)) {
        expect(error.status).toBe(400);
        expect(error.code).toBe('invalid_request');
        expect(error.message).toBe('Invalid requisition parameters.');
        expect(error.details).toEqual(validationIssues);
      }
    }

    // 503 with internal database stack trace must never leak internal details to the UI message
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'service_unavailable',
          message:
            "PrismaClientKnownRequestError: Can't reach database server at localhost:5432\n    at Object.handleRequestError (/app/node_modules/@prisma/client/runtime/library.js:121:13)",
        },
        { status: 503 },
      ),
    );

    await expect(apiClient.get('/requisitions')).rejects.toSatisfy((error: unknown) => {
      expect(isApiError(error)).toBe(true);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(503);
      expect(apiErr.code).toBe('service_unavailable');
      expect(apiErr.message).toBe(
        'The service is temporarily unavailable. Please try again shortly.',
      );
      expect(apiErr.message).not.toContain('Prisma');
      expect(apiErr.message).not.toContain('5432');
      return true;
    });
  });

  it('20. handles malformed JSON, non-JSON HTML error pages, and malformed 200 JSON responses safely', async () => {
    // HTML 502 Bad Gateway from proxy
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'service_unavailable',
      message: 'The service is temporarily unavailable. Please try again shortly.',
    });

    // Truncated JSON on 400 error
    fetchMock.mockResolvedValueOnce(
      new Response('{"error": "invalid_request", "message": "unterminated', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(apiClient.get('/requisitions')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'invalid_request',
      message: 'The request could not be processed. Please check your input.',
    });

    // Malformed JSON on 200 OK response
    fetchMock.mockResolvedValueOnce(
      new Response('not-json-at-all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(apiClient.get('/requisitions')).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      code: 'invalid_response_format',
      message: 'Received an unexpected response from the server.',
    });
  });

  it('21. converts network failures into a safe ApiError with status 0 and code "network_error"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network_error',
      message: 'Unable to reach the server. Please check your connection and try again.',
    });
  });

  it('22. handles HTTP 204 No Content and empty 200 bodies cleanly', async () => {
    setCsrfToken('csrf-204');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const noContentResult = await apiClient.delete('/candidates/cand-1');
    expect(noContentResult).toBeUndefined();

    const emptyBodyResult = await apiClient.get('/requisitions');
    expect(emptyBodyResult).toBeUndefined();
  });
});
