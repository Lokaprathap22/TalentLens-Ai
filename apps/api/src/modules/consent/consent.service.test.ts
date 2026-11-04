import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { InMemoryEmailDeliveryService } from './consent.email.js';
import type { ConsentRepository } from './consent.repository.js';
import { CURRENT_CONSENT_POLICY_VERSION } from './consent.policy.js';
import {
  ConsentContextNotFoundError,
  ConsentError,
  ConsentPolicyUnapprovedError,
  ConsentRoleError,
  createConsentService,
  InvitationInvalidOrExpiredError,
} from './consent.service.js';

const recruiterPrincipal: AuthenticatedPrincipal = {
  userId: 'recruiter-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'RECRUITER',
};

const hiringManagerPrincipal: AuthenticatedPrincipal = {
  userId: 'hm-uuid-1',
  organizationId: 'org-uuid-1',
  role: 'CLIENT_HIRING_MANAGER',
};

describe('consent service unit tests', () => {
  const dummyContext = {
    requisition: {
      id: 'req-1',
      title: 'Principal Software Engineer',
      organizationName: 'Global Tech Corp',
      clientName: 'Big Enterprise',
    },
    candidate: {
      id: 'cand-1',
      candidateCode: 'CAN-12345678',
    },
  };

  it('rejects invitation creation if principal is not a recruiter', async () => {
    const mockRepo: Partial<ConsentRepository> = {};
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });

    await expect(
      service.createInvitation(hiringManagerPrincipal, 'req-1', 'cand-1', 'candidate@example.com'),
    ).rejects.toThrow(ConsentRoleError);
  });

  it('rejects invitation creation if context is not found or unauthorized', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      findAuthorizedInvitationContext: vi.fn().mockResolvedValue(null),
    };
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });

    await expect(
      service.createInvitation(recruiterPrincipal, 'req-1', 'cand-1', 'candidate@example.com'),
    ).rejects.toThrow(ConsentContextNotFoundError);
  });

  it('creates invitation with SHA-256 token hash and URL fragment in email', async () => {
    let savedData: Parameters<ConsentRepository['createInvitation']>[0] | null = null;
    const mockRepo: Partial<ConsentRepository> = {
      findAuthorizedInvitationContext: vi.fn().mockResolvedValue(dummyContext),
      createInvitation: vi.fn().mockImplementation(async (data) => {
        savedData = data;
        return {
          id: 'invitation-1',
          candidateId: data.candidateId,
          requisitionId: data.requisitionId,
          email: data.email,
          purpose: 'HIRING_USE',
          status: 'PENDING',
          policyVersion: data.policyVersion,
          noticeTextHash: data.noticeTextHash,
          deliveryStatus: 'PENDING',
          deliveryError: null,
          expiresAt: data.expiresAt.toISOString(),
          createdAt: new Date().toISOString(),
        };
      }),
      updateInvitationDelivery: vi.fn().mockResolvedValue(undefined),
    };

    const emailService = new InMemoryEmailDeliveryService();
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: emailService,
      applicationOrigin: 'https://app.talentlens.ai',
    });

    const result = await service.createInvitation(
      recruiterPrincipal,
      'req-1',
      'cand-1',
      'Candidate@Example.Com',
    );

    expect(result.id).toBe('invitation-1');
    expect(result.deliveryStatus).toBe('SENT');
    expect(savedData).not.toBeNull();
    expect(savedData!.email).toBe('candidate@example.com');
    // Ensure raw token is not stored in DB, only 64-char hex hash
    expect(savedData!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(emailService.sentInvitations).toHaveLength(1);
    const sentEmail = emailService.sentInvitations[0]!;
    // URL fragment #token=... ensures token is never sent in HTTP header to server access logs
    expect(sentEmail.invitationUrl).toContain('https://app.talentlens.ai/consent#token=');
  });

  it('performs non-consumptive notice inspection without consuming token and reports approval state based on version and hash', async () => {
    const validHash = 'a'.repeat(64);
    const mockRepo: Partial<ConsentRepository> = {
      findPendingNoticeByTokenHash: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isExpired: false,
        organizationName: 'Global Tech Corp',
        requisitionTitle: 'Principal Software Engineer',
        clientName: 'Big Enterprise',
        candidateCode: 'CAN-12345678',
        policyVersion: '2026-11-v1',
        noticeTextHash: validHash,
      }),
    };

    // Unapproved state (unconfigured)
    const unapprovedService = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });
    const unapprovedResult = await unapprovedService.inspectNotice('valid-raw-token-12345678');
    expect(unapprovedResult.organizationName).toBe('Global Tech Corp');
    expect(unapprovedResult.requisitionTitle).toBe('Principal Software Engineer');
    expect(unapprovedResult.policyVersion).toBe('2026-11-v1');
    expect(unapprovedResult.isPolicyApproved).toBe(false);

    // Mismatched hash state (text change without version bump fails closed)
    const mismatchedService = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [{ version: '2026-11-v1', noticeTextHash: 'b'.repeat(64) }],
    });
    const mismatchedResult = await mismatchedService.inspectNotice('valid-raw-token-12345678');
    expect(mismatchedResult.isPolicyApproved).toBe(false);

    // Approved state (both version and exact notice hash match)
    const approvedService = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [{ version: '2026-11-v1', noticeTextHash: validHash }],
    });
    const approvedResult = await approvedService.inspectNotice('valid-raw-token-12345678');
    expect(approvedResult.isPolicyApproved).toBe(true);
  });

  it('throws InvitationInvalidOrExpiredError if notice is not found or expired', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      findPendingNoticeByTokenHash: vi.fn().mockResolvedValue(null),
    };

    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });

    await expect(service.inspectNotice('unknown-raw-token')).rejects.toThrow(
      InvitationInvalidOrExpiredError,
    );
  });

  it('fails closed: rejects acceptance with ConsentPolicyUnapprovedError when policy is not formally approved', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      findPendingNoticeByTokenHash: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        policyVersion: CURRENT_CONSENT_POLICY_VERSION,
        noticeTextHash: 'a'.repeat(64),
        organizationName: 'Global Tech Corp',
        requisitionTitle: 'Engineer',
      }),
      acceptInvitation: vi.fn(),
    };

    // Service with NO approved policies (default unconfigured production state)
    const unapprovedService = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [], // Empty/unapproved
    });

    await expect(
      unapprovedService.acceptConsent('valid-raw-token-123', 'John Doe'),
    ).rejects.toThrow(ConsentPolicyUnapprovedError);
    expect(mockRepo.acceptInvitation).not.toHaveBeenCalled();
  });

  it('fails closed: rejects acceptance when policy text has changed even if version string matches', async () => {
    const approvedHash = 'a'.repeat(64);
    const changedNoticeHash = 'b'.repeat(64);

    const mockRepo: Partial<ConsentRepository> = {
      findPendingNoticeByTokenHash: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        policyVersion: CURRENT_CONSENT_POLICY_VERSION,
        noticeTextHash: changedNoticeHash, // Modified notice text!
        organizationName: 'Global Tech Corp',
        requisitionTitle: 'Engineer',
      }),
      acceptInvitation: vi.fn(),
    };

    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: approvedHash }],
    });

    await expect(service.acceptConsent('valid-raw-token-123', 'John Doe')).rejects.toThrow(
      ConsentPolicyUnapprovedError,
    );
    expect(mockRepo.acceptInvitation).not.toHaveBeenCalled();
  });

  it('accepts consent when both policy version AND exact notice text hash match approved pair', async () => {
    const validHash = 'a'.repeat(64);
    const mockRepo: Partial<ConsentRepository> = {
      findPendingNoticeByTokenHash: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        policyVersion: CURRENT_CONSENT_POLICY_VERSION,
        noticeTextHash: validHash,
        organizationName: 'Global Tech Corp',
        requisitionTitle: 'Engineer',
      }),
      acceptInvitation: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        candidateId: 'cand-1',
        requisitionId: 'req-1',
        consentId: 'consent-1',
        status: 'ACCEPTED',
        releasedJobCount: 2,
        acceptedAt: new Date().toISOString(),
      }),
    };

    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: validHash }],
    });

    const result = await service.acceptConsent('valid-raw-token-123', 'John Doe');
    expect(result.status).toBe('ACCEPTED');
    expect(result.releasedJobCount).toBe(2);
    expect(mockRepo.acceptInvitation).toHaveBeenCalledWith(expect.any(String), 'John Doe');
  });

  it('rejects acceptance if confirmation name is empty or whitespace', async () => {
    const mockRepo: Partial<ConsentRepository> = {};
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
      approvedPolicies: [
        { version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: 'a'.repeat(64) },
      ],
    });

    await expect(service.acceptConsent('valid-raw-token-123', '   ')).rejects.toThrow(ConsentError);
  });

  it('declines consent with optional reason', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      declineInvitation: vi.fn().mockResolvedValue({
        invitationId: 'inv-1',
        status: 'DECLINED',
        declinedAt: new Date().toISOString(),
      }),
    };

    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });

    const result = await service.declineConsent('valid-token', 'No longer looking');
    expect(result.status).toBe('DECLINED');
  });

  it('withdrawal request enforces anti-enumeration when email is unknown', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      findActiveConsentsForEmail: vi.fn().mockResolvedValue([]),
    };
    const emailService = new InMemoryEmailDeliveryService();
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: emailService,
    });

    const result = await service.requestWithdrawal('unknown@example.com');
    // Always returns identical success message
    expect(result.message).toContain('verification link has been sent');
    // But sends zero emails
    expect(emailService.sentWithdrawals).toHaveLength(0);
  });

  it('withdrawal request generates verification email when candidate consent exists', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      findActiveConsentsForEmail: vi.fn().mockResolvedValue([
        {
          id: 'consent-1',
          candidateId: 'cand-1',
          organizationId: 'org-1',
          organizationName: 'Global Tech Corp',
          consentId: 'consent-1',
          requisitionId: 'req-1',
        },
      ]),
      createWithdrawalRequest: vi.fn().mockResolvedValue({ id: 'withdrawal-req-1' }),
    };
    const emailService = new InMemoryEmailDeliveryService();
    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: emailService,
      applicationOrigin: 'https://app.talentlens.ai',
    });

    const result = await service.requestWithdrawal('known@example.com');
    expect(result.message).toContain('verification link has been sent');
    expect(emailService.sentWithdrawals).toHaveLength(1);
    expect(emailService.sentWithdrawals[0]?.withdrawalUrl).toContain(
      'https://app.talentlens.ai/consent/withdraw#token=',
    );
  });

  it('confirms withdrawal and invalidates leases', async () => {
    const mockRepo: Partial<ConsentRepository> = {
      confirmWithdrawal: vi.fn().mockResolvedValue({
        status: 'WITHDRAWN',
        candidateId: 'cand-withdraw-1',
        heldJobCount: 3,
        withdrawnAt: new Date().toISOString(),
      }),
    };

    const service = createConsentService({
      repository: mockRepo as ConsentRepository,
      emailDeliveryService: new InMemoryEmailDeliveryService(),
    });

    const result = await service.confirmWithdrawal('valid-raw-token-withdraw');
    expect(result.status).toBe('WITHDRAWN');
    expect(result.candidateId).toBe('cand-withdraw-1');
    expect(result.heldJobCount).toBe(3);
  });
});
