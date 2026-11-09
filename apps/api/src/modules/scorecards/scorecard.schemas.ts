import { z } from 'zod';
import { evidenceSchema } from './scorecard.metadata.js';
import { scorecardWeightsSchema } from './scorecard.metadata.js';

const categorySchema = z.enum([
  'SKILL',
  'EXPERIENCE',
  'NOTICE',
  'COMPENSATION',
  'OTHER_JOB_RELATED',
]);
const requirementTypeSchema = z.enum(['MUST_HAVE', 'PREFERRED']);

export const emptyGenerationSchema = z.object({}).strict();

export const createScorecardDraftSchema = z
  .object({
    mode: z.enum(['ai', 'manual']).optional(),
    cloneFromVersionId: z.string().uuid().optional(),
  })
  .strict()
  .refine((value) => !(value.mode !== undefined && value.cloneFromVersionId !== undefined), {
    message: 'Cannot specify both mode and cloneFromVersionId',
  });

export type CreateScorecardDraftInput = z.infer<typeof createScorecardDraftSchema>;

export const criterionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    key: z.string().trim().min(1).max(100).optional(),
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).default(''),
    category: categorySchema,
    requirementType: requirementTypeSchema,
    weight: z.number().finite().min(0).max(100),
    displayOrder: z.number().int().min(0).max(10_000),
    active: z.boolean().default(true),
    evidence: evidenceSchema.optional(),
  })
  .strict();

export const updateScorecardSchema = z
  .object({
    weights: scorecardWeightsSchema.shape.scoring.optional(),
    criteria: z.array(criterionInputSchema).max(100).optional(),
  })
  .strict()
  .refine((value) => value.weights !== undefined || value.criteria !== undefined, {
    message: 'At least one field is required',
  });

export type UpdateScorecardInput = z.infer<typeof updateScorecardSchema>;
