import { describe, expect, it } from 'vitest';

import { EnvironmentValidationError, parseEnvironment } from './env.js';

const validDatabaseUrl = 'postgresql://user:password@localhost:5432/talentlens';

describe('parseEnvironment', () => {
  it('parses valid development configuration', () => {
    expect(
      parseEnvironment({
        NODE_ENV: 'development',
        API_PORT: '4000',
        DATABASE_URL: validDatabaseUrl,
      }),
    ).toMatchObject({
      nodeEnv: 'development',
      apiPort: 4000,
      databaseUrl: validDatabaseUrl,
      appOrigin: 'http://localhost:5173',
      geminiApiKey: undefined,
      geminiModel: 'gemini-3.8-flash',
      geminiTimeoutMs: 30_000,
      aiApiKey: undefined,
      aiModel: 'gemini-3.8-flash',
      aiTimeoutMs: 30_000,
      assessmentProvider: 'gemini',
      assessmentOpenAiApiKey: undefined,
      assessmentOpenAiModel: 'gemini-3.8-flash',
      assessmentTimeoutMs: 30_000,
      resumeStorageRoot: expect.stringContaining('storage'),
      approvedPolicies: [],
      approvedPolicyVersions: [],
    });
  });

  it('parses configured approved policies with version and notice hash', () => {
    const hash = 'a'.repeat(64);
    const env = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: validDatabaseUrl,
      CONSENT_APPROVED_POLICIES: `2026-11-v1:${hash}`,
    });
    expect(env.approvedPolicies).toEqual([{ version: '2026-11-v1', noticeTextHash: hash }]);
  });

  it('parses configured approved policy versions', () => {
    const env = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: validDatabaseUrl,
      CONSENT_APPROVED_POLICY_VERSIONS: '2026-11-v1, 2026-12-v2',
    });
    expect(env.approvedPolicyVersions).toEqual(['2026-11-v1', '2026-12-v2']);
  });

  it('parses valid production configuration', () => {
    expect(
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
        TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
      }),
    ).toMatchObject({
      nodeEnv: 'production',
      apiPort: 443,
      appOrigin: 'https://app.example.com',
      trustedProxyIps: ['172.28.0.10', '172.28.0.1', '127.0.0.1'],
    });
  });

  it('requires TRUSTED_PROXY_IPS in production', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
      }),
    ).toThrow('TRUSTED_PROXY_IPS is strictly required and cannot be empty in production');
  });

  it('parses valid staging configuration and requires APP_ORIGIN', () => {
    expect(
      parseEnvironment({
        NODE_ENV: 'staging',
        API_PORT: '4000',
        APP_ORIGIN: 'https://staging.example.com',
        DATABASE_URL: validDatabaseUrl,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-staging-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_STAGING_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_staging_test_key_123',
      }),
    ).toMatchObject({
      nodeEnv: 'staging',
      apiPort: 4000,
      appOrigin: 'https://staging.example.com',
    });

    expect(() =>
      parseEnvironment({
        NODE_ENV: 'staging',
        API_PORT: '4000',
        DATABASE_URL: validDatabaseUrl,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-staging-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_STAGING_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_staging_test_key_123',
      }),
    ).toThrow('APP_ORIGIN');

    // Fails closed if STORAGE_DRIVER=local in staging without explicit override
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'staging',
        API_PORT: '4000',
        APP_ORIGIN: 'https://staging.example.com',
        DATABASE_URL: validDatabaseUrl,
        STORAGE_DRIVER: 'local',
      }),
    ).toThrow('STORAGE_DRIVER=s3 is required');
  });

  it('resolves relative RESUME_STORAGE_ROOT against the repository root', () => {
    const env = parseEnvironment({
      NODE_ENV: 'development',
      API_PORT: '4000',
      DATABASE_URL: validDatabaseUrl,
      RESUME_STORAGE_ROOT: './custom-storage',
    });
    expect(env.resumeStorageRoot).toMatch(/[\\/]custom-storage$/);
  });

  it('rejects a missing database URL', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '4000',
      }),
    ).toThrow('DATABASE_URL');
  });

  it('rejects an invalid database URL', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'development',
        API_PORT: '4000',
        DATABASE_URL: 'not-a-database-url',
      }),
    ).toThrow('DATABASE_URL');
  });

  it('rejects invalid and out-of-range ports', () => {
    for (const API_PORT of ['0', '65536', '4000.5', 'not-a-port']) {
      expect(() =>
        parseEnvironment({
          NODE_ENV: 'development',
          API_PORT,
          DATABASE_URL: validDatabaseUrl,
        }),
      ).toThrow('API_PORT');
    }
  });

  it('accepts both TCP port boundaries', () => {
    expect(parseEnvironment({ API_PORT: '1', DATABASE_URL: validDatabaseUrl }).apiPort).toBe(1);
    expect(parseEnvironment({ API_PORT: '65535', DATABASE_URL: validDatabaseUrl }).apiPort).toBe(
      65_535,
    );
  });

  it('resolves port consistently with PORT fallback and defaults to 3000', () => {
    expect(parseEnvironment({ DATABASE_URL: validDatabaseUrl }).apiPort).toBe(3000);
    expect(parseEnvironment({ PORT: '3000', DATABASE_URL: validDatabaseUrl }).apiPort).toBe(3000);
    expect(
      parseEnvironment({ API_PORT: '8080', PORT: '3000', DATABASE_URL: validDatabaseUrl }).apiPort,
    ).toBe(8080);
  });

  it('does not expose secret values in validation errors', () => {
    const secret = 'super-secret-password';

    try {
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: 'not-a-port',
        DATABASE_URL: `postgresql://user:${secret}@db.example/app`,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(String(error)).not.toContain(secret);
      return;
    }

    throw new Error('Expected environment validation to fail');
  });

  it('validates assessment provider settings and rejects fake provider outside test (F-11)', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'development',
        DATABASE_URL: validDatabaseUrl,
        ASSESSMENT_PROVIDER: 'fake',
      }),
    ).toThrow('ASSESSMENT_PROVIDER');

    const testEnv = parseEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: validDatabaseUrl,
      ASSESSMENT_PROVIDER: 'fake',
    });
    expect(testEnv.assessmentProvider).toBe('fake');

    const geminiEnv = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: validDatabaseUrl,
      ASSESSMENT_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_MODEL: 'gemini-2.5-pro',
      GEMINI_TIMEOUT_MS: '45000',
    });
    expect(geminiEnv.assessmentProvider).toBe('gemini');
    expect(geminiEnv.geminiModel).toBe('gemini-2.5-pro');
    expect(geminiEnv.geminiTimeoutMs).toBe(45_000);
  });

  it('enforces SCANNER_FAIL_CLOSED and ClamAV configuration in production and staging', () => {
    // Rejects fail-open in production
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
        SCANNER_FAIL_CLOSED: 'false',
      }),
    ).toThrow('SCANNER_FAIL_CLOSED cannot be false in production and staging');

    // Rejects fail-open in staging
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'staging',
        API_PORT: '4000',
        APP_ORIGIN: 'https://staging.example.com',
        DATABASE_URL: validDatabaseUrl,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-staging-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_STAGING_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_staging_test_key_123',
        SCANNER_FAIL_CLOSED: 'false',
      }),
    ).toThrow('SCANNER_FAIL_CLOSED cannot be false in production and staging');

    // Requires CLAMAV_HOST when SCANNER_DRIVER=clamav in production
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
        SCANNER_DRIVER: 'clamav',
        TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
      }),
    ).toThrow('CLAMAV_HOST is required when SCANNER_DRIVER=clamav');

    // Accepts valid ClamAV configuration in production
    const validProd = parseEnvironment({
      NODE_ENV: 'production',
      API_PORT: '443',
      APP_ORIGIN: 'https://app.example.com',
      DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'talentlens-prod-resumes',
      S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
      S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
      SCANNER_DRIVER: 'clamav',
      CLAMAV_HOST: 'clamav.internal',
      CLAMAV_PORT: '3310',
      SCANNER_FAIL_CLOSED: 'true',
      TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
    });
    expect(validProd.nodeEnv).toBe('production');
  });

  it('normalizes empty string configuration values to undefined without failing validation', () => {
    const env = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: validDatabaseUrl,
      GEMINI_API_KEY: '',
      GEMINI_MODEL: '',
      GEMINI_TIMEOUT_MS: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_TIMEOUT_MS: '',
      CONSENT_APPROVED_POLICIES: '',
      CONSENT_APPROVED_POLICY_VERSIONS: '',
      SMTP_HOST: '',
      SMTP_PORT: '',
      TRUSTED_PROXY_IPS: '127.0.0.1, 10.0.0.5',
    });

    expect(env.geminiApiKey).toBeUndefined();
    expect(env.geminiModel).toBe('gemini-3.8-flash');
    expect(env.geminiTimeoutMs).toBe(30_000);
    expect(env.aiApiKey).toBeUndefined();
    expect(env.aiModel).toBe('gemini-3.8-flash');
    expect(env.aiTimeoutMs).toBe(30_000);
    expect(env.trustedProxyIps).toEqual(['127.0.0.1', '10.0.0.5']);
  });

  it('enforces production security rules: HTTPS APP_ORIGIN, s3 storage, gemini provider', () => {
    // Rejects HTTP APP_ORIGIN in production
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'http://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
        TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
      }),
    ).toThrow('APP_ORIGIN must use HTTPS in production');

    // Rejects local storage in production even if ALLOW_LOCAL_STORAGE_IN_PRODUCTION is true
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 'local',
        ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true',
        TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
      }),
    ).toThrow('STORAGE_DRIVER=s3 is strictly required in production');

    // Rejects non-gemini provider in production
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'talentlens-prod-resumes',
        S3_ACCESS_KEY_ID: 'AKIA_PROD_TEST',
        S3_SECRET_ACCESS_KEY: 'secret_prod_test_key_123',
        ASSESSMENT_PROVIDER: 'fake',
        TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
      }),
    ).toThrow('strictly forbidden outside NODE_ENV=test');
  });
});
