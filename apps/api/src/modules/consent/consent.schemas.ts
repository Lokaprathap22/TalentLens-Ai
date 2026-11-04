import { z } from 'zod';

export const createConsentInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address')
    .max(320, 'Email must not exceed 320 characters'),
});

export const inspectConsentSchema = z.object({
  token: z.string().trim().min(16, 'Invalid token length').max(128, 'Invalid token length'),
});

export const acceptConsentSchema = z.object({
  token: z.string().trim().min(16, 'Invalid token length').max(128, 'Invalid token length'),
  confirmationName: z
    .string()
    .trim()
    .min(1, 'Confirmation name cannot be empty')
    .max(200, 'Confirmation name must not exceed 200 characters'),
});

export const declineConsentSchema = z.object({
  token: z.string().trim().min(16, 'Invalid token length').max(128, 'Invalid token length'),
  reason: z.string().trim().max(1000, 'Reason must not exceed 1000 characters').optional(),
});

export const requestWithdrawalSchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address')
    .max(320, 'Email must not exceed 320 characters'),
  candidateCode: z.string().trim().max(100).optional(),
});

export const confirmWithdrawalSchema = z.object({
  token: z.string().trim().min(16, 'Invalid token length').max(128, 'Invalid token length'),
});
