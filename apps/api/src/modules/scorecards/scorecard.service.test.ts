import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import {
  ScorecardDisallowedCriterionError,
  ScorecardInvalidError,
  ScorecardMissingJdError,
  ScorecardRoleError,
  createScorecardService,
} from './scorecard.service.js';
import type { JdExtractionOutput } from './jd-extraction.types.js';
import type { ScorecardRecord, ScorecardRepository } from './scorecard.repository.js';

const principal: AuthenticatedPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER',
};

const extraction: JdExtractionOutput = {
  jobTitle: {
    originalText: 'Senior Java Developer',
    evidence: {
      sourceQuote: 'Senior Java Developer',
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: 'PENDING_RECRUITER_REVIEW',
    },
  },
  minimumExperienceYears: 5,
  maximumExperienceYears: 10,
  experienceRequirement: null,
  requiredSkills: [
    {
      originalText: 'Java',
      evidence: {
        sourceQuote: 'Java',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
  preferredSkills: [],
  educationRequirements: [],
  certifications: [],
  domainExperience: [],
  compensation: null,
  noticePeriod: null,
  otherRequirements: [],
  warnings: [],
  criteria: [
    {
      category: 'SKILL' as const,
      requirementType: 'MUST_HAVE' as const,
      label: 'Java',
      description: 'Production Java experience',
      weight: 100,
      evidence: {
        sourceQuote: 'Java',
        sourceStart: null,
        sourceEnd: null,
        verificationStatus: 'PENDING_RECRUITER_REVIEW',
      },
    },
  ],
};

function record(status: 'DRAFT' | 'APPROVED' = 'DRAFT'): ScorecardRecord {
  return {
    id: 'scorecard-a',
    requisitionId: 'requisition-a',
    version: 1,
    status,
    weightsJson: {},
    approvedById: null,
    approvedAt: null,
    createdAt: new Date('2026-11-04T00:00:00.000Z'),
    updatedAt: new Date('2026-11-04T00:00:00.000Z'),
    criteria: [
      {
        id: 'criterion-a',
        key: 'skill-1',
        label: 'Java',
        category: 'SKILL' as const,
        requirementType: 'MUST_HAVE' as const,
        weight: 100,
        ruleJson: { description: 'Production Java experience' },
        active: true,
        displayOrder: 0,
      },
    ],
  };
}

function repository(overrides: Partial<ScorecardRepository> = {}): ScorecardRepository {
  return {
    findAuthorizedRequisition: vi.fn(async () => ({
      id: 'requisition-a',
      title: 'Senior Java Developer',
      jdText: 'Need Java experience.',
    })),
    createDraft: vi.fn(async () => record()),
    list: vi.fn(async () => [record()]),
    find: vi.fn(async () => record()),
    updateDraft: vi.fn(async () => record()),
    approve: vi.fn(async () => ({ ...record('APPROVED'), approvedById: principal.userId })),
    ...overrides,
  };
}

describe('scorecard service', () => {
  it('extracts only the saved requisition JD and creates a draft', async () => {
    const repo = repository();
    const provider = { extract: vi.fn(async () => extraction) };
    const service = createScorecardService({ repository: repo, extractionProvider: provider });

    await service.generate(principal, 'requisition-a');

    expect(provider.extract).toHaveBeenCalledWith({
      jobTitle: 'Senior Java Developer',
      jdText: 'Need Java experience.',
    });
    expect(repo.createDraft).toHaveBeenCalledWith(
      principal,
      {
        id: 'requisition-a',
        title: 'Senior Java Developer',
        jdText: 'Need Java experience.',
      },
      expect.objectContaining({
        criteria: [
          expect.objectContaining({
            evidence: expect.objectContaining({
              sourceStart: 5,
              sourceEnd: 9,
              verificationStatus: 'PENDING_RECRUITER_REVIEW',
            }),
          }),
        ],
      }),
    );
  });

  it('rejects a requisition with no saved JD', async () => {
    const repo = repository({
      findAuthorizedRequisition: vi.fn(async () => ({
        id: 'requisition-a',
        title: 'Role',
        jdText: '   ',
      })),
    });
    const provider = { extract: vi.fn(async () => extraction) };
    const service = createScorecardService({ repository: repo, extractionProvider: provider });

    await expect(service.generate(principal, 'requisition-a')).rejects.toBeInstanceOf(
      ScorecardMissingJdError,
    );
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it('never auto-approves generated output', async () => {
    const repo = repository();
    const service = createScorecardService({
      repository: repo,
      extractionProvider: { extract: vi.fn(async () => extraction) },
    });

    const result = await service.generate(principal, 'requisition-a');

    expect(result.status).toBe('DRAFT');
    expect(repo.approve).not.toHaveBeenCalled();
  });

  it('rejects invalid approval weights', async () => {
    const repo = repository({
      find: vi.fn(async () => ({
        ...record(),
        criteria: [
          {
            id: 'criterion-a',
            key: 'skill-1',
            label: 'Java',
            category: 'SKILL' as const,
            requirementType: 'MUST_HAVE' as const,
            weight: 50,
            ruleJson: { description: 'Production Java experience' },
            active: true,
            displayOrder: 0,
          },
        ],
      })),
    });
    const service = createScorecardService({
      repository: repo,
      extractionProvider: { extract: vi.fn(async () => extraction) },
    });

    await expect(service.approve(principal, 'requisition-a', 'scorecard-a')).rejects.toBeInstanceOf(
      ScorecardInvalidError,
    );
    expect(repo.approve).not.toHaveBeenCalled();
  });

  it('marks unsupported evidence as unverified and never trusts provider offsets', async () => {
    const repo = repository();
    const output = {
      ...extraction,
      criteria: [
        {
          ...extraction.criteria[0]!,
          evidence: {
            sourceQuote: 'not in the JD',
            sourceStart: 0,
            sourceEnd: 1,
            verificationStatus: 'VERIFIED' as const,
          },
        },
      ],
    };
    const service = createScorecardService({
      repository: repo,
      extractionProvider: { extract: vi.fn(async () => output) },
    });

    await service.generate(principal, 'requisition-a');

    expect(repo.createDraft).toHaveBeenCalledWith(
      principal,
      expect.anything(),
      expect.objectContaining({
        criteria: [
          expect.objectContaining({
            evidence: {
              sourceQuote: 'not in the JD',
              sourceStart: null,
              sourceEnd: null,
              verificationStatus: 'UNVERIFIED',
            },
          }),
        ],
      }),
    );
  });

  it('requires recruiter verification before approval', async () => {
    const repo = repository({
      find: vi.fn(async () => record()),
    });
    const service = createScorecardService({
      repository: repo,
      extractionProvider: { extract: vi.fn(async () => extraction) },
    });

    await expect(service.approve(principal, 'requisition-a', 'scorecard-a')).rejects.toBeInstanceOf(
      ScorecardInvalidError,
    );
    expect(repo.approve).not.toHaveBeenCalled();
  });

  describe('update verification and protected-attribute defense', () => {
    it('verifies a valid quote from the saved JD and recomputes offsets', async () => {
      const repo = repository({
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'requisition-a',
          title: 'Senior Java Developer',
          jdText: 'Need Java experience.',
        })),
        updateDraft: vi.fn(async (_principal, _reqId, _scId, input) => {
          return {
            ...record(),
            criteria: [
              {
                id: 'criterion-a',
                key: 'skill-1',
                label: 'Java',
                category: 'SKILL' as const,
                requirementType: 'MUST_HAVE' as const,
                weight: 100,
                ruleJson: {
                  description: 'Updated',
                  evidence: input.criteria![0]!.evidence!,
                },
                active: true,
                displayOrder: 0,
              },
            ],
          };
        }),
      });
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      const updated = await service.update(principal, 'requisition-a', 'scorecard-a', {
        criteria: [
          {
            id: 'criterion-a',
            label: 'Java',
            description: 'Updated',
            category: 'SKILL',
            requirementType: 'MUST_HAVE',
            weight: 100,
            displayOrder: 0,
            active: true,
            evidence: {
              sourceQuote: 'Java',
              sourceStart: 999, // bogus caller-supplied offset
              sourceEnd: 1000,
              verificationStatus: 'VERIFIED',
            },
          },
        ],
      });

      expect(repo.updateDraft).toHaveBeenCalledWith(
        principal,
        'requisition-a',
        'scorecard-a',
        expect.objectContaining({
          criteria: [
            expect.objectContaining({
              evidence: {
                sourceQuote: 'Java',
                sourceStart: 5, // correctly recomputed from 'Need Java experience.'
                sourceEnd: 9,
                verificationStatus: 'VERIFIED',
              },
            }),
          ],
        }),
      );
      expect(updated.criteria[0]?.evidence?.verificationStatus).toBe('VERIFIED');
    });

    it('rejects verification if quote is not found in the saved JD', async () => {
      const repo = repository({
        findAuthorizedRequisition: vi.fn(async () => ({
          id: 'requisition-a',
          title: 'Role',
          jdText: 'Need Java experience.',
        })),
      });
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      await expect(
        service.update(principal, 'requisition-a', 'scorecard-a', {
          criteria: [
            {
              id: 'criterion-a',
              label: 'Java',
              description: 'Updated',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
              active: true,
              evidence: {
                sourceQuote: 'Python is required', // not in JD
                sourceStart: null,
                sourceEnd: null,
                verificationStatus: 'VERIFIED',
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ScorecardInvalidError);
    });

    it('rejects a criterion update with a benign label but discriminatory description', async () => {
      const repo = repository();
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      await expect(
        service.update(principal, 'requisition-a', 'scorecard-a', {
          criteria: [
            {
              id: 'criterion-a',
              label: 'Cultural Alignment',
              description: 'Candidates must be under age 30',
              category: 'OTHER_JOB_RELATED',
              requirementType: 'PREFERRED',
              weight: 0,
              displayOrder: 0,
              active: true,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ScorecardDisallowedCriterionError);
    });

    it('rejects a criterion update with a benign label but discriminatory source quote', async () => {
      const repo = repository();
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      await expect(
        service.update(principal, 'requisition-a', 'scorecard-a', {
          criteria: [
            {
              id: 'criterion-a',
              label: 'Physical Presence',
              description: 'Office attendance',
              category: 'OTHER_JOB_RELATED',
              requirementType: 'PREFERRED',
              weight: 0,
              displayOrder: 0,
              active: true,
              evidence: {
                sourceQuote: 'Must submit a recent photograph and marital status',
                sourceStart: null,
                sourceEnd: null,
                verificationStatus: 'PENDING_RECRUITER_REVIEW',
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ScorecardDisallowedCriterionError);
    });

    it('rejects approval if a persisted active criterion contains protected attributes', async () => {
      const draft = record();
      draft.criteria[0]!.ruleJson = {
        description: 'Candidate must be male',
        evidence: {
          sourceQuote: 'Java',
          sourceStart: 0,
          sourceEnd: 4,
          verificationStatus: 'VERIFIED',
        },
      };
      const repo = repository({
        find: vi.fn(async () => draft),
      });
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      await expect(
        service.approve(principal, 'requisition-a', 'scorecard-a'),
      ).rejects.toBeInstanceOf(ScorecardDisallowedCriterionError);
    });

    it('approves successfully when active criteria are verified, weights sum to 100, and no protected attributes', async () => {
      const verifiedRecord = record();
      verifiedRecord.criteria[0]!.ruleJson = {
        description: 'Production Java',
        evidence: {
          sourceQuote: 'Java',
          sourceStart: 0,
          sourceEnd: 4,
          verificationStatus: 'VERIFIED',
        },
      };
      const repo = repository({
        find: vi.fn(async () => verifiedRecord),
        approve: vi.fn(async () => ({
          ...verifiedRecord,
          status: 'APPROVED' as const,
          approvedById: principal.userId,
        })),
      });
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      const approved = await service.approve(principal, 'requisition-a', 'scorecard-a');
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedById).toBe(principal.userId);
    });

    it('rejects update when caller has non-recruiter role', async () => {
      const clientPrincipal: AuthenticatedPrincipal = {
        userId: 'client-user',
        organizationId: 'organization-a',
        role: 'CLIENT_HIRING_MANAGER',
      };
      const repo = repository();
      const service = createScorecardService({
        repository: repo,
        extractionProvider: { extract: vi.fn(async () => extraction) },
      });

      await expect(
        service.update(clientPrincipal, 'requisition-a', 'scorecard-a', {
          criteria: [
            {
              id: 'criterion-a',
              label: 'Java',
              description: 'Java',
              category: 'SKILL',
              requirementType: 'MUST_HAVE',
              weight: 100,
              displayOrder: 0,
              active: true,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ScorecardRoleError);
    });
  });
});
