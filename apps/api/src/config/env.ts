import { fileURLToPath } from 'node:url';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';
import {
  CANONICAL_GEMINI_FALLBACK_MODEL,
  CANONICAL_GEMINI_MODEL,
  CANONICAL_GROQ_MODEL,
  DEFAULT_AI_PROVIDER_ORDER,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DEFAULT_GROQ_BASE_URL,
  parseAiProviderOrder,
  resolveGeminiModelPair,
  validateGeminiModelId,
  validateGroqBaseUrl,
  validateGroqModelId,
  type AiProviderId,
} from '@talentlens/assessment-engine';
import { parseApprovedPolicies } from '../modules/consent/consent.policy.js';

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    API_PORT: z.preprocess(
      (value) => value ?? '3000',
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
    APP_ORIGIN: z.preprocess(
      emptyStringToUndefined,
      z
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
    ),
    GEMINI_API_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GEMINI_MODEL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GEMINI_FALLBACK_MODEL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GEMINI_TIMEOUT_MS: z
      .preprocess(
        emptyStringToUndefined,
        z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .refine((value) => value >= 1_000 && value <= 120_000)
          .optional(),
      )
      .optional(),
    AI_API_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    AI_MODEL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    AI_FALLBACK_MODEL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    AI_TIMEOUT_MS: z
      .preprocess(
        emptyStringToUndefined,
        z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .refine((value) => value >= 1_000 && value <= 120_000)
          .optional(),
      )
      .optional(),
    AI_PROVIDER_ORDER: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GROQ_API_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GROQ_MODEL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GROQ_BASE_URL: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    GROQ_TIMEOUT_MS: z
      .preprocess(
        emptyStringToUndefined,
        z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .refine((value) => value >= 1_000 && value <= 120_000)
          .optional(),
      )
      .optional(),
    ASSESSMENT_PROVIDER: z.preprocess(
      emptyStringToUndefined,
      z.enum(['gemini', 'groq', 'auto', 'fake']).optional(),
    ),
    TRUSTED_PROXY_IPS: z.preprocess(emptyStringToUndefined, z.string().optional()),
    RESUME_STORAGE_ROOT: z.string().min(1).default('./storage/resumes'),
    CONSENT_APPROVED_POLICIES: z.preprocess(emptyStringToUndefined, z.string().optional()),
    CONSENT_APPROVED_POLICY_VERSIONS: z.preprocess(emptyStringToUndefined, z.string().optional()),
    SMTP_HOST: z.preprocess(emptyStringToUndefined, z.string().optional()),
    SMTP_PORT: z.preprocess(
      (value) => (value && String(value).trim() !== '' ? Number(value) : undefined),
      z.number().int().min(1).max(65535).optional(),
    ),
    SMTP_USER: z.preprocess(emptyStringToUndefined, z.string().optional()),
    SMTP_PASS: z.preprocess(emptyStringToUndefined, z.string().optional()),
    EMAIL_FROM: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
    EMAIL_OUTBOX_ENCRYPTION_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
    EMAIL_OUTBOX_IDEMPOTENCY_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_BUCKET: z.preprocess(emptyStringToUndefined, z.string().optional()),
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
    S3_ACCESS_KEY_ID: z.preprocess(emptyStringToUndefined, z.string().optional()),
    S3_SECRET_ACCESS_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: z.preprocess(
      (v) => v === 'true' || v === true,
      z.boolean().default(false),
    ),
    SCANNER_DRIVER: z.enum(['mock', 'clamav']).default('mock'),
    CLAMAV_HOST: z.preprocess(emptyStringToUndefined, z.string().optional()),
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
      if (value.NODE_ENV === 'production') {
        if (!value.TRUSTED_PROXY_IPS || value.TRUSTED_PROXY_IPS.trim() === '') {
          context.addIssue({
            code: 'custom',
            path: ['TRUSTED_PROXY_IPS'],
            message: 'TRUSTED_PROXY_IPS is strictly required and cannot be empty in production',
          });
        }
      }
      if (!value.APP_ORIGIN) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'APP_ORIGIN is required in production and staging',
        });
      } else if (value.NODE_ENV === 'production' && !value.APP_ORIGIN.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'APP_ORIGIN must use HTTPS in production',
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
      } else if (value.NODE_ENV === 'production') {
        context.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message:
            'STORAGE_DRIVER=s3 is strictly required in production; local storage is not permitted',
        });
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
    if (
      value.NODE_ENV === 'production' &&
      value.ASSESSMENT_PROVIDER &&
      value.ASSESSMENT_PROVIDER !== 'gemini' &&
      value.ASSESSMENT_PROVIDER !== 'groq' &&
      value.ASSESSMENT_PROVIDER !== 'auto'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ASSESSMENT_PROVIDER'],
        message: 'ASSESSMENT_PROVIDER must be "gemini", "groq", or "auto" in production',
      });
    }
    if (value.AI_PROVIDER_ORDER !== undefined) {
      const parsedOrder = parseAiProviderOrder(value.AI_PROVIDER_ORDER);
      if (!parsedOrder.ok) {
        context.addIssue({
          code: 'custom',
          path: ['AI_PROVIDER_ORDER'],
          message: parsedOrder.reason,
        });
      }
    }
    if (value.GROQ_MODEL !== undefined) {
      const check = validateGroqModelId(value.GROQ_MODEL);
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['GROQ_MODEL'],
          message: check.reason,
        });
      }
    }
    if (value.GROQ_BASE_URL !== undefined) {
      const allowInsecure = value.NODE_ENV === 'development' || value.NODE_ENV === 'test';
      const check = validateGroqBaseUrl(value.GROQ_BASE_URL, {
        allowInsecureHttp: allowInsecure,
      });
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['GROQ_BASE_URL'],
          message: check.reason,
        });
      }
    }
    if (value.GEMINI_MODEL !== undefined) {
      const check = validateGeminiModelId(value.GEMINI_MODEL, 'primary');
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['GEMINI_MODEL'],
          message: check.reason,
        });
      }
    }
    if (value.AI_MODEL !== undefined) {
      const check = validateGeminiModelId(value.AI_MODEL, 'primary');
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['AI_MODEL'],
          message: check.reason,
        });
      }
    }
    if (value.GEMINI_FALLBACK_MODEL !== undefined) {
      const check = validateGeminiModelId(value.GEMINI_FALLBACK_MODEL, 'fallback');
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['GEMINI_FALLBACK_MODEL'],
          message: check.reason,
        });
      }
    }
    if (value.AI_FALLBACK_MODEL !== undefined) {
      const check = validateGeminiModelId(value.AI_FALLBACK_MODEL, 'fallback');
      if (!check.valid) {
        context.addIssue({
          code: 'custom',
          path: ['AI_FALLBACK_MODEL'],
          message: check.reason,
        });
      }
    }
  })
  .transform(
    ({
      NODE_ENV,
      API_PORT,
      DATABASE_URL,
      APP_ORIGIN,
      GEMINI_API_KEY,
      GEMINI_MODEL,
      GEMINI_FALLBACK_MODEL,
      GEMINI_TIMEOUT_MS,
      AI_API_KEY,
      AI_MODEL,
      AI_FALLBACK_MODEL,
      AI_TIMEOUT_MS,
      AI_PROVIDER_ORDER,
      GROQ_API_KEY,
      GROQ_MODEL,
      GROQ_BASE_URL,
      GROQ_TIMEOUT_MS,
      ASSESSMENT_PROVIDER,
      RESUME_STORAGE_ROOT,
      CONSENT_APPROVED_POLICIES,
      CONSENT_APPROVED_POLICY_VERSIONS,
      TRUSTED_PROXY_IPS,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS,
      EMAIL_FROM,
      EMAIL_OUTBOX_ENCRYPTION_KEY,
      EMAIL_OUTBOX_IDEMPOTENCY_SECRET,
    }) => {
      const canonicalGeminiKey = GEMINI_API_KEY ?? AI_API_KEY;
      const modelPair = resolveGeminiModelPair({
        primaryModel: GEMINI_MODEL ?? AI_MODEL ?? CANONICAL_GEMINI_MODEL,
        fallbackModel:
          GEMINI_FALLBACK_MODEL ?? AI_FALLBACK_MODEL ?? CANONICAL_GEMINI_FALLBACK_MODEL,
      });
      const canonicalGeminiModel = modelPair.ok
        ? modelPair.value.primaryModel
        : CANONICAL_GEMINI_MODEL;
      const canonicalGeminiFallbackModel = modelPair.ok ? modelPair.value.fallbackModel : null;
      const canonicalGeminiTimeout =
        GEMINI_TIMEOUT_MS ?? AI_TIMEOUT_MS ?? DEFAULT_GEMINI_TIMEOUT_MS;
      const orderCheck = parseAiProviderOrder(
        AI_PROVIDER_ORDER ?? (ASSESSMENT_PROVIDER === 'groq' ? 'groq' : undefined),
      );
      const aiProviderOrder: AiProviderId[] = orderCheck.ok
        ? orderCheck.order
        : [...DEFAULT_AI_PROVIDER_ORDER];
      const groqModelCheck = GROQ_MODEL ? validateGroqModelId(GROQ_MODEL) : undefined;
      const groqModel =
        groqModelCheck && groqModelCheck.valid ? groqModelCheck.model : CANONICAL_GROQ_MODEL;
      const groqBaseUrlCheck = GROQ_BASE_URL
        ? validateGroqBaseUrl(GROQ_BASE_URL, {
            allowInsecureHttp: NODE_ENV === 'development' || NODE_ENV === 'test',
          })
        : undefined;
      const groqBaseUrl =
        groqBaseUrlCheck && groqBaseUrlCheck.valid
          ? groqBaseUrlCheck.baseUrl
          : DEFAULT_GROQ_BASE_URL;
      const groqTimeoutMs = GROQ_TIMEOUT_MS ?? AI_TIMEOUT_MS ?? canonicalGeminiTimeout;
      return {
        nodeEnv: NODE_ENV,
        apiPort: API_PORT,
        databaseUrl: DATABASE_URL,
        appOrigin: APP_ORIGIN ?? 'http://localhost:5173',
        aiProviderOrder,
        geminiApiKey: canonicalGeminiKey,
        geminiModel: canonicalGeminiModel,
        geminiFallbackModel: canonicalGeminiFallbackModel,
        geminiTimeoutMs: canonicalGeminiTimeout,
        groqApiKey: GROQ_API_KEY,
        groqModel,
        groqBaseUrl,
        groqTimeoutMs,
        // Canonical AI settings
        aiApiKey: canonicalGeminiKey,
        aiModel: canonicalGeminiModel,
        aiFallbackModel: canonicalGeminiFallbackModel,
        aiTimeoutMs: canonicalGeminiTimeout,
        assessmentProvider: ASSESSMENT_PROVIDER ?? (NODE_ENV === 'test' ? 'fake' : 'gemini'),
        assessmentOpenAiApiKey: canonicalGeminiKey,
        assessmentOpenAiModel: canonicalGeminiModel,
        assessmentTimeoutMs: canonicalGeminiTimeout,
        trustedProxyIps: TRUSTED_PROXY_IPS
          ? TRUSTED_PROXY_IPS.split(',')
              .map((ip) => ip.trim())
              .filter(Boolean)
          : undefined,
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
      };
    },
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
