import { describe, expect, it } from 'vitest';

import {
  CURRENT_CONSENT_POLICY_VERSION,
  generateConsentNotice,
  isPolicyApproved,
  isPolicyVersionApproved,
  parseApprovedPolicies,
} from './consent.policy.js';

describe('consent policy notice generation', () => {
  it('generates deterministic notice text and SHA-256 hash', () => {
    const notice1 = generateConsentNotice({
      organizationName: 'Acme Corp',
      requisitionTitle: 'Senior Platform Engineer',
      clientName: 'Enterprise Client',
      candidateCode: 'CAN-1234ABCD',
    });

    const notice2 = generateConsentNotice({
      organizationName: 'Acme Corp',
      requisitionTitle: 'Senior Platform Engineer',
      clientName: 'Enterprise Client',
      candidateCode: 'CAN-1234ABCD',
    });

    expect(notice1.policyVersion).toBe(CURRENT_CONSENT_POLICY_VERSION);
    expect(notice1.noticeText).toBe(notice2.noticeText);
    expect(notice1.noticeTextHash).toBe(notice2.noticeTextHash);
    expect(notice1.noticeTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(notice1.noticeText).toContain('Acme Corp');
    expect(notice1.noticeText).toContain('Senior Platform Engineer');
    expect(notice1.noticeText).toContain('Enterprise Client');
  });

  it('generates notice without optional client and candidate code', () => {
    const notice = generateConsentNotice({
      organizationName: 'Apex Talent',
      requisitionTitle: 'Fullstack Developer',
    });

    expect(notice.policyVersion).toBe(CURRENT_CONSENT_POLICY_VERSION);
    expect(notice.noticeText).toContain('Apex Talent');
    expect(notice.noticeText).toContain('Fullstack Developer');
    expect(notice.noticeTextHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects empty or whitespace organization name or requisition title', () => {
    expect(() =>
      generateConsentNotice({
        organizationName: '   ',
        requisitionTitle: 'Engineer',
      }),
    ).toThrow('Approved policy notice cannot be generated');

    expect(() =>
      generateConsentNotice({
        organizationName: 'Acme',
        requisitionTitle: '',
      }),
    ).toThrow('Approved policy notice cannot be generated');
  });

  describe('isPolicyApproved (version + hash binding)', () => {
    const validHash = 'a'.repeat(64);
    const otherHash = 'b'.repeat(64);

    it('approves only when both version AND exact noticeTextHash match', () => {
      const approved = [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: validHash }];
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, validHash, approved)).toBe(true);
    });

    it('fails closed when hash does not match, even if version matches (text change without version bump)', () => {
      const approved = [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: validHash }];
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, otherHash, approved)).toBe(false);
    });

    it('fails closed when version does not match, even if hash matches', () => {
      const approved = [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: validHash }];
      expect(isPolicyApproved('2025-01-v0', validHash, approved)).toBe(false);
    });

    it('fails closed when approvedPolicies is empty or unconfigured', () => {
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, validHash)).toBe(false);
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, validHash, [])).toBe(false);
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, validHash, new Set())).toBe(false);
    });

    it('fails closed when hash is malformed, missing, or non-hex', () => {
      const approved = [{ version: CURRENT_CONSENT_POLICY_VERSION, noticeTextHash: validHash }];
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, '', approved)).toBe(false);
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, 'not-a-hash', approved)).toBe(false);
      expect(isPolicyApproved(CURRENT_CONSENT_POLICY_VERSION, 'a'.repeat(63), approved)).toBe(
        false,
      );
    });
  });

  describe('parseApprovedPolicies', () => {
    it('parses valid comma-separated version:hash pairs', () => {
      const hash1 = '1'.repeat(64);
      const hash2 = '2'.repeat(64);
      const input = `2026-11-v1:${hash1}, 2026-12-v2:${hash2}`;
      const result = parseApprovedPolicies(input);
      expect(result).toEqual([
        { version: '2026-11-v1', noticeTextHash: hash1 },
        { version: '2026-12-v2', noticeTextHash: hash2 },
      ]);
    });

    it('ignores invalid entries missing colon or valid hash', () => {
      const hash = 'a'.repeat(64);
      const input = `invalid-entry, 2026-11-v1:${hash}, badhash:123`;
      const result = parseApprovedPolicies(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ version: '2026-11-v1', noticeTextHash: hash });
    });

    it('returns empty array when configuration is empty or whitespace', () => {
      expect(parseApprovedPolicies()).toEqual([]);
      expect(parseApprovedPolicies('')).toEqual([]);
      expect(parseApprovedPolicies('   ')).toEqual([]);
    });
  });

  describe('isPolicyVersionApproved', () => {
    it('fails closed when approved versions are unconfigured or empty', () => {
      expect(isPolicyVersionApproved(CURRENT_CONSENT_POLICY_VERSION)).toBe(false);
      expect(isPolicyVersionApproved(CURRENT_CONSENT_POLICY_VERSION, [])).toBe(false);
      expect(isPolicyVersionApproved(CURRENT_CONSENT_POLICY_VERSION, new Set())).toBe(false);
    });

    it('returns false for unapproved or mismatched versions', () => {
      expect(isPolicyVersionApproved('2025-01-v0', [CURRENT_CONSENT_POLICY_VERSION])).toBe(false);
      expect(isPolicyVersionApproved('', [CURRENT_CONSENT_POLICY_VERSION])).toBe(false);
      expect(isPolicyVersionApproved('   ', [CURRENT_CONSENT_POLICY_VERSION])).toBe(false);
    });

    it('returns true when version is explicitly approved in array or Set', () => {
      expect(
        isPolicyVersionApproved(CURRENT_CONSENT_POLICY_VERSION, [CURRENT_CONSENT_POLICY_VERSION]),
      ).toBe(true);
      expect(
        isPolicyVersionApproved(
          CURRENT_CONSENT_POLICY_VERSION,
          new Set([CURRENT_CONSENT_POLICY_VERSION, '2026-12-v2']),
        ),
      ).toBe(true);
    });
  });
});
