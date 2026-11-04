import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';

import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { CriterionCategory, RequirementType } from './jd-extraction.types.js';
import type { ExtractedRequirement } from './jd-extraction.types.js';
import type { UpdateScorecardInput } from './scorecard.schemas.js';
import type { JdExtractionOutput } from './jd-extraction.types.js';
import { scorecardMetadataSchema, scorecardWeightsSchema } from './scorecard.metadata.js';
import { criterionContainsDisallowedAttribute } from './scorecard.policy.js';

export interface AuthorizedRequisition {
  id: string;
  title: string;
  jdText: string;
}

export interface ScorecardCriterionRecord {
  id: string;
  key: string;
  label: string;
  category: CriterionCategory;
  requirementType: RequirementType;
  weight: number;
  ruleJson: Record<string, unknown>;
  active: boolean;
  displayOrder: number;
}

export interface ScorecardRecord {
  id: string;
  requisitionId: string;
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'ARCHIVED';
  weightsJson: Record<string, unknown>;
  approvedById: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  criteria: ScorecardCriterionRecord[];
}

export interface ScorecardRepository {
  findAuthorizedRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<AuthorizedRequisition | null>;
  createDraft(
    principal: AuthenticatedPrincipal,
    requisition: AuthorizedRequisition,
    extraction: JdExtractionOutput,
  ): Promise<ScorecardRecord>;
  list(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<ScorecardRecord[]>;
  find(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    scorecardId: string,
  ): Promise<ScorecardRecord | null>;
  updateDraft(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    scorecardId: string,
    input: UpdateScorecardInput,
  ): Promise<ScorecardRecord | null>;
  approve(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    scorecardId: string,
  ): Promise<ScorecardRecord | null>;
}

export class ScorecardCriterionScopeError extends Error {
  constructor() {
    super('Criterion does not belong to scorecard');
    this.name = 'ScorecardCriterionScopeError';
  }
}

type DatabaseScorecardClient = PrismaClient;

const criterionSelect = {
  id: true,
  key: true,
  label: true,
  category: true,
  requirementType: true,
  weight: true,
  ruleJson: true,
  active: true,
  displayOrder: true,
} as const;

const scorecardSelect = {
  id: true,
  requisitionId: true,
  version: true,
  status: true,
  weightsJson: true,
  approvedById: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
  criteria: {
    where: { active: true },
    orderBy: { displayOrder: 'asc' as const },
    select: criterionSelect,
  },
} as const;

type DatabaseScorecardRecord = Prisma.ScorecardVersionGetPayload<{
  select: typeof scorecardSelect;
}>;

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toRecord(record: DatabaseScorecardRecord): ScorecardRecord {
  return {
    ...record,
    weightsJson: jsonRecord(record.weightsJson),
    criteria: record.criteria.map((criterion) => ({
      ...criterion,
      weight: Number(criterion.weight),
      ruleJson: jsonRecord(criterion.ruleJson),
    })),
  };
}

function scope(requisitionId: string, organizationId: string, recruiterId: string) {
  return {
    requisitionId,
    organizationId,
    requisition: { assignedRecruiterId: recruiterId },
  };
}

function criterionData(extraction: JdExtractionOutput) {
  return extraction.criteria.map((criterion, index) => ({
    key: `${criterion.category.toLowerCase()}-${index + 1}`,
    label: criterion.label,
    category: criterion.category,
    requirementType: criterion.requirementType,
    weight: criterion.weight,
    ruleJson: jsonInput({ description: criterion.description, evidence: criterion.evidence }),
    displayOrder: index,
  }));
}

function metadataRequirement(value: ExtractedRequirement | null) {
  return value;
}

function extractionMetadata(extraction: JdExtractionOutput) {
  return scorecardMetadataSchema.parse({
    contractVersion: 1,
    extractionSchemaVersion: 'jd-extraction-v2',
    jobTitle: metadataRequirement(extraction.jobTitle),
    requiredSkills: extraction.requiredSkills,
    preferredSkills: extraction.preferredSkills,
    educationRequirements: extraction.educationRequirements,
    certifications: extraction.certifications,
    domainExperience: extraction.domainExperience,
    experience: {
      minimumYears: extraction.minimumExperienceYears,
      maximumYears: extraction.maximumExperienceYears,
      requirement: extraction.experienceRequirement,
    },
    compensation: extraction.compensation,
    notice: extraction.noticePeriod,
    otherRequirements: extraction.otherRequirements,
    warnings: extraction.warnings,
  });
}

export function isScorecardVersionConflict(target: unknown): boolean {
  if (Array.isArray(target)) {
    const fields = target.map((item) => String(item).toLowerCase());
    return fields.length === 2 && fields.includes('requisitionid') && fields.includes('version');
  }
  if (typeof target === 'string') {
    const normalized = target.toLowerCase();
    return (
      normalized === 'scorecard_versions_requisition_id_version_key' ||
      normalized === 'requisitionid_version' ||
      normalized === 'requisition_id_version' ||
      normalized.includes('requisition_id_version') ||
      normalized.includes('requisitionid_version')
    );
  }
  return false;
}

export function isRetryableConcurrencyError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code === 'P2002') {
    const meta = error.meta as { target?: unknown } | undefined;
    if (!meta) return false;
    return isScorecardVersionConflict(meta.target);
  }
  return false;
}

export async function withConcurrencyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableConcurrencyError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
}

export async function lockRequisitionRow(
  transaction: { $queryRaw: PrismaClient['$queryRaw'] },
  requisitionId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM "requisitions" WHERE id = CAST(${requisitionId} AS uuid) FOR UPDATE`,
  );
}

export function createScorecardRepository(
  database: DatabaseScorecardClient = getDatabaseClient(),
): ScorecardRepository {
  return {
    async findAuthorizedRequisition(organizationId, recruiterId, requisitionId) {
      return database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: { id: true, title: true, jdText: true },
      });
    },

    async createDraft(principal, requisition, extraction) {
      return withConcurrencyRetry(() =>
        database.$transaction(
          async (transaction) => {
            await lockRequisitionRow(transaction, requisition.id);
            const latest = await transaction.scorecardVersion.aggregate({
              where: {
                requisitionId: requisition.id,
                organizationId: principal.organizationId,
              },
              _max: { version: true },
            });
            const version = (latest._max.version ?? 0) + 1;
            const criteria = criterionData(extraction);
            const created = await transaction.scorecardVersion.create({
              data: {
                organizationId: principal.organizationId,
                requisitionId: requisition.id,
                version,
                weightsJson: {
                  contractVersion: 1,
                  scoring: {},
                  extraction: extractionMetadata(extraction),
                },
                criteria: { create: criteria },
              },
            });
            const createdWithCriteria = await transaction.scorecardVersion.findUniqueOrThrow({
              where: { id: created.id },
              select: scorecardSelect,
            });
            await transaction.auditLog.create({
              data: {
                organizationId: principal.organizationId,
                actorId: principal.userId,
                action: 'SCORECARD_DRAFT_GENERATED',
                resourceType: 'ScorecardVersion',
                resourceId: createdWithCriteria.id,
                requisitionId: requisition.id,
                metadataJson: {
                  version: createdWithCriteria.version,
                  criterionCount: criteria.length,
                },
              },
            });
            return toRecord(createdWithCriteria);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    },

    async list(organizationId, recruiterId, requisitionId) {
      const records = await database.scorecardVersion.findMany({
        where: scope(requisitionId, organizationId, recruiterId),
        orderBy: { version: 'desc' },
        select: scorecardSelect,
      });
      return records.map(toRecord);
    },

    async find(organizationId, recruiterId, requisitionId, scorecardId) {
      const record = await database.scorecardVersion.findFirst({
        where: { ...scope(requisitionId, organizationId, recruiterId), id: scorecardId },
        select: scorecardSelect,
      });
      return record ? toRecord(record) : null;
    },

    async updateDraft(principal, requisitionId, scorecardId, input) {
      return database.$transaction(async (transaction) => {
        const current = await transaction.scorecardVersion.findFirst({
          where: {
            ...scope(requisitionId, principal.organizationId, principal.userId),
            id: scorecardId,
            status: 'DRAFT',
          },
          select: { id: true, weightsJson: true },
        });
        if (!current) return null;

        if (input.criteria) {
          const existingCriteria = await transaction.scorecardCriterion.findMany({
            where: { scorecardVersionId: scorecardId },
            select: { id: true, key: true, ruleJson: true },
          });
          const existingById = new Map(
            existingCriteria.map((criterion) => [criterion.id, criterion]),
          );
          const existingKeys = new Set(
            existingCriteria.map((criterion) => criterion.key.toLowerCase()),
          );
          let manualKeyCounter = 1;
          const allocateUniqueManualKey = (): string => {
            while (existingKeys.has(`manual-${manualKeyCounter}`)) {
              manualKeyCounter += 1;
            }
            const key = `manual-${manualKeyCounter}`;
            existingKeys.add(key.toLowerCase());
            return key;
          };

          for (const criterion of input.criteria) {
            if (criterion.id !== undefined && !existingById.has(criterion.id)) {
              throw new ScorecardCriterionScopeError();
            }
            const assignedKey = criterion.key
              ? (existingKeys.add(criterion.key.toLowerCase()), criterion.key)
              : allocateUniqueManualKey();

            if (criterion.id !== undefined) {
              const existing = existingById.get(criterion.id);
              const existingRule = existing ? jsonRecord(existing.ruleJson) : {};
              await transaction.scorecardCriterion.updateMany({
                where: { id: criterion.id, scorecardVersionId: scorecardId },
                data: {
                  key: assignedKey,
                  label: criterion.label,
                  category: criterion.category,
                  requirementType: criterion.requirementType,
                  weight: criterion.weight,
                  ruleJson: jsonInput({
                    ...existingRule,
                    description: criterion.description,
                    ...(criterion.evidence ? { evidence: criterion.evidence } : {}),
                  }),
                  active: criterion.active,
                  displayOrder: criterion.displayOrder,
                },
              });
            } else {
              await transaction.scorecardCriterion.create({
                data: {
                  scorecardVersionId: scorecardId,
                  key: assignedKey,
                  label: criterion.label,
                  category: criterion.category,
                  requirementType: criterion.requirementType,
                  weight: criterion.weight,
                  ruleJson: jsonInput({
                    description: criterion.description,
                    ...(criterion.evidence ? { evidence: criterion.evidence } : {}),
                  }),
                  active: criterion.active,
                  displayOrder: criterion.displayOrder,
                },
              });
            }
          }
        }

        await transaction.scorecardVersion.update({
          where: { id: scorecardId },
          data:
            input.weights === undefined
              ? {}
              : {
                  weightsJson: jsonInput({
                    ...jsonRecord(current.weightsJson),
                    contractVersion: 1,
                    scoring: input.weights,
                  }),
                },
        });
        await transaction.auditLog.create({
          data: {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            action: 'SCORECARD_DRAFT_UPDATED',
            resourceType: 'ScorecardVersion',
            resourceId: scorecardId,
            requisitionId,
            metadataJson: { criteriaUpdated: input.criteria?.length ?? 0 },
          },
        });
        const updated = await transaction.scorecardVersion.findFirst({
          where: {
            ...scope(requisitionId, principal.organizationId, principal.userId),
            id: scorecardId,
          },
          select: scorecardSelect,
        });
        return updated ? toRecord(updated) : null;
      });
    },

    async approve(principal, requisitionId, scorecardId) {
      return withConcurrencyRetry(() =>
        database.$transaction(async (transaction) => {
          await lockRequisitionRow(transaction, requisitionId);
          const current = await transaction.scorecardVersion.findFirst({
            where: {
              ...scope(requisitionId, principal.organizationId, principal.userId),
              id: scorecardId,
              status: 'DRAFT',
            },
            select: {
              weightsJson: true,
              criteria: {
                where: { active: true },
                select: { weight: true, requirementType: true, ruleJson: true, label: true },
              },
            },
          });
          const criteriaAreVerified =
            current?.criteria.every((criterion) => {
              const rule = jsonRecord(criterion.ruleJson);
              const description = typeof rule.description === 'string' ? rule.description : '';
              const evidence =
                typeof rule.evidence === 'object' &&
                rule.evidence !== null &&
                !Array.isArray(rule.evidence)
                  ? (rule.evidence as Record<string, unknown>)
                  : null;
              return (
                criterion.label.trim().length > 0 &&
                typeof rule.description === 'string' &&
                !criterionContainsDisallowedAttribute({
                  label: criterion.label,
                  description,
                  evidence: evidence
                    ? {
                        sourceQuote:
                          typeof evidence.sourceQuote === 'string'
                            ? evidence.sourceQuote
                            : undefined,
                      }
                    : undefined,
                }) &&
                evidence !== null &&
                evidence.verificationStatus === 'VERIFIED'
              );
            }) ?? false;
          const metadataIsValid =
            current !== null && scorecardWeightsSchema.safeParse(current.weightsJson).success;
          if (
            !current ||
            current.criteria.length === 0 ||
            !current.criteria.some((criterion) => criterion.requirementType === 'MUST_HAVE') ||
            !criteriaAreVerified ||
            !metadataIsValid ||
            Math.abs(
              current.criteria.reduce((sum, criterion) => sum + Number(criterion.weight), 0) - 100,
            ) > 0.0001
          ) {
            return null;
          }
          await transaction.scorecardVersion.updateMany({
            where: {
              requisitionId,
              organizationId: principal.organizationId,
              status: 'APPROVED',
              id: { not: scorecardId },
            },
            data: { status: 'ARCHIVED' },
          });
          const result = await transaction.scorecardVersion.updateMany({
            where: {
              ...scope(requisitionId, principal.organizationId, principal.userId),
              id: scorecardId,
              status: 'DRAFT',
            },
            data: { status: 'APPROVED', approvedById: principal.userId, approvedAt: new Date() },
          });
          if (result.count !== 1) return null;

          await transaction.auditLog.create({
            data: {
              organizationId: principal.organizationId,
              actorId: principal.userId,
              action: 'SCORECARD_APPROVED',
              resourceType: 'ScorecardVersion',
              resourceId: scorecardId,
              requisitionId,
              metadataJson: {},
            },
          });
          const approved = await transaction.scorecardVersion.findFirst({
            where: {
              ...scope(requisitionId, principal.organizationId, principal.userId),
              id: scorecardId,
            },
            select: scorecardSelect,
          });
          return approved ? toRecord(approved) : null;
        }),
      );
    },
  };
}
