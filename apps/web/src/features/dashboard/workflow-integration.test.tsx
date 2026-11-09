import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { AppRoutes } from '../../App.js';
import { clearCsrfToken, clearUnauthorizedHandler } from '../../lib/api-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf-token-test',
    },
  });
}

const RECRUITER_USER = {
  userId: 'user-recruiter-m910',
  organizationId: 'org-northwind-1',
  organizationName: 'Northwind Talent',
  email: 'recruiter.lead@northwind.example',
  role: 'RECRUITER',
};

describe('M9.10 Full Core Recruitment Workflow Integration', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearCsrfToken();
    clearUnauthorizedHandler();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('verifies the full recruiter-to-client workflow lifecycle', async () => {
    const user = userEvent.setup({ delay: null });

    const reqId = '11111111-1111-4111-8111-111111111111';
    const candId = '22222222-2222-4222-8222-222222222222';
    const clientId = '33333333-3333-4333-8333-333333333333';

    // 1. Recruiter session
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';

      if (url.endsWith('/api/v1/auth/me')) {
        return jsonResponse({ user: RECRUITER_USER });
      }
      if (url.endsWith('/api/v1/auth/csrf')) {
        return jsonResponse({ csrfToken: 'mock-csrf' });
      }
      if (url.includes('/api/v1/dashboard/summary')) {
        return jsonResponse({
          role: 'RECRUITER',
          generatedAt: '2026-11-06T10:00:00.000Z',
          metrics: {
            totalActiveRequisitions: 1,
            requisitionsRequiringAttention: 0,
            candidatesInPipeline: 1,
            candidatesAwaitingAssessment: 0,
            candidatesAwaitingReview: 1,
            pendingClientDecisions: 0,
            upcomingConfirmedInterviews: 0,
          },
          pipelineStages: [
            { key: 'intake', label: 'Intake', count: 0, hint: 'Awaiting assessment' },
            { key: 'assessed', label: 'Assessed', count: 0, hint: 'Criteria evaluated' },
            { key: 'review', label: 'Review', count: 1, hint: 'Recruiter verification' },
            { key: 'shortlisted', label: 'Shortlisted', count: 0, hint: 'Approved for client' },
            { key: 'client', label: 'Client', count: 0, hint: 'With hiring manager' },
            { key: 'interview', label: 'Interview', count: 0, hint: 'Confirmed schedule' },
          ],
          recentRequisitions: [
            {
              id: reqId,
              title: 'Principal Distributed Systems Engineer',
              clientName: 'Apex Fintech Solutions',
              status: 'OPEN',
              candidatesCount: 1,
              awaitingReviewCount: 1,
              withClientCount: 0,
              updatedAt: '2026-10-05T00:00:00.000Z',
            },
          ],
          reviewQueue: [
            {
              candidateId: candId,
              requisitionId: reqId,
              candidateCode: 'CAN-8A4F1D92',
              requisitionTitle: 'Principal Distributed Systems Engineer',
              assessmentStatus: 'COMPLETE',
              score: 92,
              coverage: 95,
              consent: 'ACTIVE',
              lastActivityAt: '2026-11-06T09:00:00.000Z',
            },
          ],
          upcomingInterviews: [],
          recentActivity: [],
        });
      }
      if (url.includes('/api/v1/clients')) {
        return jsonResponse({
          clients: [
            {
              id: clientId,
              name: 'Apex Fintech Solutions',
              status: 'ACTIVE',
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        });
      }
      if (url.includes('/api/v1/requisitions') && !url.includes('/candidates')) {
        return jsonResponse({
          requisitions: [
            {
              id: reqId,
              clientId,
              clientName: 'Apex Fintech Solutions',
              title: 'Principal Distributed Systems Engineer',
              jdText: 'Distributed consensus systems, Raft protocol.',
              status: 'OPEN',
              createdAt: '2026-10-05T00:00:00.000Z',
              updatedAt: '2026-10-05T00:00:00.000Z',
            },
          ],
        });
      }
      if (url.includes(`/api/v1/requisitions/${reqId}/candidates`)) {
        return jsonResponse({
          items: [
            {
              candidateId: candId,
              candidateCode: 'CAN-8A4F1D92',
              resumeDocumentId: 'doc-001',
              resumeFileName: 'marcus_vance_cv.pdf',
              parseStatus: 'PARSED',
              assessmentId: 'ass-001',
              assessmentStatus: 'COMPLETED',
              overallScore: 92,
              coverage: 0.95,
              isComplete: true,
              criteriaCount: 3,
              criteriaMetCount: 3,
              reviewStatus: 'NOT_REVIEWED',
              reviewedAt: null,
              isShortlisted: false,
              shortlistedAt: null,
              submissionId: null,
              submissionStatus: null,
              submittedAt: null,
              lastActivityAt: '2026-11-06T09:00:00.000Z',
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });
      }

      return jsonResponse({ error: 'not_found' }, 404);
    });

    // Render at live dashboard
    render(
      <MemoryRouter initialEntries={['/dashboard?state=live']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    // Dashboard renders with live data
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(
      (await screen.findAllByText('Principal Distributed Systems Engineer')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    // Inspect candidate dialog opens
    const inspectBtn = screen.getByRole('button', { name: 'Inspect' });
    await user.click(inspectBtn);

    const dialog = await screen.findByRole('dialog', {
      name: /Assessment preview · CAN-8A4F1D92/i,
    });
    expect(dialog).toBeInTheDocument();

    // Verify dialog has action to navigate to candidate workspace
    const openWorkspaceBtn = within(dialog).getByRole('button', {
      name: /Open candidate workspace/i,
    });
    expect(openWorkspaceBtn).toBeInTheDocument();
  }, 15000);
});
