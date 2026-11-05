import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { InitialEntry } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../app/auth.js';
import { clearCsrfToken, clearUnauthorizedHandler } from '../../lib/api-client.js';
import { LoginPage } from './LoginPage.js';
import {
  isPathAllowedForRole,
  isSafeInternalPath,
  resolveSafePostLoginRedirect,
  type AuthenticatedUser,
} from './auth.types.js';

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

function DestinationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="landed-path">{`${location.pathname}${location.search}`}</div>;
}

function renderLoginPage(initialEntry: InitialEntry = '/login'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<DestinationProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage (M9.2A Step 3)', () => {
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

  it('1. validates required fields before calling the backend', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    const submitButton = await screen.findByRole('button', { name: 'Sign in' });
    await user.click(submitButton);

    expect(screen.getByText('Organization name is required.')).toBeInTheDocument();
    expect(screen.getByText('Work email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    // Only the initial /auth/me check was sent
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('2. validates work email format inline', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid work email address.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('3. toggles password visibility with accessible label and aria-pressed state', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    const passwordInput = await screen.findByLabelText(/^Password$/i);
    expect(passwordInput).toHaveAttribute('type', 'password');

    const toggleButton = screen.getByRole('button', { name: 'Show password' });
    expect(toggleButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggleButton);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('4. submits valid credentials, fetches CSRF token, and redirects RECRUITER to /dashboard', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-from-login' }));

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'SecretPass!99');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('landed-path')).toHaveTextContent('/dashboard');
  });

  it('5. displays generic 401 invalid credentials message without echoing password', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'invalid_credentials', message: 'Invalid organization, email or password' },
          { status: 401 },
        ),
      );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'MySuperSecretPassword123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The organization, email or password is incorrect.');
    expect(alert.textContent).not.toContain('MySuperSecretPassword123!');
  });

  it('6. displays friendly 429 rate-limit message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'too_many_requests', message: 'Too many authentication attempts' },
          { status: 429 },
        ),
      );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many sign-in attempts. Please wait a few minutes before trying again.',
    );
  });

  it('7. displays friendly network and 503 service error messages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach TalentLens AI. Please check your network connection and try again.',
    );

    // Retry and receive 503
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'service_unavailable', message: 'Database unavailable' },
        { status: 503 },
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authentication is temporarily unavailable. Please try again shortly.',
    );
  });

  it('8. disables inputs and submit button while login request is in flight', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );

    let resolveLogin!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveLogin = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }));

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const pendingButton = screen.getByRole('button', { name: /Signing in…/i });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByLabelText(/Organization/i)).toBeDisabled();
    expect(screen.getByLabelText(/Work email/i)).toBeDisabled();
    expect(screen.getByLabelText(/^Password$/i)).toBeDisabled();

    resolveLogin(jsonResponse({ user: SAMPLE_RECRUITER }));

    await waitFor(() => {
      expect(screen.getByTestId('landed-path')).toHaveTextContent('/dashboard');
    });
  });

  it('9. preserves safe internal redirect paths and rejects external or cross-role redirects', async () => {
    expect(isSafeInternalPath('/dashboard?state=empty')).toBe(true);
    expect(isSafeInternalPath('https://evil.example/phish')).toBe(false);
    expect(isSafeInternalPath('//evil.example/phish')).toBe(false);
    expect(isSafeInternalPath('/\\evil.example')).toBe(false);
    expect(isSafeInternalPath('/dashboard/../admin')).toBe(false);
    expect(isPathAllowedForRole('/dashboard', 'CLIENT_HIRING_MANAGER')).toBe(false);
    expect(resolveSafePostLoginRedirect('https://evil.example', 'RECRUITER')).toBe('/dashboard');
    expect(resolveSafePostLoginRedirect('/dashboard', 'CLIENT_HIRING_MANAGER')).toBe(
      '/client-portal',
    );

    // 9a: Safe internal redirect from router state is honored for RECRUITER
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-redirect-ok' }));

    const user = userEvent.setup({ delay: null });
    renderLoginPage({
      pathname: '/login',
      state: { from: '/dashboard?state=empty' },
    });

    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('landed-path')).toHaveTextContent('/dashboard?state=empty');
  });

  it('10. rejects external redirect query parameters and falls back to role default landing route', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-redirect-fallback' }));

    const user = userEvent.setup({ delay: null });
    renderLoginPage('/login?redirect=https://evil.example/steal');

    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('landed-path')).toHaveTextContent('/dashboard');
  });

  it('11. login success followed by CSRF 503 does not report invalid credentials, retains verified principal, and Retry fetches CSRF without another login request', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Must NOT report invalid credentials or keep the login form mounted
    expect(
      await screen.findByRole('heading', {
        name: /Workspace security initialization incomplete/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/The organization, email or password is incorrect/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.getByText('priya.raman@northwind.example')).toBeInTheDocument();

    // Clicking Retry fetches GET /auth/csrf ONLY (no second POST /auth/login) and redirects to /dashboard
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-recovered-after-login' }));

    await user.click(screen.getByRole('button', { name: /^Retry$/i }));

    expect(await screen.findByTestId('landed-path')).toHaveTextContent('/dashboard');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/login');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/auth/csrf');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('12. login success followed by CSRF 503 and then CSRF 401 on Retry clears pending identity and returns to sign-in form', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'unauthenticated', message: 'Authentication required' },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ user: SAMPLE_RECRUITER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );

    const user = userEvent.setup({ delay: null });
    renderLoginPage();

    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', {
        name: /Workspace security initialization incomplete/i,
      }),
    ).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'unauthenticated', message: 'Session expired' }, { status: 401 }),
    );

    await user.click(screen.getByRole('button', { name: /^Retry$/i }));

    expect(
      await screen.findByRole('heading', { name: /Sign in to your workspace/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
