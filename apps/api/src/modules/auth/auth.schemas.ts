import { z } from 'zod';

export const loginRequestSchema = z.object({
  organization: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const activateAccountSchema = z.object({
  token: z.string().trim().min(10).max(200),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128),
});

export type ActivateAccountRequest = z.infer<typeof activateAccountSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long').max(128),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

export const requestPasswordResetSchema = z.object({
  organization: z.string().trim().min(1).max(200),
  email: z.string().trim().email('Valid work email address is required').max(320),
});

export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetSchema>;

export const confirmPasswordResetSchema = z.object({
  token: z.string().trim().min(10).max(200),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long').max(128),
});

export type ConfirmPasswordResetRequest = z.infer<typeof confirmPasswordResetSchema>;

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(200),
});

export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;
