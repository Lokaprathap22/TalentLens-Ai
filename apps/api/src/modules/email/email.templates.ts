/**
 * HTML Escaping utility to prevent HTML injection in transactional email templates.
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface ConsentInvitationTemplateData {
  candidateName?: string | undefined;
  organizationName: string;
  requisitionTitle: string;
  invitationUrl: string;
  expiresAt: Date;
}

export function renderConsentInvitation(data: ConsentInvitationTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const org = escapeHtml(data.organizationName);
  const title = escapeHtml(data.requisitionTitle);
  const name = data.candidateName ? escapeHtml(data.candidateName) : 'Candidate';
  const url = data.invitationUrl;
  const expiry = data.expiresAt.toUTCString();

  const subject = `Action Required: Consent Authorization for ${data.requisitionTitle} at ${data.organizationName}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Consent Authorization Request</h2>
    <p>Hello ${name},</p>
    <p><strong>${org}</strong> has received your resume for the <strong>${title}</strong> position and invites you to review their data processing policy and authorize recruitment consideration.</p>
    <p>Under privacy compliance regulations, your resume will remain held until you review and confirm your consent.</p>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Review &amp; Authorize Consent</a>
    </div>
    <p style="font-size: 13px; color: #6b7280;">This secure authorization link expires on <strong>${expiry}</strong>.</p>
    <p style="font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px;">If you did not apply for this role or do not wish to be considered, you may decline or simply ignore this email.</p>
  </div>
</body>
</html>`;

  const text = `Hello ${data.candidateName ?? 'Candidate'},

${data.organizationName} has received your resume for the ${data.requisitionTitle} position.

To authorize processing of your application, please review and accept their recruitment consent policy using this link:
${data.invitationUrl}

This link expires on ${data.expiresAt.toUTCString()}.

If you do not wish to be considered, you may decline or ignore this email.`;

  return { subject, html, text };
}

export interface WithdrawalVerificationTemplateData {
  organizationName: string;
  withdrawalUrl: string;
  expiresAt: Date;
}

export function renderWithdrawalVerification(data: WithdrawalVerificationTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const org = escapeHtml(data.organizationName);
  const url = data.withdrawalUrl;
  const expiry = data.expiresAt.toUTCString();

  const subject = `Confirm Consent Withdrawal — ${data.organizationName}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #dc2626; font-size: 20px;">Confirm Consent Withdrawal</h2>
    <p>A request was received to withdraw your candidate consent and cease active processing with <strong>${org}</strong>.</p>
    <p>To confirm that you initiated this request and immediately halt all recruitment processing, please click below:</p>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #dc2626; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Confirm Withdrawal</a>
    </div>
    <p style="font-size: 13px; color: #6b7280;">This confirmation link expires on <strong>${expiry}</strong>.</p>
    <p style="font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px;">If you did not request this withdrawal, please disregard this email. Your active consent will remain intact.</p>
  </div>
</body>
</html>`;

  const text = `Confirm Consent Withdrawal — ${data.organizationName}

A request was received to withdraw your candidate consent and cease active processing with ${data.organizationName}.

To confirm this withdrawal:
${data.withdrawalUrl}

This link expires on ${data.expiresAt.toUTCString()}.

If you did not request this, please disregard this message.`;

  return { subject, html, text };
}

export interface CandidateDeletionVerificationTemplateData {
  organizationName: string;
  deletionUrl: string;
  expiresAt: Date;
}

export function renderCandidateDeletionVerification(
  data: CandidateDeletionVerificationTemplateData,
): {
  subject: string;
  html: string;
  text: string;
} {
  const org = escapeHtml(data.organizationName);
  const url = data.deletionUrl;
  const expiry = data.expiresAt.toUTCString();

  const subject = `Confirm Permanent Data Deletion — ${data.organizationName}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #dc2626; font-size: 20px;">Confirm Permanent Candidate Data Deletion</h2>
    <p>A request was received to permanently erase your candidate data associated with <strong>${org}</strong> under your right to erasure.</p>
    <p>Confirming this request will permanently delete your uploaded CV files, profile records, AI assessments, and consent history, and will irreversibly redact your contact identity.</p>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #dc2626; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Confirm Permanent Deletion</a>
    </div>
    <p style="font-size: 13px; color: #6b7280;">This single-use verification link expires on <strong>${expiry}</strong>.</p>
    <p style="font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px;">If you did not request permanent data erasure, please disregard this email. No records will be deleted without confirmation.</p>
  </div>
</body>
</html>`;

  const text = `Confirm Permanent Data Deletion — ${data.organizationName}

A request was received to permanently erase your candidate data associated with ${data.organizationName}.

Confirming this request will permanently delete your uploaded CV files, profile records, AI assessments, and consent history, and irreversibly redact your contact identity.

To confirm permanent deletion:
${data.deletionUrl}

This single-use verification link expires on ${data.expiresAt.toUTCString()}.

If you did not request this, please disregard this message.`;

  return { subject, html, text };
}

export interface ClientSubmissionTemplateData {
  clientName: string;
  requisitionTitle: string;
  candidateRef: string;
  portalUrl: string;
  advisoryScore?: number | null | undefined;
}

export function renderClientSubmission(data: ClientSubmissionTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const client = escapeHtml(data.clientName);
  const title = escapeHtml(data.requisitionTitle);
  const candRef = escapeHtml(data.candidateRef);
  const url = data.portalUrl;
  const scoreBadge =
    data.advisoryScore !== null && data.advisoryScore !== undefined
      ? `<p><strong>Advisory Match Score:</strong> ${data.advisoryScore}%</p>`
      : '';

  const subject = `New Candidate Submitted: ${data.candidateRef} for ${data.requisitionTitle}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Candidate Submission for Review</h2>
    <p>Dear ${client} Hiring Team,</p>
    <p>A new candidate has been verified, shortlisted, and submitted for your review on the <strong>${title}</strong> requisition.</p>
    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Candidate Reference:</strong> <span style="font-family: monospace;">${candRef}</span></p>
      ${scoreBadge}
      <p style="margin: 0; font-size: 13px; color: #6b7280;">Protected demographic details are masked to ensure fair, unbiased evaluation.</p>
    </div>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Review Candidate Submission</a>
    </div>
  </div>
</body>
</html>`;

  const text = `Candidate Submission for Review — ${data.requisitionTitle}

A candidate has been submitted to ${data.clientName} for ${data.requisitionTitle}:
Candidate Reference: ${data.candidateRef}
${data.advisoryScore !== null && data.advisoryScore !== undefined ? `Advisory Match Score: ${data.advisoryScore}%\n` : ''}
Review the submission and record your feedback here:
${data.portalUrl}`;

  return { subject, html, text };
}

export interface ClientFeedbackTemplateData {
  recruiterName?: string | undefined;
  requisitionTitle: string;
  candidateCode: string;
  decision: 'SHORTLIST' | 'REJECT';
  reason?: string | undefined;
  dashboardUrl: string;
}

export function renderClientFeedback(data: ClientFeedbackTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const recruiter = data.recruiterName ? escapeHtml(data.recruiterName) : 'Recruiter';
  const title = escapeHtml(data.requisitionTitle);
  const code = escapeHtml(data.candidateCode);
  const decisionLabel = data.decision === 'SHORTLIST' ? 'Shortlisted' : 'Declined';
  const decisionTone = data.decision === 'SHORTLIST' ? '#16a34a' : '#4b5563';
  const reasonText = data.reason ? escapeHtml(data.reason) : '';

  const subject = `Client Feedback Received: ${data.candidateCode} (${decisionLabel}) — ${data.requisitionTitle}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Client Feedback Received</h2>
    <p>Hello ${recruiter},</p>
    <p>The client has recorded their feedback for candidate <strong style="font-family: monospace;">${code}</strong> on <strong>${title}</strong>:</p>
    <div style="border-left: 4px solid ${decisionTone}; padding: 12px 16px; background-color: #f9fafb; margin: 20px 0;">
      <p style="margin: 0; font-weight: 600; color: ${decisionTone}; font-size: 15px;">Decision: ${decisionLabel}</p>
      ${reasonText ? `<p style="margin: 8px 0 0 0; font-size: 14px; color: #374151;">"${reasonText}"</p>` : ''}
    </div>
    <div style="margin: 28px 0;">
      <a href="${data.dashboardUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Open Candidate Workspace</a>
    </div>
  </div>
</body>
</html>`;

  const text = `Client Feedback Received — ${data.requisitionTitle}

Candidate: ${data.candidateCode}
Decision: ${decisionLabel}
${data.reason ? `Notes: "${data.reason}"\n` : ''}
Open workspace:
${data.dashboardUrl}`;

  return { subject, html, text };
}

export interface InterviewNotificationTemplateData {
  recipientRole: string;
  candidateCode: string;
  requisitionTitle: string;
  format: string;
  scheduledAt: string;
  timezone: string;
}

export function renderInterviewNotification(data: InterviewNotificationTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const code = escapeHtml(data.candidateCode);
  const title = escapeHtml(data.requisitionTitle);
  const format = escapeHtml(data.format);
  const time = escapeHtml(data.scheduledAt);
  const tz = escapeHtml(data.timezone);

  const subject = `Interview Update: ${data.candidateCode} — ${data.requisitionTitle}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Interview Schedule Update</h2>
    <p>An interview schedule update has been proposed for candidate <strong style="font-family: monospace;">${code}</strong> for <strong>${title}</strong>.</p>
    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Format:</strong> ${format}</p>
      <p style="margin: 0;"><strong>Proposed Time:</strong> ${time} (${tz})</p>
    </div>
  </div>
</body>
</html>`;

  const text = `Interview Update: ${data.candidateCode} — ${data.requisitionTitle}
Format: ${data.format}
Scheduled: ${data.scheduledAt} (${data.timezone})`;

  return { subject, html, text };
}

export interface AccountActivationTemplateData {
  userName?: string | undefined;
  organizationName: string;
  activationUrl: string;
  expiresAt: Date;
}

export function renderAccountActivation(data: AccountActivationTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const org = escapeHtml(data.organizationName);
  const name = data.userName ? escapeHtml(data.userName) : 'Team Member';
  const url = data.activationUrl;
  const expiry = data.expiresAt.toUTCString();

  const subject = `Activate Your TalentLens AI Account — ${data.organizationName}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Welcome to TalentLens AI</h2>
    <p>Hello ${name},</p>
    <p>You have been invited to join <strong>${org}</strong> on TalentLens AI. To activate your account and choose your secure password, please click the link below:</p>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #0f766e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Activate Account</a>
    </div>
    <p style="font-size: 13px; color: #6b7280;">This secure activation link expires on <strong>${expiry}</strong>.</p>
    <p style="font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px;">If you did not expect this invitation, you may safely ignore this email.</p>
  </div>
</body>
</html>`;

  const text = `Hello ${data.userName ?? 'Team Member'},

You have been invited to join ${data.organizationName} on TalentLens AI.

Activate your account and set your password here:
${data.activationUrl}

This link expires on ${data.expiresAt.toUTCString()}.

If you did not expect this invitation, you may safely ignore this email.`;

  return { subject, html, text };
}

export interface PasswordResetTemplateData {
  userName?: string | undefined;
  organizationName: string;
  resetUrl: string;
  expiresAt: Date;
}

export function renderPasswordReset(data: PasswordResetTemplateData): {
  subject: string;
  html: string;
  text: string;
} {
  const org = escapeHtml(data.organizationName);
  const name = data.userName ? escapeHtml(data.userName) : 'User';
  const url = data.resetUrl;
  const expiry = data.expiresAt.toUTCString();

  const subject = `Reset Your TalentLens AI Password — ${data.organizationName}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; background: #ffffff;">
    <h2 style="margin-top: 0; color: #111827; font-size: 20px;">Password Reset Request</h2>
    <p>Hello ${name},</p>
    <p>We received a request to reset the password for your <strong>${org}</strong> account on TalentLens AI. Click the link below to choose a new password:</p>
    <div style="margin: 28px 0;">
      <a href="${url}" style="background-color: #0f766e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Reset Password</a>
    </div>
    <p style="font-size: 13px; color: #6b7280;">This secure reset link expires on <strong>${expiry}</strong>.</p>
    <p style="font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 24px;">If you did not request a password reset, you can safely ignore this email. Your account remains secure.</p>
  </div>
</body>
</html>`;

  const text = `Hello ${data.userName ?? 'User'},

We received a request to reset your password for ${data.organizationName} on TalentLens AI.

Reset your password using this secure link:
${data.resetUrl}

This link expires on ${data.expiresAt.toUTCString()}.

If you did not request a password reset, please ignore this email.`;

  return { subject, html, text };
}
