import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as consentApi from './consent.api.js';
import { ConsentPortalPage } from './ConsentPortalPage.js';
import type { ConsentNoticeDto } from './types.js';

const MOCK_NOTICE: ConsentNoticeDto = {
  organizationName: 'Acme Systems',
  requisitionTitle: 'Staff Security Engineer',
  clientName: 'Apex Financial',
  candidateCode: 'CAN-8899',
  purpose: 'HIRING_USE',
  policyVersion: '1.2.0',
  noticeTextHash: 'hash-1234',
  expiresAt: '2026-11-20T12:00:00Z',
  isPolicyApproved: true,
  noticeText: 'This is the comprehensive AI screening notice disclosure for candidates.',
};

describe('ConsentPortalPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('renders missing token error when no hash token is present', async () => {
    window.location.hash = '';
    render(<ConsentPortalPage />);

    expect(screen.getByText('Missing Invitation Token')).toBeInTheDocument();
    expect(
      screen.getByText(/requires a valid, secure invitation link provided by your recruiter/i),
    ).toBeInTheDocument();
  });

  it('renders expired/invalid token error when backend reports invitation invalid or expired', async () => {
    window.location.hash = '#token=expired-token';

    vi.spyOn(consentApi, 'inspectConsentNotice').mockRejectedValueOnce(
      new ApiError({
        status: 410,
        code: 'INVITATION_INVALID_OR_EXPIRED',
        message: 'The consent invitation has expired.',
      }),
    );

    render(<ConsentPortalPage />);

    await waitFor(() => {
      expect(screen.getByText('Invitation Expired or Invalid')).toBeInTheDocument();
    });
  });

  it('renders notice details when token is valid', async () => {
    window.location.hash = '#token=valid-token';

    const inspectSpy = vi
      .spyOn(consentApi, 'inspectConsentNotice')
      .mockResolvedValueOnce(MOCK_NOTICE);

    render(<ConsentPortalPage />);

    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');

    await waitFor(() => {
      expect(screen.getByText('Consent for AI-Assisted Resume Screening')).toBeInTheDocument();
    });

    expect(inspectSpy).toHaveBeenCalledWith('valid-token');
    expect(screen.getByText('Staff Security Engineer')).toBeInTheDocument();
    expect(screen.getByText('Acme Systems')).toBeInTheDocument();
    expect(screen.getByText('Candidate: CAN-8899')).toBeInTheDocument();
    expect(screen.getByText('Policy v1.2.0')).toBeInTheDocument();
    expect(
      screen.getByText('This is the comprehensive AI screening notice disclosure for candidates.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/full legal name/i)).toBeInTheDocument();
  });

  it('displays warning banner when policy is not approved', async () => {
    window.location.hash = '#token=valid-token';

    vi.spyOn(consentApi, 'inspectConsentNotice').mockResolvedValueOnce({
      ...MOCK_NOTICE,
      isPolicyApproved: false,
    });

    render(<ConsentPortalPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/pending review by the organization's compliance officer/i),
      ).toBeInTheDocument();
    });
  });

  it('successfully submits consent acceptance', async () => {
    window.location.hash = '#token=valid-token';

    vi.spyOn(consentApi, 'inspectConsentNotice').mockResolvedValueOnce(MOCK_NOTICE);
    const acceptSpy = vi.spyOn(consentApi, 'acceptConsent').mockResolvedValueOnce({
      status: 'ACCEPTED',
      candidateId: 'cand-1',
      requisitionId: 'req-1',
      purpose: 'HIRING_USE',
      policyVersion: '1.2.0',
      capturedAt: '2026-11-06T10:00:00Z',
      releasedJobCount: 1,
    });

    render(<ConsentPortalPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/full legal name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/full legal name/i);
    fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });

    const acceptButton = screen.getByRole('button', { name: /accept & authorize screening/i });
    expect(acceptButton).not.toBeDisabled();
    fireEvent.click(acceptButton);

    await waitFor(() => {
      expect(screen.getByText('Consent Recorded Successfully')).toBeInTheDocument();
    });

    expect(acceptSpy).toHaveBeenCalledWith('valid-token', 'Jane Doe');
    expect(screen.getByText(/Jane Doe/i)).toBeInTheDocument();
  });

  it('successfully submits consent decline', async () => {
    window.location.hash = '#token=valid-token';

    vi.spyOn(consentApi, 'inspectConsentNotice').mockResolvedValueOnce(MOCK_NOTICE);
    const declineSpy = vi.spyOn(consentApi, 'declineConsent').mockResolvedValueOnce({
      status: 'DECLINED',
      candidateId: 'cand-1',
      requisitionId: 'req-1',
    });

    render(<ConsentPortalPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /decline screening/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /decline screening/i }));

    expect(screen.getByText('Decline Consent for Screening')).toBeInTheDocument();
    const reasonInput = screen.getByLabelText(/reason for declining/i);
    fireEvent.change(reasonInput, { target: { value: 'Withdrawing my application' } });

    fireEvent.click(screen.getByRole('button', { name: /confirm decline/i }));

    await waitFor(() => {
      expect(screen.getByText('Consent Declined')).toBeInTheDocument();
    });

    expect(declineSpy).toHaveBeenCalledWith('valid-token', 'Withdrawing my application');
  });
});
