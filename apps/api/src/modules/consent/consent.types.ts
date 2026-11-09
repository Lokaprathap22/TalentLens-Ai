import type {
  ConsentPurpose,
  ConsentStatus,
  ConsentCaptureMethod,
  ConsentInvitationStatus,
  InvitationDeliveryStatus,
  WithdrawalRequestStatus,
} from '@talentlens/database';

export type {
  ConsentPurpose,
  ConsentStatus,
  ConsentCaptureMethod,
  ConsentInvitationStatus,
  InvitationDeliveryStatus,
  WithdrawalRequestStatus,
};

export interface ConsentInvitationDto {
  id: string;
  candidateId: string;
  requisitionId: string;
  email: string;
  purpose: ConsentPurpose;
  status: ConsentInvitationStatus;
  policyVersion: string;
  noticeTextHash: string;
  noticeText?: string | null;
  deliveryStatus: InvitationDeliveryStatus;
  deliveryError?: string | null;
  expiresAt: string;
  createdAt: string;
  outboxId?: string | undefined;
}

export interface ConsentNoticeData {
  organizationId: string;
  organizationName: string;
  requisitionTitle: string;
  clientName?: string;
  candidateCode?: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  noticeTextHash: string;
  noticeText?: string | null;
  expiresAt: string;
}

export interface ConsentNoticeDto extends ConsentNoticeData {
  isPolicyApproved: boolean;
  noticeText: string;
}

export interface ConsentAcceptResult {
  status: 'ACCEPTED';
  consentId?: string;
  candidateId: string;
  requisitionId: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  capturedAt: string;
  releasedJobCount: number;
}

export interface ConsentDeclineResult {
  status: 'DECLINED';
  candidateId: string;
  requisitionId: string;
}

export interface ConsentWithdrawalRequestResult {
  message: string;
}

export interface ConsentWithdrawalConfirmResult {
  status: 'WITHDRAWN';
  candidateId: string;
  withdrawnAt: string;
  heldJobCount: number;
}

export interface DeletionRequestDto {
  id: string;
  candidateId: string;
  organizationId: string;
  status: 'REQUESTED' | 'PROCESSING' | 'COMPLETED' | 'PARTIALLY_BLOCKED' | 'REJECTED';
  requestedAt: string;
  processedAt?: string | null;
  resultSummary?: string | null;
}

export interface ProcessDeletionResult {
  deletionRequestId: string;
  candidateId: string;
  status: 'COMPLETED';
  deletedResumeCount: number;
  anonymizedRecords: string[];
  processedAt: string;
}
