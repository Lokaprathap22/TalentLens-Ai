import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import { ScorecardCreationDialog } from './ScorecardCreationDialog.js';
import * as scorecardApi from './scorecard.api.js';
import type { ScorecardRecord } from './types.js';

const mockExistingScorecard: ScorecardRecord = {
  id: 'a0000000-0000-4000-8000-000000000001',
  requisitionId: 'b0000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'APPROVED',
  weights: {},
  approvedById: 'user-1',
  approvedAt: '2026-11-05T10:00:00.000Z',
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  criteria: [
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      key: 'skill-ts',
      label: 'TypeScript',
      description: 'Expertise in TypeScript',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 100,
      displayOrder: 1,
      active: true,
      evidence: {
        sourceQuote: 'TypeScript experience',
        sourceStart: 10,
        sourceEnd: 31,
        verificationStatus: 'VERIFIED',
      },
    },
  ],
};

describe('ScorecardCreationDialog', () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const requisitionId = 'b0000000-0000-4000-8000-000000000001';
  const requisitionTitle = 'Senior Full Stack Engineer';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(
      <ScorecardCreationDialog
        open={false}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        onCreated={onCreated}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders creation methods and defaults to AI Assisted mode', () => {
    render(
      <ScorecardCreationDialog
        open={true}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        existingScorecards={[mockExistingScorecard]}
        onCreated={onCreated}
      />,
    );

    expect(screen.getByText('Create Scorecard Version')).toBeInTheDocument();
    expect(screen.getByText('AI Assisted')).toBeInTheDocument();
    expect(screen.getByText('Manual Draft')).toBeInTheDocument();
    expect(screen.getByText('Clone Version')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate draft criteria/i })).toBeInTheDocument();
  });

  it('generates an AI draft when clicking Generate draft criteria', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(scorecardApi, 'createScorecardDraft').mockResolvedValueOnce({
      ...mockExistingScorecard,
      id: 'new-ai-draft-id',
      version: 2,
      status: 'DRAFT',
    });

    render(
      <ScorecardCreationDialog
        open={true}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        onCreated={onCreated}
      />,
    );

    await user.click(screen.getByRole('button', { name: /generate draft criteria/i }));

    expect(createSpy).toHaveBeenCalledWith(requisitionId, { mode: 'ai' });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-ai-draft-id', version: 2 }),
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('switches to Manual mode and creates an empty draft', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(scorecardApi, 'createScorecardDraft').mockResolvedValueOnce({
      ...mockExistingScorecard,
      id: 'new-manual-id',
      version: 2,
      status: 'DRAFT',
      criteria: [],
    });

    render(
      <ScorecardCreationDialog
        open={true}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        onCreated={onCreated}
      />,
    );

    await user.click(screen.getByRole('button', { name: /mode: manual draft/i }));
    expect(screen.getByRole('button', { name: /create empty draft/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create empty draft/i }));

    expect(createSpy).toHaveBeenCalledWith(requisitionId, { mode: 'manual' });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-manual-id' }));
    });
  });

  it('switches to Clone mode and clones from selected version', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(scorecardApi, 'createScorecardDraft').mockResolvedValueOnce({
      ...mockExistingScorecard,
      id: 'new-clone-id',
      version: 2,
      status: 'DRAFT',
    });

    render(
      <ScorecardCreationDialog
        open={true}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        existingScorecards={[mockExistingScorecard]}
        onCreated={onCreated}
      />,
    );

    await user.click(screen.getByRole('button', { name: /mode: clone version/i }));
    expect(screen.getByRole('button', { name: /^clone version$/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^clone version$/i }));

    expect(createSpy).toHaveBeenCalledWith(requisitionId, {
      cloneFromVersionId: mockExistingScorecard.id,
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-clone-id' }));
    });
  });

  it('displays error alert when creation fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'createScorecardDraft').mockRejectedValueOnce(
      new ApiError({
        status: 502,
        code: 'provider_unavailable',
        message: 'Extraction service unavailable',
      }),
    );

    render(
      <ScorecardCreationDialog
        open={true}
        onClose={onClose}
        requisitionId={requisitionId}
        requisitionTitle={requisitionTitle}
        onCreated={onCreated}
      />,
    );

    await user.click(screen.getByRole('button', { name: /generate draft criteria/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(
        screen.getByText(/the ai requirement extraction provider is currently unreachable/i),
      ).toBeInTheDocument();
      expect(onCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
