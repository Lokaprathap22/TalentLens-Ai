import { createHash } from 'node:crypto';

export const CURRENT_CONSENT_POLICY_VERSION = '2026-11-v1';

export interface ConsentNoticeParams {
  organizationName: string;
  requisitionTitle: string;
  clientName?: string | undefined;
  candidateCode?: string | undefined;
}

export interface GeneratedNotice {
  policyVersion: string;
  noticeText: string;
  noticeTextHash: string;
}

/**
 * Notice template for candidate screening & assessment consent.
 *
 * IMPORTANT LEGAL & PRIVACY NOTICE:
 * This policy text is a structured operational draft reflecting system data processing
 * practices. It DOES NOT constitute legal advice or an authoritative compliance certification.
 * Before deploying to production, this policy content must be formally reviewed, customized,
 * and approved by the hiring organization and its legal/privacy advisors under applicable
 * privacy frameworks (including the Digital Personal Data Protection Act, 2023, and GDPR).
 */
export function generateConsentNotice(params: ConsentNoticeParams): GeneratedNotice {
  if (!params.organizationName?.trim() || !params.requisitionTitle?.trim()) {
    throw new Error(
      'Approved policy notice cannot be generated: missing organization or requisition title',
    );
  }

  const clientDisclosure = params.clientName
    ? `Your application profile, resume text, and AI evaluation summary will be shared with the client organization (${params.clientName.trim()}) for interview selection and placement consideration.`
    : `Your application profile, resume text, and AI evaluation summary will be processed directly by ${params.organizationName.trim()} for hiring evaluation.`;

  const noticeText = [
    `=== TALENTLENS AI — CANDIDATE PROCESSING & EVALUATION CONSENT NOTICE ===`,
    `Policy Version: ${CURRENT_CONSENT_POLICY_VERSION}`,
    ``,
    `1. DATA CONTROLLER & PURPOSE:`,
    `${params.organizationName.trim()} is seeking your explicit consent to collect, securely store, and process your personal data and resume solely for evaluating your candidacy for the position: "${params.requisitionTitle.trim()}".`,
    ``,
    `2. INFORMATION COLLECTED & PROCESSED:`,
    `- Contact details (name, email address, phone number).`,
    `- Professional resume contents (employment history, educational background, certifications, technical and professional skills).`,
    `- Assessment notes and interview feedback recorded during the recruitment process.`,
    ``,
    `3. AI-ASSISTED SCREENING & EVALUATION DISCLOSURE:`,
    `Our recruitment platform utilizes automated document parsing and artificial intelligence algorithms to evaluate alignment between candidate qualifications and job requisition criteria.`,
    ``,
    `4. HUMAN OVERSIGHT & ACCOUNTABILITY:`,
    `AI scoring provides decision support only. Human recruiters review all candidate submissions and make all final shortlisting, interview, and hiring decisions. No candidate is automatically rejected solely by an automated algorithm.`,
    ``,
    `5. THIRD-PARTY & CLIENT DISCLOSURE:`,
    `${clientDisclosure}`,
    ``,
    `6. DATA RETENTION & WITHDRAWAL OF CONSENT:`,
    `You have the right to withdraw your consent at any time without recruiter approval by using the withdrawal link provided in your invitation or through our candidate portal. Upon confirmed withdrawal, automated processing and evaluation for this position halt immediately, active processing jobs are placed on hold, and no further AI screening will occur.`,
    ``,
    `7. STATUTORY REVIEW NOTICE:`,
    `This consent notice reflects organizational data practices and requires review by legal counsel for jurisdictional statutory compliance.`,
  ].join('\n');

  const noticeTextHash = createHash('sha256').update(noticeText, 'utf8').digest('hex');

  return {
    policyVersion: CURRENT_CONSENT_POLICY_VERSION,
    noticeText,
    noticeTextHash,
  };
}

export function computeNoticeHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ApprovedPolicy {
  version: string;
  noticeTextHash: string;
}

/**
 * Parses comma-separated version:hash strings into structured ApprovedPolicy pairs.
 * Format: `<version>:<sha256HexHash>,<version2>:<sha256HexHash>`
 *
 * Example: `2026-11-v1:a1b2c3d4...`
 */
export function parseApprovedPolicies(rawConfig?: string): ApprovedPolicy[] {
  if (!rawConfig || !rawConfig.trim()) return [];
  const entries = rawConfig
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const results: ApprovedPolicy[] = [];

  for (const entry of entries) {
    const colonIndex = entry.indexOf(':');
    if (colonIndex <= 0 || colonIndex === entry.length - 1) continue;
    const version = entry.slice(0, colonIndex).trim();
    const noticeTextHash = entry
      .slice(colonIndex + 1)
      .trim()
      .toLowerCase();
    if (version && /^[a-f0-9]{64}$/.test(noticeTextHash)) {
      results.push({ version, noticeTextHash });
    }
  }

  return results;
}

/**
 * Verifies whether a consent policy version AND its exact noticeTextHash pair
 * have been formally recorded as approved for production use.
 *
 * FAILS CLOSED:
 * A policy notice is approved ONLY if BOTH version and SHA-256 hash match the
 * explicitly configured approved pair. If unconfigured, changed, missing, or
 * mismatched, it returns false. A text change invalidates approval even if
 * the version string is unmodified.
 */
export function isPolicyApproved(
  version: string,
  noticeTextHash: string,
  approvedPolicies?: readonly ApprovedPolicy[] | Set<string>,
): boolean {
  if (!version?.trim() || !noticeTextHash?.trim()) return false;
  const cleanVersion = version.trim();
  const cleanHash = noticeTextHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanHash)) return false;
  if (!approvedPolicies) return false;

  if (approvedPolicies instanceof Set) {
    return (
      approvedPolicies.has(`${cleanVersion}:${cleanHash}`) ||
      approvedPolicies.has(`${cleanVersion}:${cleanHash.toUpperCase()}`)
    );
  }

  return approvedPolicies.some(
    (p) => p.version === cleanVersion && p.noticeTextHash.toLowerCase() === cleanHash,
  );
}

/**
 * @deprecated Use isPolicyApproved(version, noticeTextHash, approvedPolicies) instead.
 */
export function isPolicyVersionApproved(
  version: string,
  approvedVersions?: readonly string[] | Set<string>,
): boolean {
  if (!version || !version.trim()) return false;
  if (!approvedVersions) return false;
  const set = approvedVersions instanceof Set ? approvedVersions : new Set(approvedVersions);
  return set.has(version.trim());
}
