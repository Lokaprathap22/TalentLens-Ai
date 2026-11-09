import { z } from 'zod';

export function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const listCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(100).optional(),
  sortBy: z.enum(['activity', 'score', 'uploadedAt']).default('activity'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  processingStatus: z
    .enum(['PENDING', 'PROCESSING', 'PARSED', 'NEEDS_REVIEW', 'FAILED'])
    .optional(),
  assessmentStatus: z.enum(['COMPLETE', 'NEEDS_REVIEW', 'FAILED']).optional(),
  reviewDecision: z.enum(['REVIEWED', 'NEEDS_REVIEW', 'CLOSED']).optional(),
  submissionStatus: z
    .enum(['SUBMITTED', 'CLIENT_SHORTLISTED', 'CLIENT_REJECTED', 'INTERVIEW_PROPOSED', 'WITHDRAWN'])
    .optional(),
});

export type ListCandidatesQueryInput = z.infer<typeof listCandidatesQuerySchema>;

export const listGlobalCandidatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  requisitionId: z.string().uuid().optional(),
  statusCategory: z
    .enum(['ALL', 'ASSESSED', 'AWAITING_ASSESSMENT', 'NEEDS_REVIEW', 'FAILED'])
    .optional(),
  assessmentStatus: z.enum(['ALL', 'COMPLETE', 'NEEDS_REVIEW', 'FAILED']).optional(),
  reviewStatus: z.enum(['ALL', 'REVIEWED', 'NEEDS_REVIEW', 'NOT_REVIEWED', 'CLOSED']).optional(),
  sortBy: z.enum(['activity', 'score', 'createdAt']).default('activity'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListGlobalCandidatesInput = z.infer<typeof listGlobalCandidatesQuerySchema>;

export const listInterviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z
    .enum(['ALL', 'PROPOSED', 'ACCEPTED', 'REJECTED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED'])
    .optional(),
  statusCategory: z.enum(['ALL', 'UPCOMING', 'PENDING_ACTION', 'COMPLETED', 'PAST']).optional(),
  clientId: z.string().uuid().optional(),
  requisitionId: z.string().uuid().optional(),
  fromDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  toDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  sortBy: z.enum(['startAt', 'createdAt', 'status']).default('startAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListInterviewsInput = Partial<z.infer<typeof listInterviewsQuerySchema>>;

export const recordReviewSchema = z.object({
  decision: z.enum(['REVIEWED', 'NEEDS_REVIEW', 'CLOSED']),
  notesInternal: z.string().max(2000).optional(),
});

export const shortlistCandidateSchema = z.object({
  notesInternal: z.string().max(2000).optional(),
});

export const submitCandidateSchema = z.object({
  notesInternal: z.string().max(2000).optional(),
});

export const clientFeedbackSchema = z
  .object({
    decision: z.enum(['SHORTLIST', 'REJECT']),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'REJECT') {
      if (!data.reason || data.reason.trim().length < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A meaningful decline reason of at least 3 characters is required.',
          path: ['reason'],
        });
      }
    }
  });

export const proposeInterviewSchema = z
  .object({
    proposalId: z.string().uuid().optional(),
    startAt: z
      .string()
      .datetime({ message: 'Must be a valid ISO 8601 datetime string.' })
      .optional(),
    endAt: z.string().datetime({ message: 'Must be a valid ISO 8601 datetime string.' }).optional(),
    proposedAt: z
      .string()
      .datetime({ message: 'Must be a valid ISO 8601 datetime string.' })
      .optional(),
    timezone: z.string().min(2, { message: 'Timezone identifier is required.' }),
    format: z.enum(['VIDEO', 'PHONE', 'IN_PERSON']).default('VIDEO'),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const startStr = data.startAt ?? data.proposedAt;
    if (!startStr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A valid start time (startAt or proposedAt) is required.',
        path: ['startAt'],
      });
      return;
    }
    const startDate = new Date(startStr);
    if (startDate.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Proposed interview time must be strictly in the future.',
        path: [data.startAt ? 'startAt' : 'proposedAt'],
      });
    }

    if (data.endAt) {
      const endDate = new Date(data.endAt);
      if (endDate.getTime() <= startDate.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Interview window end time must be strictly after start time.',
          path: ['endAt'],
        });
      }
    }

    if (!isValidIanaTimezone(data.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid IANA timezone identifier: "${data.timezone}".`,
        path: ['timezone'],
      });
    }
  });

export const rejectInterviewProposalSchema = z.object({
  reason: z
    .string()
    .min(3, { message: 'Rejection reason must be at least 3 characters.' })
    .max(2000),
});

export const proposeAlternativeInterviewSchema = proposeInterviewSchema;

export const candidateTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listClientsQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const createClientSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const updateClientSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.status !== undefined, {
    message: 'At least one field (name or status) must be provided.',
  });

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const inviteClientMemberSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email({ message: 'Enter a valid work email address.' })
      .max(320, { message: 'Email address must not exceed 320 characters.' }),
    name: z
      .string()
      .trim()
      .min(1, { message: 'Name must not be empty if provided.' })
      .max(200, { message: 'Name must not exceed 200 characters.' })
      .optional(),
  })
  .strict();

export type InviteClientMemberInput = z.infer<typeof inviteClientMemberSchema>;
