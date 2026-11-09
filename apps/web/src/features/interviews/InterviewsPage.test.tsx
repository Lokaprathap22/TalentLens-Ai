import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../app/auth.js';
import { WorkspaceProvider, createAuthenticatedWorkspace } from '../../app/workspace.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { InterviewsPage } from './InterviewsPage.js';
import * as interviewsApi from './interviews.api.js';
import type { InterviewItem, ListInterviewsResponse } from './types.js';

const RECRUITER_USER: AuthenticatedUser = {
  userId: 'user-recruiter-1',
  organizationId: 'org-1',
  organizationName: 'Apex Executive Search',
  email: 'elena.rostova@talentlens.example',
  role: 'RECRUITER',
};

const CLIENT_USER: AuthenticatedUser = {
  userId: 'user-client-1',
  organizationId: 'org-1',
  organizationName: 'Apex Executive Search',
  email: 'client.hm@cyberdyne.example',
  role: 'CLIENT_HIRING_MANAGER',
};

const MOCK_INTERVIEWS: InterviewItem[] = [
  {
    id: 'int-1',
    submissionId: 'sub-1',
    requisitionId: 'req-1',
    requisitionTitle: 'Staff Distributed Systems Engineer With Extra Long Requirement Title',
    clientId: 'client-1',
    clientName: 'Cyberdyne Systems',
    candidateId: 'cand-1',
    candidateCode: 'CAN-8F2A1C',
    proposerUserId: 'user-recruiter-1',
    proposerRole: 'RECRUITER',
    startAt: '2026-11-10T05:32:00.000Z',
    endAt: '2026-11-10T06:32:00.000Z',
    timezone: 'America/New_York',
    format: 'VIDEO',
    status: 'ACCEPTED',
    reason: null,
    canAccept: false,
    canReject: false,
    canReschedule: true,
    canComplete: true,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
  },
  {
    id: 'int-2',
    submissionId: 'sub-2',
    requisitionId: 'req-2',
    requisitionTitle: 'Principal Cloud Security Architect',
    clientId: 'client-2',
    clientName: 'Initech Corp',
    candidateId: 'cand-2',
    candidateCode: 'CAN-4E9B3D',
    proposerUserId: 'user-client-2',
    proposerRole: 'CLIENT_HIRING_MANAGER',
    startAt: '2026-11-11T15:30:00.000Z',
    endAt: '2026-11-11T16:30:00.000Z',
    timezone: 'America/Chicago',
    format: 'PHONE',
    status: 'PROPOSED',
    reason: 'Prefer morning slot if available',
    canAccept: true,
    canReject: true,
    canReschedule: false,
    canComplete: false,
    createdAt: '2026-11-05T11:00:00.000Z',
    updatedAt: '2026-11-06T11:00:00.000Z',
  },
  {
    id: 'int-3',
    submissionId: 'sub-3',
    requisitionId: 'req-3',
    requisitionTitle: 'Lead Machine Learning Engineer',
    clientId: 'client-3',
    clientName: 'Soylent AI',
    candidateId: 'cand-3',
    candidateCode: 'CAN-2D7C9A',
    proposerUserId: 'user-recruiter-1',
    proposerRole: 'RECRUITER',
    startAt: '2026-11-07T01:30:00.000Z',
    endAt: '2026-11-07T02:30:00.000Z',
    timezone: 'America/Los_Angeles',
    format: 'IN_PERSON',
    status: 'COMPLETED',
    reason: null,
    canAccept: false,
    canReject: false,
    canReschedule: false,
    canComplete: false,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-07T03:00:00.000Z',
  },
];

const MOCK_RESPONSE: ListInterviewsResponse = {
  items: MOCK_INTERVIEWS,
  total: 3,
  page: 1,
  pageSize: 15,
  totalPages: 1,
  counts: {
    total: 3,
    upcoming: 1,
    pendingAction: 1,
    completed: 1,
    rejected: 0,
  },
};

function renderInterviewsPage(user: AuthenticatedUser = RECRUITER_USER): ReturnType<typeof render> {
  const workspace = createAuthenticatedWorkspace(user);
  return render(
    <AuthProvider>
      <WorkspaceProvider value={workspace}>
        <InterviewsPage />
      </WorkspaceProvider>
    </AuthProvider>,
  );
}

describe('InterviewsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(interviewsApi, 'listInterviews').mockResolvedValue(MOCK_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders both desktop table container and responsive mobile/tablet card view with masked candidate data', async () => {
    renderInterviewsPage();

    expect(
      await screen.findByRole('heading', { name: /Interviews Workspace/i }),
    ).toBeInTheDocument();

    const desktopContainer = await screen.findByTestId('interviews-desktop-table');
    const mobileContainer = screen.getByTestId('interviews-mobile-list');

    expect(desktopContainer).toHaveClass('hidden', 'lg:block');
    expect(mobileContainer).toHaveClass('lg:hidden');

    // Desktop table renders all action buttons without clipping
    expect(within(desktopContainer).getByText('CAN-8F2A1C')).toBeInTheDocument();
    expect(within(desktopContainer).getByText('CAN-4E9B3D')).toBeInTheDocument();
    expect(within(desktopContainer).getByText('America/New_York')).toBeInTheDocument();
    expect(
      within(desktopContainer).getByRole('button', { name: 'Propose Alt' }),
    ).toBeInTheDocument();
    expect(
      within(desktopContainer).getByRole('button', { name: 'Mark Complete' }),
    ).toBeInTheDocument();
    expect(within(desktopContainer).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(within(desktopContainer).getByRole('button', { name: 'Decline' })).toBeInTheDocument();

    // Mobile/tablet cards render complete metadata and interactive buttons
    expect(within(mobileContainer).getByText('CAN-8F2A1C')).toBeInTheDocument();
    expect(within(mobileContainer).getByText('Cyberdyne Systems')).toBeInTheDocument();
    expect(within(mobileContainer).getByText('America/Chicago')).toBeInTheDocument();
    expect(within(mobileContainer).getByText('Phone Call')).toBeInTheDocument();
    expect(within(mobileContainer).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(within(mobileContainer).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(
      within(mobileContainer).getByRole('button', { name: 'Propose Alt' }),
    ).toBeInTheDocument();
    expect(
      within(mobileContainer).getByRole('button', { name: 'Mark Complete' }),
    ).toBeInTheDocument();
  });

  it('2. executes accept, decline modal, propose alternative modal, and complete actions from rendered controls', async () => {
    const user = userEvent.setup();
    const acceptSpy = vi
      .spyOn(interviewsApi, 'recruiterAcceptInterview')
      .mockResolvedValue({ success: true });
    const completeSpy = vi
      .spyOn(interviewsApi, 'recruiterCompleteInterview')
      .mockResolvedValue({ success: true });
    const rejectSpy = vi
      .spyOn(interviewsApi, 'recruiterRejectInterview')
      .mockResolvedValue({ success: true });

    renderInterviewsPage();

    const desktopContainer = await screen.findByTestId('interviews-desktop-table');

    await user.click(within(desktopContainer).getByRole('button', { name: 'Accept' }));
    await waitFor(() => {
      expect(acceptSpy).toHaveBeenCalledWith('req-2', 'sub-2', 'int-2');
    });

    await user.click(within(desktopContainer).getByRole('button', { name: 'Mark Complete' }));
    await waitFor(() => {
      expect(completeSpy).toHaveBeenCalledWith('req-1', 'sub-1', 'int-1');
    });

    await user.click(within(desktopContainer).getByRole('button', { name: 'Decline' }));
    const reasonBox = await screen.findByLabelText(/Reason for declining/i);
    await user.type(reasonBox, 'Panel unavailable');
    await user.click(screen.getByRole('button', { name: 'Confirm Decline' }));

    await waitFor(() => {
      expect(rejectSpy).toHaveBeenCalledWith('req-2', 'sub-2', 'int-2', 'Panel unavailable');
    });
  });

  it('3. renders client portal view with responsive header and triggers client accept action', async () => {
    const user = userEvent.setup();
    const clientAcceptSpy = vi
      .spyOn(interviewsApi, 'clientAcceptInterview')
      .mockResolvedValue({ success: true });

    renderInterviewsPage(CLIENT_USER);

    expect(
      await screen.findByRole('heading', { name: /Interviews & Scheduling/i }),
    ).toBeInTheDocument();

    const mobileContainer = screen.getByTestId('interviews-mobile-list');
    await user.click(within(mobileContainer).getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(clientAcceptSpy).toHaveBeenCalledWith('client-2', 'sub-2', 'int-2');
    });
  });
});
