import { apiClient } from '../../lib/api-client.js';
import type {
  CandidateDeletionConfirmResult,
  CandidateDeletionRequestResult,
  ConsentAcceptResult,
  ConsentDeclineResult,
  ConsentInvitationDto,
  ConsentNoticeDto,
  ConsentWithdrawalConfirmResult,
  ConsentWithdrawalRequestResult,
} from './types.js';

export async function createConsentInvitation(
  requisitionId: string,
  candidateId: string,
  email: string,
): Promise<ConsentInvitationDto> {
  return apiClient.post<ConsentInvitationDto>(
    `/requisitions/${encodeURIComponent(requisitionId)}/candidates/${encodeURIComponent(candidateId)}/consent-invitations`,
    { email },
  );
}

export async function inspectConsentNotice(token: string): Promise<ConsentNoticeDto> {
  return apiClient.post<ConsentNoticeDto>('/consent/inspect', { token });
}

export async function acceptConsent(
  token: string,
  confirmationName: string,
): Promise<ConsentAcceptResult> {
  return apiClient.post<ConsentAcceptResult>('/consent/accept', {
    token,
    confirmationName,
  });
}

export async function declineConsent(
  token: string,
  reason?: string,
): Promise<ConsentDeclineResult> {
  return apiClient.post<ConsentDeclineResult>('/consent/decline', {
    token,
    ...(reason ? { reason } : {}),
  });
}

export async function requestConsentWithdrawal(
  email: string,
  candidateCode?: string,
): Promise<ConsentWithdrawalRequestResult> {
  return apiClient.post<ConsentWithdrawalRequestResult>('/consent/withdraw/request', {
    email,
    ...(candidateCode ? { candidateCode } : {}),
  });
}

export async function confirmConsentWithdrawal(
  token: string,
): Promise<ConsentWithdrawalConfirmResult> {
  return apiClient.post<ConsentWithdrawalConfirmResult>('/consent/withdraw/confirm', {
    token,
  });
}

export async function requestCandidateDeletion(
  email: string,
  candidateCode?: string,
): Promise<CandidateDeletionRequestResult> {
  return apiClient.post<CandidateDeletionRequestResult>('/consent/deletion/request', {
    email,
    ...(candidateCode ? { candidateCode } : {}),
  });
}

export async function confirmCandidateDeletion(
  token: string,
): Promise<CandidateDeletionConfirmResult> {
  return apiClient.post<CandidateDeletionConfirmResult>('/consent/deletion/confirm', {
    token,
  });
}
