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
    ).toEqual({
      nodeEnv: 'development',
      apiPort: 4000,
      databaseUrl: validDatabaseUrl,
      appOrigin: 'http://localhost:5173',
      aiApiKey: undefined,
      aiBaseUrl: undefined,
      aiModel: undefined,
      aiTimeoutMs: 30_000,
      resumeStorageRoot: expect.stringContaining('storage'),
    });
  });

  it('parses valid production configuration', () => {
    expect(
      parseEnvironment({
        NODE_ENV: 'production',
        API_PORT: '443',
        APP_ORIGIN: 'https://app.example.com',
        DATABASE_URL: 'postgres://runtime-user:runtime-password@db.example:5432/app',
      }),
    ).toMatchObject({
      nodeEnv: 'production',
      apiPort: 443,
      appOrigin: 'https://app.example.com',
    });
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
});
