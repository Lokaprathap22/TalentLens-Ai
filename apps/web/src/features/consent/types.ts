export type ConsentPurpose = 'HIRING_USE';

export type ConsentInvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'SUPERSEDED';

export type ConsentDeliveryStatus = 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

export interface ConsentInvitationDto {
  id: string;
  candidateId: string;
  requisitionId: string;
  email: string;
  purpose: ConsentPurpose;
  status: ConsentInvitationStatus;
  policyVersion: string;
  noticeTextHash: string;
  deliveryStatus: ConsentDeliveryStatus;
  deliveryError: string | null;
  expiresAt: string;
  createdAt: string;
  invitationUrl?: string;
  rawToken?: string;
}

export interface ConsentNoticeDto {
  organizationName: string;
  requisitionTitle: string;
  clientName?: string;
  candidateCode?: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  noticeTextHash: string;
  expiresAt: string;
  isPolicyApproved: boolean;
  noticeText: string;
}

export interface ConsentAcceptResult {
  status: 'ACCEPTED';
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
