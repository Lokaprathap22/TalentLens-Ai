import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { ScorecardDto } from './scorecard.dto.js';
import {
  JdProviderAuthError,
  JdProviderConfigurationError,
  JdProviderContentBlockedError,
  JdProviderError,
  JdProviderInvalidRequestError,
  JdProviderNotConfiguredError,
  JdProviderRateLimitError,
  JdProviderRequestError,
  JdProviderResponseError,
  JdProviderTimeoutError,
  type JdExtractionProvider,
  type JdProviderDiagnostics,
} from './jd-extraction.provider.js';
import type { JdExtractionOutput } from './jd-extraction.types.js';
import type { ExtractedEvidence, ExtractedRequirement } from './jd-extraction.types.js';
import {
  createScorecardRepository,
  type ScorecardRecord,
  type ScorecardRepository,
} from './scorecard.repository.js';
import type { CreateScorecardDraftInput, UpdateScorecardInput } from './scorecard.schemas.js';
import {
  criterionContainsDisallowedAttribute,
  containsDisallowedAttribute,
  DISALLOWED_ATTRIBUTE_WARNING,
} from './scorecard.policy.js';

export class ScorecardNotFoundError extends Error {
  constructor() {
    super('Scorecard not found');
    this.name = 'ScorecardNotFoundError';
  }
}

export class ScorecardRoleError extends Error {
  constructor() {
    super('Recruiter role required');
    this.name = 'ScorecardRoleError';
  }
}

export class ScorecardInvalidError extends Error {
  constructor() {
    super('Scorecard is invalid');
    this.name = 'ScorecardInvalidError';
  }
}

export class ScorecardMissingJdError extends Error {
  constructor() {
    super('Job description is missing');
    this.name = 'ScorecardMissingJdError';
  }
}

export class ScorecardDisallowedCriterionError extends Error {
  constructor() {
    super('Scorecard contains a disallowed criterion');
    this.name = 'ScorecardDisallowedCriterionError';
  }
}

export interface ScorecardServiceDependencies {
  repository?: ScorecardRepository;
  extractionProvider: JdExtractionProvider;
}

function requireRecruiter(principal: AuthenticatedPrincipal): void {
  if (principal.role !== 'RECRUITER') throw new ScorecardRoleError();
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}

function toDto(record: ScorecardRecord): ScorecardDto {
  return {
    id: record.id,
    requisitionId: record.requisitionId,
    version: record.version,
    status: record.status,
    weights: jsonRecord(record.weightsJson),
    approvedById: record.approvedById,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    criteria: record.criteria.map((criterion) => ({
      id: criterion.id,
      key: criterion.key,
      label: criterion.label,
      description:
        typeof criterion.ruleJson.description === 'string' ? criterion.ruleJson.description : '',
      category: criterion.category,
      requirementType: criterion.requirementType,
      weight: criterion.weight,
      displayOrder: criterion.displayOrder,
      active: criterion.active,
      evidence:
        typeof criterion.ruleJson.evidence === 'object' &&
          criterion.ruleJson.evidence !== null &&
          !Array.isArray(criterion.ruleJson.evidence)
          ? (criterion.ruleJson.evidence as ScorecardDto['criteria'][number]['evidence'])
          : null,
    })),
  };
}

function normalizeForEvidence(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function findSourceRange(source: string, quote: string): { start: number; end: number } | null {
  const normalizedQuote = normalizeForEvidence(quote);
  if (!normalizedQuote) return null;
  const pattern = normalizedQuote
    .split(' ')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const match = new RegExp(pattern, 'i').exec(source);
  return match?.index === undefined
    ? null
    : { start: match.index, end: match.index + match[0].length };
}

function verifyEvidence(evidence: ExtractedEvidence, jdText: string): ExtractedEvidence {
  const sourceRange = findSourceRange(jdText, evidence.sourceQuote);
  if (!sourceRange) {
    return {
      ...evidence,
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: 'UNVERIFIED',
    };
  }
  return {
    ...evidence,
    sourceStart: sourceRange.start,
    sourceEnd: sourceRange.end,
    verificationStatus: 'PENDING_RECRUITER_REVIEW',
  };
}

function verifyRequirement(
  requirement: ExtractedRequirement,
  jdText: string,
): ExtractedRequirement {
  return { ...requirement, evidence: verifyEvidence(requirement.evidence, jdText) };
}

function groundExtraction(output: JdExtractionOutput, jdText: string): JdExtractionOutput {
  const criteria = output.criteria
    .filter((criterion) => !criterionContainsDisallowedAttribute(criterion))
    .map((criterion) => ({
      ...criterion,
      evidence: verifyEvidence(criterion.evidence, jdText),
    }));
  return {
    ...output,
    jobTitle: output.jobTitle ? verifyRequirement(output.jobTitle, jdText) : null,
    experienceRequirement: output.experienceRequirement
      ? verifyRequirement(output.experienceRequirement, jdText)
      : null,
    requiredSkills: output.requiredSkills.map((value) => verifyRequirement(value, jdText)),
    preferredSkills: output.preferredSkills.map((value) => verifyRequirement(value, jdText)),
    educationRequirements: output.educationRequirements.map((value) =>
      verifyRequirement(value, jdText),
    ),
    certifications: output.certifications.map((value) => verifyRequirement(value, jdText)),
    domainExperience: output.domainExperience.map((value) => verifyRequirement(value, jdText)),
    otherRequirements: output.otherRequirements.map((value) => verifyRequirement(value, jdText)),
    compensation: output.compensation
      ? { ...output.compensation, evidence: verifyEvidence(output.compensation.evidence, jdText) }
      : null,
    noticePeriod: output.noticePeriod
      ? { ...output.noticePeriod, evidence: verifyEvidence(output.noticePeriod.evidence, jdText) }
      : null,
    warnings: [
      ...output.warnings,
      ...(containsDisallowedAttribute(JSON.stringify(output))
        ? [DISALLOWED_ATTRIBUTE_WARNING]
        : []),
    ],
    criteria,
  };
}

function validateExtraction(output: JdExtractionOutput): void {
  if (
    output.minimumExperienceYears !== null &&
    output.maximumExperienceYears !== null &&
    output.maximumExperienceYears < output.minimumExperienceYears
  ) {
    throw new ScorecardInvalidError();
  }
  if (output.criteria.some((criterion) => criterionContainsDisallowedAttribute(criterion))) {
    throw new ScorecardDisallowedCriterionError();
  }
}

function validateApproval(record: ScorecardRecord): void {
  if (record.criteria.length === 0 || !record.criteria.some((criterion) => criterion.active)) {
    throw new ScorecardInvalidError();
  }
  const activeCriteria = record.criteria.filter((criterion) => criterion.active);
  if (
    activeCriteria.some((criterion) => {
      const evidence = criterion.ruleJson.evidence;
      return (
        typeof evidence !== 'object' ||
        evidence === null ||
        Array.isArray(evidence) ||
        (evidence as Record<string, unknown>).verificationStatus !== 'VERIFIED'
      );
    })
  ) {
    throw new ScorecardInvalidError();
  }
  if (
    activeCriteria.some((criterion) =>
      criterionContainsDisallowedAttribute({
        label: criterion.label,
        description:
          typeof criterion.ruleJson.description === 'string' ? criterion.ruleJson.description : '',
        evidence:
          typeof criterion.ruleJson.evidence === 'object' &&
            criterion.ruleJson.evidence !== null &&
            !Array.isArray(criterion.ruleJson.evidence)
            ? (criterion.ruleJson.evidence as { sourceQuote?: string })
            : undefined,
      }),
    )
  ) {
    throw new ScorecardDisallowedCriterionError();
  }
  if (!activeCriteria.every((criterion) => criterion.weight > 0)) {
    throw new ScorecardInvalidError();
  }
  const total = activeCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (Math.abs(total - 100) > 0.0001) throw new ScorecardInvalidError();
  if (!activeCriteria.some((criterion) => criterion.requirementType === 'MUST_HAVE')) {
    throw new ScorecardInvalidError();
  }
}

function validateCriterionKeys(input: UpdateScorecardInput): void {
  if (!input.criteria) return;
  const seenIds = new Set<string>();
  const seenExplicitKeys = new Set<string>();

  for (const criterion of input.criteria) {
    if (criterion.id !== undefined) {
      const normalizedId = criterion.id.trim().toLowerCase();
      if (seenIds.has(normalizedId)) {
        throw new ScorecardInvalidError();
      }
      seenIds.add(normalizedId);
    }

    const explicitKey = criterion.key?.trim();
    if (explicitKey) {
      const normalizedKey = explicitKey.toLowerCase();
      if (seenExplicitKeys.has(normalizedKey)) {
        throw new ScorecardInvalidError();
      }
      seenExplicitKeys.add(normalizedKey);
    }
  }
}

export function createScorecardService(dependencies: ScorecardServiceDependencies) {
  const repository = dependencies.repository ?? createScorecardRepository();

  return {
    async generate(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      options?: CreateScorecardDraftInput,
    ): Promise<ScorecardDto> {
      requireRecruiter(principal);
      if (options?.mode !== undefined && options?.cloneFromVersionId !== undefined) {
        throw new ScorecardInvalidError();
      }

      const requisition = await repository.findAuthorizedRequisition(
        principal.organizationId,
        principal.userId,
        requisitionId,
      );
      if (!requisition) throw new ScorecardNotFoundError();

      if (options?.mode === 'manual') {
        if (!repository.createManualDraft) {
          throw new ScorecardInvalidError();
        }
        return toDto(await repository.createManualDraft(principal, requisition));
      }

      if (options?.cloneFromVersionId !== undefined) {
        if (!repository.cloneDraft) {
          throw new ScorecardInvalidError();
        }
        const cloned = await repository.cloneDraft(
          principal,
          requisition,
          options.cloneFromVersionId,
          (rawEvidence) => {
            if (
              !rawEvidence ||
              typeof rawEvidence.sourceQuote !== 'string' ||
              rawEvidence.sourceQuote.length === 0
            ) {
              return null;
            }
            const verified = verifyEvidence(
              {
                sourceQuote: rawEvidence.sourceQuote,
                sourceStart: null,
                sourceEnd: null,
                verificationStatus: 'PENDING_RECRUITER_REVIEW',
              },
              requisition.jdText,
            );
            return {
              sourceQuote: verified.sourceQuote,
              sourceStart: verified.sourceStart,
              sourceEnd: verified.sourceEnd,
              verificationStatus: verified.verificationStatus,
            };
          },
        );
        if (!cloned) throw new ScorecardNotFoundError();
        return toDto(cloned);
      }

      if (!requisition.jdText.trim()) throw new ScorecardMissingJdError();

      const extraction = await dependencies.extractionProvider.extract({
        jobTitle: requisition.title,
        jdText: requisition.jdText,
      });
      const grounded = groundExtraction(extraction, requisition.jdText);
      validateExtraction(grounded);
      return toDto(await repository.createDraft(principal, requisition, grounded));
    },

    async list(principal: AuthenticatedPrincipal, requisitionId: string): Promise<ScorecardDto[]> {
      requireRecruiter(principal);
      return (await repository.list(principal.organizationId, principal.userId, requisitionId)).map(
        toDto,
      );
    },

    async get(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      scorecardId: string,
    ): Promise<ScorecardDto> {
      requireRecruiter(principal);
      const record = await repository.find(
        principal.organizationId,
        principal.userId,
        requisitionId,
        scorecardId,
      );
      if (!record) throw new ScorecardNotFoundError();
      return toDto(record);
    },

    async update(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      scorecardId: string,
      input: UpdateScorecardInput,
    ): Promise<ScorecardDto> {
      requireRecruiter(principal);
      validateCriterionKeys(input);
      if (
        input.criteria?.some((criterion) =>
          criterionContainsDisallowedAttribute({
            label: criterion.label,
            description: criterion.description,
            evidence: criterion.evidence
              ? { sourceQuote: criterion.evidence.sourceQuote }
              : undefined,
          }),
        )
      ) {
        throw new ScorecardDisallowedCriterionError();
      }
      if (
        input.criteria?.some((criterion) => criterion.evidence?.verificationStatus === 'VERIFIED')
      ) {
        const requisition = await repository.findAuthorizedRequisition(
          principal.organizationId,
          principal.userId,
          requisitionId,
        );
        if (!requisition) throw new ScorecardNotFoundError();
        const verifiedCriteria = input.criteria.map((criterion) => {
          if (criterion.evidence?.verificationStatus !== 'VERIFIED') return criterion;
          const verifiedEvidence = verifyEvidence(criterion.evidence, requisition.jdText);
          if (verifiedEvidence.verificationStatus !== 'PENDING_RECRUITER_REVIEW') {
            throw new ScorecardInvalidError();
          }
          return {
            ...criterion,
            evidence: { ...verifiedEvidence, verificationStatus: 'VERIFIED' as const },
          };
        });
        input = { ...input, criteria: verifiedCriteria };
      }
      const record = await repository.updateDraft(principal, requisitionId, scorecardId, input);
      if (!record) throw new ScorecardNotFoundError();
      return toDto(record);
    },

    async approve(
      principal: AuthenticatedPrincipal,
      requisitionId: string,
      scorecardId: string,
    ): Promise<ScorecardDto> {
      requireRecruiter(principal);
      const current = await repository.find(
        principal.organizationId,
        principal.userId,
        requisitionId,
        scorecardId,
      );
      if (!current) throw new ScorecardNotFoundError();
      if (current.status !== 'DRAFT') throw new ScorecardInvalidError();
      validateApproval(current);

      const approved = await repository.approve(principal, requisitionId, scorecardId);
      if (!approved) throw new ScorecardNotFoundError();
      return toDto(approved);
    },
  };
}

export type ScorecardService = ReturnType<typeof createScorecardService>;
export {
  JdProviderAuthError,
  JdProviderConfigurationError,
  JdProviderContentBlockedError,
  JdProviderError,
  JdProviderInvalidRequestError,
  JdProviderNotConfiguredError,
  JdProviderRateLimitError,
  JdProviderRequestError,
  JdProviderResponseError,
  JdProviderTimeoutError,
  type JdProviderDiagnostics,
};
