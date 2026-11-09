import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as consentApi from './consent.api.js';
import { ConsentInvitationModal } from './ConsentInvitationModal.js';
import type { ConsentInvitationDto } from './types.js';

const MOCK_INVITATION: ConsentInvitationDto = {
  id: 'inv-123',
  candidateId: 'cand-456',
  requisitionId: 'req-789',
  email: 'alex@example.com',
  purpose: 'HIRING_USE',
  status: 'PENDING',
  policyVersion: '1.0.0',
  noticeTextHash: 'hash-abc',
  deliveryStatus: 'SENT',
  deliveryError: null,
  expiresAt: '2026-11-13T00:00:00Z',
  createdAt: '2026-11-06T00:00:00Z',
};

describe('ConsentInvitationModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form when opened', () => {
    render(
      <ConsentInvitationModal
        open={true}
        onClose={vi.fn()}
        requisitionId="req-789"
        candidateId="cand-456"
        candidateCode="CAN-9999"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Issue Consent Invitation' })).toBeInTheDocument();
    expect(screen.getByLabelText(/candidate email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate invitation/i })).toBeInTheDocument();
  });

  it('submits email and displays email confirmation notice without leaking bearer link', async () => {
    const createSpy = vi
      .spyOn(consentApi, 'createConsentInvitation')
      .mockResolvedValueOnce(MOCK_INVITATION);
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <ConsentInvitationModal
        open={true}
        onClose={onClose}
        requisitionId="req-789"
        candidateId="cand-456"
        candidateCode="CAN-9999"
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByLabelText(/candidate email address/i), {
      target: { value: 'alex@example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: /generate invitation/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Consent Invitation Dispatched' }),
      ).toBeInTheDocument();
    });

    expect(createSpy).toHaveBeenCalledWith('req-789', 'cand-456', 'alex@example.com');
    expect(onSuccess).toHaveBeenCalledWith(MOCK_INVITATION);
    expect(screen.getByText('Email Invitation Dispatched')).toBeInTheDocument();
    expect(screen.getAllByText('alex@example.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Privacy & Security Policy/i)).toBeInTheDocument();

    // Verify bearer token / URL copy input is NOT present
    expect(screen.queryByLabelText(/invitation url/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /copy link/i })).toBeNull();

    // Clicking Done calls onClose
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('displays error message when creation fails', async () => {
    vi.spyOn(consentApi, 'createConsentInvitation').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'validation_error',
        message: 'Invalid email address provided.',
      }),
    );

    render(
      <ConsentInvitationModal
        open={true}
        onClose={vi.fn()}
        requisitionId="req-789"
        candidateId="cand-456"
        candidateCode="CAN-9999"
      />,
    );

    fireEvent.change(screen.getByLabelText(/candidate email address/i), {
      target: { value: 'rejected@example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: /generate invitation/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid email address provided.')).toBeInTheDocument();
    });
  });
});
