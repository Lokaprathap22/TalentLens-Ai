import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { RequisitionsPage } from './RequisitionsPage.js';
import type { RequisitionRecord } from './types.js';

const CLIENT_APEX = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Apex Fintech',
  status: 'ACTIVE' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const CLIENT_BEACON = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Beacon Health',
  status: 'ACTIVE' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const REQ_DRAFT: RequisitionRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: CLIENT_APEX.id,
  clientName: CLIENT_APEX.name,
  title: 'Senior Backend Engineer',
  jdText: 'Looking for a Senior Backend Engineer with TypeScript and PostgreSQL experience.',
  status: 'DRAFT',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-15T14:30:00.000Z',
};

const REQ_OPEN: RequisitionRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  clientId: CLIENT_BEACON.id,
  clientName: CLIENT_BEACON.name,
  title: 'Frontend React Lead',
  jdText: 'Lead our web platform using React 19, Tailwind CSS, and Vite.',
  status: 'OPEN',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-20T11:15:00.000Z',
};

const REQ_PAUSED: RequisitionRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  clientId: CLIENT_APEX.id,
  clientName: CLIENT_APEX.name,
  title: 'DevOps Specialist',
  jdText: 'Kubernetes, Terraform, AWS.',
  status: 'PAUSED',
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

const REQ_CLOSED: RequisitionRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  clientId: CLIENT_BEACON.id,
  clientName: CLIENT_BEACON.name,
  title: 'Legacy Architect',
  jdText: 'Java 8, Oracle DB.',
  status: 'CLOSED',
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

function renderRequisitionsPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/requisitions']}>
      <RequisitionsPage />
    </MemoryRouter>,
  );
}

describe('RequisitionsPage UI & Workflows (M9.3 Step 3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders initial loading skeleton while GET /requisitions is in flight', () => {
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}));

    renderRequisitionsPage();

    expect(screen.getByRole('status')).toHaveTextContent(/Loading requisitions directory/i);
    expect(screen.getByRole('heading', { name: 'Requisitions', level: 1 })).toBeInTheDocument();
  });

  it('2. renders directory, summary counts, status badges, and formatted dates', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      requisitions: [REQ_DRAFT, REQ_OPEN, REQ_PAUSED, REQ_CLOSED],
    });

    renderRequisitionsPage();

    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Frontend React Lead')).toBeInTheDocument();
    expect(screen.getByText('DevOps Specialist')).toBeInTheDocument();
    expect(screen.getByText('Legacy Architect')).toBeInTheDocument();

    const summarySection = screen.getByRole('region', { name: /Requisitions summary/i });
    expect(within(summarySection).getByText('4')).toBeInTheDocument(); // total
    expect(within(summarySection).getAllByText('1').length).toBeGreaterThan(0); // draft, open, paused, closed

    const table = screen.getByRole('table');
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    expect(within(table).getByText('Open')).toBeInTheDocument();
    expect(within(table).getByText('Paused')).toBeInTheDocument();
    expect(within(table).getByText('Closed')).toBeInTheDocument();
  });

  it('3. filters requisitions by search query and tabs and clears filters', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      requisitions: [REQ_DRAFT, REQ_OPEN, REQ_PAUSED, REQ_CLOSED],
    });
    const user = userEvent.setup({ delay: null });

    renderRequisitionsPage();
    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();

    // Filter by Draft tab
    await user.click(screen.getByRole('tab', { name: /^Draft/i }));
    expect(screen.getByText('Senior Backend Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Frontend React Lead')).not.toBeInTheDocument();

    // Filter by Open tab
    await user.click(screen.getByRole('tab', { name: /^Open/i }));
    expect(screen.getByText('Frontend React Lead')).toBeInTheDocument();
    expect(screen.queryByText('Senior Backend Engineer')).not.toBeInTheDocument();

    // Search query
    const searchInput = screen.getByPlaceholderText(/Search title or client/i);
    await user.clear(searchInput);
    await user.type(searchInput, 'React');
    expect(screen.getByText('Frontend React Lead')).toBeInTheDocument();

    // Search query matches client name
    await user.clear(searchInput);
    await user.type(searchInput, 'Apex');
    // Tab is still Open, and Apex only has DRAFT and PAUSED, so 0 matches
    expect(screen.getByText(/No matching requisitions/i)).toBeInTheDocument();

    // Clear filters
    const clearButtons = screen.getAllByRole('button', { name: /Clear filters/i });
    await user.click(clearButtons[0]!);
    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();
  });

  it('4. renders empty state when zero requisitions exist with create CTA', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ requisitions: [] });

    renderRequisitionsPage();

    expect(await screen.findByText(/No requisitions yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Create your first job requisition to start intake, generate scorecards, and screen candidate resumes/i,
      ),
    ).toBeInTheDocument();
  });

  it('5. renders error state with retry button on load failure', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'server_error', message: 'Fail' }))
      .mockResolvedValueOnce({ requisitions: [REQ_DRAFT] });

    const user = userEvent.setup({ delay: null });

    renderRequisitionsPage();

    expect(await screen.findByText(/Unable to load requisitions/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('6. opens create dialog, loads clients, and successfully creates requisition', async () => {
    vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ requisitions: [REQ_DRAFT] }) // list requisitions
      .mockResolvedValueOnce({ clients: [CLIENT_APEX, CLIENT_BEACON] }); // list clients in dialog

    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      requisition: {
        ...REQ_DRAFT,
        id: 'new-req-id',
        title: 'Principal Architect',
        jdText: 'Distributed systems.',
      },
    });

    const user = userEvent.setup({ delay: null });

    renderRequisitionsPage();
    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Create requisition/i }));

    const dialog = screen.getByRole('dialog', { name: /Create new requisition/i });
    expect(dialog).toBeInTheDocument();

    // Select client
    const clientSelect = await screen.findByRole('combobox', { name: /Client organization/i });
    await user.selectOptions(clientSelect, CLIENT_APEX.id);

    // Enter title
    const titleInput = screen.getByRole('textbox', { name: /Job title/i });
    await user.type(titleInput, 'Principal Architect');

    // Enter JD
    const jdInput = screen.getByRole('textbox', { name: /Job description requirements/i });
    await user.type(jdInput, 'Distributed systems requirements and architecture.');

    // Submit using dialog footer button
    const submitBtn = within(dialog).getByRole('button', { name: /Create requisition/i });
    await user.click(submitBtn);

    expect(postSpy).toHaveBeenCalledWith('/requisitions', {
      clientId: CLIENT_APEX.id,
      title: 'Principal Architect',
      jdText: 'Distributed systems requirements and architecture.',
    });

    // Dialog closes and new requisition is visible
    expect(await screen.findByText('Principal Architect')).toBeInTheDocument();
  });

  it('7. opens edit draft dialog for DRAFT requisition and updates title and jdText', async () => {
    vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ requisitions: [REQ_DRAFT] })
      .mockResolvedValueOnce({ clients: [CLIENT_APEX] });

    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      requisition: {
        ...REQ_DRAFT,
        title: 'Senior Backend Engineer II',
      },
    });

    const user = userEvent.setup({ delay: null });

    renderRequisitionsPage();
    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Edit draft for ${REQ_DRAFT.title}` }));

    expect(screen.getByRole('dialog', { name: /Edit requisition draft/i })).toBeInTheDocument();

    const titleInput = screen.getByRole('textbox', { name: /Job title/i });
    await user.clear(titleInput);
    await user.type(titleInput, 'Senior Backend Engineer II');

    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(patchSpy).toHaveBeenCalledWith(`/requisitions/${REQ_DRAFT.id}`, {
      clientId: CLIENT_APEX.id,
      title: 'Senior Backend Engineer II',
      jdText: REQ_DRAFT.jdText,
    });

    expect(await screen.findByText('Senior Backend Engineer II')).toBeInTheDocument();
  });

  it('8. does not render edit button for non-DRAFT requisitions', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      requisitions: [REQ_OPEN, REQ_PAUSED, REQ_CLOSED],
    });

    renderRequisitionsPage();
    expect(await screen.findByText('Frontend React Lead')).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: /Edit draft for Frontend React Lead/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit draft for DevOps Specialist/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit draft for Legacy Architect/i }),
    ).not.toBeInTheDocument();
  });

  it('9. handles scorecard requirement error when attempting transition to OPEN', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      requisitions: [REQ_DRAFT],
    });

    const postSpy = vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'invalid_request',
      }),
    );

    const user = userEvent.setup({ delay: null });

    renderRequisitionsPage();
    expect(await screen.findByText('Senior Backend Engineer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Change status for ${REQ_DRAFT.title}` }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Confirm transition to OPEN/i }));

    expect(postSpy).toHaveBeenCalledWith(`/requisitions/${REQ_DRAFT.id}/status`, {
      status: 'OPEN',
    });

    // Displays clear scorecard requirement alert
    expect(
      await screen.findByText(
        /This requisition cannot be opened yet because it requires an approved scorecard/i,
      ),
    ).toBeInTheDocument();

    // Dialog remains open for correction/dismissal
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    // Cancel closes dialog
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // Requisition remains DRAFT
    expect(within(screen.getByRole('table')).getByText('Draft')).toBeInTheDocument();
  });
});
