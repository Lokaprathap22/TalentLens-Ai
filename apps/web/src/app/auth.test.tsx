import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser } from '../features/auth/auth.types.js';
import {
  apiClient,
  clearCsrfToken,
  clearUnauthorizedHandler,
  getCsrfToken,
  isApiError,
} from '../lib/api-client.js';
import { AuthProvider, useAuth } from './auth.js';

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

const SAMPLE_RECRUITER: AuthenticatedUser = {
  userId: 'user-recruiter-1',
  organizationId: 'org-northwind-1',
  organizationName: 'Northwind Talent',
  email: 'priya.raman@northwind.example',
  role: 'RECRUITER',
};

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('AuthProvider & useAuth (M9.2A Step 3)', () => {
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

  it('1. starts in loading state while GET /auth/me is in flight', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.state).toEqual({ status: 'loading' });
  });

  it('2. restores an existing session via GET /auth/me followed by GET /auth/csrf', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-restored-123' }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('authenticated');
    });

    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-restored-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('3. transitions to unauthenticated when GET /auth/me returns 401 without calling /auth/csrf', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('unauthenticated');
    });

    expect(getCsrfToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
  });

  it('4. transitions to recoverable initialization-error (stage: session) when GET /auth/me returns 503', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'service_unavailable', message: 'Database unavailable' },
        { status: 503 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    expect(result.current.state).toEqual({
      status: 'initialization-error',
      stage: 'session',
      message: 'Workspace session verification is temporarily unavailable. Please retry shortly.',
    });
    expect(getCsrfToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5. transitions to recoverable initialization-error (stage: session) when GET /auth/me fails with a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    expect(result.current.state).toEqual({
      status: 'initialization-error',
      stage: 'session',
      message:
        'Unable to reach TalentLens AI to verify your workspace session. Check your connection and retry.',
    });
    expect(getCsrfToken()).toBeNull();
  });

  it('6. retryInitialization() after GET /auth/me failure restores the session via GET /auth/me + GET /auth/csrf', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'service_unavailable', message: 'Temporary outage' }, { status: 503 }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-after-me-retry' }));

    await act(async () => {
      await result.current.retryInitialization();
    });

    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-after-me-retry');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('7. retains verified principal in initialization-error (stage: csrf) when GET /auth/me succeeds and GET /auth/csrf returns 503, then retries CSRF only', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    expect(result.current.state).toEqual({
      status: 'initialization-error',
      stage: 'csrf',
      message:
        'Your account is verified, but workspace security initialization is temporarily unavailable. Please retry shortly.',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Retry must fetch /auth/csrf ONLY without repeating /auth/me
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-only-retry-ok' }));

    await act(async () => {
      await result.current.retryInitialization();
    });

    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-only-retry-ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('8. login() authenticates via POST /auth/login, fetches CSRF token, and updates auth state', async () => {
    // Initial boot: unauthenticated
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('unauthenticated');
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-login-456' }));

    let loggedInUser: AuthenticatedUser | undefined;
    await act(async () => {
      loggedInUser = await result.current.login({
        organization: '  Northwind Talent  ',
        email: '  priya.raman@northwind.example  ',
        password: 'CorrectHorseBatteryStaple!',
      });
    });

    expect(loggedInUser).toEqual(SAMPLE_RECRUITER);
    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-login-456');

    const loginCall = fetchMock.mock.calls[1];
    expect(loginCall?.[0]).toBe('/api/v1/auth/login');
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      organization: 'Northwind Talent',
      email: 'priya.raman@northwind.example',
      password: 'CorrectHorseBatteryStaple!',
    });
  });

  it('9. login() success followed by CSRF 503 retains verified principal in initialization-error and retryInitialization() fetches CSRF without another login request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('unauthenticated');
    });

    // POST /auth/login succeeds, GET /auth/csrf returns 503
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.login({
          organization: 'Northwind Talent',
          email: 'priya.raman@northwind.example',
          password: 'CorrectHorseBatteryStaple!',
        });
      } catch (error) {
        caughtError = error;
      }
    });

    expect(isApiError(caughtError)).toBe(true);
    if (isApiError(caughtError)) {
      expect(caughtError.status).toBe(503);
      expect(caughtError.code).toBe('service_unavailable');
      expect(caughtError.code).not.toBe('invalid_credentials');
    }

    expect(result.current.state).toEqual({
      status: 'initialization-error',
      stage: 'csrf',
      message:
        'Your account is verified, but workspace security initialization is temporarily unavailable. Please retry shortly.',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Retry fetches /auth/csrf ONLY without repeating POST /auth/login
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-after-login-retry' }));

    await act(async () => {
      await result.current.retryInitialization();
    });

    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-after-login-retry');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('10. CSRF 401 during boot or retry clears pending identity and transitions to unauthenticated', async () => {
    // Boot: /auth/me 200, /auth/csrf 503 -> pending user retained
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    // Retry: /auth/csrf returns 401 -> clears pending identity and sets unauthenticated
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'unauthenticated', message: 'Session revoked' }, { status: 401 }),
    );

    await act(async () => {
      await result.current.retryInitialization();
    });

    expect(result.current.state).toEqual({ status: 'unauthenticated' });
    expect(getCsrfToken()).toBeNull();

    // A subsequent retry must start from /auth/me since pendingUser was cleared
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-fresh-session' }));

    await act(async () => {
      await result.current.retryInitialization();
    });

    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/v1/auth/csrf');
    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
  });

  it('11. stale retry responses cannot restore invalidated authentication', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('initialization-error');
    });

    let resolveRetryCsrf!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRetryCsrf = resolve;
        }),
    );

    let retryPromise!: Promise<void>;
    act(() => {
      retryPromise = result.current.retryInitialization();
    });

    // While retry is in flight, a 401 on a protected endpoint invalidates the session
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'unauthenticated', message: 'Session expired' }, { status: 401 }),
    );

    await act(async () => {
      await expect(apiClient.get('/requisitions')).rejects.toMatchObject({ status: 401 });
    });

    expect(result.current.state).toEqual({ status: 'unauthenticated' });

    // Now the stale CSRF retry resolves with 200 -> must NOT restore authenticated state or CSRF token
    await act(async () => {
      resolveRetryCsrf(jsonResponse({ csrfToken: 'stale-csrf-token' }));
      await retryPromise;
    });

    expect(result.current.state).toEqual({ status: 'unauthenticated' });
    expect(getCsrfToken()).toBeNull();
  });

  it('12. login() rejects with 401 on invalid credentials and stays unauthenticated', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('unauthenticated');
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'invalid_credentials', message: 'Invalid organization, email or password' },
        { status: 401 },
      ),
    );

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.login({
          organization: 'Northwind Talent',
          email: 'priya.raman@northwind.example',
          password: 'wrong-password',
        });
      } catch (error) {
        caughtError = error;
      }
    });

    expect(isApiError(caughtError)).toBe(true);
    if (isApiError(caughtError)) {
      expect(caughtError.status).toBe(401);
      expect(caughtError.code).toBe('invalid_credentials');
    }
    expect(result.current.state).toEqual({ status: 'unauthenticated' });
    expect(getCsrfToken()).toBeNull();
  });

  it('13. login() rejects with 429 on rate limiting and stays unauthenticated', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('unauthenticated');
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'too_many_requests', message: 'Too many authentication attempts' },
        { status: 429 },
      ),
    );

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.login({
          organization: 'Northwind Talent',
          email: 'priya.raman@northwind.example',
          password: 'any-password',
        });
      } catch (error) {
        caughtError = error;
      }
    });

    expect(isApiError(caughtError)).toBe(true);
    if (isApiError(caughtError)) {
      expect(caughtError.status).toBe(429);
      expect(caughtError.code).toBe('too_many_requests');
    }
    expect(result.current.state).toEqual({ status: 'unauthenticated' });
  });

  it('14. logout() calls POST /auth/logout with x-csrf-token, clears CSRF token, and sets unauthenticated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-active-789' }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('authenticated');
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.state).toEqual({ status: 'unauthenticated' });
    expect(getCsrfToken()).toBeNull();

    const logoutCall = fetchMock.mock.calls[2];
    expect(logoutCall?.[0]).toBe('/api/v1/auth/logout');
    const headers = new Headers(logoutCall?.[1]?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-active-789');
  });

  it('15. logout() preserves authenticated state and sets logoutError when network or 503 failure occurs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-active-789' }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('authenticated');
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'service_unavailable',
          message: 'Authentication service is temporarily unavailable.',
        },
        { status: 503 },
      ),
    );

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.logout();
      } catch (error) {
        caughtError = error;
      }
    });

    expect(isApiError(caughtError)).toBe(true);
    // Must NOT falsely claim logout succeeded
    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(result.current.logoutError).toBe(
      'The service is temporarily unavailable. Please try again shortly.',
    );
  });

  it('16. 401 response on a protected API request clears CSRF token and transitions to unauthenticated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-active-10' }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('authenticated');
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'unauthenticated', message: 'Session expired' }, { status: 401 }),
    );

    await act(async () => {
      await expect(apiClient.get('/requisitions')).rejects.toMatchObject({ status: 401 });
    });

    expect(result.current.state).toEqual({ status: 'unauthenticated' });
    expect(getCsrfToken()).toBeNull();
  });

  it('17. 403 forbidden response on a protected API request preserves authenticated state and CSRF token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-active-11' }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.status).toBe('authenticated');
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'forbidden', message: 'Insufficient role' }, { status: 403 }),
    );

    await act(async () => {
      await expect(apiClient.get('/requisitions')).rejects.toMatchObject({ status: 403 });
    });

    expect(result.current.state).toEqual({
      status: 'authenticated',
      user: SAMPLE_RECRUITER,
    });
    expect(getCsrfToken()).toBe('csrf-active-11');
  });

  it('18. unmount cleanup unregisters the unauthorized listener and ignores stale async responses', async () => {
    let resolveMe!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveMe = resolve;
        }),
    );

    const { unmount } = renderHook(() => useAuth(), { wrapper });

    unmount();

    // Resolving /auth/me after unmount must not trigger /auth/csrf or throw React state warnings
    await act(async () => {
      resolveMe(jsonResponse({ user: SAMPLE_RECRUITER }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBeNull();
  });
});
