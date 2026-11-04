import { fileURLToPath } from 'node:url';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.preprocess(
      (value) => value ?? '4000',
      z
        .string()
        .regex(/^\d+$/, 'API_PORT must be an integer')
        .transform(Number)
        .refine((value) => value >= 1 && value <= 65_535, {
          message: 'API_PORT must be between 1 and 65535',
        }),
    ),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .url('DATABASE_URL must be a valid URL')
      .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
        message: 'DATABASE_URL must use the PostgreSQL protocol',
      }),
    APP_ORIGIN: z
      .string()
      .url('APP_ORIGIN must be a valid URL')
      .refine((value) => {
        try {
          return new URL(value).origin === value;
        } catch {
          return false;
        }
      }, 'APP_ORIGIN must not include a path, query, or fragment')
      .optional(),
    AI_API_KEY: z.string().min(1).optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_MODEL: z.string().min(1).optional(),
    AI_TIMEOUT_MS: z
      .preprocess(
        (value) => value ?? '30000',
        z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .refine((value) => value >= 1_000 && value <= 120_000),
      )
      .optional(),
    RESUME_STORAGE_ROOT: z.string().min(1).default('./storage/resumes'),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && !value.APP_ORIGIN) {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: 'APP_ORIGIN is required in production',
      });
    }
  })
  .transform(
    ({
      NODE_ENV,
      API_PORT,
      DATABASE_URL,
      APP_ORIGIN,
      AI_API_KEY,
      AI_BASE_URL,
      AI_MODEL,
      AI_TIMEOUT_MS,
      RESUME_STORAGE_ROOT,
    }) => ({
      nodeEnv: NODE_ENV,
      apiPort: API_PORT,
      databaseUrl: DATABASE_URL,
      appOrigin: APP_ORIGIN ?? 'http://localhost:5173',
      aiApiKey: AI_API_KEY,
      aiBaseUrl: AI_BASE_URL,
      aiModel: AI_MODEL,
      aiTimeoutMs: AI_TIMEOUT_MS ?? 30_000,
      resumeStorageRoot: path.isAbsolute(RESUME_STORAGE_ROOT)
        ? path.normalize(RESUME_STORAGE_ROOT)
        : path.resolve(repositoryRoot(), RESUME_STORAGE_ROOT),
    }),
  );

export type Environment = z.infer<typeof environmentSchema>;
export type EnvironmentInput = Record<string, string | undefined>;

export class EnvironmentValidationError extends Error {
  constructor(messages: string[]) {
    super(`Invalid runtime environment: ${messages.join('; ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

export function parseEnvironment(input: EnvironmentInput): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const field = issue.path.join('.') || 'environment';
      return `${field}: ${issue.message}`;
    });

    throw new EnvironmentValidationError(messages);
  }

  return result.data;
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
}

function repositoryEnvironmentPath(): string {
  return path.resolve(repositoryRoot(), '.env');
}

export function loadEnvironment(input: EnvironmentInput = process.env): Environment {
  dotenv.config({
    path: repositoryEnvironmentPath(),
    processEnv: input,
    override: false,
  });

  return parseEnvironment(input);
}
