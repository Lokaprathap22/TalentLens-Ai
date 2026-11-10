import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { DashboardPage } from './DashboardPage.js';
import { useDashboardData } from './use-dashboard-data.js';
import { useAuthOptional } from '../../app/auth.js';
import type { ClientDashboardData, RecruiterDashboardData } from './types.js';

vi.mock('./use-dashboard-data.js', () => ({
  useDashboardData: vi.fn(),
}));

vi.mock('../../app/auth.js', () => ({
  useAuthOptional: vi.fn(),
}));

describe('DashboardPage Component', () => {
  const mockLogout = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogout.mockReset();
  });

  const mockRecruiterData: RecruiterDashboardData = {
    role: 'RECRUITER',
    generatedAt: '2026-11-08T12:00:00.000Z',
    metrics: {
      totalActiveRequisitions: 3,
      requisitionsRequiringAttention: 1,
      candidatesInPipeline: 18,
      candidatesAwaitingAssessment: 2,
      candidatesAwaitingReview: 5,
      pendingClientDecisions: 2,
      upcomingConfirmedInterviews: 1,
    },
    pipeline: [
      { key: 'intake', label: 'Intake', count: 2, hint: 'Awaiting assessment' },
      { key: 'assessed', label: 'Assessed', count: 4, hint: 'Criteria evaluated' },
      { key: 'review', label: 'Review', count: 5, hint: 'Recruiter verification' },
      { key: 'shortlisted', label: 'Shortlisted', count: 4, hint: 'Approved for client' },
      { key: 'client', label: 'Client', count: 2, hint: 'With hiring manager' },
      { key: 'interview', label: 'Interview', count: 1, hint: 'Confirmed schedule' },
    ],
    reviewQueue: [
      {
        candidateId: 'cand-rec-1',
        requisitionId: 'req-rec-1',
        candidateCode: 'CAN-8A4F1D',
        requisitionTitle: 'Staff Backend Architect',
        assessmentStatus: 'COMPLETE',
        score: 91,
        coverage: 95,
        consent: 'ACTIVE',
        lastActivityAt: '2026-11-08T10:00:00.000Z',
      },
    ],
    requisitions: [
      {
        id: 'req-rec-1',
        title: 'Staff Backend Architect',
        clientName: 'Apex Innovations',
        status: 'OPEN',
        candidates: 8,
        awaitingReview: 3,
        withClient: 1,
      },
    ],
    interviews: [
      {
        id: 'int-rec-1',
        candidateCode: 'CAN-8A4F1D',
        requisitionTitle: 'Staff Backend Architect',
        startAt: '2026-11-10T14:00:00.000Z',
        endAt: '2026-11-10T15:00:00.000Z',
        timeZone: 'America/New_York',
        format: 'VIDEO',
        status: 'ACCEPTED',
      },
    ],
    activity: [
      {
        id: 'act-rec-1',
        kind: 'review_recorded',
        summary: 'Recruiter reviewed candidate CAN-8A4F1D',
        actor: 'Sarah Recruiter',
        createdAt: '2026-11-08T10:00:00.000Z',
      },
    ],
  };

  const mockClientData: ClientDashboardData = {
    role: 'CLIENT_HIRING_MANAGER',
    generatedAt: '2026-11-08T12:00:00.000Z',
    metrics: {
      pendingCandidateReviews: 2,
      submittedAwaitingDecisions: 2,
      upcomingConfirmedInterviews: 1,
      recentDecisionsCount: 3,
      activeRequisitionsCount: 1,
    },
    pendingReviews: [
      {
        submissionId: 'sub-cli-1',
        candidateCode: 'CAN-7B3E2C',
        requisitionId: 'req-cli-1',
        requisitionTitle: 'Senior Infrastructure Engineer',
        clientId: 'cli-1',
        clientName: 'Client 1',
        submittedAt: '2026-11-07T15:00:00.000Z',
        status: 'SUBMITTED',
        criteriaCount: 4,
        advisoryScore: 89,
      },
    ],
    upcomingInterviews: [
      {
        id: 'int-cli-1',
        candidateCode: 'CAN-7B3E2C',
        requisitionTitle: 'Senior Infrastructure Engineer',
        startAt: '2026-11-11T16:00:00.000Z',
        endAt: '2026-11-11T17:00:00.000Z',
        timeZone: 'Europe/London',
        format: 'VIDEO',
        status: 'ACCEPTED',
      },
    ],
    recentDecisions: [
      {
        id: 'dec-cli-1',
        candidateCode: 'CAN-6C2D1B',
        requisitionTitle: 'Senior Infrastructure Engineer',
        decision: 'SHORTLIST',
        reason: 'Exceptional system design experience',
        createdAt: '2026-11-06T14:00:00.000Z',
      },
    ],
    activeRequisitions: [
      {
        id: 'req-cli-1',
        title: 'Senior Infrastructure Engineer',
        clientId: 'cli-1',
        clientName: 'Client 1',
        status: 'OPEN',
        activeSubmissionsCount: 2,
        interviewsCount: 1,
      },
    ],
    activity: [
      {
        id: 'act-cli-1',
        kind: 'submitted',
        summary: 'Candidate CAN-7B3E2C submitted for review',
        actor: 'Talent Acquisition',
        createdAt: '2026-11-07T15:00:00.000Z',
      },
    ],
  };

  it('renders loading skeleton when state is loading', () => {
    vi.mocked(useAuthOptional).mockReturnValue({
      state: {
        status: 'authenticated',
        user: {
          userId: 'u1',
          organizationId: 'o1',
          organizationName: 'Org',
          email: 'recruiter@example.com',
          role: 'RECRUITER',
        },
      },
      isInitializing: false,
      isLoggingOut: false,
      logoutError: null,
      clearLogoutError: vi.fn(),
      login: vi.fn(),
      logout: mockLogout,
      retryInitialization: vi.fn(),
      updateUser: vi.fn(),
    });

    vi.mocked(useDashboardData).mockReturnValue({
      state: { status: 'loading' },
      isSample: false,
      reload: vi.fn(),
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading dashboard')).toBeInTheDocument();
  });

  it('renders error state with retry button when summary retrieval fails', async () => {
    const reloadMock = vi.fn();
    const user = userEvent.setup();

    vi.mocked(useAuthOptional).mockReturnValue({
      state: {
        status: 'authenticated',
        user: {
          userId: 'u1',
          organizationId: 'o1',
          organizationName: 'Org',
          email: 'recruiter@example.com',
          role: 'RECRUITER',
        },
      },
      isInitializing: false,
      isLoggingOut: false,
      logoutError: null,
      clearLogoutError: vi.fn(),
      login: vi.fn(),
      logout: mockLogout,
      retryInitialization: vi.fn(),
      updateUser: vi.fn(),
    });

    vi.mocked(useDashboardData).mockReturnValue({
      state: { status: 'error' },
      isSample: false,
      reload: reloadMock,
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Unable to load dashboard workspace')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Try again/i });
    await user.click(retryBtn);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('renders full recruiter dashboard with operational metrics, review queue, requisitions, and interviews', async () => {
    const user = userEvent.setup();

    vi.mocked(useAuthOptional).mockReturnValue({
      state: {
        status: 'authenticated',
        user: {
          userId: 'u1',
          organizationId: 'o1',
          organizationName: 'Org',
          email: 'recruiter@example.com',
          role: 'RECRUITER',
        },
      },
      isInitializing: false,
      isLoggingOut: false,
      logoutError: null,
      clearLogoutError: vi.fn(),
      login: vi.fn(),
      logout: mockLogout,
      retryInitialization: vi.fn(),
      updateUser: vi.fn(),
    });

    vi.mocked(useDashboardData).mockReturnValue({
      state: { status: 'ready', data: mockRecruiterData },
      isSample: false,
      reload: vi.fn(),
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Page header
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();

    // Operational metrics strip
    expect(screen.getAllByText('Active requisitions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In pipeline').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();

    // Hiring pipeline overview
    expect(screen.getByText('Hiring pipeline')).toBeInTheDocument();

    // Candidate review queue
    expect(screen.getByText('Candidate review queue')).toBeInTheDocument();
    expect(screen.getAllByText('CAN-8A4F1D').length).toBeGreaterThanOrEqual(1);

    // Requisition link
    const reqLink = screen.getByRole('link', { name: 'Staff Backend Architect' });
    expect(reqLink).toHaveAttribute('href', '/requisitions/req-rec-1');

    // Upcoming interviews
    expect(screen.getAllByText('Upcoming interviews').length).toBeGreaterThanOrEqual(1);

    // Inspect candidate dialog opens
    const inspectBtn = screen.getByRole('button', { name: 'Inspect' });
    await user.click(inspectBtn);

    const dialog = screen.getByRole('dialog', { name: /Assessment preview · CAN-8A4F1D/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/No automated rejection/i)).toBeInTheDocument();
  });

  it('renders dedicated client hiring manager dashboard with client navigation and review actions', async () => {
    const user = userEvent.setup();

    vi.mocked(useAuthOptional).mockReturnValue({
      state: {
        status: 'authenticated',
        user: {
          userId: 'u2',
          organizationId: 'o1',
          organizationName: 'Org',
          email: 'hiring.manager@client.example',
          role: 'CLIENT_HIRING_MANAGER',
        },
      },
      isInitializing: false,
      isLoggingOut: false,
      logoutError: null,
      clearLogoutError: vi.fn(),
      login: vi.fn(),
      logout: mockLogout,
      retryInitialization: vi.fn(),
      updateUser: vi.fn(),
    });

    vi.mocked(useDashboardData).mockReturnValue({
      state: { status: 'ready', data: mockClientData },
      isSample: false,
      reload: vi.fn(),
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Client portal header
    expect(screen.getByText('Client Portal')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Client Portal Sections' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Submissions' })).toHaveAttribute(
      'href',
      '/client-portal',
    );
    expect(within(nav).getByRole('link', { name: 'Interviews' })).toHaveAttribute(
      'href',
      '/interviews',
    );

    // Title
    expect(screen.getByRole('heading', { name: 'Client Dashboard', level: 1 })).toBeInTheDocument();

    // Client metrics strip
    expect(screen.getByText('Awaiting your review')).toBeInTheDocument();
    expect(screen.getAllByText('Active positions').length).toBeGreaterThanOrEqual(1);

    // Pending review submission row
    expect(screen.getAllByText('CAN-7B3E2C').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('89')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review submission' })).toBeInTheDocument();

    // Recent decision
    expect(screen.getAllByText('Recent decisions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('CAN-6C2D1B')).toBeInTheDocument();
    expect(screen.getByText(/Exceptional system design experience/i)).toBeInTheDocument();

    // Sign out button
    const signOutBtn = screen.getByRole('button', { name: /Sign out/i });
    await user.click(signOutBtn);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('renders Recent workflow activity inside a bounded scrollable feed with event count and wrapped descriptions', () => {
    const longDescription =
      'Consent withdrawn and downstream automated assessment paused for candidate CAN-99887766 across requisition Principal Distributed Systems Architect with extended audit context';
    const manyEvents = [
      {
        id: 'act-latest',
        kind: 'consent_withdrawn' as const,
        summary: longDescription,
        actor: 'Candidate Self-Service Portal',
        createdAt: '2026-11-07T16:55:00.000Z',
      },
      ...Array.from({ length: 12 }, (_, idx) => ({
        id: `act-${idx + 1}`,
        kind: 'review_recorded' as const,
        summary: `Audit event #${idx + 1} recorded`,
        actor: 'Alex Morgan',
        createdAt: `2026-11-07T15:${String(50 - idx).padStart(2, '0')}:00.000Z`,
      })),
    ];

    vi.mocked(useAuthOptional).mockReturnValue({
      state: {
        status: 'authenticated',
        user: {
          userId: 'u1',
          organizationId: 'o1',
          organizationName: 'Org',
          email: 'recruiter@example.com',
          role: 'RECRUITER',
        },
      },
      isInitializing: false,
      isLoggingOut: false,
      logoutError: null,
      clearLogoutError: vi.fn(),
      login: vi.fn(),
      logout: mockLogout,
      retryInitialization: vi.fn(),
      updateUser: vi.fn(),
    });

    vi.mocked(useDashboardData).mockReturnValue({
      state: {
        status: 'ready',
        data: {
          ...mockRecruiterData,
          activity: manyEvents,
        },
      },
      isSample: false,
      reload: vi.fn(),
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('13 events')).toBeInTheDocument();
    const scrollRegion = screen.getByLabelText('Recent workflow activity feed');
    expect(scrollRegion).toHaveClass('overflow-y-auto');
    expect(within(scrollRegion).getByText(longDescription)).toBeInTheDocument();
    expect(within(scrollRegion).getByText('Audit event #12 recorded')).toBeInTheDocument();
  });
});
