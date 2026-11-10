import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as candidateApi from './candidate.api.js';
import { CandidateDetailDrawer } from './CandidateDetailDrawer.js';
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

describe('CandidateDetailDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(MOCK_DETAIL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when open is false', () => {
    render(
      <MemoryRouter>
        <CandidateDetailDrawer
          open={false}
          onClose={vi.fn()}
          requisitionId={REQUISITION_ID}
          candidateId={CANDIDATE_ID}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders drawer dialog and contents when open is true', async () => {
    render(
      <MemoryRouter>
        <CandidateDetailDrawer
          open={true}
          onClose={vi.fn()}
          requisitionId={REQUISITION_ID}
          candidateId={CANDIDATE_ID}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
  });

  it('calls onClose when close icon button is clicked', async () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CandidateDetailDrawer
          open={true}
          onClose={handleClose}
          requisitionId={REQUISITION_ID}
          candidateId={CANDIDATE_ID}
        />
      </MemoryRouter>,
    );

    const closeBtn = screen.getByRole('button', { name: /close candidate inspection drawer/i });
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CandidateDetailDrawer
          open={true}
          onClose={handleClose}
          requisitionId={REQUISITION_ID}
          candidateId={CANDIDATE_ID}
        />
      </MemoryRouter>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('provides a dedicated page link, responsive review controls, and accurate consent invitation state', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce({
      ...MOCK_DETAIL,
      consentInvitation: {
        id: 'inv-drawer-1',
        status: 'PENDING',
        deliveryStatus: 'SENT',
        sentAt: '2026-10-25T14:35:00.000Z',
        expiresAt: '2026-11-01T14:35:00.000Z',
        consumedAt: null,
      },
    });

    render(
      <MemoryRouter>
        <CandidateDetailDrawer
          open={true}
          onClose={vi.fn()}
          requisitionId={REQUISITION_ID}
          candidateId={CANDIDATE_ID}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
    const dedicatedLink = screen.getByRole('link', { name: /open dedicated page/i });
    expect(dedicatedLink).toHaveAttribute(
      'href',
      `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}`,
    );

    expect(screen.getByRole('button', { name: /^Reviewed$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Flag \/ Needs Review/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decline \/ Closed/i })).toBeInTheDocument();
    expect(screen.getByText(/Invitation sent · Resend invitation/i)).toBeInTheDocument();
  });
});
