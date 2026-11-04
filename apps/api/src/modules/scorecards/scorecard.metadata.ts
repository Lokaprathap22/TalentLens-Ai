import { z } from 'zod';

const verificationStatusSchema = z.enum([
  'PENDING_RECRUITER_REVIEW',
  'VERIFIED',
  'UNVERIFIED',
  'REJECTED',
]);

export const evidenceSchema = z.object({
  sourceQuote: z.string().min(1).max(5_000),
  sourceStart: z.number().int().min(0).nullable(),
  sourceEnd: z.number().int().min(0).nullable(),
  verificationStatus: verificationStatusSchema,
});

export const requirementMetadataSchema = z.object({
  originalText: z.string().min(1).max(5_000),
  evidence: evidenceSchema,
});

export const scorecardMetadataSchema = z.object({
  contractVersion: z.literal(1),
  extractionSchemaVersion: z.literal('jd-extraction-v2'),
  jobTitle: requirementMetadataSchema.nullable(),
  requiredSkills: z.array(requirementMetadataSchema),
  preferredSkills: z.array(requirementMetadataSchema),
  educationRequirements: z.array(requirementMetadataSchema),
  certifications: z.array(requirementMetadataSchema),
  domainExperience: z.array(requirementMetadataSchema),
  experience: z.object({
    minimumYears: z.number().min(0).nullable(),
    maximumYears: z.number().min(0).nullable(),
    requirement: requirementMetadataSchema.nullable(),
  }),
  compensation: z
    .object({
      minimum: z.number().min(0).nullable(),
      maximum: z.number().min(0).nullable(),
      currency: z.string().min(1).nullable(),
      period: z.string().min(1).nullable(),
      originalText: z.string().min(1),
      evidence: evidenceSchema,
    })
    .nullable(),
  notice: z
    .object({
      normalizedDays: z.number().int().min(0).nullable(),
      originalUnit: z.string().min(1).nullable(),
      originalText: z.string().min(1),
      evidence: evidenceSchema,
    })
    .nullable(),
  otherRequirements: z.array(requirementMetadataSchema),
  warnings: z.array(z.string().min(1)),
});

export const scorecardWeightsSchema = z.object({
  contractVersion: z.literal(1),
  scoring: z.record(z.string(), z.number().finite().min(0).max(100)),
  extraction: scorecardMetadataSchema,
});

export type ScorecardMetadata = z.infer<typeof scorecardMetadataSchema>;
