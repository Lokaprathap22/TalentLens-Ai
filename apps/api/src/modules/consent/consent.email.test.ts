import { describe, expect, it } from 'vitest';

import { DefaultEmailDeliveryService, InMemoryEmailDeliveryService } from './consent.email.js';

describe('consent email delivery services', () => {
  describe('DefaultEmailDeliveryService', () => {
    it('returns controlled unconfigured delivery status for invitations without throwing', async () => {
      const service = new DefaultEmailDeliveryService();
      const result = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=abc',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('EMAIL_DELIVERY_NOT_CONFIGURED');
    });

    it('returns controlled unconfigured delivery status for withdrawal verification without throwing', async () => {
      const service = new DefaultEmailDeliveryService();
      const result = await service.sendWithdrawalVerification({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        withdrawalUrl: 'https://app.talentlens.ai/consent/withdraw#token=xyz',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('EMAIL_DELIVERY_NOT_CONFIGURED');
    });

    it('returns controlled unconfigured delivery status for deletion verification without throwing', async () => {
      const service = new DefaultEmailDeliveryService();
      const result = await service.sendDeletionVerification({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        deletionUrl: 'https://app.talentlens.ai/consent/deletion#token=del123',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('EMAIL_DELIVERY_NOT_CONFIGURED');
    });
  });

  describe('InMemoryEmailDeliveryService', () => {
    it('records sent invitations and verification requests in memory', async () => {
      const service = new InMemoryEmailDeliveryService();

      const invResult = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=abc',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(invResult.delivered).toBe(true);
      expect(service.sentInvitations).toHaveLength(1);
      expect(service.sentInvitations[0]?.to).toBe('candidate@example.com');

      const withResult = await service.sendWithdrawalVerification({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        withdrawalUrl: 'https://app.talentlens.ai/consent/withdraw#token=xyz',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(withResult.delivered).toBe(true);
      expect(service.sentWithdrawals).toHaveLength(1);
      expect(service.sentWithdrawals[0]?.to).toBe('candidate@example.com');

      const delResult = await service.sendDeletionVerification({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        deletionUrl: 'https://app.talentlens.ai/consent/deletion#token=del123',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(delResult.delivered).toBe(true);
      expect(service.sentDeletions).toHaveLength(1);
      expect(service.sentDeletions[0]?.to).toBe('candidate@example.com');
    });

    it('can simulate delivery failures when configured', async () => {
      const service = new InMemoryEmailDeliveryService();
      service.shouldFail = true;
      service.failureMessage = 'SIMULATED_DELIVERY_FAILURE';
      const result = await service.sendConsentInvitation({
        to: 'candidate@example.com',
        organizationName: 'Acme Corp',
        requisitionTitle: 'Staff Engineer',
        invitationUrl: 'https://app.talentlens.ai/consent#token=abc',
        expiresAt: new Date(Date.now() + 86400000),
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toBe('SIMULATED_DELIVERY_FAILURE');
    });
  });
});
