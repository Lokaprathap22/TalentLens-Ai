import { z } from 'zod';

const requisitionFields = {
  clientId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  jdText: z.string().trim().min(1).max(100_000),
};

export const createRequisitionSchema = z.object(requisitionFields).strict();

export const updateRequisitionSchema = z
  .object({
    clientId: requisitionFields.clientId.optional(),
    title: requisitionFields.title.optional(),
    jdText: requisitionFields.jdText.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export const transitionRequisitionStatusSchema = z
  .object({
    status: z.enum(['OPEN', 'PAUSED', 'CLOSED', 'FILLED']),
  })
  .strict();

export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionSchema>;
export type TransitionRequisitionStatusInput = z.infer<typeof transitionRequisitionStatusSchema>;
export type TransitionTargetStatus = TransitionRequisitionStatusInput['status'];
