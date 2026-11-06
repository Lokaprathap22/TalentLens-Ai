export type EmailTemplateType =
  | 'consent_invitation'
  | 'withdrawal_verification'
  | 'client_submission'
  | 'client_feedback'
  | 'interview_notification';

export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'PERMANENTLY_REJECTED';

export type RecipientRole = 'CANDIDATE' | 'CLIENT_HIRING_MANAGER' | 'RECRUITER';

export interface OutboxRecord {
  id: string;
  organizationId?: string | null | undefined;
  idempotencyKey: string;
  template: EmailTemplateType;
  recipientEmail: string;
  recipientRole: RecipientRole;
  subject: string;
  html: string;
  text: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: string | undefined;
  nextAttemptAt?: string | undefined;
  leaseToken?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
  lockedBy?: string | null | undefined;
  lastError?: string | undefined;
  lastErrorCode?: string | undefined;
  sentAt?: string | undefined;
  createdAt: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface EnqueueEmailInput {
  organizationId?: string | undefined;
  idempotencyKey: string;
  template: EmailTemplateType;
  recipientEmail: string;
  recipientRole: RecipientRole;
  subject: string;
  html: string;
  text: string;
  metadata?: Record<string, unknown> | undefined;
  maxAttempts?: number | undefined;
}

export interface ProviderSendResult {
  success: boolean;
  messageId?: string | undefined;
  error?: string | undefined;
  isPermanentFailure?: boolean | undefined;
}

export interface EmailProvider {
  send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey?: string | undefined;
  }): Promise<ProviderSendResult>;
}

export interface EmailServiceConfig {
  provider: EmailProvider;
  fromAddress: string;
  maxAttempts?: number | undefined;
  dispatchTimeoutMs?: number | undefined;
}
