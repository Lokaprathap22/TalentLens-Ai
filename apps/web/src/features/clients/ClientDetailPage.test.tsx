import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { ClientDetailPage } from './ClientDetailPage.js';
import type { ClientMemberRecord, ClientRecord } from './types.js';

const SAMPLE_CLIENT: ClientRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Corporation',
  status: 'ACTIVE',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-15T14:30:00.000Z',
};

const SAMPLE_MEMBERS: ClientMemberRecord[] = [
  {
    id: 'mem-1',
    membershipId: 'mem-1',
    userId: 'usr-1',
    clientId: SAMPLE_CLIENT.id,
    organizationId: 'org-1',
    name: 'Jane Doe',
    email: 'jane.doe@acme.com',
    role: 'CLIENT_HIRING_MANAGER',
    membershipStatus: 'ACTIVE',
    userStatus: 'ACTIVE',
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
  },
  {
    id: 'mem-2',
    membershipId: 'mem-2',
    userId: 'usr-2',
    clientId: SAMPLE_CLIENT.id,
    organizationId: 'org-1',
    name: 'Alex Chen',
    email: 'alex.chen@acme.com',
    role: 'CLIENT_HIRING_MANAGER',
    membershipStatus: 'ACTIVE',
    userStatus: 'INVITED',
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
  },
];

function renderClientDetailPage(clientId = SAMPLE_CLIENT.id): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/clients/${clientId}`]}>
      <Routes>
        <Route path="/clients/:clientId" element={<ClientDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ClientDetailPage & Client Access Management', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders loading skeleton while client and members are fetching', () => {
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}));

    renderClientDetailPage();

    expect(screen.getByRole('status')).toHaveTextContent(/Loading client details/i);
  });

  it('2. renders client overview and hiring managers table with status badges and counts', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === `/clients/${SAMPLE_CLIENT.id}`) {
        return { client: SAMPLE_CLIENT };
      }
      if (path === `/clients/${SAMPLE_CLIENT.id}/members`) {
        return { members: SAMPLE_MEMBERS };
      }
      throw new Error(`Unhandled path: ${path}`);
    });

    renderClientDetailPage();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Acme Corporation', level: 1 }),
      ).toBeInTheDocument();
    });

    // Check members list
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane.doe@acme.com')).toBeInTheDocument();
    expect(screen.getByText('Alex Chen')).toBeInTheDocument();
    expect(screen.getByText('alex.chen@acme.com')).toBeInTheDocument();

    // Check account status badges
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('Invited')).toBeInTheDocument();
  });

  it('3. filters members by status tabs (All, Active, Pending invitation)', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === `/clients/${SAMPLE_CLIENT.id}`) {
        return { client: SAMPLE_CLIENT };
      }
      if (path === `/clients/${SAMPLE_CLIENT.id}/members`) {
        return { members: SAMPLE_MEMBERS };
      }
      throw new Error(`Unhandled path: ${path}`);
    });

    renderClientDetailPage();

    await waitFor(() => {
      expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    });

    // Switch to Pending invitation tab
    const pendingTab = screen.getByRole('tab', { name: /Pending invitation/i });
    await user.click(pendingTab);

    // Only Alex Chen should be visible
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    expect(screen.getByText('Alex Chen')).toBeInTheDocument();

    // Switch to Active tab
    const activeTab = screen.getByRole('tab', { name: /^Active/i });
    await user.click(activeTab);

    // Only Jane Doe should be visible
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText('Alex Chen')).not.toBeInTheDocument();
  });

  it('4. renders empty state when no client members have been invited', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === `/clients/${SAMPLE_CLIENT.id}`) {
        return { client: SAMPLE_CLIENT };
      }
      if (path === `/clients/${SAMPLE_CLIENT.id}/members`) {
        return { members: [] };
      }
      throw new Error(`Unhandled path: ${path}`);
    });

    renderClientDetailPage();

    await waitFor(() => {
      expect(screen.getByText(/No client hiring managers yet/i)).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: /Invite first hiring manager/i }),
    ).toBeInTheDocument();
  });

  it('5. opens invite dialog, validates inputs, sends invitation, and updates members list with success notification', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === `/clients/${SAMPLE_CLIENT.id}`) {
        return { client: SAMPLE_CLIENT };
      }
      if (path === `/clients/${SAMPLE_CLIENT.id}/members`) {
        return { members: [] };
      }
      throw new Error(`Unhandled path: ${path}`);
    });

    const newMember: ClientMemberRecord = {
      id: 'mem-new',
      membershipId: 'mem-new',
      userId: 'usr-new',
      clientId: SAMPLE_CLIENT.id,
      organizationId: 'org-1',
      name: 'Marcus Brody',
      email: 'marcus@acme.com',
      role: 'CLIENT_HIRING_MANAGER',
      membershipStatus: 'ACTIVE',
      userStatus: 'INVITED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      member: newMember,
    });

    renderClientDetailPage();

    await waitFor(() => {
      expect(screen.getByText(/No client hiring managers yet/i)).toBeInTheDocument();
    });

    // Click Invite member button
    const inviteButton = screen.getByRole('button', { name: /Invite first hiring manager/i });
    await user.click(inviteButton);

    // Dialog opens
    const dialog = screen.getByRole('dialog', { name: /Invite client hiring manager/i });
    expect(dialog).toBeInTheDocument();

    // Fill form
    const emailInput = within(dialog).getByLabelText(/Work email address/i);
    const nameInput = within(dialog).getByLabelText(/Full name/i);
    await user.type(emailInput, 'marcus@acme.com');
    await user.type(nameInput, 'Marcus Brody');

    // Submit form
    const submitButton = within(dialog).getByRole('button', { name: /Send invitation/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(`/clients/${SAMPLE_CLIENT.id}/members`, {
        email: 'marcus@acme.com',
        name: 'Marcus Brody',
      });
    });

    // Verify dialog closes and banner displays
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/Invitation sent to marcus@acme.com/i);
    });

    // Verify member added to table
    expect(screen.getByText('Marcus Brody')).toBeInTheDocument();
    expect(screen.getByText('marcus@acme.com')).toBeInTheDocument();
  }, 15000);

  it('6. displays inline error message in dialog when invite fails with 409 conflict', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === `/clients/${SAMPLE_CLIENT.id}`) {
        return { client: SAMPLE_CLIENT };
      }
      if (path === `/clients/${SAMPLE_CLIENT.id}/members`) {
        return { members: [] };
      }
      throw new Error(`Unhandled path: ${path}`);
    });

    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: 'duplicate_invitation',
        message: 'An invitation is already pending for this email address with this client.',
      }),
    );

    renderClientDetailPage();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Acme Corporation', level: 1 }),
      ).toBeInTheDocument();
    });

    const inviteButtons = screen.getAllByRole('button', { name: /Invite member/i });
    await user.click(inviteButtons[0]!);

    const dialog = screen.getByRole('dialog', { name: /Invite client hiring manager/i });
    const emailInput = within(dialog).getByLabelText(/Work email address/i);
    await user.type(emailInput, 'duplicate@acme.com');

    const submitButton = within(dialog).getByRole('button', { name: /Send invitation/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        /An invitation is already pending for this email address with this client/i,
      );
    });

    // Dialog stays open so user can correct the input
    expect(dialog).toBeInTheDocument();
  });

  it('7. displays not found state when client does not exist', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'not_found', message: 'Client not found' }),
    );

    renderClientDetailPage('missing-uuid');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Client not found/i })).toBeInTheDocument();
    });

    expect(
      screen.getByText(/The requested client organization could not be found/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to clients/i })).toBeInTheDocument();
  });
});
