import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as consentApi from './consent.api.js';
import { ConsentDeletionPage } from './ConsentDeletionPage.js';

describe('ConsentDeletionPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
    window.location.search = '';
  });

  describe('Request Flow (no token in URL)', () => {
    it('renders data deletion request form when no token is present', () => {
      render(<ConsentDeletionPage />);

      expect(screen.getByText('Candidate Data Deletion Portal')).toBeInTheDocument();
      expect(screen.getByText('Request Data Deletion Verification')).toBeInTheDocument();
      expect(screen.getByLabelText(/candidate email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/candidate reference code/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /send deletion verification link/i }),
      ).toBeInTheDocument();
    });

    it('submits deletion request with email and candidateCode', async () => {
      const requestSpy = vi.spyOn(consentApi, 'requestCandidateDeletion').mockResolvedValueOnce({
        message:
          'If an active candidate record is associated with this email, a verification link has been sent.',
      });

      render(<ConsentDeletionPage />);

      fireEvent.change(screen.getByLabelText(/candidate email/i), {
        target: { value: 'candidate@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/candidate reference code/i), {
        target: { value: 'CAND-00123' },
      });

      fireEvent.click(screen.getByRole('button', { name: /send deletion verification link/i }));

      await waitFor(() => {
        expect(screen.getByText('Verification Email Sent')).toBeInTheDocument();
      });

      expect(requestSpy).toHaveBeenCalledWith('candidate@example.com', 'CAND-00123');
      expect(
        screen.getByText(
          /if an active candidate record is associated with this email, a verification link has been sent/i,
        ),
      ).toBeInTheDocument();
    });

    it('handles request submission error', async () => {
      vi.spyOn(consentApi, 'requestCandidateDeletion').mockRejectedValueOnce(
        new ApiError({
          status: 400,
          message: 'Invalid email address provided',
          code: 'VALIDATION_ERROR',
        }),
      );

      render(<ConsentDeletionPage />);

      fireEvent.change(screen.getByLabelText(/candidate email/i), {
        target: { value: 'invalid-email' },
      });

      fireEvent.click(screen.getByRole('button', { name: /send deletion verification link/i }));

      await waitFor(() => {
        expect(screen.getByText('Invalid email address provided')).toBeInTheDocument();
      });
    });
  });

  describe('Confirm Flow (token present in URL fragment or query)', () => {
    it('extracts token from hash, cleans url, and displays confirmation prompt with warnings', () => {
      window.location.hash = '#token=deletion-token-xyz';
      render(<ConsentDeletionPage />);

      expect(screen.getByText('Confirm Permanent Candidate Erasure')).toBeInTheDocument();
      expect(screen.getByText(/irreversible action:/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /permanently delete my data/i })).toBeDisabled(); // must acknowledge checkbox first
    });

    it('submits confirmation when acknowledged and displays erasure success summary', async () => {
      window.location.hash = '#token=deletion-token-xyz';

      const confirmSpy = vi.spyOn(consentApi, 'confirmCandidateDeletion').mockResolvedValueOnce({
        status: 'COMPLETED',
        candidateId: 'cand-uuid-123',
        deletionRequestId: 'del-uuid-456',
      });

      render(<ConsentDeletionPage />);

      // Acknowledge the irreversible warning checkbox
      const checkbox = screen.getByRole('checkbox', {
        name: /i understand that this action is irreversible/i,
      });
      fireEvent.click(checkbox);

      const deleteBtn = screen.getByRole('button', { name: /permanently delete my data/i });
      expect(deleteBtn).not.toBeDisabled();
      fireEvent.click(deleteBtn);

      await waitFor(() => {
        expect(screen.getByText('Your Data Has Been Permanently Erased')).toBeInTheDocument();
      });

      expect(confirmSpy).toHaveBeenCalledWith('deletion-token-xyz');
      expect(screen.getByText('Data Erasure Completed')).toBeInTheDocument();
    });

    it('handles expired or invalid token gracefully', async () => {
      window.location.hash = '#token=expired-token-123';

      vi.spyOn(consentApi, 'confirmCandidateDeletion').mockRejectedValueOnce(
        new ApiError({
          status: 410,
          message: 'Token expired',
          code: 'WITHDRAWAL_INVALID_OR_EXPIRED',
        }),
      );

      render(<ConsentDeletionPage />);

      const checkbox = screen.getByRole('checkbox', {
        name: /i understand that this action is irreversible/i,
      });
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole('button', { name: /permanently delete my data/i }));

      await waitFor(() => {
        expect(screen.getByText('Verification Link Unavailable')).toBeInTheDocument();
      });

      expect(
        screen.getByText(/this data deletion verification link is invalid, has expired/i),
      ).toBeInTheDocument();
    });

    it('handles retryable server error with clear error message', async () => {
      window.location.hash = '#token=valid-token';

      vi.spyOn(consentApi, 'confirmCandidateDeletion').mockRejectedValueOnce(
        new ApiError({
          status: 500,
          message: 'Database temporary lock timeout',
          code: 'INTERNAL_ERROR',
        }),
      );

      render(<ConsentDeletionPage />);

      const checkbox = screen.getByRole('checkbox', {
        name: /i understand that this action is irreversible/i,
      });
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole('button', { name: /permanently delete my data/i }));

      await waitFor(() => {
        expect(screen.getByText('Database temporary lock timeout')).toBeInTheDocument();
      });
    });
  });
});
