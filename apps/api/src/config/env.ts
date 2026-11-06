import { fileURLToPath } from 'node:url';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';
import { parseApprovedPolicies } from '../modules/consent/consent.policy.js';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
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
    ASSESSMENT_PROVIDER: z.enum(['openai', 'fake']).optional(),
    ASSESSMENT_OPENAI_API_KEY: z.string().min(1).optional(),
    ASSESSMENT_OPENAI_BASE_URL: z.string().url().optional(),
    ASSESSMENT_OPENAI_MODEL: z.string().min(1).optional(),
    ASSESSMENT_TIMEOUT_MS: z
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
    CONSENT_APPROVED_POLICIES: z.string().optional(),
    CONSENT_APPROVED_POLICY_VERSIONS: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.preprocess(
      (value) => (value ? Number(value) : undefined),
      z.number().int().min(1).max(65535).optional(),
    ),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_OUTBOX_ENCRYPTION_KEY: z.string().optional(),
    EMAIL_OUTBOX_IDEMPOTENCY_SECRET: z.string().optional(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: z.preprocess(
      (v) => v === 'true' || v === true,
      z.boolean().default(false),
    ),
    SCANNER_DRIVER: z.enum(['mock', 'clamav']).default('mock'),
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.preprocess(
      (v) => (v ? Number(v) : undefined),
      z.number().int().min(1).max(65535).optional(),
    ),
    SCANNER_FAIL_CLOSED: z.preprocess((v) => {
      if (v === undefined || v === null || v === '') return true;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v.toLowerCase() !== 'false' && v !== '0';
      return Boolean(v);
    }, z.boolean().default(true)),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') {
      if (value.SCANNER_FAIL_CLOSED === false) {
        context.addIssue({
          code: 'custom',
          path: ['SCANNER_FAIL_CLOSED'],
          message: 'SCANNER_FAIL_CLOSED cannot be false in production and staging',
        });
      }
      if (value.SCANNER_DRIVER === 'clamav' && !value.CLAMAV_HOST) {
        context.addIssue({
          code: 'custom',
          path: ['CLAMAV_HOST'],
          message: 'CLAMAV_HOST is required when SCANNER_DRIVER=clamav',
        });
      }
      if (!value.APP_ORIGIN) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'APP_ORIGIN is required in production and staging',
        });
      }
      if (value.STORAGE_DRIVER === 's3') {
        if (!value.S3_BUCKET) {
          context.addIssue({
            code: 'custom',
            path: ['S3_BUCKET'],
            message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
          });
        }
        if (!value.S3_ACCESS_KEY_ID) {
          context.addIssue({
            code: 'custom',
            path: ['S3_ACCESS_KEY_ID'],
            message: 'S3_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3',
          });
        }
        if (!value.S3_SECRET_ACCESS_KEY) {
          context.addIssue({
            code: 'custom',
            path: ['S3_SECRET_ACCESS_KEY'],
            message: 'S3_SECRET_ACCESS_KEY is required when STORAGE_DRIVER=s3',
          });
        }
      } else if (!value.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
        context.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message:
            'STORAGE_DRIVER=s3 is required in production and staging unless ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true',
        });
      }
    }
    if (value.ASSESSMENT_PROVIDER === 'fake' && value.NODE_ENV !== 'test') {
      context.addIssue({
        code: 'custom',
        path: ['ASSESSMENT_PROVIDER'],
        message: 'ASSESSMENT_PROVIDER=fake is strictly forbidden outside NODE_ENV=test',
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
      ASSESSMENT_PROVIDER,
      ASSESSMENT_OPENAI_API_KEY,
      ASSESSMENT_OPENAI_BASE_URL,
      ASSESSMENT_OPENAI_MODEL,
      ASSESSMENT_TIMEOUT_MS,
      RESUME_STORAGE_ROOT,
      CONSENT_APPROVED_POLICIES,
      CONSENT_APPROVED_POLICY_VERSIONS,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS,
      EMAIL_FROM,
      EMAIL_OUTBOX_ENCRYPTION_KEY,
      EMAIL_OUTBOX_IDEMPOTENCY_SECRET,
    }) => ({
      nodeEnv: NODE_ENV,
      apiPort: API_PORT,
      databaseUrl: DATABASE_URL,
      appOrigin: APP_ORIGIN ?? 'http://localhost:5173',
      aiApiKey: AI_API_KEY,
      aiBaseUrl: AI_BASE_URL,
      aiModel: AI_MODEL,
      aiTimeoutMs: AI_TIMEOUT_MS ?? 30_000,
      assessmentProvider: ASSESSMENT_PROVIDER ?? (NODE_ENV === 'test' ? 'fake' : 'openai'),
      assessmentOpenAiApiKey: ASSESSMENT_OPENAI_API_KEY,
      assessmentOpenAiBaseUrl: ASSESSMENT_OPENAI_BASE_URL,
      assessmentOpenAiModel: ASSESSMENT_OPENAI_MODEL,
      assessmentTimeoutMs: ASSESSMENT_TIMEOUT_MS ?? 30_000,
      resumeStorageRoot: path.isAbsolute(RESUME_STORAGE_ROOT)
        ? path.normalize(RESUME_STORAGE_ROOT)
        : path.resolve(repositoryRoot(), RESUME_STORAGE_ROOT),
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpUser: SMTP_USER,
      smtpPass: SMTP_PASS,
      emailFrom: EMAIL_FROM,
      emailOutboxEncryptionKey: EMAIL_OUTBOX_ENCRYPTION_KEY,
      emailOutboxIdempotencySecret: EMAIL_OUTBOX_IDEMPOTENCY_SECRET,
      approvedPolicies: parseApprovedPolicies(CONSENT_APPROVED_POLICIES),
      approvedPolicyVersions: CONSENT_APPROVED_POLICY_VERSIONS
        ? CONSENT_APPROVED_POLICY_VERSIONS.split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [],
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
  const normalizedInput = {
    ...input,
    API_PORT: input.API_PORT ?? input.PORT,
  };
  const result = environmentSchema.safeParse(normalizedInput);

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
