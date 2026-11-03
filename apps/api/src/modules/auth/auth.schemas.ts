import { z } from 'zod';

export const loginRequestSchema = z.object({
  organization: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
