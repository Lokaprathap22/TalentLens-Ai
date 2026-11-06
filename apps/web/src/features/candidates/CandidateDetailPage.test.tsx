import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as reqApi from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import * as candidateApi from './candidate.api.js';
import { CandidateDetailPage } from './CandidateDetailPage.js';
import type { CandidateDetail } from './types.js';

const REQUISITION_ID = 'req-1111-2222-3333';
const CANDIDATE_ID = 'cand-4444-5555-6666';

const MOCK_DETAIL: CandidateDetail = {
  candidateId: CANDIDATE_ID,
  candidateCode: 'CAN-8A4F1D92',
  requisitionId: REQUISITION_ID,
  requisitionTitle: 'Staff Backend Engineer',
  client: { id: 'client-1', name: 'Acme Corp' },
  resume: {
    id: 'res-1',
    fileName: 'cv.pdf',
    fileType: 'PDF',
    sizeBytes: 1024,
    uploadedAt: '2026-10-25T14:30:00.000Z',
  },
  hasInspectedOriginalResume: false,
  consent: null,
  assessment: null,
  review: null,
  shortlist: null,
  submission: null,
  clientFeedback: [],
};

describe('CandidateDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(reqApi, 'getRequisition').mockResolvedValue({
      id: REQUISITION_ID,
      title: 'Staff Backend Engineer',
      clientName: 'Acme Corp',
      status: 'OPEN',
      department: 'Engineering',
      location: 'Remote',
      assignedRecruiterId: 'rec-1',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    } as unknown as RequisitionRecord);
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(MOCK_DETAIL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders page header, breadcrumbs, back button, and candidate details', async () => {
    render(
      <MemoryRouter initialEntries={[`/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}`]}>
        <Routes>
          <Route
            path="/requisitions/:requisitionId/candidates/:candidateId"
            element={<CandidateDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Candidate Inspection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to candidates/i })).toBeInTheDocument();

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
  });
});
