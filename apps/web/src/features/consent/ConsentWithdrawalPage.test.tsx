import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as consentApi from './consent.api.js';
import { ConsentWithdrawalPage } from './ConsentWithdrawalPage.js';

describe('ConsentWithdrawalPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  describe('Request Flow (no hash token)', () => {
    it('renders the withdrawal request form when no hash token is present', () => {
      render(<ConsentWithdrawalPage />);

      expect(screen.getByText('Withdraw Candidate Consent')).toBeInTheDocument();
      expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/candidate reference code/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /send withdrawal verification link/i }),
      ).toBeInTheDocument();
    });

    it('submits withdrawal request with email and candidateCode', async () => {
      const requestSpy = vi.spyOn(consentApi, 'requestConsentWithdrawal').mockResolvedValueOnce({
        message:
          'If an active consent record is associated with this email, a verification link has been sent.',
      });

      render(<ConsentWithdrawalPage />);

      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: 'candidate@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/candidate reference code/i), {
        target: { value: 'CAN-1234' },
      });

      fireEvent.click(screen.getByRole('button', { name: /send withdrawal verification link/i }));

      await waitFor(() => {
        expect(screen.getByText('Verification Request Sent')).toBeInTheDocument();
      });

      expect(requestSpy).toHaveBeenCalledWith('candidate@example.com', 'CAN-1234');
      expect(
        screen.getByText(
          /if an active consent record is associated with this email, a verification link has been sent/i,
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Confirm Flow (hash token present)', () => {
    it('renders confirmation prompt when hash token is present', () => {
      window.location.hash = '#token=withdraw-token-123';
      render(<ConsentWithdrawalPage />);

      expect(screen.getByText('Confirm Consent Withdrawal')).toBeInTheDocument();
      expect(
        screen.getByText(/withdrawing your consent halts all automated screening/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /confirm withdrawal of consent/i }),
      ).toBeInTheDocument();
    });

    it('submits withdrawal confirmation and displays success feedback', async () => {
      window.location.hash = '#token=withdraw-token-123';

      const confirmSpy = vi.spyOn(consentApi, 'confirmConsentWithdrawal').mockResolvedValueOnce({
        status: 'WITHDRAWN',
        candidateId: 'cand-1',
        withdrawnAt: '2026-11-06T15:30:00Z',
        heldJobCount: 2,
      });

      render(<ConsentWithdrawalPage />);

      fireEvent.click(screen.getByRole('button', { name: /confirm withdrawal of consent/i }));

      await waitFor(() => {
        expect(screen.getByText('Consent Withdrawn Successfully')).toBeInTheDocument();
      });

      expect(confirmSpy).toHaveBeenCalledWith('withdraw-token-123');
      expect(screen.getByText('2')).toBeInTheDocument(); // heldJobCount
      expect(
        screen.getByText(
          /all automated evaluation and ai screening for this position have been halted/i,
        ),
      ).toBeInTheDocument();
    });

    it('handles expired or invalid withdrawal token error gracefully', async () => {
      window.location.hash = '#token=expired-withdraw-token';

      vi.spyOn(consentApi, 'confirmConsentWithdrawal').mockRejectedValueOnce(
        new ApiError({
          status: 410,
          code: 'INVITATION_INVALID_OR_EXPIRED',
          message: 'The token has expired.',
        }),
      );

      render(<ConsentWithdrawalPage />);

      fireEvent.click(screen.getByRole('button', { name: /confirm withdrawal of consent/i }));

      await waitFor(() => {
        expect(screen.getByText('Withdrawal Link Expired or Invalid')).toBeInTheDocument();
      });

      expect(
        screen.getByRole('button', { name: /request a new withdrawal link/i }),
      ).toBeInTheDocument();
    });
  });
});
