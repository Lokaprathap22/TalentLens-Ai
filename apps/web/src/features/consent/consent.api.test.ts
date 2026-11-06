import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  acceptConsent,
  confirmConsentWithdrawal,
  createConsentInvitation,
  declineConsent,
  inspectConsentNotice,
  requestConsentWithdrawal,
} from './consent.api.js';

describe('consent.api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('createConsentInvitation', () => {
    it('calls POST /requisitions/:requisitionId/candidates/:candidateId/consent-invitations with email', async () => {
      const mockResult = {
        id: 'inv-123',
        candidateId: 'cand-456',
        requisitionId: 'req-789',
        email: 'candidate@example.com',
        purpose: 'HIRING_USE',
        status: 'PENDING',
        policyVersion: '1.0.0',
        noticeTextHash: 'hash-abc',
        deliveryStatus: 'NOT_CONFIGURED',
        deliveryError: null,
        expiresAt: '2026-11-12T00:00:00Z',
        createdAt: '2026-11-05T00:00:00Z',
        invitationUrl: 'https://app.talentlens.ai/consent#token=token123',
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResult);

      const result = await createConsentInvitation('req-789', 'cand-456', 'candidate@example.com');

      expect(postSpy).toHaveBeenCalledWith(
        '/requisitions/req-789/candidates/cand-456/consent-invitations',
        { email: 'candidate@example.com' },
      );
      expect(result).toEqual(mockResult);
    });

    it('propagates ApiError when invitation creation fails', async () => {
      vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
        new ApiError({
          status: 400,
          code: 'validation_error',
          message: 'Invalid email address',
        }),
      );

      await expect(
        createConsentInvitation('req-789', 'cand-456', 'bad-email'),
      ).rejects.toMatchObject({
        status: 400,
        code: 'validation_error',
      });
    });
  });

  describe('inspectConsentNotice', () => {
    it('calls POST /consent/inspect with token', async () => {
      const mockNotice = {
        organizationName: 'Acme Corp',
        requisitionTitle: 'Senior Platform Engineer',
        clientName: 'Acme Client',
        candidateCode: 'CAN-0042',
        purpose: 'HIRING_USE',
        policyVersion: '1.0.0',
        noticeTextHash: 'hash-abc',
        expiresAt: '2026-11-12T00:00:00Z',
        isPolicyApproved: true,
        noticeText: 'Notice body text...',
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockNotice);

      const result = await inspectConsentNotice('token-abc');

      expect(postSpy).toHaveBeenCalledWith('/consent/inspect', { token: 'token-abc' });
      expect(result).toEqual(mockNotice);
    });
  });

  describe('acceptConsent', () => {
    it('calls POST /consent/accept with token and confirmationName', async () => {
      const mockAccept = {
        status: 'ACCEPTED',
        candidateId: 'cand-456',
        requisitionId: 'req-789',
        purpose: 'HIRING_USE',
        policyVersion: '1.0.0',
        capturedAt: '2026-11-05T12:00:00Z',
        releasedJobCount: 1,
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockAccept);

      const result = await acceptConsent('token-abc', 'Alex Morgan');

      expect(postSpy).toHaveBeenCalledWith('/consent/accept', {
        token: 'token-abc',
        confirmationName: 'Alex Morgan',
      });
      expect(result).toEqual(mockAccept);
    });
  });

  describe('declineConsent', () => {
    it('calls POST /consent/decline with token and optional reason', async () => {
      const mockDecline = {
        status: 'DECLINED',
        candidateId: 'cand-456',
        requisitionId: 'req-789',
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockDecline);

      const result = await declineConsent('token-abc', 'Found another job');

      expect(postSpy).toHaveBeenCalledWith('/consent/decline', {
        token: 'token-abc',
        reason: 'Found another job',
      });
      expect(result).toEqual(mockDecline);
    });

    it('calls POST /consent/decline without reason when omitted', async () => {
      const mockDecline = {
        status: 'DECLINED',
        candidateId: 'cand-456',
        requisitionId: 'req-789',
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockDecline);

      const result = await declineConsent('token-abc');

      expect(postSpy).toHaveBeenCalledWith('/consent/decline', {
        token: 'token-abc',
      });
      expect(result).toEqual(mockDecline);
    });
  });

  describe('requestConsentWithdrawal', () => {
    it('calls POST /consent/withdraw/request with email and candidateCode', async () => {
      const mockResponse = {
        message:
          'If an active consent record is associated with this email, a verification link has been sent.',
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResponse);

      const result = await requestConsentWithdrawal('candidate@example.com', 'CAN-0042');

      expect(postSpy).toHaveBeenCalledWith('/consent/withdraw/request', {
        email: 'candidate@example.com',
        candidateCode: 'CAN-0042',
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('confirmConsentWithdrawal', () => {
    it('calls POST /consent/withdraw/confirm with token', async () => {
      const mockConfirm = {
        status: 'WITHDRAWN',
        candidateId: 'cand-456',
        withdrawnAt: '2026-11-05T14:00:00Z',
        heldJobCount: 1,
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockConfirm);

      const result = await confirmConsentWithdrawal('withdraw-token-xyz');

      expect(postSpy).toHaveBeenCalledWith('/consent/withdraw/confirm', {
        token: 'withdraw-token-xyz',
      });
      expect(result).toEqual(mockConfirm);
    });
  });
});
