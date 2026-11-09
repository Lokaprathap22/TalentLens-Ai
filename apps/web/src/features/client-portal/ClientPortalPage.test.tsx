import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../app/auth.js';
import { WorkspaceProvider, createAuthenticatedWorkspace } from '../../app/workspace.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ClientPortalPage } from './ClientPortalPage.js';
import * as clientPortalApi from './client-portal.api.js';
import type { AuthorizedClient, ClientSubmissionDetail, ClientSubmissionSummary } from './types.js';

const CLIENT_USER: AuthenticatedUser = {
  userId: 'user-client-1',
  organizationId: 'org-1',
  organizationName: 'TalentLens Agency',
  email: 'client.manager@acme.example',
  role: 'CLIENT_HIRING_MANAGER',
};

const MOCK_CLIENTS: AuthorizedClient[] = [
  {
    id: 'client-1',
    name: 'Acme Technologies',
    status: 'ACTIVE',
  },
];

const MOCK_SUBMISSIONS: ClientSubmissionSummary[] = [
  {
    submissionId: 'sub-1',
    candidateRef: 'CAND-SUB-1001',
    requisitionId: 'req-1',
    requisitionTitle: 'Staff Backend Engineer',
    status: 'SUBMITTED',
    submittedAt: '2026-11-06T10:00:00.000Z',
    assessmentSummary: {
      score: 92,
      coverage: 1,
      status: 'COMPLETED',
      criteriaCount: 3,
    },
    latestDecision: null,
  },
  {
    submissionId: 'sub-2',
    candidateRef: 'CAND-SUB-1002',
    requisitionId: 'req-1',
    requisitionTitle: 'Staff Backend Engineer',
    status: 'CLIENT_SHORTLISTED',
    submittedAt: '2026-11-05T14:00:00.000Z',
    assessmentSummary: {
      score: 85,
      coverage: 1,
      status: 'COMPLETED',
      criteriaCount: 3,
    },
    latestDecision: {
      decision: 'SHORTLIST',
      createdAt: '2026-11-05T16:00:00.000Z',
    },
  },
  {
    submissionId: 'sub-3',
    candidateRef: 'CAND-SUB-1003',
    requisitionId: 'req-2',
    requisitionTitle: 'Frontend Lead',
    status: 'CLIENT_REJECTED',
    submittedAt: '2026-11-04T09:00:00.000Z',
    assessmentSummary: {
      score: 60,
      coverage: 0.8,
      status: 'COMPLETED',
      criteriaCount: 4,
    },
    latestDecision: {
      decision: 'REJECT',
      createdAt: '2026-11-04T11:00:00.000Z',
    },
  },
];

const MOCK_SUBMISSION_DETAIL: ClientSubmissionDetail = {
  submissionId: 'sub-1',
  candidateRef: 'CAND-SUB-1001',
  requisitionId: 'req-1',
  requisitionTitle: 'Staff Backend Engineer',
  status: 'SUBMITTED',
  submittedAt: '2026-11-06T10:00:00.000Z',
  assessment: {
    score: 92,
    coverage: 1,
    status: 'COMPLETED',
    criteria: [
      {
        label: 'Distributed Systems Mastery',
        category: 'Architecture',
        requirementType: 'MUST_HAVE',
        status: 'MET',
        reasoning: 'Engineered high-throughput event queues processing 100k msg/sec.',
        verifiedQuotes: ['Designed Kafka-backed event log serving real-time analytics.'],
      },
    ],
  },
  feedbackHistory: [],
};

function renderClientPortal(): ReturnType<typeof render> {
  const workspace = createAuthenticatedWorkspace(CLIENT_USER);
  return render(
    <AuthProvider>
      <WorkspaceProvider value={workspace}>
        <ClientPortalPage />
      </WorkspaceProvider>
    </AuthProvider>,
  );
}

describe('ClientPortalPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(clientPortalApi, 'listAuthorizedClients').mockResolvedValue(MOCK_CLIENTS);
    vi.spyOn(clientPortalApi, 'listClientSubmissions').mockResolvedValue(MOCK_SUBMISSIONS);
    vi.spyOn(clientPortalApi, 'getClientSubmission').mockResolvedValue(MOCK_SUBMISSION_DETAIL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders Client Portal header, client organization badge, and metrics overview', async () => {
    renderClientPortal();

    expect(
      await screen.findByRole('heading', { name: /Candidate Evaluation Workspace/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme Technologies')).toBeInTheDocument();
    expect(screen.getByText('client.manager@acme.example')).toBeInTheDocument();

    // Metrics cards: Total: 3, Pending: 1, Shortlisted: 1, Declined: 1
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Total Submissions')).toBeInTheDocument();
    expect(screen.getAllByText('Pending Review').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1').length).toBe(3);
  });

  it('2. displays masked candidate submissions in data table', async () => {
    renderClientPortal();

    expect(await screen.findByText('CAND-SUB-1001')).toBeInTheDocument();
    expect(screen.getByText('CAND-SUB-1002')).toBeInTheDocument();
    expect(screen.getByText('CAND-SUB-1003')).toBeInTheDocument();

    // Verify mask badges
    expect(screen.getAllByText('Masked Profile').length).toBe(3);

    // Verify advisory scores
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();

    // Verify statuses
    expect(screen.getAllByText('Pending Review').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Shortlisted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Declined').length).toBeGreaterThan(0);
  });

  it('3. filters candidate submissions by status and search input', async () => {
    const user = userEvent.setup();
    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');

    // Filter by Pending Review
    const pendingTab = screen.getByRole('tab', { name: 'Pending Review' });
    await user.click(pendingTab);

    expect(screen.getByText('CAND-SUB-1001')).toBeInTheDocument();
    expect(screen.queryByText('CAND-SUB-1002')).not.toBeInTheDocument();
    expect(screen.queryByText('CAND-SUB-1003')).not.toBeInTheDocument();

    // Filter by search
    const allTab = screen.getByRole('tab', { name: 'All Submissions' });
    await user.click(allTab);

    const searchInput = screen.getByPlaceholderText(/Search by code or position/i);
    await user.type(searchInput, 'Frontend');

    expect(screen.queryByText('CAND-SUB-1001')).not.toBeInTheDocument();
    expect(screen.getByText('CAND-SUB-1003')).toBeInTheDocument();
  }, 15000);

  it('4. opens review modal, displays advisory criteria and verified quotes, and records SHORTLIST decision', async () => {
    const user = userEvent.setup();
    const recordFeedbackSpy = vi
      .spyOn(clientPortalApi, 'recordClientFeedback')
      .mockResolvedValueOnce({
        id: 'fb-new-1',
        decision: 'SHORTLIST',
        createdAt: '2026-11-06T12:00:00.000Z',
      });

    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');

    // Click "Review Candidate"
    const reviewBtn = screen.getByRole('button', { name: /Review Candidate/i });
    await user.click(reviewBtn);

    // Modal opens
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('CAND-SUB-1001')).toBeInTheDocument();
    expect(within(dialog).getByText(/Candidate Submission Review/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Distributed Systems Mastery')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Designed Kafka-backed event log serving real-time analytics/i),
    ).toBeInTheDocument();

    // Select Shortlist
    const shortlistBtn = within(dialog).getByRole('button', { name: /Shortlist Candidate/i });
    await user.click(shortlistBtn);

    // Confirm Shortlist
    const confirmBtn = within(dialog).getByRole('button', { name: /Confirm Shortlist/i });
    await user.click(confirmBtn);

    expect(recordFeedbackSpy).toHaveBeenCalledWith('client-1', 'sub-1', {
      decision: 'SHORTLIST',
    });

    expect(
      await within(dialog).findByText(/Your feedback has been successfully recorded/i),
    ).toBeInTheDocument();
  });

  it('5. enforces mandatory reason when declining candidate', async () => {
    const user = userEvent.setup({ delay: null });
    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');

    const reviewBtn = screen.getByRole('button', { name: /Review Candidate/i });
    await user.click(reviewBtn);

    const dialog = await screen.findByRole('dialog');

    // Select Decline Candidate
    const declineBtn = await within(dialog).findByRole('button', { name: /Decline Candidate/i });
    await user.click(declineBtn);

    // Try submitting without reason
    const confirmBtn = within(dialog).getByRole('button', { name: /Confirm Decline/i });
    await user.click(confirmBtn);

    expect(
      await within(dialog).findByText(
        /A specific decline reason of at least 3 characters is required/i,
      ),
    ).toBeInTheDocument();

    // Type reason
    const reasonInput = within(dialog).getByLabelText(/Decline Reason/i);
    await user.type(reasonInput, 'Need more hands-on cloud migration experience.');

    const recordFeedbackSpy = vi
      .spyOn(clientPortalApi, 'recordClientFeedback')
      .mockResolvedValueOnce({
        id: 'fb-new-2',
        decision: 'REJECT',
        createdAt: '2026-11-06T12:00:00.000Z',
      });

    await user.click(confirmBtn);

    expect(recordFeedbackSpy).toHaveBeenCalledWith('client-1', 'sub-1', {
      decision: 'REJECT',
      reason: 'Need more hands-on cloud migration experience.',
    });
  }, 15000);

  it('6. surfaces anti-bias compliance error if prohibited discriminatory content is detected', async () => {
    const user = userEvent.setup({ delay: null });
    vi.spyOn(clientPortalApi, 'recordClientFeedback').mockRejectedValueOnce(
      new Error(
        'Feedback rejected by compliance filter: Feedback contains prohibited discriminatory content (AGE)',
      ),
    );

    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');

    const reviewBtn = screen.getByRole('button', { name: /Review Candidate/i });
    await user.click(reviewBtn);

    const dialog = await screen.findByRole('dialog');

    const declineBtn = await within(dialog).findByRole('button', { name: /Decline Candidate/i });
    await user.click(declineBtn);

    const reasonInput = within(dialog).getByLabelText(/Decline Reason/i);
    await user.type(reasonInput, 'Candidate seems too senior or old for the team culture.');

    const confirmBtn = within(dialog).getByRole('button', { name: /Confirm Decline/i });
    await user.click(confirmBtn);

    expect(
      await within(dialog).findByText(/Feedback rejected by compliance filter/i),
    ).toBeInTheDocument();
  }, 15000);

  it('7. displays interview scheduling section in review modal and allows client to accept recruiter proposals', async () => {
    const user = userEvent.setup();
    const detailWithInterview: ClientSubmissionDetail = {
      ...MOCK_SUBMISSION_DETAIL,
      interviews: [
        {
          id: 'iv-client-1',
          startAt: '2026-11-15T15:00:00.000Z',
          endAt: '2026-11-15T15:45:00.000Z',
          timezone: 'America/New_York',
          format: 'VIDEO',
          status: 'PROPOSED',
          reason: 'Initial chat with engineering lead',
          createdAt: '2026-11-06T10:00:00.000Z',
        },
      ],
    };

    vi.spyOn(clientPortalApi, 'getClientSubmission').mockResolvedValue(detailWithInterview);
    const acceptSpy = vi
      .spyOn(clientPortalApi, 'clientAcceptInterviewProposal')
      .mockResolvedValueOnce({
        success: true,
        action: 'ACCEPT',
        proposalId: 'iv-client-1',
        status: 'ACCEPTED',
      });

    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');

    const reviewBtn = screen.getByRole('button', { name: /Review Candidate/i });
    await user.click(reviewBtn);

    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('Interview Schedule & Proposals')).toBeInTheDocument();
    expect(within(dialog).getByText(/Initial chat with engineering lead/i)).toBeInTheDocument();

    const acceptBtn = within(dialog).getByRole('button', { name: /Accept Window/i });
    await user.click(acceptBtn);

    expect(acceptSpy).toHaveBeenCalledWith('client-1', 'sub-1', 'iv-client-1');
  });

  it('8. enables Record Hiring Decision and Review & Decide action when submission is INTERVIEW_PROPOSED after COMPLETED interview', async () => {
    const user = userEvent.setup({ delay: null });
    const postInterviewSummary: ClientSubmissionSummary = {
      submissionId: 'sub-iv-1',
      candidateRef: 'CAND-SUB-2001',
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Backend Engineer',
      status: 'INTERVIEW_PROPOSED',
      submittedAt: '2026-11-06T10:00:00.000Z',
      assessmentSummary: {
        score: 94,
        coverage: 1,
        status: 'COMPLETED',
        criteriaCount: 3,
      },
      latestDecision: null,
    };

    const postInterviewDetail: ClientSubmissionDetail = {
      ...MOCK_SUBMISSION_DETAIL,
      submissionId: 'sub-iv-1',
      candidateRef: 'CAND-SUB-2001',
      status: 'INTERVIEW_PROPOSED',
      feedbackHistory: [
        {
          id: 'fb-iv-1',
          decision: 'PROPOSE_INTERVIEW',
          reason: 'Initial technical interview proposed',
          proposedAt: '2026-11-15T15:00:00.000Z',
          timezone: 'UTC',
          createdAt: '2026-11-06T11:00:00.000Z',
        },
      ],
      interviews: [
        {
          id: 'iv-completed-1',
          startAt: '2026-11-15T15:00:00.000Z',
          endAt: '2026-11-15T15:45:00.000Z',
          timezone: 'UTC',
          format: 'VIDEO',
          status: 'COMPLETED',
          reason: 'Strong systems interview',
          createdAt: '2026-11-06T11:00:00.000Z',
        },
      ],
    };

    const shortlistedDetailAfter: ClientSubmissionDetail = {
      ...postInterviewDetail,
      status: 'CLIENT_SHORTLISTED',
      feedbackHistory: [
        {
          id: 'fb-shortlist-final',
          decision: 'SHORTLIST',
          reason: 'Recommended for final offer stage',
          proposedAt: null,
          timezone: null,
          createdAt: '2026-11-15T16:30:00.000Z',
        },
        ...postInterviewDetail.feedbackHistory,
      ],
    };

    vi.spyOn(clientPortalApi, 'listClientSubmissions')
      .mockResolvedValueOnce([postInterviewSummary])
      .mockResolvedValueOnce([{ ...postInterviewSummary, status: 'CLIENT_SHORTLISTED' }]);

    vi.spyOn(clientPortalApi, 'getClientSubmission')
      .mockResolvedValueOnce(postInterviewDetail)
      .mockResolvedValueOnce(shortlistedDetailAfter);

    const feedbackSpy = vi.spyOn(clientPortalApi, 'recordClientFeedback').mockResolvedValueOnce({
      id: 'fb-shortlist-final',
      decision: 'SHORTLIST',
      createdAt: '2026-11-15T16:30:00.000Z',
    });

    renderClientPortal();

    await screen.findByText('CAND-SUB-2001');

    // Verify Interview Stage filter tab and Review & Decide action button
    const interviewTab = screen.getByRole('tab', { name: 'Interview Stage' });
    await user.click(interviewTab);
    expect(screen.getByText('CAND-SUB-2001')).toBeInTheDocument();

    const reviewDecideBtn = screen.getByRole('button', { name: /Review & Decide/i });
    await user.click(reviewDecideBtn);

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('COMPLETED')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Interview has completed\. Record your final decision to shortlist or decline/i,
      ),
    ).toBeInTheDocument();

    // Feedback history distinguishes PROPOSE_INTERVIEW as 'Interview Proposed' rather than 'Declined'
    expect(within(dialog).getAllByText('Interview Proposed').length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).queryByText('Declined')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Shortlist Candidate/i }));
    await user.type(
      within(dialog).getByLabelText(/Decision Notes/i),
      'Recommended for final offer stage',
    );
    await user.click(within(dialog).getByRole('button', { name: /Confirm Shortlist/i }));

    expect(feedbackSpy).toHaveBeenCalledWith('client-1', 'sub-iv-1', {
      decision: 'SHORTLIST',
      reason: 'Recommended for final offer stage',
    });

    // Confirmation remains visible after modal transitions to terminal CLIENT_SHORTLISTED and hides form
    expect(
      await within(dialog).findByText(/Your feedback has been successfully recorded/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Final Hiring Decision Recorded:/i)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /Confirm Shortlist/i }),
    ).not.toBeInTheDocument();
  }, 15000);

  it('9. records post-interview REJECT with mandatory reason and locks terminal CLIENT_REJECTED controls', async () => {
    const user = userEvent.setup({ delay: null });
    const postInterviewSummary: ClientSubmissionSummary = {
      submissionId: 'sub-iv-reject',
      candidateRef: 'CAND-SUB-2002',
      requisitionId: 'req-1',
      requisitionTitle: 'Staff Backend Engineer',
      status: 'INTERVIEW_PROPOSED',
      submittedAt: '2026-11-06T10:00:00.000Z',
      assessmentSummary: {
        score: 78,
        coverage: 1,
        status: 'COMPLETED',
        criteriaCount: 2,
      },
      latestDecision: null,
    };

    const postInterviewDetail: ClientSubmissionDetail = {
      ...MOCK_SUBMISSION_DETAIL,
      submissionId: 'sub-iv-reject',
      candidateRef: 'CAND-SUB-2002',
      status: 'INTERVIEW_PROPOSED',
      interviews: [
        {
          id: 'iv-completed-2',
          startAt: '2026-11-15T15:00:00.000Z',
          endAt: '2026-11-15T15:45:00.000Z',
          timezone: 'UTC',
          format: 'VIDEO',
          status: 'COMPLETED',
          reason: null,
          createdAt: '2026-11-06T11:00:00.000Z',
        },
      ],
    };

    const rejectedDetailAfter: ClientSubmissionDetail = {
      ...postInterviewDetail,
      status: 'CLIENT_REJECTED',
      feedbackHistory: [
        {
          id: 'fb-reject-final',
          decision: 'REJECT',
          reason: 'Insufficient multi-region failover architecture depth.',
          proposedAt: null,
          timezone: null,
          createdAt: '2026-11-15T17:00:00.000Z',
        },
      ],
    };

    vi.spyOn(clientPortalApi, 'listClientSubmissions')
      .mockResolvedValueOnce([postInterviewSummary])
      .mockResolvedValueOnce([{ ...postInterviewSummary, status: 'CLIENT_REJECTED' }]);

    vi.spyOn(clientPortalApi, 'getClientSubmission')
      .mockResolvedValueOnce(postInterviewDetail)
      .mockResolvedValueOnce(rejectedDetailAfter);

    const feedbackSpy = vi.spyOn(clientPortalApi, 'recordClientFeedback').mockResolvedValueOnce({
      id: 'fb-reject-final',
      decision: 'REJECT',
      createdAt: '2026-11-15T17:00:00.000Z',
    });

    renderClientPortal();

    await screen.findByText('CAND-SUB-2002');
    await user.click(screen.getByRole('button', { name: /Review & Decide/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: /Decline Candidate/i }));
    await user.click(within(dialog).getByRole('button', { name: /Confirm Decline/i }));

    expect(
      await within(dialog).findByText(
        /A specific decline reason of at least 3 characters is required/i,
      ),
    ).toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText(/Decline Reason/i),
      'Insufficient multi-region failover architecture depth.',
    );
    await user.click(within(dialog).getByRole('button', { name: /Confirm Decline/i }));

    expect(feedbackSpy).toHaveBeenCalledWith('client-1', 'sub-iv-reject', {
      decision: 'REJECT',
      reason: 'Insufficient multi-region failover architecture depth.',
    });

    expect(
      await within(dialog).findByText(/Your feedback has been successfully recorded/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/This candidate submission has been declined/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /Propose Interview Slot/i }),
    ).not.toBeInTheDocument();
  }, 15000);

  it('10. hides decision form for terminal CLIENT_SHORTLISTED, CLIENT_REJECTED, and WITHDRAWN states', async () => {
    const user = userEvent.setup({ delay: null });
    const withdrawnRow: ClientSubmissionSummary = {
      submissionId: 'sub-4',
      candidateRef: 'CAND-SUB-1004',
      requisitionId: 'req-2',
      requisitionTitle: 'Security Architect',
      status: 'WITHDRAWN',
      submittedAt: '2026-11-03T09:00:00.000Z',
      assessmentSummary: null,
      latestDecision: null,
    };

    vi.spyOn(clientPortalApi, 'listClientSubmissions').mockResolvedValue([
      MOCK_SUBMISSIONS[1]!, // CLIENT_SHORTLISTED
      MOCK_SUBMISSIONS[2]!, // CLIENT_REJECTED
      withdrawnRow, // WITHDRAWN
    ]);

    vi.spyOn(clientPortalApi, 'getClientSubmission')
      .mockResolvedValueOnce({
        ...MOCK_SUBMISSION_DETAIL,
        submissionId: 'sub-2',
        candidateRef: 'CAND-SUB-1002',
        status: 'CLIENT_SHORTLISTED',
      })
      .mockResolvedValueOnce({
        ...MOCK_SUBMISSION_DETAIL,
        submissionId: 'sub-3',
        candidateRef: 'CAND-SUB-1003',
        status: 'CLIENT_REJECTED',
      })
      .mockResolvedValueOnce({
        ...MOCK_SUBMISSION_DETAIL,
        submissionId: 'sub-4',
        candidateRef: 'CAND-SUB-1004',
        status: 'WITHDRAWN',
      });

    renderClientPortal();

    await screen.findByText('CAND-SUB-1002');
    const viewButtons = screen.getAllByRole('button', { name: /View Decision/i });
    expect(viewButtons).toHaveLength(3);

    // CLIENT_SHORTLISTED
    await user.click(viewButtons[0]!);
    let dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/This candidate has been shortlisted/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Record Hiring Decision')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Close review dialog/i }));

    // CLIENT_REJECTED
    await user.click(screen.getAllByRole('button', { name: /View Decision/i })[1]!);
    dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/This candidate submission has been declined/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Record Hiring Decision')).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /Propose Interview Slot/i }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Close review dialog/i }));

    // WITHDRAWN
    await user.click(screen.getAllByRole('button', { name: /View Decision/i })[2]!);
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Candidate Consent Withdrawn:/i)).toBeInTheDocument();
    expect(within(dialog).queryByText('Record Hiring Decision')).not.toBeInTheDocument();
  }, 15000);

  it('11. prevents duplicate feedback submission while request is in flight and resets form when switching submissions', async () => {
    const user = userEvent.setup({ delay: null });
    let resolveFeedback!: (val: { id: string; decision: 'SHORTLIST'; createdAt: string }) => void;
    const inflightPromise = new Promise<{ id: string; decision: 'SHORTLIST'; createdAt: string }>(
      (resolve) => {
        resolveFeedback = resolve;
      },
    );

    const feedbackSpy = vi
      .spyOn(clientPortalApi, 'recordClientFeedback')
      .mockImplementationOnce(() => inflightPromise);

    const secondSummary: ClientSubmissionSummary = {
      ...MOCK_SUBMISSIONS[0]!,
      submissionId: 'sub-9',
      candidateRef: 'CAND-SUB-9001',
    };

    vi.spyOn(clientPortalApi, 'listClientSubmissions').mockResolvedValue([
      MOCK_SUBMISSIONS[0]!,
      secondSummary,
    ]);
    vi.spyOn(clientPortalApi, 'getClientSubmission')
      .mockResolvedValueOnce(MOCK_SUBMISSION_DETAIL)
      .mockResolvedValueOnce({
        ...MOCK_SUBMISSION_DETAIL,
        submissionId: 'sub-9',
        candidateRef: 'CAND-SUB-9001',
      });

    renderClientPortal();

    await screen.findByText('CAND-SUB-1001');
    const reviewBtns = screen.getAllByRole('button', { name: /Review Candidate/i });
    await user.click(reviewBtns[0]!);

    let dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: /Decline Candidate/i }));
    await user.type(within(dialog).getByLabelText(/Decline Reason/i), 'Temporary note');

    // Close and open another submission — stale choice and note must reset
    await user.click(within(dialog).getByRole('button', { name: /Close review dialog/i }));
    await user.click(screen.getAllByRole('button', { name: /Review Candidate/i })[1]!);

    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('CAND-SUB-9001')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Decision Notes/i)).toHaveValue('');

    // Verify duplicate click while in flight calls API once
    await user.click(within(dialog).getByRole('button', { name: /Shortlist Candidate/i }));
    const submitBtn = within(dialog).getByRole('button', { name: /Confirm Shortlist/i });
    await user.click(submitBtn);
    await user.click(submitBtn);

    expect(feedbackSpy).toHaveBeenCalledTimes(1);
    resolveFeedback({
      id: 'fb-once',
      decision: 'SHORTLIST',
      createdAt: '2026-11-15T18:00:00.000Z',
    });
  }, 15000);
});
