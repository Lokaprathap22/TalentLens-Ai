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
  deliveryStatus: InvitationDeliveryStatus;
  deliveryError?: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface ConsentNoticeData {
  organizationName: string;
  requisitionTitle: string;
  clientName?: string;
  candidateCode?: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  noticeTextHash: string;
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
