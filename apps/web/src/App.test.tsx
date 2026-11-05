import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App.js';
import type { AuthenticatedUser } from './features/auth/auth.types.js';
import { clearCsrfToken, clearUnauthorizedHandler } from './lib/api-client.js';

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

const RECRUITER_USER: AuthenticatedUser = {
  userId: 'user-recruiter-1',
  organizationId: 'org-northwind-1',
  organizationName: 'Northwind Talent',
  email: 'priya.raman@northwind.example',
  role: 'RECRUITER',
};

const CLIENT_USER: AuthenticatedUser = {
  userId: 'user-client-1',
  organizationId: 'org-northwind-1',
  organizationName: 'Northwind Talent',
  email: 'hiring.manager@client.example',
  role: 'CLIENT_HIRING_MANAGER',
};

const DELIVERY_HEAD_USER: AuthenticatedUser = {
  userId: 'user-delivery-1',
  organizationId: 'org-northwind-1',
  organizationName: 'Northwind Talent',
  email: 'delivery.lead@northwind.example',
  role: 'DELIVERY_HEAD',
};

function renderAt(initialEntry = '/dashboard'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('TalentLens AI Authentication, ProtectedRoute & Recruiter AppShell (M9.1 + M9.2A)', () => {
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

  function mockAuthenticatedSession(user: AuthenticatedUser = RECRUITER_USER): void {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-session-token' }));
  }

  function mockUnauthenticatedSession(): void {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'unauthenticated', message: 'Authentication required' },
        { status: 401 },
      ),
    );
  }

  it('1. renders a full-viewport loading screen while session restoration is in flight', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    renderAt('/dashboard');

    expect(screen.getByRole('status')).toHaveTextContent(/Restoring secure workspace session/i);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('2. redirects unauthenticated access to /dashboard to /login and preserves destination on sign-in', async () => {
    mockUnauthenticatedSession();
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard?state=empty');

    expect(
      await screen.findByRole('heading', { name: /Sign in to your workspace/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();

    // Sign in and verify redirect back to the originally requested /dashboard?state=empty
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: RECRUITER_USER }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-after-login' }));

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'priya.raman@northwind.example');
    await user.type(screen.getByLabelText(/^Password$/i), 'ValidPassword!123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /No candidates in the review queue/i }),
    ).toBeInTheDocument();
  });

  it('3. allows authenticated RECRUITER to access /dashboard with real workspace identity', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    renderAt('/dashboard');

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Northwind Talent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('priya.raman@northwind.example').length).toBeGreaterThan(0);

    // Wait for dashboard pipeline sections
    expect(await screen.findByRole('heading', { name: 'Hiring pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Candidate review queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Active requisitions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upcoming interviews' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent workflow activity' })).toBeInTheDocument();
  });

  it('4. redirects authenticated CLIENT_HIRING_MANAGER away from recruiter AppShell to /client-portal', async () => {
    mockAuthenticatedSession(CLIENT_USER);
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');

    expect(
      await screen.findByRole('heading', {
        name: /Client Hiring Manager portal arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.getAllByText('hiring.manager@client.example').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Client Hiring Manager').length).toBeGreaterThan(0);

    // Sign out from client portal notice page
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    await user.click(screen.getByRole('button', { name: /Sign out of session/i }));

    expect(
      await screen.findByRole('heading', { name: /Sign in to your workspace/i }),
    ).toBeInTheDocument();
  });

  it('5. redirects authenticated DELIVERY_HEAD away from recruiter AppShell to /delivery-overview', async () => {
    mockAuthenticatedSession(DELIVERY_HEAD_USER);
    renderAt('/dashboard');

    expect(
      await screen.findByRole('heading', {
        name: /Delivery Head workspace arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.getAllByText('delivery.lead@northwind.example').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delivery Head').length).toBeGreaterThan(0);
  });

  it('6. redirects an already-authenticated user visiting /login to their role landing page', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    renderAt('/login');

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('7. displays real identity in AccountMenu, signs out on click, and surfaces recoverable error on sign-out failure', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });

    // Open AccountMenu
    const accountTrigger = screen.getByRole('button', { name: 'Account menu' });
    await user.click(accountTrigger);

    const menu = screen.getByRole('menu', { name: 'Account menu' });
    expect(within(menu).getByText('priya.raman@northwind.example')).toBeInTheDocument();
    expect(within(menu).getByText(/Recruiter · Northwind Talent/i)).toBeInTheDocument();

    // First attempt: simulate 503 failure -> must NOT falsely claim sign-out succeeded
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'service_unavailable',
          message: 'Authentication service is temporarily unavailable.',
        },
        { status: 503 },
      ),
    );

    await user.click(within(menu).getByRole('menuitem', { name: /Sign out/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Unable to sign out/i);
    expect(alert).toHaveTextContent(/The service is temporarily unavailable/i);
    // Still on Dashboard
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();

    // Second attempt: retry sign out and succeed -> redirects to /login
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    await user.click(within(alert).getByRole('button', { name: /Retry sign out/i }));

    expect(
      await screen.findByRole('heading', { name: /Sign in to your workspace/i }),
    ).toBeInTheDocument();
  });

  it('8. switches review queue tabs and explicitly surfaces insufficient evidence without zero scores', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    const user = userEvent.setup({ delay: null });
    renderAt('/dashboard');

    expect(await screen.findByText('CAN-4821')).toBeInTheDocument();

    const gapsTab = screen.getByRole('tab', { name: /Evidence & parsing gaps/i });
    await user.click(gapsTab);

    expect(screen.getByText('CAN-4799')).toBeInTheDocument();
    expect(screen.getAllByText(/Insufficient evidence \(not scored\)/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('0 / 100')).not.toBeInTheDocument();

    const consentTab = screen.getByRole('tab', { name: /Consent holds/i });
    await user.click(consentTab);
    expect(screen.getByText('CAN-4768')).toBeInTheDocument();
    expect(screen.getAllByText('Consent withdrawn').length).toBeGreaterThan(0);
  });

  it('9. filters the candidate review queue by search query and opens the candidate inspection dialog', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    const user = userEvent.setup({ delay: null });
    renderAt('/dashboard');

    expect(await screen.findByText('CAN-4821')).toBeInTheDocument();

    const searchInput = screen.getByRole('searchbox', {
      name: /Filter review queue by candidate code or requisition/i,
    });
    await user.type(searchInput, 'CAN-4786');

    expect(screen.getByText('CAN-4786')).toBeInTheDocument();
    expect(screen.queryByText('CAN-4821')).not.toBeInTheDocument();

    const inspectButton = screen.getByRole('button', { name: 'Inspect' });
    await user.click(inspectButton);

    const dialog = screen.getByRole('dialog', { name: /Assessment preview · CAN-4786/i });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Mandatory human review & fairness guardrails/i),
    ).toBeInTheDocument();
  });

  it('10. supports empty and error preview states via URL search parameters and renders /design-system', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    renderAt('/dashboard?state=error');
    expect(
      await screen.findByRole('heading', { name: /Unable to load dashboard workspace/i }),
    ).toBeInTheDocument();
  });

  it('11. renders the protected /design-system reference route for authenticated recruiters', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    renderAt('/design-system');
    expect(
      await screen.findByRole('heading', { name: 'Design system', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Domain status badges', level: 2 }),
    ).toBeInTheDocument();
  });

  it('12. shows recoverable initialization error on /dashboard when GET /auth/me returns 503 without redirecting to /login or mounting protected content, and Retry restores session', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'service_unavailable', message: 'Database unavailable' },
        { status: 503 },
      ),
    );
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');

    expect(
      await screen.findByRole('heading', { name: /Unable to verify workspace session/i }),
    ).toBeInTheDocument();
    // Must not redirect to /login and must not render protected dashboard content
    expect(
      screen.queryByRole('heading', { name: /Sign in to your workspace/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();

    // Retry restores session via GET /auth/me + GET /auth/csrf
    mockAuthenticatedSession(RECRUITER_USER);
    await user.click(screen.getByRole('button', { name: /^Retry$/i }));

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('13. shows recoverable CSRF initialization error on /dashboard when GET /auth/me succeeds and GET /auth/csrf returns 503, and Retry fetches CSRF without repeating /auth/me', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: RECRUITER_USER }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'service_unavailable', message: 'CSRF unavailable' },
          { status: 503 },
        ),
      );
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');

    expect(
      await screen.findByRole('heading', {
        name: /Workspace security initialization incomplete/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('priya.raman@northwind.example')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();

    // Retry fetches /auth/csrf ONLY without repeating /auth/me
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-recovered-token' }));
    await user.click(screen.getByRole('button', { name: /^Retry$/i }));

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/csrf');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/auth/csrf');
  });

  it('14. allows authenticated RECRUITER to navigate to /clients via sidebar and blocks non-recruiter roles', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        clients: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Apex Fintech',
            status: 'ACTIVE',
            createdAt: '2026-10-12T09:00:00.000Z',
            updatedAt: '2026-10-15T14:30:00.000Z',
          },
        ],
      }),
    );
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const clientsNavLink = within(sidebar).getByRole('link', { name: 'Clients' });
    await user.click(clientsNavLink);

    expect(await screen.findByRole('heading', { name: 'Clients', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();
  });

  it('15. redirects CLIENT_HIRING_MANAGER and DELIVERY_HEAD away from /clients', async () => {
    mockAuthenticatedSession(CLIENT_USER);
    const { unmount } = renderAt('/clients');

    expect(
      await screen.findByRole('heading', {
        name: /Client Hiring Manager portal arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clients' })).not.toBeInTheDocument();

    unmount();
    clearCsrfToken();
    clearUnauthorizedHandler();
    fetchMock.mockReset();

    mockAuthenticatedSession(DELIVERY_HEAD_USER);
    renderAt('/clients');

    expect(
      await screen.findByRole('heading', {
        name: /Delivery Head workspace arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clients' })).not.toBeInTheDocument();
  });

  it('16. renders Requisitions workspace when clicking Requisitions sidebar link', async () => {
    mockAuthenticatedSession(RECRUITER_USER);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        requisitions: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            clientName: 'Apex Fintech',
            title: 'Lead Platform Architect',
            jdText: 'Design distributed cloud architectures with Kubernetes.',
            status: 'DRAFT',
            createdAt: '2026-10-12T09:00:00.000Z',
            updatedAt: '2026-10-15T14:30:00.000Z',
          },
        ],
      }),
    );
    const user = userEvent.setup({ delay: null });

    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const reqNavLink = within(sidebar).getByRole('link', { name: 'Requisitions' });
    await user.click(reqNavLink);

    expect(
      await screen.findByRole('heading', { name: 'Requisitions', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Lead Platform Architect')).toBeInTheDocument();
  });

  it('17. redirects non-recruiter roles away from /requisitions', async () => {
    mockAuthenticatedSession(CLIENT_USER);
    const { unmount } = renderAt('/requisitions');

    expect(
      await screen.findByRole('heading', {
        name: /Client Hiring Manager portal arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Requisitions' })).not.toBeInTheDocument();

    unmount();
    clearCsrfToken();
    clearUnauthorizedHandler();
    fetchMock.mockReset();

    mockAuthenticatedSession(DELIVERY_HEAD_USER);
    renderAt('/requisitions');

    expect(
      await screen.findByRole('heading', {
        name: /Delivery Head workspace arriving in an upcoming milestone/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Requisitions' })).not.toBeInTheDocument();
  });
});
