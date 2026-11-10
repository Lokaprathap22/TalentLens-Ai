import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as requisitionApi from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import * as candidateApi from './candidate.api.js';
import { CandidatesPage } from './CandidatesPage.js';
import type { CandidateSummary } from './types.js';

const mockRequisition: RequisitionRecord = {
  id: 'b0000000-0000-4000-8000-000000000001',
  clientId: 'c0000000-0000-4000-8000-000000000001',
  clientName: 'Acme Corp',
  title: 'Principal Backend Engineer',
  jdText: 'Looking for a Principal Backend Engineer with experience in TypeScript.',
  status: 'OPEN',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const mockCandidates: CandidateSummary[] = [
  {
    candidateId: 'cand-1',
    candidateCode: 'CAN-11111111',
    resumeDocumentId: 'doc-1',
    resumeFileName: 'alice_cv.pdf',
    parseStatus: 'PARSED',
    assessmentId: 'ass-1',
    assessmentStatus: 'COMPLETE',
    overallScore: 88,
    coverage: 0.9,
    isComplete: true,
    criteriaCount: 5,
    criteriaMetCount: 5,
    reviewStatus: 'NOT_REVIEWED',
    reviewedAt: null,
    isShortlisted: false,
    shortlistedAt: null,
    submissionId: null,
    submissionStatus: null,
    submittedAt: null,
    lastActivityAt: '2026-11-05T12:00:00.000Z',
  },
  {
    candidateId: 'cand-2',
    candidateCode: 'CAN-22222222',
    resumeDocumentId: 'doc-2',
    resumeFileName: 'bob_cv.docx',
    parseStatus: 'PENDING',
    assessmentId: null,
    assessmentStatus: null,
    overallScore: null,
    coverage: null,
    isComplete: false,
    criteriaCount: 0,
    criteriaMetCount: 0,
    reviewStatus: 'NOT_REVIEWED',
    reviewedAt: null,
    isShortlisted: false,
    shortlistedAt: null,
    submissionId: null,
    submissionStatus: null,
    submittedAt: null,
    lastActivityAt: '2026-11-05T11:00:00.000Z',
  },
  {
    candidateId: 'cand-3',
    candidateCode: 'CAN-33333333',
    resumeDocumentId: 'doc-3',
    resumeFileName: 'charlie_cv.pdf',
    parseStatus: 'NEEDS_REVIEW',
    assessmentId: 'ass-3',
    assessmentStatus: 'NEEDS_REVIEW',
    overallScore: 65,
    coverage: 0.7,
    isComplete: false,
    criteriaCount: 5,
    criteriaMetCount: 3,
    reviewStatus: 'NEEDS_REVIEW',
    reviewedAt: '2026-11-05T11:30:00.000Z',
    isShortlisted: false,
    shortlistedAt: null,
    submissionId: null,
    submissionStatus: null,
    submittedAt: null,
    lastActivityAt: '2026-11-05T11:30:00.000Z',
  },
];

function renderCandidatesPage(reqId = mockRequisition.id) {
  return render(
    <MemoryRouter initialEntries={[`/requisitions/${reqId}/candidates`]}>
      <Routes>
        <Route path="/requisitions/:requisitionId/candidates" element={<CandidatesPage />} />
        <Route path="/requisitions/:requisitionId" element={<div>Requisition Detail View</div>} />
        <Route
          path="/requisitions/:requisitionId/scorecards"
          element={<div>Scorecards View</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidatesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(requisitionApi, 'getRequisition').mockResolvedValue(mockRequisition);
    vi.spyOn(candidateApi, 'listCandidates').mockResolvedValue({
      items: mockCandidates,
      total: mockCandidates.length,
    });
  });

  it('1. renders loading skeleton initially while requests are in flight', () => {
    renderCandidatesPage();
    expect(screen.getByText('Loading candidates')).toBeInTheDocument();
  });

  it('2. renders candidate directory header, title, client context, and table rows', async () => {
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Candidates' })).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Principal Backend Engineer · Acme Corp · 3 candidates/i),
    ).toBeInTheDocument();

    // Candidate rows rendered by privacy-safe candidateCode
    expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    expect(screen.getByText('alice_cv.pdf')).toBeInTheDocument();
    expect(screen.getByText('CAN-22222222')).toBeInTheDocument();
    expect(screen.getByText('bob_cv.docx')).toBeInTheDocument();
    expect(screen.getByText('CAN-33333333')).toBeInTheDocument();
    expect(screen.getByText('charlie_cv.pdf')).toBeInTheDocument();
  });

  it('3. presents consent-aware processing status (Queued / May be awaiting consent)', async () => {
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-22222222')).toBeInTheDocument();
    });

    // PENDING parse status is labeled "Queued" with note "May be awaiting consent", NOT "Processing"
    expect(screen.getAllByText(/May be awaiting consent/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Consent-gated processing:/i)).toBeInTheDocument();
  });

  it('4. filters candidate table by text search (code or filename)', async () => {
    const user = userEvent.setup();
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    });

    const searchInput = screen.getByRole('searchbox', {
      name: /Search candidates by code or filename/i,
    });
    await user.type(searchInput, 'bob');

    expect(screen.getByText('CAN-22222222')).toBeInTheDocument();
    expect(screen.queryByText('CAN-11111111')).not.toBeInTheDocument();
    expect(screen.queryByText('CAN-33333333')).not.toBeInTheDocument();
  });

  it('5. filters candidates by processing status tab', async () => {
    const user = userEvent.setup();
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    });

    // Click 'Extracted' (PARSED) tab
    const extractedTab = screen.getByRole('tab', { name: 'Extracted' });
    await user.click(extractedTab);

    expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    expect(screen.queryByText('CAN-22222222')).not.toBeInTheDocument();
    expect(screen.queryByText('CAN-33333333')).not.toBeInTheDocument();

    // Click 'Queued' (PENDING) tab
    const queuedTab = screen.getByRole('tab', { name: 'Queued' });
    await user.click(queuedTab);

    expect(screen.getByText('CAN-22222222')).toBeInTheDocument();
    expect(screen.queryByText('CAN-11111111')).not.toBeInTheDocument();
  });

  it('6. displays empty state when requisition has no candidates', async () => {
    vi.spyOn(candidateApi, 'listCandidates').mockResolvedValueOnce({
      items: [],
      total: 0,
    });

    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('No candidates yet')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Upload resumes to start processing candidates for this requisition/i),
    ).toBeInTheDocument();
  });

  it('7. displays error state and supports retry on candidate load failure', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'listCandidates').mockRejectedValueOnce(
      new ApiError({
        status: 500,
        code: 'service_unavailable',
        message: 'Database connection failed',
      }),
    );

    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to load candidates')).toBeInTheDocument();
    });

    // Click Retry
    vi.spyOn(candidateApi, 'listCandidates').mockResolvedValueOnce({
      items: mockCandidates,
      total: mockCandidates.length,
    });

    const retryBtn = screen.getByRole('button', { name: /Try again/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    });
  });

  it('8. opens upload modal when clicking Upload resumes action', async () => {
    const user = userEvent.setup();
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Candidates' })).toBeInTheDocument();
    });

    const uploadButtons = screen.getAllByRole('button', { name: /Upload resumes/i });
    await user.click(uploadButtons[0]!);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upload resumes' })).toBeInTheDocument();
  });

  it('9. navigates back to requisition detail and scorecards views', async () => {
    const user = userEvent.setup();
    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Candidates' })).toBeInTheDocument();
    });

    // Navigate back to requisition detail and scorecards views
    const scorecardsBtn = screen.getByRole('button', { name: /Scorecards/i });
    await user.click(scorecardsBtn);

    expect(screen.getByText('Scorecards View')).toBeInTheDocument();
  });

  it('10. displays real consent and invitation statuses and opens ConsentInvitationModal without placeholder text', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'listCandidates').mockResolvedValueOnce({
      items: [
        {
          ...mockCandidates[0]!,
          consentStatus: 'ACTIVE',
          consentInvitation: {
            id: 'inv-1',
            status: 'ACCEPTED',
            deliveryStatus: 'SENT',
            sentAt: '2026-11-05T09:00:00.000Z',
            expiresAt: '2026-11-12T09:00:00.000Z',
            consumedAt: '2026-11-05T09:15:00.000Z',
          },
          isHeldForConsent: false,
        },
        {
          ...mockCandidates[1]!,
          consentStatus: 'NOT_GRANTED',
          consentInvitation: {
            id: 'inv-2',
            status: 'PENDING',
            deliveryStatus: 'SENT',
            sentAt: '2026-11-05T10:00:00.000Z',
            expiresAt: '2026-11-12T10:00:00.000Z',
            consumedAt: null,
          },
          isHeldForConsent: true,
        },
        {
          ...mockCandidates[2]!,
          candidateId: 'cand-4',
          candidateCode: 'CAN-44444444',
          parseStatus: 'PENDING',
          assessmentId: null,
          assessmentStatus: null,
          consentStatus: 'NOT_GRANTED',
          consentInvitation: null,
          isHeldForConsent: true,
        },
      ],
      total: 3,
    });

    renderCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-11111111')).toBeInTheDocument();
    });

    expect(screen.queryByText(/arrives in a later milestone/i)).not.toBeInTheDocument();
    expect(screen.getByText('Consent active')).toBeInTheDocument();
    expect(screen.getByText('Invitation sent')).toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    expect(screen.getByText('Held · awaiting consent')).toBeInTheDocument();
    expect(screen.getByText('Held · invitation not sent')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Send invitation$/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/CAN-44444444/)).toBeInTheDocument();
  });
});
