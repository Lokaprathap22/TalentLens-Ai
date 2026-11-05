import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { RequisitionDetailPage } from './RequisitionDetailPage.js';
import type { RequisitionRecord } from './types.js';

const CLIENT_APEX = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Apex Fintech',
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
  clientId: CLIENT_APEX.id,
  clientName: CLIENT_APEX.name,
  title: 'Frontend React Lead',
  jdText: 'Lead our web platform using React 19, Tailwind CSS, and Vite.',
  status: 'OPEN',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-20T11:15:00.000Z',
};

const REQ_CLOSED: RequisitionRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  clientId: CLIENT_APEX.id,
  clientName: CLIENT_APEX.name,
  title: 'Legacy Architect',
  jdText: 'Java 8, Oracle DB.',
  status: 'CLOSED',
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

function renderDetailPage(initialId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/requisitions/${initialId}`]}>
      <Routes>
        <Route path="/requisitions/:requisitionId" element={<RequisitionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequisitionDetailPage UI & Workflows (M9.3 Step 3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders loading skeleton while GET /requisitions/:id is in flight', () => {
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(() => {}));

    renderDetailPage(REQ_DRAFT.id);

    expect(screen.getByRole('status')).toHaveTextContent(/Loading requisition details/i);
  });

  it('2. renders full requisition details, job description, workflow card, and overview', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ requisition: REQ_DRAFT });

    renderDetailPage(REQ_DRAFT.id);

    expect(
      await screen.findByRole('heading', { name: 'Senior Backend Engineer', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.getAllByText(/Apex Fintech/).length).toBeGreaterThan(0);
    expect(screen.getByText(REQ_DRAFT.jdText)).toBeInTheDocument();
    expect(screen.getByText(/Next milestone: Scorecard approval/i)).toBeInTheDocument();

    // Badges & Actions
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Edit draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change status/i })).toBeInTheDocument();
  });

  it('3. renders 404 empty state when requisition is not found', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'not_found', message: 'Not found' }),
    );

    renderDetailPage('non-existent-id');

    expect(
      await screen.findByRole('heading', { name: 'Requisition not found', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/could not be found in your organization workspace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to requisitions/i })).toBeInTheDocument();
  });

  it('4. renders error state with retry button on unexpected server failure', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockRejectedValueOnce(
        new ApiError({ status: 500, code: 'server_error', message: 'Internal error' }),
      )
      .mockResolvedValueOnce({ requisition: REQ_DRAFT });

    const user = userEvent.setup({ delay: null });

    renderDetailPage(REQ_DRAFT.id);

    expect(await screen.findByText(/Failed to load requisition/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(
      await screen.findByRole('heading', { name: 'Senior Backend Engineer', level: 1 }),
    ).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('5. opens edit draft dialog and saves updated job description', async () => {
    vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ requisition: REQ_DRAFT })
      .mockResolvedValueOnce({ clients: [CLIENT_APEX] });

    const updatedText = 'Updated job description with comprehensive requirements.';
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      requisition: {
        ...REQ_DRAFT,
        jdText: updatedText,
      },
    });

    const user = userEvent.setup({ delay: null });

    renderDetailPage(REQ_DRAFT.id);
    expect(
      await screen.findByRole('heading', { name: 'Senior Backend Engineer', level: 1 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Edit draft/i }));

    expect(screen.getByRole('dialog', { name: /Edit requisition draft/i })).toBeInTheDocument();

    const jdTextarea = screen.getByRole('textbox', { name: /Job description requirements/i });
    await user.clear(jdTextarea);
    await user.type(jdTextarea, updatedText);

    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(patchSpy).toHaveBeenCalledWith(`/requisitions/${REQ_DRAFT.id}`, {
      clientId: CLIENT_APEX.id,
      title: REQ_DRAFT.title,
      jdText: updatedText,
    });

    expect(await screen.findByText(updatedText)).toBeInTheDocument();
  });

  it('6. prevents opening when scorecard is missing, keeping status DRAFT', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ requisition: REQ_DRAFT });

    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'invalid_request',
      }),
    );

    const user = userEvent.setup({ delay: null });

    renderDetailPage(REQ_DRAFT.id);
    expect(
      await screen.findByRole('heading', { name: 'Senior Backend Engineer', level: 1 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Change status/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Confirm transition to OPEN/i }));

    // Shows scorecard requirement alert
    expect(
      await screen.findByText(
        /This requisition cannot be opened yet because it requires an approved scorecard/i,
      ),
    ).toBeInTheDocument();

    // Cancel closes dialog
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // Still DRAFT
    expect(screen.getByText(/Next milestone: Scorecard approval/i)).toBeInTheDocument();
  });

  it('7. in OPEN status, hides "Edit draft" button and shows active screening message', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ requisition: REQ_OPEN });

    renderDetailPage(REQ_OPEN.id);

    expect(
      await screen.findByRole('heading', { name: 'Frontend React Lead', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Edit draft/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Active screening in progress/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change status/i })).toBeInTheDocument();
  });

  it('8. in terminal CLOSED status, hides both "Edit draft" and "Change status" buttons', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ requisition: REQ_CLOSED });

    renderDetailPage(REQ_CLOSED.id);

    expect(
      await screen.findByRole('heading', { name: 'Legacy Architect', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Edit draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change status/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Terminal state \(CLOSED\)/i)).toBeInTheDocument();
  });
});
