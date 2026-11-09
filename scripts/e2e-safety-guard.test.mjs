import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  E2eSafetyError,
  assertSafeE2eEnvironment,
  validateE2eEnvironmentConfig,
} from './e2e-safety-guard.mjs';

function createValidLocalEnv(overrides = {}) {
  return {
    TALENTLENS_E2E_ENV: 'local-isolated',
    NODE_ENV: 'test',
    DATABASE_URL:
      'postgresql://talentlens:talentlens_local_only@127.0.0.1:5433/talentlens_scorecard_test',
    MAILPIT_URL: 'http://127.0.0.1:8025',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_REQUIRE_TLS: 'false',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'talentlens-test-resumes',
    S3_ENDPOINT: 'http://127.0.0.1:9090',
    S3_FORCE_PATH_STYLE: 'true',
    SCANNER_DRIVER: 'clamav',
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: '3310',
    APP_ORIGIN: 'http://localhost:8080',
    ASSESSMENT_PROVIDER: 'fake',
    ...overrides,
  };
}

function createValidComposeEnv(overrides = {}) {
  return {
    TALENTLENS_E2E_ENV: 'compose-isolated',
    TALENTLENS_E2E_TOPOLOGY: 'docker-compose.prod-test',
    NODE_ENV: 'test',
    DATABASE_URL:
      'postgresql://talentlens:talentlens_local_only@postgres:5432/talentlens_scorecard_test',
    MAILPIT_URL: 'http://mailpit:8025',
    SMTP_HOST: 'mailpit',
    SMTP_PORT: '1025',
    SMTP_REQUIRE_TLS: 'false',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'talentlens-test-resumes',
    S3_ENDPOINT: 'http://s3mock:9090',
    S3_FORCE_PATH_STYLE: 'true',
    SCANNER_DRIVER: 'clamav',
    CLAMAV_HOST: 'clamav',
    CLAMAV_PORT: '3310',
    APP_ORIGIN: 'http://web:8080',
    ASSESSMENT_PROVIDER: 'fake',
    ...overrides,
  };
}

test('1. Approved local E2E database and Mailpit configuration passes with read-only probes', async () => {
  let dbProbeCalls = 0;
  let mailpitProbeCalls = 0;

  const result = await assertSafeE2eEnvironment({
    env: createValidLocalEnv(),
    probeDatabaseIdentity: async (expectedDb) => {
      dbProbeCalls += 1;
      return { databaseName: expectedDb, migrationsTable: '_prisma_migrations' };
    },
    probeMailpit: async () => {
      mailpitProbeCalls += 1;
      return { version: 'v1.33.0' };
    },
  });

  assert.equal(dbProbeCalls, 1);
  assert.equal(mailpitProbeCalls, 1);
  assert.equal(result.verifiedDatabase, 'talentlens_scorecard_test');
  assert.equal(result.mailpitOrigin, 'http://127.0.0.1:8025');
});

test('2. Production-like database name is rejected without leaking credentials', async () => {
  for (const dangerousName of ['talentlens', 'talentlens_prod', 'talentlens_production']) {
    const env = createValidLocalEnv({
      DATABASE_URL: `postgresql://prod_admin:TopSecretPass99@127.0.0.1:5433/${dangerousName}`,
    });
    assert.throws(
      () => validateE2eEnvironmentConfig(env),
      (err) =>
        err instanceof E2eSafetyError &&
        err.category === 'database' &&
        !err.message.includes('TopSecretPass99') &&
        !err.message.includes('prod_admin'),
    );
  }
});

test('3. Unknown database name is rejected', () => {
  const env = createValidLocalEnv({
    DATABASE_URL: 'postgresql://talentlens:local@127.0.0.1:5433/arbitrary_unknown_db',
  });
  assert.throws(
    () => validateE2eEnvironmentConfig(env),
    (err) => err instanceof E2eSafetyError && err.category === 'database',
  );
});

test('4. External PostgreSQL host is rejected (and service alias blocked in local mode)', () => {
  for (const host of ['10.0.1.50', 'prod.db.oci.internal', 'postgres', '0.0.0.0']) {
    const env = createValidLocalEnv({
      DATABASE_URL: `postgresql://u:p@${host}:5433/talentlens_scorecard_test`,
    });
    assert.throws(
      () => validateE2eEnvironmentConfig(env),
      (err) => err instanceof E2eSafetyError && err.category === 'database',
    );
  }
});

test('5. Wrong port is rejected across PostgreSQL, Mailpit, SMTP, S3, and APP_ORIGIN', () => {
  assert.throws(
    () =>
      validateE2eEnvironmentConfig(
        createValidLocalEnv({
          DATABASE_URL: 'postgresql://talentlens:local@127.0.0.1:5432/talentlens_scorecard_test',
        }),
      ),
    (err) => err instanceof E2eSafetyError && err.category === 'database',
  );

  assert.throws(
    () =>
      validateE2eEnvironmentConfig(createValidLocalEnv({ MAILPIT_URL: 'http://127.0.0.1:8026' })),
    (err) => err instanceof E2eSafetyError && err.category === 'mailpit',
  );

  assert.throws(
    () => validateE2eEnvironmentConfig(createValidLocalEnv({ SMTP_PORT: '587' })),
    (err) => err instanceof E2eSafetyError && err.category === 'smtp',
  );

  assert.throws(
    () =>
      validateE2eEnvironmentConfig(createValidLocalEnv({ S3_ENDPOINT: 'http://127.0.0.1:9000' })),
    (err) => err instanceof E2eSafetyError && err.category === 'storage',
  );

  assert.throws(
    () =>
      validateE2eEnvironmentConfig(createValidLocalEnv({ APP_ORIGIN: 'http://localhost:3000' })),
    (err) => err instanceof E2eSafetyError && err.category === 'app-origin',
  );
});

test('6. URL parsing failure and invalid schemes are rejected safely', () => {
  const malformedDbEnv = createValidLocalEnv({
    DATABASE_URL: 'not a url ::: //secret_token_should_not_appear',
  });
  assert.throws(
    () => validateE2eEnvironmentConfig(malformedDbEnv),
    (err) =>
      err instanceof E2eSafetyError &&
      err.category === 'database' &&
      !err.message.includes('secret_token_should_not_appear'),
  );

  assert.throws(
    () =>
      validateE2eEnvironmentConfig(
        createValidLocalEnv({ DATABASE_URL: 'http://127.0.0.1:5433/talentlens_scorecard_test' }),
      ),
    (err) => err instanceof E2eSafetyError && err.category === 'database',
  );

  assert.throws(
    () => validateE2eEnvironmentConfig(createValidLocalEnv({ MAILPIT_URL: 'invalid-mailpit-url' })),
    (err) => err instanceof E2eSafetyError && err.category === 'mailpit',
  );
});

test('7. Real external SMTP host or credentials or TLS requirement is rejected', () => {
  assert.throws(
    () =>
      validateE2eEnvironmentConfig(
        createValidLocalEnv({ SMTP_HOST: 'smtp.email.ap-hyderabad-1.oci.oraclecloud.com' }),
      ),
    (err) => err instanceof E2eSafetyError && err.category === 'smtp',
  );

  assert.throws(
    () =>
      validateE2eEnvironmentConfig(
        createValidLocalEnv({ SMTP_USER: 'ocid1.user', SMTP_PASS: 'secret' }),
      ),
    (err) => err instanceof E2eSafetyError && err.category === 'smtp',
  );

  assert.throws(
    () => validateE2eEnvironmentConfig(createValidLocalEnv({ SMTP_REQUIRE_TLS: 'true' })),
    (err) => err instanceof E2eSafetyError && err.category === 'smtp',
  );
});

test('8. External Mailpit API URL is rejected', () => {
  assert.throws(
    () =>
      validateE2eEnvironmentConfig(
        createValidLocalEnv({ MAILPIT_URL: 'https://mail.talentlens.ai:8025' }),
      ),
    (err) => err instanceof E2eSafetyError && err.category === 'mailpit',
  );
});

test('9. Missing environment marker is rejected', () => {
  const envWithoutMarker = createValidLocalEnv();
  delete envWithoutMarker.TALENTLENS_E2E_ENV;
  assert.throws(
    () => validateE2eEnvironmentConfig(envWithoutMarker),
    (err) => err instanceof E2eSafetyError && err.category === 'environment-marker',
  );

  const composeWithoutTopology = createValidComposeEnv();
  delete composeWithoutTopology.TALENTLENS_E2E_TOPOLOGY;
  assert.throws(
    () => validateE2eEnvironmentConfig(composeWithoutTopology),
    (err) => err instanceof E2eSafetyError && err.category === 'environment-marker',
  );
});

test('10. A production database cannot pass merely because NODE_ENV=test', () => {
  const prodAttempt = createValidLocalEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://prod:pw@prod-postgres.internal:5432/talentlens',
  });
  assert.throws(
    () => validateE2eEnvironmentConfig(prodAttempt),
    (err) => err instanceof E2eSafetyError && err.category === 'database',
  );

  const sameHostWrongDbAttempt = createValidLocalEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://talentlens:pw@127.0.0.1:5432/talentlens',
  });
  assert.throws(
    () => validateE2eEnvironmentConfig(sameHostWrongDbAttempt),
    (err) => err instanceof E2eSafetyError && err.category === 'database',
  );
});

test('11. Guard failure occurs before any data-changing workflow or Mailpit/DB probes', async () => {
  let workflowStarted = false;
  let dbProbeRan = false;
  let mailpitProbeRan = false;

  const badEnv = createValidLocalEnv({
    S3_BUCKET: 'talentlens-production-resumes',
  });

  await assert.rejects(
    async () => {
      await assertSafeE2eEnvironment({
        env: badEnv,
        probeDatabaseIdentity: async () => {
          dbProbeRan = true;
          return { databaseName: 'talentlens_scorecard_test' };
        },
        probeMailpit: async () => {
          mailpitProbeRan = true;
          return { version: 'v1.33.0' };
        },
      });
      workflowStarted = true;
    },
    (err) => err instanceof E2eSafetyError && err.category === 'storage',
  );

  assert.equal(workflowStarted, false);
  assert.equal(dbProbeRan, false);
  assert.equal(mailpitProbeRan, false);

  // Also ensure DB read-only identity mismatch stops before Mailpit or workflow
  let mailpitAfterDbMismatch = false;
  await assert.rejects(
    async () => {
      await assertSafeE2eEnvironment({
        env: createValidLocalEnv(),
        probeDatabaseIdentity: async () => ({
          databaseName: 'talentlens',
          migrationsTable: '_prisma_migrations',
        }),
        probeMailpit: async () => {
          mailpitAfterDbMismatch = true;
          return { version: 'v1.33.0' };
        },
      });
    },
    (err) => err instanceof E2eSafetyError && err.category === 'database-identity',
  );
  assert.equal(mailpitAfterDbMismatch, false);
});

test('12. Valid isolated Docker Compose topology passes', async () => {
  const result = await assertSafeE2eEnvironment({
    env: createValidComposeEnv(),
    probeDatabaseIdentity: async (expectedDb) => ({
      databaseName: expectedDb,
      migrationsTable: '_prisma_migrations',
    }),
    probeMailpit: async () => ({ version: 'v1.33.0' }),
  });

  assert.equal(result.marker, 'compose-isolated');
  assert.equal(result.database.host, 'postgres');
  assert.equal(result.database.port, '5432');
  assert.equal(result.mailpitOrigin, 'http://mailpit:8025');
  assert.equal(result.s3.origin, 'http://s3mock:9090');
  assert.equal(result.appOrigin, 'http://web:8080');
});

test('13. Actual CLI run-browser-e2e.mjs rejects missing marker and production DB before startup', () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.TALENTLENS_E2E_ENV;
  delete cleanEnv.DATABASE_URL;

  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/run-browser-e2e.mjs'], {
        env: cleanEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (err) =>
      err.status !== 0 &&
      String(err.stderr || err.stdout).includes('[E2E GUARD FAIL][environment-marker]'),
  );

  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/run-browser-e2e.mjs'], {
        env: {
          ...cleanEnv,
          TALENTLENS_E2E_ENV: 'local-isolated',
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://prod_user:SuperSecretPw99@127.0.0.1:5432/talentlens',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (err) => {
      const output = String(err.stderr || '') + String(err.stdout || '');
      return (
        err.status !== 0 &&
        output.includes('[E2E GUARD FAIL][database]') &&
        !output.includes('SuperSecretPw99') &&
        !output.includes('prod_user')
      );
    },
  );
});
