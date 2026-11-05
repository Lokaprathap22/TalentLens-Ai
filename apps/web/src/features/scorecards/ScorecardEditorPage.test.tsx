import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as requisitionApi from '../requisitions/requisition.api.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import { ScorecardEditorPage } from './ScorecardEditorPage.js';
import * as scorecardApi from './scorecard.api.js';
import type { ScorecardRecord } from './types.js';

const mockRequisition: RequisitionRecord = {
  id: 'b0000000-0000-4000-8000-000000000001',
  clientId: 'c0000000-0000-4000-8000-000000000001',
  clientName: 'TechCorp',
  title: 'Staff Systems Architect',
  jdText:
    'Looking for a Staff Systems Architect with expertise in Kubernetes and Cloud infrastructure.',
  status: 'DRAFT',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const mockDraftScorecard: ScorecardRecord = {
  id: 'a0000000-0000-4000-8000-000000000001',
  requisitionId: mockRequisition.id,
  version: 1,
  status: 'DRAFT',
  weights: {},
  approvedById: null,
  approvedAt: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  criteria: [
    {
      id: 'crit-k8s',
      key: 'kubernetes',
      label: 'Kubernetes Architecture',
      description: 'Hands-on production cluster design',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      displayOrder: 1,
      active: true,
      evidence: {
        sourceQuote: 'Kubernetes and Cloud infrastructure',
        sourceStart: 57,
        sourceEnd: 93,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
    {
      id: 'crit-cloud',
      key: 'cloud-infra',
      label: 'Cloud Infrastructure',
      description: 'Multi-region VPC deployment',
      category: 'EXPERIENCE',
      requirementType: 'PREFERRED',
      weight: 40,
      displayOrder: 2,
      active: true,
      evidence: {
        sourceQuote: 'Cloud infrastructure',
        sourceStart: 73,
        sourceEnd: 93,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
};

const mockVerifiedDraftScorecard: ScorecardRecord = {
  ...mockDraftScorecard,
  criteria: [
    {
      id: 'crit-k8s',
      key: 'kubernetes',
      label: 'Kubernetes Architecture',
      description: 'Hands-on production cluster design',
      category: 'SKILL',
      requirementType: 'MUST_HAVE',
      weight: 60,
      displayOrder: 1,
      active: true,
      evidence: {
        sourceQuote: 'Kubernetes and Cloud infrastructure',
        sourceStart: 57,
        sourceEnd: 93,
        verificationStatus: 'VERIFIED',
      },
    },
    {
      id: 'crit-cloud',
      key: 'cloud-infra',
      label: 'Cloud Infrastructure',
      description: 'Multi-region VPC deployment',
      category: 'EXPERIENCE',
      requirementType: 'PREFERRED',
      weight: 40,
      displayOrder: 2,
      active: true,
      evidence: {
        sourceQuote: 'Cloud infrastructure',
        sourceStart: 73,
        sourceEnd: 93,
        verificationStatus: 'VERIFIED',
      },
    },
  ],
};

const mockApprovedScorecard: ScorecardRecord = {
  ...mockDraftScorecard,
  id: 'a0000000-0000-4000-8000-000000000002',
  version: 2,
  status: 'APPROVED',
  approvedById: 'user-recruiter-1',
  approvedAt: '2026-11-05T12:00:00.000Z',
};

function renderScorecardEditorPage(reqId = mockRequisition.id, versionId = mockDraftScorecard.id) {
  return render(
    <MemoryRouter initialEntries={[`/requisitions/${reqId}/scorecards/${versionId}`]}>
      <Routes>
        <Route
          path="/requisitions/:requisitionId/scorecards/:versionId"
          element={<ScorecardEditorPage />}
        />
        <Route
          path="/requisitions/:requisitionId/scorecards"
          element={<div>Scorecards Directory</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ScorecardEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(requisitionApi, 'getRequisition').mockResolvedValue(mockRequisition);
  });

  it('renders loading state initially', () => {
    vi.spyOn(scorecardApi, 'getScorecard').mockImplementation(() => new Promise(() => {}));

    renderScorecardEditorPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders criteria and approval readiness for a draft version', async () => {
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(screen.getByText('Scorecard Version 1')).toBeInTheDocument();
      expect(screen.getByText('Kubernetes Architecture')).toBeInTheDocument();
      expect(screen.getByText('Cloud Infrastructure')).toBeInTheDocument();
      expect(screen.getByText('Approval Readiness')).toBeInTheDocument();
    });

    // Verification requirement should show pending
    expect(
      screen.getByText(/2 active criteria require evidence verification/i),
    ).toBeInTheDocument();
  });

  it('verifies criterion evidence when clicking Verify source quote', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /verify source quote/i })[0],
      ).toBeInTheDocument();
    });

    const verifyButtons = screen.getAllByRole('button', {
      name: /verify source quote/i,
    });
    await user.click(verifyButtons[0]!);

    // Should indicate verified by recruiter for that criterion
    expect(screen.getByText(/verified by recruiter/i)).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes in this draft.')).toBeInTheDocument();
  });

  it('toggles criterion active/inactive state non-destructively', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /deactivate/i })[0]).toBeInTheDocument();
    });

    const deactivateBtn = screen.getAllByRole('button', {
      name: /deactivate/i,
    })[0]!;
    await user.click(deactivateBtn);

    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reactivate/i })).toBeInTheDocument();
  });

  it('renders immutability notice for approved scorecards and hides edit controls', async () => {
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockApprovedScorecard);

    renderScorecardEditorPage(mockRequisition.id, mockApprovedScorecard.id);

    await waitFor(() => {
      expect(screen.getByText(/Version 2 is APPROVED and Active/i)).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add criterion/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clone to new draft/i })).toBeInTheDocument();
  });

  it('saves draft changes when clicking Save draft', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);
    const updateSpy = vi.spyOn(scorecardApi, 'updateScorecardDraft').mockResolvedValueOnce({
      ...mockDraftScorecard,
      updatedAt: '2026-11-05T10:15:00.000Z',
    });

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /verify source quote/i })[0],
      ).toBeInTheDocument();
    });

    // Make a change
    await user.click(screen.getAllByRole('button', { name: /verify source quote/i })[0]!);

    // Save draft
    const saveButton = screen.getAllByRole('button', { name: /save draft/i })[0]!;
    await user.click(saveButton);

    expect(updateSpy).toHaveBeenCalledWith(
      mockRequisition.id,
      mockDraftScorecard.id,
      expect.objectContaining({ criteria: expect.any(Array) }),
    );
  });

  it('attaches a source quote when adding a new criterion and resets stale verification when editing quote', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add criterion/i })).toBeInTheDocument();
    });

    // 1. Add new criterion with quote
    await user.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(screen.getByRole('heading', { name: /add screening criterion/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/criterion label/i), 'Distributed Storage');
    await user.type(
      screen.getByLabelText(/source job description quote/i),
      'expertise in Kubernetes',
    );
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /add criterion/i }));

    expect(await screen.findByText('Distributed Storage')).toBeInTheDocument();
    expect(screen.getByText(/"expertise in Kubernetes"/i)).toBeInTheDocument();

    // 2. Verify stale verification reset when quote is edited
    // First, verify crit-k8s quote
    const verifyButtons = screen.getAllByRole('button', { name: /verify source quote/i });
    await user.click(verifyButtons[0]!);
    expect(screen.getAllByText(/verified by recruiter/i).length).toBeGreaterThan(0);

    // Now edit crit-k8s quote
    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    expect(screen.getByRole('heading', { name: /edit criterion/i })).toBeInTheDocument();
    const quoteInput = screen.getByLabelText(/source job description quote/i);
    await user.clear(quoteInput);
    await user.type(quoteInput, 'Cloud infrastructure modified');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Quote should now be changed and reset to pending review (button 'Verify source quote' appears)
    expect(await screen.findByText(/"Cloud infrastructure modified"/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /verify source quote/i }).length).toBeGreaterThan(
      0,
    );
  });

  it('handles failed save when backend rejects ungrounded quote and retains user input', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);
    vi.spyOn(scorecardApi, 'updateScorecardDraft').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'invalid_request',
        message: 'invalid_request',
      }),
    );

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /verify source quote/i })[0],
      ).toBeInTheDocument();
    });

    // Make a change
    await user.click(screen.getAllByRole('button', { name: /verify source quote/i })[0]!);

    // Attempt save
    const saveButton = screen.getAllByRole('button', { name: /save draft/i })[0]!;
    await user.click(saveButton);

    // Error is displayed and draft remains dirty with user changes
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/unable to save scorecard changes/i)).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes in this draft.')).toBeInTheDocument();
  });

  it('toggles job description inspection within CriterionFormDialog', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockDraftScorecard);

    renderScorecardEditorPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add criterion/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /add criterion/i }));
    expect(screen.getByText(/job description reference/i)).toBeInTheDocument();

    const inspectBtn = screen.getByRole('button', { name: /inspect jd/i });
    await user.click(inspectBtn);

    // Job description text should now be visible
    expect(screen.getByText(mockRequisition.jdText)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide jd/i })).toBeInTheDocument();
  });

  it('editing a verified criterion label resets verification and clears offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const labelInput = screen.getByLabelText(/criterion label/i);
    await user.clear(labelInput);
    await user.type(labelInput, 'Kubernetes Cloud Architecture & Security');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Kubernetes Cloud Architecture & Security')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify source quote/i })).toBeInTheDocument();
    expect(screen.getByText('Unindexed quote')).toBeInTheDocument();
    expect(
      screen.getByText(/1 active criterion requires evidence verification/i),
    ).toBeInTheDocument();
  });

  it('editing a verified criterion description resets verification and clears offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const descInput = screen.getByLabelText(/description \/ evaluation guide/i);
    await user.clear(descInput);
    await user.type(descInput, 'Hands-on production cluster design and multi-cloud resilience');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/hands-on production cluster design and multi-cloud resilience/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify source quote/i })).toBeInTheDocument();
    expect(screen.getByText('Unindexed quote')).toBeInTheDocument();
    expect(
      screen.getByText(/1 active criterion requires evidence verification/i),
    ).toBeInTheDocument();
  });

  it('editing a verified criterion category resets verification and clears offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const catSelect = screen.getByLabelText(/^category/i);
    await user.selectOptions(catSelect, 'EXPERIENCE');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /verify source quote/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Unindexed quote')).toBeInTheDocument();
    expect(
      screen.getByText(/1 active criterion requires evidence verification/i),
    ).toBeInTheDocument();
  });

  it('changing the source quote resets verification and clears offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getByText('Characters [57..93]')).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const quoteInput = screen.getByLabelText(/source job description quote/i);
    await user.clear(quoteInput);
    await user.type(quoteInput, 'Kubernetes and Cloud infrastructure updated');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/"Kubernetes and Cloud infrastructure updated"/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify source quote/i })).toBeInTheDocument();
    expect(screen.getByText('Unindexed quote')).toBeInTheDocument();
  });

  it('removing evidence causes approval readiness to fail', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^approve scorecard$/i })).toBeEnabled();
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const quoteInput = screen.getByLabelText(/source job description quote/i);
    await user.clear(quoteInput);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/no extracted job description quote linked/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach jd quote/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve scorecard$/i })).toBeDisabled();
    expect(
      screen.getByText(/1 active criterion requires verified source evidence/i),
    ).toBeInTheDocument();
  });

  it('changing only weight preserves verification status and offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const weightInput = screen.getByLabelText(/weight percentage/i);
    await user.clear(weightInput);
    await user.type(weightInput, '55');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('55%')).toBeInTheDocument();
    expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    expect(screen.queryByRole('button', { name: /verify source quote/i })).not.toBeInTheDocument();
    expect(screen.getByText('Characters [57..93]')).toBeInTheDocument();
  });

  it('saving with unchanged criterion fields preserves verification status and offsets', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    });

    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    // Submit unchanged
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    expect(screen.queryByRole('button', { name: /verify source quote/i })).not.toBeInTheDocument();
    expect(screen.getByText('Characters [57..93]')).toBeInTheDocument();
  });

  it('re-verification requires an explicit recruiter action after semantic edit', async () => {
    const user = userEvent.setup();
    vi.spyOn(scorecardApi, 'getScorecard').mockResolvedValueOnce(mockVerifiedDraftScorecard);

    renderScorecardEditorPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^approve scorecard$/i })).toBeEnabled();
    });

    // Edit label
    const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const labelInput = screen.getByLabelText(/criterion label/i);
    await user.clear(labelInput);
    await user.type(labelInput, 'Kubernetes Cloud Architecture Revised');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // Approval is blocked and button to verify appears
    expect(await screen.findByRole('button', { name: /^approve scorecard$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /verify source quote/i })).toBeInTheDocument();

    // Explicit recruiter action: verify source quote
    await user.click(screen.getByRole('button', { name: /verify source quote/i }));

    // Both are verified again and approval is re-enabled
    expect(screen.getAllByText(/verified by recruiter/i).length).toBe(2);
    expect(screen.getByRole('button', { name: /^approve scorecard$/i })).toBeEnabled();
  });
});
