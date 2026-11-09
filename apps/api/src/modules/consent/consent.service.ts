import { createHash, randomBytes } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { EmailDeliveryService } from './consent.email.js';
import { createEmailIdempotencyKey } from '../email/email.crypto.js';
import {
  renderCandidateDeletionVerification,
  renderConsentInvitation,
  renderWithdrawalVerification,
} from '../email/email.templates.js';
import {
  generateConsentNotice,
  isPolicyApproved,
  verifyNoticeIntegrity,
  type ApprovedPolicy,
} from './consent.policy.js';
import type { ConsentRepository } from './consent.repository.js';
import type {
  ConsentAcceptResult,
  ConsentDeclineResult,
  ConsentInvitationDto,
  ConsentNoticeDto,
  ConsentWithdrawalConfirmResult,
  ConsentWithdrawalRequestResult,
  DeletionRequestDto,
  InvitationDeliveryStatus,
  ProcessDeletionResult,
} from './consent.types.js';
import {
  createDocumentStorageService,
  type DocumentStorageService,
} from '../resumes/resume.storage.js';

export class ConsentError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ConsentRoleError extends ConsentError {
  constructor(message = 'Only recruiters can issue consent invitations') {
    super(message, 'ROLE_FORBIDDEN', 403);
    this.name = 'ConsentRoleError';
  }
}

export class ConsentContextNotFoundError extends ConsentError {
  constructor(message = 'Requisition or candidate not found or recruiter not authorized') {
    super(message, 'RESOURCE_NOT_FOUND', 404);
    this.name = 'ConsentContextNotFoundError';
  }
}

export class InvitationInvalidOrExpiredError extends ConsentError {
  constructor(message = 'Invitation is invalid, already consumed, superseded, or expired') {
    super(message, 'INVITATION_INVALID_OR_EXPIRED', 400);
    this.name = 'InvitationInvalidOrExpiredError';
  }
}

export class WithdrawalInvalidOrExpiredError extends ConsentError {
  constructor(message = 'Withdrawal request is invalid, already consumed, or expired') {
    super(message, 'WITHDRAWAL_INVALID_OR_EXPIRED', 400);
    this.name = 'WithdrawalInvalidOrExpiredError';
  }
}

export class ConsentPolicyUnapprovedError extends ConsentError {
  constructor(version: string, noticeTextHash?: string) {
    const details = noticeTextHash ? ` (hash: ${noticeTextHash})` : '';
    super(
      `Consent policy version "${version}"${details} has not been approved for production capture.`,
      'CONSENT_POLICY_UNAPPROVED',
      400,
    );
    this.name = 'ConsentPolicyUnapprovedError';
  }
}

export interface ConsentServiceOptions {
  repository: ConsentRepository;
  emailDeliveryService: EmailDeliveryService;
  storageService?: DocumentStorageService;
  applicationOrigin?: string;
  approvedPolicies?: readonly ApprovedPolicy[] | Set<string>;
  approvedPolicyVersions?: readonly string[] | Set<string>;
}

export interface ConsentService {
  createInvitation(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    email: string,
  ): Promise<ConsentInvitationDto>;

  inspectNotice(token: string): Promise<ConsentNoticeDto>;

  acceptConsent(token: string, confirmationName: string): Promise<ConsentAcceptResult>;

  declineConsent(token: string, reason?: string): Promise<ConsentDeclineResult>;

  requestWithdrawal(email: string, candidateCode?: string): Promise<ConsentWithdrawalRequestResult>;

  confirmWithdrawal(token: string): Promise<ConsentWithdrawalConfirmResult>;

  requestCandidateDeletion(email: string, candidateCode?: string): Promise<{ message: string }>;

  confirmCandidateDeletion(
    token: string,
  ): Promise<{ status: 'COMPLETED'; candidateId: string; deletionRequestId: string }>;

  createDeletionRequest(
    principal: AuthenticatedPrincipal,
    candidateId: string,
  ): Promise<DeletionRequestDto>;

  processDeletionRequest(
    principal: AuthenticatedPrincipal,
    requestId: string,
  ): Promise<ProcessDeletionResult>;
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken.trim(), 'utf8').digest('hex');
}

export function createConsentService(options: ConsentServiceOptions): ConsentService {
  const { repository, emailDeliveryService, approvedPolicies, approvedPolicyVersions } = options;
  const appOrigin = options.applicationOrigin?.replace(/\/+$/, '') ?? 'http://localhost:5173';

  function requireRecruiter(principal: AuthenticatedPrincipal): void {
    if (principal.role !== 'RECRUITER') {
      throw new ConsentRoleError();
    }
  }

  return {
    /**
     * Creates a single-use consent invitation for an assigned requisition and candidate.
     *
     * Candidate Contact Provenance Note:
     * The `email` argument is recruiter-supplied contact data for the candidate. The system
     * treats this as recruiter-asserted contact information, NOT pre-verified candidate contact
     * details, until the candidate independently accesses the tokenized link and confirms.
     */
    async createInvitation(principal, requisitionId, candidateId, email) {
      requireRecruiter(principal);

      const context = await repository.findAuthorizedInvitationContext(
        principal.organizationId,
        principal.userId,
        requisitionId,
        candidateId,
      );

      if (!context) {
        throw new ConsentContextNotFoundError();
      }

      // Generate cryptographically secure, high-entropy 32-byte token
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);

      // Generate immutable server-controlled notice
      const notice = generateConsentNotice({
        organizationName: context.requisition.organizationName,
        requisitionTitle: context.requisition.title,
        clientName: context.requisition.clientName,
        candidateCode: context.candidate.candidateCode,
      });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiration

      // Browser URL fragment prevents token leakage in HTTP headers to server access logs
      const invitationUrl = `${appOrigin}/consent#token=${rawToken}`;

      const renderedEmail = renderConsentInvitation({
        candidateName: context.candidate.candidateCode,
        organizationName: context.requisition.organizationName,
        requisitionTitle: context.requisition.title,
        invitationUrl,
        expiresAt,
      });

      const hashPart = createHash('sha256').update(invitationUrl).digest('hex').slice(0, 16);
      const emailIdempotencyKey = createEmailIdempotencyKey(
        'consent_invitation',
        email,
        `${candidateId}:${requisitionId}:${hashPart}`,
      );

      const invitation = await repository.createInvitation({
        organizationId: principal.organizationId,
        candidateId,
        requisitionId,
        createdById: principal.userId,
        tokenHash,
        email: email.trim().toLowerCase(),
        policyVersion: notice.policyVersion,
        noticeTextHash: notice.noticeTextHash,
        noticeText: notice.noticeText,
        expiresAt,
        emailPayload: {
          subject: renderedEmail.subject,
          html: renderedEmail.html,
          text: renderedEmail.text,
          idempotencyKey: emailIdempotencyKey,
        },
      });

      const delivery = await emailDeliveryService.sendConsentInvitation({
        to: invitation.email,
        candidateName: context.candidate.candidateCode,
        candidateId,
        organizationName: context.requisition.organizationName,
        requisitionTitle: context.requisition.title,
        invitationUrl,
        expiresAt,
        organizationId: principal.organizationId,
        idempotencyKey: emailIdempotencyKey,
        outboxRecordId: invitation.outboxId,
      });

      const deliveryStatus: InvitationDeliveryStatus = delivery.delivered
        ? 'SENT'
        : delivery.error?.includes('EMAIL_DELIVERY_NOT_CONFIGURED')
          ? 'NOT_CONFIGURED'
          : 'FAILED';

      await repository.updateInvitationDelivery(invitation.id, deliveryStatus, delivery.error);

      return {
        ...invitation,
        deliveryStatus,
        deliveryError: delivery.error ?? null,
      };
    },

    async inspectNotice(token) {
      const tokenHash = hashToken(token);
      const noticeData = await repository.findPendingNoticeByTokenHash(tokenHash);

      if (!noticeData) {
        throw new InvitationInvalidOrExpiredError();
      }

      // If stored notice text snapshot exists, verify cryptographic integrity against noticeTextHash
      if (
        noticeData.noticeText &&
        !verifyNoticeIntegrity(noticeData.noticeText, noticeData.noticeTextHash)
      ) {
        throw new ConsentError(
          'Consent notice integrity verification failed: text does not match cryptographic hash',
          'NOTICE_INTEGRITY_COMPROMISED',
          400,
        );
      }

      const noticeText =
        noticeData.noticeText ??
        generateConsentNotice({
          organizationName: noticeData.organizationName,
          requisitionTitle: noticeData.requisitionTitle,
          clientName: noticeData.clientName,
          candidateCode: noticeData.candidateCode,
        }).noticeText;

      let isApproved = isPolicyApproved(
        noticeData.policyVersion,
        noticeData.noticeTextHash,
        approvedPolicies,
        approvedPolicyVersions,
      );

      if (!isApproved && repository.isPolicyApprovedForOrganization) {
        isApproved = await repository.isPolicyApprovedForOrganization(
          noticeData.organizationId,
          noticeData.policyVersion,
        );
      }

      return {
        ...noticeData,
        isPolicyApproved: isApproved,
        noticeText,
      };
    },

    async acceptConsent(token, confirmationName) {
      if (!confirmationName || !confirmationName.trim()) {
        throw new ConsentError(
          'Confirmation legal name is required to accept consent',
          'VALIDATION_ERROR',
          400,
        );
      }
      const tokenHash = hashToken(token);
      const noticeData = await repository.findPendingNoticeByTokenHash(tokenHash);
      if (!noticeData) {
        throw new InvitationInvalidOrExpiredError();
      }

      // If stored notice text snapshot exists, verify cryptographic integrity against noticeTextHash
      if (
        noticeData.noticeText &&
        !verifyNoticeIntegrity(noticeData.noticeText, noticeData.noticeTextHash)
      ) {
        throw new ConsentError(
          'Consent notice integrity verification failed: text does not match cryptographic hash',
          'NOTICE_INTEGRITY_COMPROMISED',
          400,
        );
      }

      let isApproved = isPolicyApproved(
        noticeData.policyVersion,
        noticeData.noticeTextHash,
        approvedPolicies,
        approvedPolicyVersions,
      );

      if (!isApproved && repository.isPolicyApprovedForOrganization) {
        isApproved = await repository.isPolicyApprovedForOrganization(
          noticeData.organizationId,
          noticeData.policyVersion,
        );
      }

      if (!isApproved) {
        throw new ConsentPolicyUnapprovedError(noticeData.policyVersion, noticeData.noticeTextHash);
      }

      const result = await repository.acceptInvitation(tokenHash, confirmationName.trim());

      if (!result) {
        throw new InvitationInvalidOrExpiredError();
      }

      return result;
    },

    async declineConsent(token, reason) {
      const tokenHash = hashToken(token);
      const result = await repository.declineInvitation(tokenHash, reason);

      if (!result) {
        throw new InvitationInvalidOrExpiredError();
      }

      return result;
    },

    async requestWithdrawal(email, candidateCode) {
      const safeResponse: ConsentWithdrawalRequestResult = {
        message:
          'If an active consent record is associated with this email, a verification link has been sent.',
      };

      const normalizedEmail = email.trim().toLowerCase();
      const activeConsents = await repository.findActiveConsentsForEmail(
        normalizedEmail,
        candidateCode,
      );

      // Anti-enumeration: always return the same generic message even if no consents exist
      if (activeConsents.length === 0) {
        return safeResponse;
      }

      // Process withdrawal request for each active consent
      for (const consentItem of activeConsents) {
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration
        const withdrawalUrl = `${appOrigin}/consent/withdraw#token=${rawToken}`;

        const renderedWithdrawal = renderWithdrawalVerification({
          organizationName: consentItem.organizationName,
          withdrawalUrl,
          expiresAt,
        });

        const emailIdempotencyKey = createEmailIdempotencyKey(
          'withdrawal_verification',
          normalizedEmail,
          `${consentItem.consentId}:${tokenHash}`,
        );

        const withdrawalReq = await repository.createWithdrawalRequest({
          organizationId: consentItem.organizationId,
          candidateId: consentItem.candidateId,
          consentId: consentItem.consentId,
          tokenHash,
          email: normalizedEmail,
          expiresAt,
          emailPayload: {
            subject: renderedWithdrawal.subject,
            html: renderedWithdrawal.html,
            text: renderedWithdrawal.text,
            idempotencyKey: emailIdempotencyKey,
          },
        });

        if (!withdrawalReq) {
          continue;
        }

        await emailDeliveryService.sendWithdrawalVerification({
          to: normalizedEmail,
          organizationName: consentItem.organizationName,
          withdrawalUrl,
          expiresAt,
          organizationId: consentItem.organizationId,
          candidateId: consentItem.candidateId,
          idempotencyKey: emailIdempotencyKey,
          outboxRecordId: withdrawalReq.outboxId,
        });
      }

      return safeResponse;
    },

    async confirmWithdrawal(token) {
      const tokenHash = hashToken(token);
      const result = await repository.confirmWithdrawal(tokenHash);

      if (!result) {
        throw new WithdrawalInvalidOrExpiredError();
      }

      return result;
    },

    async requestCandidateDeletion(email, candidateCode) {
      const safeResponse = {
        message:
          'If an active candidate record is associated with this email, a verification link has been sent.',
      };

      const normalizedEmail = email.trim().toLowerCase();
      const candidates = await repository.findCandidatesForDeletionByEmail(
        normalizedEmail,
        candidateCode,
      );

      // Anti-enumeration: always return the identical generic response
      if (candidates.length === 0) {
        return safeResponse;
      }

      for (const candidate of candidates) {
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration
        const deletionUrl = `${appOrigin}/consent/deletion#token=${rawToken}`;

        const renderedDeletion = renderCandidateDeletionVerification({
          organizationName: candidate.organizationName,
          deletionUrl,
          expiresAt,
        });

        const emailIdempotencyKey = createEmailIdempotencyKey(
          'deletion_verification',
          normalizedEmail,
          `${candidate.candidateId}:${tokenHash}`,
        );

        const verification = await repository.createDeletionVerification({
          organizationId: candidate.organizationId,
          candidateId: candidate.candidateId,
          tokenHash,
          email: normalizedEmail,
          expiresAt,
          emailPayload: {
            subject: renderedDeletion.subject,
            html: renderedDeletion.html,
            text: renderedDeletion.text,
            idempotencyKey: emailIdempotencyKey,
          },
        });

        // Skip sending if candidate is no longer ACTIVE or a recent pending verification was coalesced
        if (!verification || verification.coalesced) {
          continue;
        }

        await emailDeliveryService.sendDeletionVerification({
          to: normalizedEmail,
          organizationName: candidate.organizationName,
          deletionUrl,
          expiresAt,
          organizationId: candidate.organizationId,
          candidateId: candidate.candidateId,
          idempotencyKey: emailIdempotencyKey,
          outboxRecordId: verification.outboxId,
        });
      }

      return safeResponse;
    },

    async confirmCandidateDeletion(token) {
      const tokenHash = hashToken(token);
      const storage = options.storageService ?? createDocumentStorageService();
      const result = await repository.confirmCandidateDeletion(tokenHash, async (key: string) => {
        await storage.delete(key);
      });

      if (!result) {
        throw new WithdrawalInvalidOrExpiredError();
      }

      return result;
    },

    async createDeletionRequest(principal, candidateId) {
      if (principal.role !== 'RECRUITER') {
        throw new ConsentRoleError('Only recruiters can create deletion requests');
      }
      return repository.createDeletionRequest(
        principal.organizationId,
        candidateId,
        principal.userId,
      );
    },

    async processDeletionRequest(principal, requestId) {
      if (principal.role !== 'RECRUITER') {
        throw new ConsentRoleError('Only recruiters can process deletion requests');
      }
      const storage = options.storageService ?? createDocumentStorageService();
      return repository.processDeletion(
        principal.organizationId,
        requestId,
        async (key: string) => {
          await storage.delete(key);
        },
        principal.userId,
      );
    },
  };
}
