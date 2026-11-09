import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as requisitionApi from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import * as candidateApi from './candidate.api.js';
import { GlobalCandidatesPage } from './GlobalCandidatesPage.js';
import type { GlobalCandidateSummary, ListGlobalCandidatesResponse } from './types.js';

const mockRequisition: RequisitionRecord = {
  id: 'req-uuid-1',
  clientId: 'client-uuid-1',
  clientName: 'Acme Corp',
  title: 'Staff Backend Engineer',
  jdText: 'Looking for a Staff Backend Engineer.',
  status: 'OPEN',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const mockCandidates: GlobalCandidateSummary[] = [
  {
    candidateId: 'cand-1',
    candidateCode: 'CAN-1111',
    createdAt: '2026-11-05T09:00:00.000Z',
    lastActivityAt: '2026-11-05T12:00:00.000Z',
    requisitionId: 'req-uuid-1',
    requisitionTitle: 'Staff Backend Engineer',
    clientName: 'Acme Corp',
    resumeDocumentId: 'doc-1',
    resumeFileName: 'alice_cv.pdf',
    parseStatus: 'PARSED',
    currentRole: 'Senior Backend Engineer',
    experienceYears: 7,
    location: 'Bangalore',
    skills: ['Node.js', 'PostgreSQL'],
    assessmentId: 'ass-1',
    assessmentStatus: 'COMPLETE',
    overallScore: 88,
    coverage: 0.9,
    isComplete: true,
    criteriaCount: 5,
    criteriaMetCount: 5,
    reviewStatus: 'REVIEWED',
    reviewedAt: '2026-11-05T11:00:00.000Z',
    isShortlisted: true,
    shortlistedAt: '2026-11-05T11:30:00.000Z',
    submissionStatus: 'SUBMITTED',
    submittedAt: '2026-11-05T12:00:00.000Z',
    statusCategory: 'ASSESSED',
  },
  {
    candidateId: 'cand-2',
    candidateCode: 'CAN-2222',
    createdAt: '2026-11-05T08:00:00.000Z',
    lastActivityAt: '2026-11-05T10:00:00.000Z',
    requisitionId: 'req-uuid-1',
    requisitionTitle: 'Staff Backend Engineer',
    clientName: 'Acme Corp',
    resumeDocumentId: 'doc-2',
    resumeFileName: 'bob_cv.docx',
    parseStatus: 'PENDING',
    currentRole: 'Software Engineer',
    experienceYears: 3,
    location: 'Remote',
    skills: ['TypeScript'],
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
    submissionStatus: null,
    submittedAt: null,
    statusCategory: 'AWAITING_ASSESSMENT',
  },
  {
    candidateId: 'cand-3',
    candidateCode: 'CAN-3333',
    createdAt: '2026-11-05T07:00:00.000Z',
    lastActivityAt: '2026-11-05T09:00:00.000Z',
    requisitionId: 'req-uuid-1',
    requisitionTitle: 'Staff Backend Engineer',
    clientName: 'Acme Corp',
    resumeDocumentId: 'doc-3',
    resumeFileName: 'charlie_cv.pdf',
    parseStatus: 'NEEDS_REVIEW',
    currentRole: 'Backend Developer',
    experienceYears: 5,
    location: 'New York',
    skills: ['Go', 'Docker'],
    assessmentId: 'ass-3',
    assessmentStatus: 'NEEDS_REVIEW',
    overallScore: 62,
    coverage: 0.7,
    isComplete: false,
    criteriaCount: 5,
    criteriaMetCount: 3,
    reviewStatus: 'NEEDS_REVIEW',
    reviewedAt: '2026-11-05T08:30:00.000Z',
    isShortlisted: false,
    shortlistedAt: null,
    submissionStatus: null,
    submittedAt: null,
    statusCategory: 'NEEDS_REVIEW',
  },
];

const mockGlobalResponse: ListGlobalCandidatesResponse = {
  items: mockCandidates,
  total: 3,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

function renderGlobalCandidatesPage() {
  return render(
    <MemoryRouter initialEntries={['/candidates']}>
      <Routes>
        <Route path="/candidates" element={<GlobalCandidatesPage />} />
        <Route
          path="/requisitions/:requisitionId/candidates/:candidateId"
          element={<div>Candidate Inspection View</div>}
        />
        <Route path="/requisitions/:requisitionId" element={<div>Requisition Detail View</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GlobalCandidatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(requisitionApi, 'listRequisitions').mockResolvedValue([mockRequisition]);
    vi.spyOn(candidateApi, 'listGlobalCandidates').mockResolvedValue(mockGlobalResponse);
  });

  it('1. renders PageHeader and candidate table with candidates', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Candidate Directory' }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    expect(screen.getByText('CAN-2222')).toBeInTheDocument();
    expect(screen.getByText('CAN-3333')).toBeInTheDocument();

    // Verify verified score badge for assessed candidate
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByText('5/5 criteria met')).toBeInTheDocument();

    // Verify awaiting assessment indicator
    expect(screen.getAllByText('Awaiting assessment').length).toBeGreaterThan(0);

    // Verify needs review indicator
    expect(screen.getAllByText('Review needed').length).toBeGreaterThan(0);
  });

  it('2. filters by search term', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(
      'Search by code, role, skill, or resume name...',
    );
    fireEvent.change(searchInput, { target: { value: 'Senior' } });

    await waitFor(() => {
      expect(candidateApi.listGlobalCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'Senior',
          page: 1,
        }),
      );
    });
  });

  it('3. filters by requisition dropdown', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Filter by requisition');
    fireEvent.change(select, { target: { value: 'req-uuid-1' } });

    await waitFor(() => {
      expect(candidateApi.listGlobalCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          requisitionId: 'req-uuid-1',
          page: 1,
        }),
      );
    });
  });

  it('4. filters by status category tab', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });

    const assessedTab = screen.getByRole('tab', { name: 'Assessed' });
    fireEvent.click(assessedTab);

    await waitFor(() => {
      expect(candidateApi.listGlobalCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCategory: 'ASSESSED',
          page: 1,
        }),
      );
    });
  });

  it('5. changes sorting order', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });

    const sortSelect = screen.getByLabelText('Sort:');
    fireEvent.change(sortSelect, { target: { value: 'score:desc' } });

    await waitFor(() => {
      expect(candidateApi.listGlobalCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: 'score',
          sortOrder: 'desc',
          page: 1,
        }),
      );
    });
  });

  it('6. navigates to candidate inspection view when clicking inspect', async () => {
    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });

    const inspectButtons = screen.getAllByRole('button', { name: /Inspect candidate CAN-1111/i });
    fireEvent.click(inspectButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Candidate Inspection View')).toBeInTheDocument();
    });
  });

  it('7. displays empty state when no candidates match filter and supports clearing filters', async () => {
    vi.spyOn(candidateApi, 'listGlobalCandidates').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    renderGlobalCandidatesPage();

    // Type a search to trigger filtering state
    const searchInput = screen.getByPlaceholderText(
      'Search by code, role, skill, or resume name...',
    );
    fireEvent.change(searchInput, { target: { value: 'Nonexistent' } });

    await waitFor(() => {
      expect(screen.getByText('No candidates match your criteria')).toBeInTheDocument();
    });

    const clearButton = screen.getByRole('button', { name: 'Clear all filters' });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(candidateApi.listGlobalCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          search: undefined,
          requisitionId: undefined,
          statusCategory: undefined,
        }),
      );
    });
  });

  it('8. displays error state and supports retry on fetch error', async () => {
    vi.spyOn(candidateApi, 'listGlobalCandidates').mockRejectedValueOnce(
      new Error('Network error loading candidates'),
    );

    renderGlobalCandidatesPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to load candidate directory')).toBeInTheDocument();
    });

    vi.spyOn(candidateApi, 'listGlobalCandidates').mockResolvedValueOnce(mockGlobalResponse);

    const retryButton = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText('CAN-1111')).toBeInTheDocument();
    });
  });
});
