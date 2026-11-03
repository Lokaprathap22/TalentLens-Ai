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
  })
  .transform(({ NODE_ENV, API_PORT, DATABASE_URL }) => ({
    nodeEnv: NODE_ENV,
    apiPort: API_PORT,
    databaseUrl: DATABASE_URL,
  }));

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

function repositoryEnvironmentPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env');
}

export function loadEnvironment(input: EnvironmentInput = process.env): Environment {
  dotenv.config({
    path: repositoryEnvironmentPath(),
    processEnv: input,
    override: false,
  });

  return parseEnvironment(input);
}
