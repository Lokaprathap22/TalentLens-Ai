import { z } from 'zod';

export const assessmentParamsSchema = z.object({
  requisitionId: z.string().uuid({ message: 'requisitionId must be a valid UUID' }),
  resumeId: z.string().uuid({ message: 'resumeId must be a valid UUID' }).optional(),
  assessmentId: z.string().uuid({ message: 'assessmentId must be a valid UUID' }).optional(),
});

export const assessmentListQuerySchema = z.object({
  resumeDocumentId: z.string().uuid().optional(),
  status: z.enum(['COMPLETE', 'NEEDS_REVIEW', 'FAILED']).optional(),
});

export const providerCriterionOutputSchema = z.object({
  criterionId: z.string().uuid({ message: 'criterionId must be a valid UUID' }),
  status: z.enum(['MATCH', 'PARTIAL', 'NOT_FOUND', 'UNCERTAIN']),
  score: z.number().min(0).max(1).nullable(),
  explanation: z.string().trim().min(1).max(2000),
  evidenceQuotes: z.array(z.string().trim().min(1).max(1000)).max(10),
});

export const providerOutputSchema = z.object({
  criteria: z.array(providerCriterionOutputSchema).min(1).max(50),
});
