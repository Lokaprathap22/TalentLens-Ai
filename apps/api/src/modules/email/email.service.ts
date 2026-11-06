import { createHash } from 'node:crypto';
import { createEmailIdempotencyKey } from './email.crypto.js';
import type {
  ConsentInvitationEmailOptions,
  DeliveryResult,
  EmailDeliveryService,
  WithdrawalVerificationEmailOptions,
} from '../consent/consent.email.js';
import { PostgresEmailOutboxStore, type EmailOutboxStore } from './email.outbox.js';
import { NullEmailProvider } from './email.provider.js';
import {
  renderClientFeedback,
  renderClientSubmission,
  renderConsentInvitation,
  renderInterviewNotification,
  renderWithdrawalVerification,
  type ClientFeedbackTemplateData,
  type ClientSubmissionTemplateData,
  type InterviewNotificationTemplateData,
} from './email.templates.js';
import type { EmailProvider, OutboxRecord, OutboxStatus, RecipientRole } from './email.types.js';

export interface TransactionalEmailServiceOptions {
  provider?: EmailProvider | undefined;
  outboxStore?: EmailOutboxStore | undefined;
  fromAddress?: string | undefined;
  maxAttempts?: number | undefined;
  immediateDispatch?: boolean | undefined;
}

export class TransactionalEmailService implements EmailDeliveryService {
  private readonly provider: EmailProvider;
  private readonly outbox: EmailOutboxStore;
  private readonly fromAddress: string;
  private readonly maxAttempts: number;
  private readonly immediateDispatch: boolean;

  constructor(options: TransactionalEmailServiceOptions = {}) {
    this.provider = options.provider ?? new NullEmailProvider();
    this.outbox = options.outboxStore ?? new PostgresEmailOutboxStore();
    this.fromAddress = options.fromAddress ?? 'notifications@talentlens.ai';
    this.maxAttempts = options.maxAttempts ?? 3;
    this.immediateDispatch = options.immediateDispatch ?? true;
  }

  public getOutboxStore(): EmailOutboxStore {
    return this.outbox;
  }

  public getProvider(): EmailProvider {
    return this.provider;
  }

  /**
   * Dispatches an individual outbox record through the configured provider.
   * If leaseToken is passed, delivery completion will fence against expired stale leases.
   */
  public async dispatchRecord(recordId: string, leaseToken?: string): Promise<DeliveryResult> {
    const record = await this.outbox.getRecord(recordId);
    if (!record) {
      return { delivered: false, error: 'Outbox record not found' };
    }

    if (record.status === 'SENT') {
      return { delivered: true };
    }

    let activeLeaseToken: string | undefined = leaseToken ?? record.leaseToken ?? undefined;

    if (!activeLeaseToken) {
      const acquired = await this.outbox.markSending(record.id);
      if (!acquired) {
        return { delivered: false, error: 'Record already sending, sent, or rejected' };
      }
      const freshRecord = await this.outbox.getRecord(record.id);
      activeLeaseToken = freshRecord?.leaseToken ?? undefined;
    }

    try {
      const result = await this.provider.send({
        to: record.recipientEmail,
        subject: record.subject,
        html: record.html,
        text: record.text,
        idempotencyKey: record.idempotencyKey,
      });

      if (result.success) {
        await this.outbox.markSent(record.id, result.messageId, activeLeaseToken);
        return { delivered: true };
      }

      const errorText = result.error ?? 'Unknown transmission failure';
      await this.outbox.markFailed(
        record.id,
        errorText,
        result.isPermanentFailure,
        activeLeaseToken,
      );
      return { delivered: false, error: errorText };
    } catch (err) {
      const errorMsg = (err as Error)?.message ?? 'Unexpected delivery exception';
      await this.outbox.markFailed(record.id, errorMsg, false, activeLeaseToken);
      return { delivered: false, error: errorMsg };
    }
  }

  /**
   * Processes a batch of pending emails due for sending or retrying.
   * Uses claimForDispatch if supported by the store for atomic locking.
   */
  public async dispatchNextBatch(
    limit = 10,
    workerId = 'dispatcher',
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let pendingRecords: OutboxRecord[] = [];

    if (typeof this.outbox.claimForDispatch === 'function') {
      pendingRecords = await this.outbox.claimForDispatch(workerId, limit);
    } else {
      pendingRecords = await this.outbox.getNextPending(limit);
    }

    let succeeded = 0;
    let failed = 0;

    for (const record of pendingRecords) {
      const res = await this.dispatchRecord(record.id, record.leaseToken ?? undefined);
      if (res.delivered) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }

    return {
      processed: pendingRecords.length,
      succeeded,
      failed,
    };
  }

  /**
   * Implements EmailDeliveryService interface for consent invitations.
   * Supports transactional enqueuing when `options.tx` is passed.
   */
  public async sendConsentInvitation(
    options: ConsentInvitationEmailOptions,
  ): Promise<DeliveryResult> {
    const rendered = renderConsentInvitation({
      candidateName: options.candidateName,
      organizationName: options.organizationName,
      requisitionTitle: options.requisitionTitle,
      invitationUrl: options.invitationUrl,
      expiresAt: options.expiresAt,
    });

    const hashPart = createHash('sha256').update(options.invitationUrl).digest('hex').slice(0, 16);
    const idempotencyKey = createEmailIdempotencyKey('consent_invitation', options.to, hashPart);

    const { record } = await this.outbox.enqueue(
      {
        organizationId: options.organizationId,
        idempotencyKey,
        template: 'consent_invitation',
        recipientEmail: options.to,
        recipientRole: 'CANDIDATE',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        maxAttempts: this.maxAttempts,
        metadata: {
          organizationName: options.organizationName,
          requisitionTitle: options.requisitionTitle,
        },
      },
      options.tx,
    );

    // If enqueue is part of an uncommitted transaction, immediate dispatch must be skipped
    // until after the transaction commits or worker claims it!
    if (this.immediateDispatch && !options.tx && !options.skipImmediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Implements EmailDeliveryService interface for withdrawal verification.
   * Supports transactional enqueuing when `options.tx` is passed.
   */
  public async sendWithdrawalVerification(
    options: WithdrawalVerificationEmailOptions,
  ): Promise<DeliveryResult> {
    const rendered = renderWithdrawalVerification({
      organizationName: options.organizationName,
      withdrawalUrl: options.withdrawalUrl,
      expiresAt: options.expiresAt,
    });

    const hashPart = createHash('sha256').update(options.withdrawalUrl).digest('hex').slice(0, 16);
    const idempotencyKey = createEmailIdempotencyKey(
      'withdrawal_verification',
      options.to,
      hashPart,
    );

    const { record } = await this.outbox.enqueue(
      {
        organizationId: options.organizationId,
        idempotencyKey,
        template: 'withdrawal_verification',
        recipientEmail: options.to,
        recipientRole: 'CANDIDATE',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        maxAttempts: this.maxAttempts,
        metadata: {
          organizationName: options.organizationName,
        },
      },
      options.tx,
    );

    if (this.immediateDispatch && !options.tx && !options.skipImmediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Sends transactional notification to client hiring managers when a candidate is submitted.
   * Supports transactional enqueuing when `data.tx` is passed.
   */
  public async sendClientSubmission(
    data: ClientSubmissionTemplateData & {
      to: string;
      idempotencyKey?: string;
      organizationId?: string;
      tx?: unknown;
      skipImmediateDispatch?: boolean;
    },
  ): Promise<DeliveryResult> {
    const rendered = renderClientSubmission(data);
    const idempotencyKey =
      data.idempotencyKey ??
      createEmailIdempotencyKey(
        'client_submission',
        data.to,
        `${data.requisitionTitle}:${data.candidateRef}`,
      );

    const { record } = await this.outbox.enqueue(
      {
        organizationId: data.organizationId,
        idempotencyKey,
        template: 'client_submission',
        recipientEmail: data.to,
        recipientRole: 'CLIENT_HIRING_MANAGER',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        maxAttempts: this.maxAttempts,
        metadata: {
          clientName: data.clientName,
          candidateRef: data.candidateRef,
          advisoryScore: data.advisoryScore,
        },
      },
      data.tx,
    );

    if (this.immediateDispatch && !data.tx && !data.skipImmediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Sends transactional notification to recruiters when client feedback is recorded.
   * Supports transactional enqueuing when `data.tx` is passed.
   */
  public async sendClientFeedback(
    data: ClientFeedbackTemplateData & {
      to: string;
      idempotencyKey?: string;
      organizationId?: string;
      tx?: unknown;
      skipImmediateDispatch?: boolean;
    },
  ): Promise<DeliveryResult> {
    const rendered = renderClientFeedback(data);
    const idempotencyKey =
      data.idempotencyKey ??
      createEmailIdempotencyKey(
        'client_feedback',
        data.to,
        `${data.candidateCode}:${data.decision}`,
      );

    const { record } = await this.outbox.enqueue(
      {
        organizationId: data.organizationId,
        idempotencyKey,
        template: 'client_feedback',
        recipientEmail: data.to,
        recipientRole: 'RECRUITER',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        maxAttempts: this.maxAttempts,
        metadata: {
          candidateCode: data.candidateCode,
          decision: data.decision,
        },
      },
      data.tx,
    );

    if (this.immediateDispatch && !data.tx && !data.skipImmediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Sends transactional notification for interview updates or proposals (reserved for M9.12).
   */
  public async sendInterviewNotification(
    data: InterviewNotificationTemplateData & {
      to: string;
      recipientRole?: RecipientRole;
      idempotencyKey?: string;
      organizationId?: string;
      tx?: unknown;
      skipImmediateDispatch?: boolean;
    },
  ): Promise<DeliveryResult> {
    const rendered = renderInterviewNotification(data);
    const idempotencyKey =
      data.idempotencyKey ??
      createEmailIdempotencyKey(
        'interview_notification',
        data.to,
        `${data.candidateCode}:${data.scheduledAt}`,
      );

    const { record } = await this.outbox.enqueue(
      {
        organizationId: data.organizationId,
        idempotencyKey,
        template: 'interview_notification',
        recipientEmail: data.to,
        recipientRole: data.recipientRole ?? 'CLIENT_HIRING_MANAGER',
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        maxAttempts: this.maxAttempts,
        metadata: {
          candidateCode: data.candidateCode,
          scheduledAt: data.scheduledAt,
        },
      },
      data.tx,
    );

    if (this.immediateDispatch && !data.tx && !data.skipImmediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Retrieves status of an outbox record.
   */
  public async getOutboxStatus(id: string): Promise<OutboxRecord | null> {
    return this.outbox.getRecord(id);
  }

  /**
   * Manually retries a failed outbox record.
   */
  public async retryEmail(id: string): Promise<DeliveryResult> {
    const record = await this.outbox.manualRetry(id);
    if (!record) {
      return { delivered: false, error: 'Outbox record not found' };
    }

    if (this.immediateDispatch) {
      return this.dispatchRecord(record.id);
    }

    return { delivered: true };
  }

  /**
   * Lists records in outbox matching filter.
   */
  public async listOutbox(filter?: {
    status?: OutboxStatus;
    recipient?: string;
    organizationId?: string;
  }): Promise<OutboxRecord[]> {
    return this.outbox.listRecords(filter);
  }
}
