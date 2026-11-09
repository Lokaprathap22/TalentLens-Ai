import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as requisitionApi from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import { ScorecardsPage } from './ScorecardsPage.js';
import * as scorecardApi from './scorecard.api.js';
import type { ScorecardRecord } from './types.js';

const mockRequisition: RequisitionRecord = {
  id: 'b0000000-0000-4000-8000-000000000001',
  clientId: 'c0000000-0000-4000-8000-000000000001',
  clientName: 'Acme Corp',
  title: 'Principal Backend Engineer',
  jdText:
    'Looking for a Principal Backend Engineer with 7+ years of experience in distributed systems.',
  status: 'DRAFT',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const mockApprovedScorecard: ScorecardRecord = {
  id: 'a0000000-0000-4000-8000-000000000001',
  requisitionId: mockRequisition.id,
  version: 1,
  status: 'APPROVED',
  weights: {},
  approvedById: 'user-recruiter-1',
  approvedAt: '2026-11-05T10:00:00.000Z',
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  criteria: [
    {
      id: 'crit-1',
      key: 'distributed-systems',
      label: 'Distributed Systems',
      description: 'Experience with microservices and messaging.',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      displayOrder: 1,
      active: true,
      evidence: {
        sourceQuote: 'distributed systems',
        sourceStart: 50,
        sourceEnd: 69,
        verificationStatus: 'VERIFIED',
      },
    },
    {
      id: 'crit-2',
      key: 'experience-years',
      label: '7+ Years Experience',
      description: 'Senior industry track record.',
      category: 'EXPERIENCE',
      requirementType: 'PREFERRED',
      weight: 40,
      displayOrder: 2,
      active: true,
      evidence: {
        sourceQuote: '7+ years of experience',
        sourceStart: 25,
        sourceEnd: 47,
        verificationStatus: 'VERIFIED',
      },
    },
  ],
};

const mockDraftScorecard: ScorecardRecord = {
  id: 'a0000000-0000-4000-8000-000000000002',
  requisitionId: mockRequisition.id,
  version: 2,
  status: 'DRAFT',
  weights: {},
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-11-05T11:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
  criteria: [],
};

function renderScorecardsPage(reqId = mockRequisition.id) {
  return render(
    <MemoryRouter initialEntries={[`/requisitions/${reqId}/scorecards`]}>
      <Routes>
        <Route path="/requisitions/:requisitionId/scorecards" element={<ScorecardsPage />} />
        <Route
          path="/requisitions/:requisitionId/scorecards/:versionId"
          element={<div>Scorecard Detail View</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ScorecardsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(requisitionApi, 'getRequisition').mockResolvedValue(mockRequisition);
  });

  it('renders loading state initially', () => {
    vi.spyOn(scorecardApi, 'listScorecards').mockImplementation(() => new Promise(() => {}));

    renderScorecardsPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders error state when scorecard listing fails', async () => {
    vi.spyOn(scorecardApi, 'listScorecards').mockRejectedValueOnce(new Error('Network error'));

    renderScorecardsPage();

    await waitFor(() => {
      expect(screen.getByText('Unable to load scorecards')).toBeInTheDocument();
    });
  });

  it('renders empty state when no scorecards exist', async () => {
    vi.spyOn(scorecardApi, 'listScorecards').mockResolvedValueOnce([]);

    renderScorecardsPage();

    await waitFor(() => {
      expect(screen.getByText('No scorecards created yet')).toBeInTheDocument();
      expect(screen.getByText('No approved scorecard yet')).toBeInTheDocument();
    });
  });

  it('renders active approved scorecard banner and version history table', async () => {
    vi.spyOn(scorecardApi, 'listScorecards').mockResolvedValueOnce([
      mockDraftScorecard,
      mockApprovedScorecard,
    ]);

    renderScorecardsPage();

    await waitFor(() => {
      expect(screen.getByText(/Active Approved Scorecard \(Version 1\)/i)).toBeInTheDocument();
      expect(screen.getByText('Version 1')).toBeInTheDocument();
      expect(screen.getByText('Version 2')).toBeInTheDocument();
    });
  });

  it('opens creation dialog when clicking New scorecard version', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'listScorecards').mockResolvedValueOnce([mockApprovedScorecard]);

    renderScorecardsPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new scorecard version/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new scorecard version/i }));

    expect(screen.getByText('Create Scorecard Version')).toBeInTheDocument();
  });
});
