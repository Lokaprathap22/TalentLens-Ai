import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { ClientsPage } from './ClientsPage.js';
import type { ClientRecord } from './types.js';

const CLIENT_APEX: ClientRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Apex Fintech',
  status: 'ACTIVE',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-15T14:30:00.000Z',
};

const CLIENT_BEACON: ClientRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Beacon Health',
  status: 'INACTIVE',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-20T11:15:00.000Z',
};

const CLIENT_COBALT: ClientRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Cobalt Cloud',
  status: 'ACTIVE',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
};

function renderClientsPage(pageSize?: number): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      <ClientsPage {...(pageSize !== undefined ? { pageSize } : {})} />
    </MemoryRouter>,
  );
}

describe('ClientsPage UI & Workflows (M9.3 Step 2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders initial loading skeleton while GET /clients is in flight', () => {
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}));

    renderClientsPage();

    expect(screen.getByRole('status')).toHaveTextContent(/Loading client directory/i);
    expect(screen.getByRole('heading', { name: 'Clients', level: 1 })).toBeInTheDocument();
  });

  it('2. renders client directory, summary strip counts, status badges, and formatted dates', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [CLIENT_APEX, CLIENT_BEACON, CLIENT_COBALT],
    });

    renderClientsPage();

    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();
    expect(screen.getByText('Beacon Health')).toBeInTheDocument();
    expect(screen.getByText('Cobalt Cloud')).toBeInTheDocument();

    const summarySection = screen.getByRole('region', { name: /Client directory summary/i });
    expect(within(summarySection).getByText('3')).toBeInTheDocument();
    expect(within(summarySection).getByText('2')).toBeInTheDocument();
    expect(within(summarySection).getByText('1')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: /Organization clients/i });
    expect(within(table).getAllByText('Active')).toHaveLength(2);
    expect(within(table).getAllByText('Inactive')).toHaveLength(1);
    expect(within(table).getAllByText('12 Oct 2026').length).toBeGreaterThan(0);
  });

  it('3. filters clients by search query and All / Active / Inactive tabs and clears filters', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [CLIENT_APEX, CLIENT_BEACON, CLIENT_COBALT],
    });
    const user = userEvent.setup({ delay: null });

    renderClientsPage();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();

    // Filter by Active tab
    await user.click(screen.getByRole('tab', { name: /^Active/i }));
    expect(screen.getByText('Apex Fintech')).toBeInTheDocument();
    expect(screen.getByText('Cobalt Cloud')).toBeInTheDocument();
    expect(screen.queryByText('Beacon Health')).not.toBeInTheDocument();

    // Filter by Inactive tab
    await user.click(screen.getByRole('tab', { name: /^Inactive/i }));
    expect(screen.getByText('Beacon Health')).toBeInTheDocument();
    expect(screen.queryByText('Apex Fintech')).not.toBeInTheDocument();

    // Search with no match in Inactive tab -> shows search-no-results state
    const searchInput = screen.getByRole('searchbox', { name: /Search clients by name/i });
    await user.type(searchInput, 'Apex');

    expect(screen.getByRole('heading', { name: /No matching clients/i })).toBeInTheDocument();
    expect(
      screen.getByText(/No clients match "Apex" in the selected status filter\./i),
    ).toBeInTheDocument();

    // Clear filters restores full list
    const clearButtons = screen.getAllByRole('button', { name: /Clear filters/i });
    await user.click(clearButtons[0]!);

    expect(screen.getByText('Apex Fintech')).toBeInTheDocument();
    expect(screen.getByText('Beacon Health')).toBeInTheDocument();
    expect(screen.getByText('Cobalt Cloud')).toBeInTheDocument();
  });

  it('4. renders empty directory state when organization has zero clients', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ clients: [] });

    renderClientsPage();

    expect(await screen.findByRole('heading', { name: /No clients yet/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Add your first client organization to start creating requisitions and scorecards\./i,
      ),
    ).toBeInTheDocument();
  });

  it('5. renders API error state and retries loading when Try again is clicked', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockRejectedValueOnce(
        new ApiError({
          status: 503,
          code: 'service_unavailable',
          message: 'Service unavailable',
        }),
      )
      .mockResolvedValueOnce({ clients: [CLIENT_APEX] });
    const user = userEvent.setup({ delay: null });

    renderClientsPage();

    expect(
      await screen.findByRole('heading', { name: /Unable to load client directory/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The client service is temporarily unavailable/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('6. validates required/whitespace client name, handles 409 duplicate-name conflict while preserving input, and creates a client on success', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ clients: [CLIENT_APEX] });
    const createdClient: ClientRecord = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Delta BioLabs',
      status: 'ACTIVE',
      createdAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    };
    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'conflict',
          message: 'A client with this name already exists in the organization.',
        }),
      )
      .mockResolvedValueOnce({ client: createdClient });

    const user = userEvent.setup({ delay: null });
    renderClientsPage();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();

    // Open Add client dialog
    await user.click(screen.getByRole('button', { name: 'Add client' }));
    const dialog = screen.getByRole('dialog', { name: /Add client/i });
    const nameInput = within(dialog).getByLabelText(/Client name/i);
    const submitBtn = within(dialog).getByRole('button', { name: 'Add client' });

    // 1) Required validation on empty submit
    await user.click(submitBtn);
    expect(within(dialog).getByText('Enter a client name.')).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(postSpy).not.toHaveBeenCalled();

    // 2) Whitespace-only validation
    await user.type(nameInput, '    ');
    await user.click(submitBtn);
    expect(within(dialog).getByText('Enter a client name.')).toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();

    // 3) Duplicate name 409 conflict preserves input and displays exact message
    await user.clear(nameInput);
    await user.type(nameInput, 'Apex Fintech');
    await user.click(submitBtn);

    expect(
      await within(dialog).findByText('The client name already exists in your organization.'),
    ).toBeInTheDocument();
    expect(nameInput).toHaveValue('Apex Fintech');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');

    // 4) Valid submission succeeds, closes dialog, reconciles list and summary counts
    await user.clear(nameInput);
    await user.type(nameInput, '  Delta BioLabs  ');
    await user.click(submitBtn);

    expect(await screen.findByText('Delta BioLabs')).toBeInTheDocument();
    expect(postSpy).toHaveBeenLastCalledWith('/clients', { name: 'Delta BioLabs' });
    expect(screen.getByRole('status')).toHaveTextContent('Added client "Delta BioLabs".');

    const summarySection = screen.getByRole('region', { name: /Client directory summary/i });
    expect(within(summarySection).getAllByText('2').length).toBeGreaterThanOrEqual(2);
  });

  it('7. edits an existing client name, handles 409 conflict on edit, and updates row while preserving other fields', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [CLIENT_APEX, CLIENT_BEACON],
    });
    const updatedApex: ClientRecord = {
      ...CLIENT_APEX,
      name: 'Apex Global Partners',
      updatedAt: '2026-11-05T11:00:00.000Z',
    };
    const patchSpy = vi
      .spyOn(apiClient, 'patch')
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'conflict',
          message: 'Duplicate client name',
        }),
      )
      .mockResolvedValueOnce({ client: updatedApex });

    const user = userEvent.setup({ delay: null });
    renderClientsPage();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Apex Fintech' }));

    const dialog = screen.getByRole('dialog', { name: /Edit client/i });
    const nameInput = within(dialog).getByLabelText(/Client name/i);
    expect(nameInput).toHaveValue('Apex Fintech');

    // Attempt rename to Beacon Health -> 409 conflict
    await user.clear(nameInput);
    await user.type(nameInput, 'Beacon Health');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(
      await within(dialog).findByText('The client name already exists in your organization.'),
    ).toBeInTheDocument();
    expect(nameInput).toHaveValue('Beacon Health');

    // Rename to Apex Global Partners -> 200 OK
    await user.clear(nameInput);
    await user.type(nameInput, 'Apex Global Partners');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Apex Global Partners')).toBeInTheDocument();
    expect(screen.queryByText('Apex Fintech')).not.toBeInTheDocument();
    expect(patchSpy).toHaveBeenLastCalledWith(`/clients/${CLIENT_APEX.id}`, {
      name: 'Apex Global Partners',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Updated client name to "Apex Global Partners".',
    );
  });

  it('8. deactivates an active client and reactivates an inactive client via confirmation dialog, reconciling counts and filters', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [CLIENT_APEX, CLIENT_BEACON],
    });
    const deactivatedApex: ClientRecord = {
      ...CLIENT_APEX,
      status: 'INACTIVE',
      updatedAt: '2026-11-05T12:00:00.000Z',
    };
    const reactivatedBeacon: ClientRecord = {
      ...CLIENT_BEACON,
      status: 'ACTIVE',
      updatedAt: '2026-11-05T12:05:00.000Z',
    };
    const patchSpy = vi
      .spyOn(apiClient, 'patch')
      .mockResolvedValueOnce({ client: deactivatedApex })
      .mockResolvedValueOnce({ client: reactivatedBeacon });

    const user = userEvent.setup({ delay: null });
    renderClientsPage();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();

    // 1) Deactivate Apex Fintech
    await user.click(screen.getByRole('button', { name: 'Deactivate Apex Fintech' }));

    const deactivateDialog = screen.getByRole('alertdialog', {
      name: /Deactivate Apex Fintech\?/i,
    });
    expect(
      within(deactivateDialog).getByText(/will no longer be selectable for new requisitions/i),
    ).toBeInTheDocument();

    await user.click(within(deactivateDialog).getByRole('button', { name: 'Deactivate client' }));

    expect(patchSpy).toHaveBeenNthCalledWith(1, `/clients/${CLIENT_APEX.id}`, {
      status: 'INACTIVE',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/Deactivated "Apex Fintech"/i);

    // Both clients are now INACTIVE (active: 0, inactive: 2)
    expect(screen.getByRole('tab', { name: /^Active\s*0$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Inactive\s*2$/i })).toBeInTheDocument();

    // 2) Reactivate Beacon Health
    await user.click(screen.getByRole('button', { name: 'Reactivate Beacon Health' }));

    const reactivateDialog = screen.getByRole('alertdialog', {
      name: /Reactivate Beacon Health\?/i,
    });
    expect(
      within(reactivateDialog).getByText(/become selectable again when creating new requisitions/i),
    ).toBeInTheDocument();

    await user.click(within(reactivateDialog).getByRole('button', { name: 'Reactivate client' }));

    expect(patchSpy).toHaveBeenNthCalledWith(2, `/clients/${CLIENT_BEACON.id}`, {
      status: 'ACTIVE',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/Reactivated "Beacon Health"/i);
    expect(screen.getByRole('tab', { name: /^Active\s*1$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Inactive\s*1$/i })).toBeInTheDocument();
  });

  it('9. paginates client rows and clamps to previous page when a status update removes the only item on page 2', async () => {
    const thirdActive: ClientRecord = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Zenith Robotics',
      status: 'ACTIVE',
      createdAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-11-02T12:00:00.000Z',
    };
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [CLIENT_APEX, CLIENT_COBALT, thirdActive],
    });
    vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      client: { ...thirdActive, status: 'INACTIVE' },
    });

    const user = userEvent.setup({ delay: null });
    // Render with pageSize=2 so 3 active clients span 2 pages (2 on page 1, 1 on page 2)
    renderClientsPage(2);

    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();
    expect(screen.getByText('Cobalt Cloud')).toBeInTheDocument();
    expect(screen.queryByText('Zenith Robotics')).not.toBeInTheDocument();

    // Filter by Active tab and navigate to page 2
    await user.click(screen.getByRole('tab', { name: /^Active/i }));
    await user.click(screen.getByRole('button', { name: 'Page 2' }));

    expect(screen.getByText('Zenith Robotics')).toBeInTheDocument();
    expect(screen.queryByText('Apex Fintech')).not.toBeInTheDocument();

    // Deactivate Zenith Robotics while on page 2 of Active filter -> clamps back to page 1
    await user.click(screen.getByRole('button', { name: 'Deactivate Zenith Robotics' }));
    const confirmDialog = screen.getByRole('alertdialog', {
      name: /Deactivate Zenith Robotics\?/i,
    });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Deactivate client' }));

    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();
    expect(screen.getByText('Cobalt Cloud')).toBeInTheDocument();
    expect(screen.queryByText('Zenith Robotics')).not.toBeInTheDocument();
  });

  it('10. disables submit and prevents dialog dismissal while a create mutation is in flight', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ clients: [CLIENT_APEX] });

    let resolvePost!: (value: { client: ClientRecord }) => void;
    const postSpy = vi.spyOn(apiClient, 'post').mockImplementation(
      () =>
        new Promise<{ client: ClientRecord }>((resolve) => {
          resolvePost = resolve;
        }),
    );

    const user = userEvent.setup({ delay: null });
    renderClientsPage();
    expect(await screen.findByText('Apex Fintech')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add client' }));
    const dialog = screen.getByRole('dialog', { name: /Add client/i });
    const nameInput = within(dialog).getByLabelText(/Client name/i);

    await user.type(nameInput, 'Northstar Energy');
    await user.click(within(dialog).getByRole('button', { name: 'Add client' }));

    const savingBtn = within(dialog).getByRole('button', { name: /Adding client…/i });
    expect(savingBtn).toBeDisabled();
    expect(savingBtn).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Attempting to click Close dialog while in flight does not close the dialog
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('dialog', { name: /Add client/i })).toBeInTheDocument();
    expect(postSpy).toHaveBeenCalledTimes(1);

    resolvePost({
      client: {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Northstar Energy',
        status: 'ACTIVE',
        createdAt: '2026-11-05T12:00:00.000Z',
        updatedAt: '2026-11-05T12:00:00.000Z',
      },
    });

    expect(await screen.findByText('Northstar Energy')).toBeInTheDocument();
  });
});
