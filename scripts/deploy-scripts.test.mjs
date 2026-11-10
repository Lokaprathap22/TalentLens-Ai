import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  BUILD_CACHE_RELATIVE_PATH,
  buildLocalExecutionPlan,
  detectComposeCommand as detectLocalComposeCommand,
  inspectLocalEnvFile,
  main as runDeployLocalMain,
  parseDeployLocalArgs,
} from './deploy-local.mjs';
import {
  buildRemoteIdempotencyCommand,
  buildRemoteReleaseWriteCommand,
  buildRemoteRestoreSnapshotCommand,
  buildRemoteSyncCommand,
  createSanitizedSourceTarball,
  listTarGzEntries,
  main as runDeployProductionMain,
  parseDeployProductionArgs,
  parseRemoteProbeOutput,
  validateExecutionGuard,
} from './deploy-production.mjs';
import { parseDotEnvContent, runPreflightEnv } from './preflight-env.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createProdFixtureEnv(overrides = {}) {
  const base = {
    NODE_ENV: 'production',
    PORT: '3000',
    WEB_PORT: '8080',
    API_PORT: '3000',
    APP_ORIGIN: 'https://talentlens.example.com',
    TRUSTED_PROXY_IPS: '172.28.0.10,172.28.0.1,127.0.0.1',
    POSTGRES_USER: 'talentlens',
    POSTGRES_PASSWORD: 'fixture_db_password_minimum_24chars',
    POSTGRES_DB: 'talentlens',
    DATABASE_URL:
      'postgresql://talentlens:fixture_db_password_minimum_24chars@postgres:5432/talentlens?schema=public',
    AI_PROVIDER_ORDER: 'gemini,groq',
    GEMINI_API_KEY: '',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash',
    GEMINI_TIMEOUT_MS: '90000',
    GROQ_API_KEY: '',
    GROQ_MODEL: 'openai/gpt-oss-120b',
    GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    GROQ_TIMEOUT_MS: '90000',
    ASSESSMENT_PROVIDER: 'gemini',
    STORAGE_DRIVER: 's3',
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'false',
    S3_BUCKET: 'talentlens-resumes',
    S3_REGION: 'ap-hyderabad-1',
    S3_ENDPOINT: 'https://test.compat.objectstorage.ap-hyderabad-1.oci.customer-oci.com',
    S3_ACCESS_KEY_ID: 'oci-access-key-fixture',
    S3_SECRET_ACCESS_KEY: 'oci-secret-access-key-fixture',
    S3_FORCE_PATH_STYLE: 'true',
    SCANNER_DRIVER: 'clamav',
    CLAMAV_HOST: 'clamav',
    CLAMAV_PORT: '3310',
    SCANNER_FAIL_CLOSED: 'true',
    EMAIL_OUTBOX_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'fixture_idempotency_secret_value_minimum_32chars',
    SMTP_HOST: 'smtp.email.ap-hyderabad-1.oci.oraclecloud.com',
    SMTP_PORT: '587',
    EMAIL_FROM: 'no-reply@talentlens.ai',
    CONSENT_APPROVED_POLICY_VERSIONS: '2026-11-v1',
    ...overrides,
  };
  return Object.entries(base)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function createFakeWorkspaceForDeploy(dir, { includeEnv = true, envContent } = {}) {
  const write = (rel, content) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write('tsconfig.base.json', '{"compilerOptions":{}}\n');
  write('prisma/schema.prisma', 'datasource db { provider = "postgresql" }\n');
  write('prisma/migrations/001/migration.sql', '-- init\n');
  write('docker-compose.prod.yml', 'services:\n  api:\n    image: node:24-alpine\n');
  write('deploy.sh', '#!/usr/bin/env bash\necho ok\n');
  write('.env.example', 'NODE_ENV=production\n');
  write('package.json', '{"name":"talentlens-ai"}\n');

  for (const ws of ['shared', 'document-processing', 'database', 'assessment-engine']) {
    write(`packages/${ws}/package.json`, `{"name":"@talentlens/${ws}"}\n`);
    write(`packages/${ws}/tsconfig.json`, '{"compilerOptions":{"outDir":"dist"}}\n');
    write(`packages/${ws}/src/index.ts`, `export const pkg = '${ws}';\n`);
  }

  if (includeEnv) {
    write(
      '.env',
      envContent ??
        'NODE_ENV=development\nAPI_PORT=4000\nAPP_ORIGIN=http://localhost:5173\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\n',
    );
  }
}

function createBufferedStreams() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (msg) => out.push(String(msg)),
    stderr: (msg) => err.push(String(msg)),
    allOutput: () => [...out, ...err].join('\n'),
  };
}

test('1. deploy-local arg parser & sequential plan respect flags cleanly', () => {
  const opts = parseDeployLocalArgs([
    '--dry-run',
    '--skip-db',
    '--skip-preflight',
    '--force',
    '--apply-migrations',
    '--start',
    '--env-file',
    '.env.local',
  ]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.skipDb, true);
  assert.equal(opts.skipPreflight, true);
  assert.equal(opts.force, true);
  assert.equal(opts.applyMigrations, true);
  assert.equal(opts.start, true);
  assert.equal(opts.envFile, '.env.local');
  assert.deepEqual(buildLocalExecutionPlan(opts), [
    'npm run build --workspace @talentlens/shared (--force)',
    'npm run build --workspace @talentlens/document-processing (--force)',
    'npm run build --workspace @talentlens/database (--force)',
    'npm run build --workspace @talentlens/assessment-engine (--force)',
    'npm run db:migrate:deploy',
    'npm run dev',
  ]);
  assert.throws(() => parseDeployLocalArgs(['--env-file']), /requires a file path/);
  assert.throws(() => parseDeployLocalArgs(['--bogus']), /Unknown flag/);
});

test('2. inspectLocalEnvFile masks secrets and flags host dev hints safely', () => {
  const dir = makeTempDir('tl-local-env-');
  try {
    const envPath = path.join(dir, '.env.fixture');
    const secretVal = 'gsk_super_secret_fixture_value_999';
    fs.writeFileSync(
      envPath,
      [
        'NODE_ENV=development',
        'API_PORT=4000',
        'APP_ORIGIN=http://localhost:5173',
        'DATABASE_URL=postgresql://talentlens:SecretPass123!@postgres:5432/talentlens?schema=public',
        `GROQ_API_KEY=${secretVal}`,
      ].join('\n'),
      'utf8',
    );
    const report = inspectLocalEnvFile(envPath);
    assert.equal(report.exists, true);
    assert.equal(report.errors.length, 0);
    assert.equal(report.hasGeminiKey, false);
    assert.equal(report.hasGroqKey, true);
    assert.equal(report.dbHostPort, 'postgres:5432/talentlens');
    assert.equal(
      report.warnings.some((w) => w.includes('targets Docker hostname "postgres"')),
      true,
    );
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secretVal), false);
    assert.equal(serialized.includes('SecretPass123!'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. deploy-local fails closed on NODE_ENV=production, remote DATABASE_URL host, and placeholder keys', () => {
  const dir = makeTempDir('tl-local-fail-');
  try {
    const prodEnvPath = path.join(dir, '.env.prod');
    fs.writeFileSync(
      prodEnvPath,
      'NODE_ENV=production\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\n',
      'utf8',
    );
    const prodReport = inspectLocalEnvFile(prodEnvPath);
    assert.equal(
      prodReport.errors.some((e) => e.includes('NODE_ENV=production')),
      true,
    );

    const remoteDbPath = path.join(dir, '.env.remote');
    fs.writeFileSync(
      remoteDbPath,
      'NODE_ENV=development\nDATABASE_URL=postgresql://talentlens:pw@prod-db.internal:5432/talentlens\n',
      'utf8',
    );
    const remoteReport = inspectLocalEnvFile(remoteDbPath);
    assert.equal(
      remoteReport.errors.some((e) => e.includes('non-local remote DATABASE_URL host')),
      true,
    );

    const placeholderPath = path.join(dir, '.env.placeholder');
    const phSecret = 'replace_with_real_gemini_key';
    fs.writeFileSync(
      placeholderPath,
      `NODE_ENV=development\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\nGEMINI_API_KEY=${phSecret}\n`,
      'utf8',
    );
    const placeholderFail = inspectLocalEnvFile(placeholderPath);
    assert.equal(
      placeholderFail.errors.some((e) => e.includes('GEMINI_API_KEY contains a placeholder value')),
      true,
    );
    assert.equal(JSON.stringify(placeholderFail).includes(phSecret), false);

    const placeholderSkipped = inspectLocalEnvFile(placeholderPath, { skipPreflight: true });
    assert.equal(placeholderSkipped.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. deploy-local auto-detects docker compose vs docker-compose and enforces DB readiness polling', () => {
  const dir = makeTempDir('tl-local-db-');
  try {
    createFakeWorkspaceForDeploy(dir);

    const v1Compose = detectLocalComposeCommand((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'compose') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'docker-compose' && args[0] === 'version') {
        return { status: 0, stdout: 'docker-compose version 1.29.2', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    assert.equal(v1Compose?.bin, 'docker-compose');

    let readyCalls = 0;
    const recorded = [];
    const streams = createBufferedStreams();
    const okExit = runDeployLocalMain(['--skip-build'], {
      cwd: dir,
      nodeVersion: '24.21.0',
      maxDbWaitAttempts: 4,
      dbWaitIntervalMs: 1,
      sleepFn: () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
      execFn: (cmd, args) => {
        recorded.push([cmd, ...args]);
        if (cmd === 'docker' && args[0] === 'compose' && args[1] === 'version') {
          return { status: 0, stdout: 'v2', stderr: '' };
        }
        if (cmd === 'docker' && args.includes('up')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'docker' && args.includes('pg_isready')) {
          readyCalls += 1;
          return { status: readyCalls >= 3 ? 0 : 1, stdout: '', stderr: 'starting' };
        }
        if (cmd === 'npx' && args[0] === 'prisma') {
          return { status: 0, stdout: 'Database schema is up to date', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      },
    });
    assert.equal(okExit, 0);
    assert.equal(readyCalls, 3);
    assert.match(streams.allOutput(), /PostgreSQL ready after 3 attempt\(s\)/);

    const failStreams = createBufferedStreams();
    const failExit = runDeployLocalMain(['--skip-build'], {
      cwd: dir,
      nodeVersion: '24.21.0',
      maxDbWaitAttempts: 2,
      dbWaitIntervalMs: 1,
      sleepFn: () => {},
      stdout: failStreams.stdout,
      stderr: failStreams.stderr,
      execFn: (cmd, args) => {
        if (cmd === 'docker' && args[0] === 'compose' && args[1] === 'version') {
          return { status: 0, stdout: 'v2', stderr: '' };
        }
        if (cmd === 'docker' && args.includes('up')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'docker' && args.includes('pg_isready')) {
          return { status: 1, stdout: '', stderr: 'no response' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(failExit, 1);
    assert.match(failStreams.allOutput(), /did not become ready after 2 attempt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. deploy-local SHA-256 build fingerprint cache hits skip builds and --force or source edits rebuild', () => {
  const dir = makeTempDir('tl-local-cache-');
  try {
    createFakeWorkspaceForDeploy(dir);
    const builtWorkspaces = [];
    const execMock = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'run' && args[1] === 'build') {
        const ws = args[3];
        builtWorkspaces.push(ws);
        const shortName = ws.replace('@talentlens/', '');
        const distIndex = path.join(dir, 'packages', shortName, 'dist', 'index.js');
        fs.mkdirSync(path.dirname(distIndex), { recursive: true });
        fs.writeFileSync(distIndex, `// built ${ws}\n`, 'utf8');
        if (ws === '@talentlens/database') {
          const genClient = path.join(dir, 'packages/database/src/generated/prisma/client.ts');
          fs.mkdirSync(path.dirname(genClient), { recursive: true });
          fs.writeFileSync(genClient, 'export class PrismaClient {}\n', 'utf8');
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'npx' && args[0] === 'prisma') {
        return { status: 0, stdout: 'up to date', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const s1 = createBufferedStreams();
    assert.equal(
      runDeployLocalMain(['--skip-db'], {
        cwd: dir,
        nodeVersion: '24.21.0',
        execFn: execMock,
        stdout: s1.stdout,
        stderr: s1.stderr,
      }),
      0,
    );
    assert.deepEqual(builtWorkspaces.splice(0), [
      '@talentlens/shared',
      '@talentlens/document-processing',
      '@talentlens/database',
      '@talentlens/assessment-engine',
    ]);
    assert.equal(fs.existsSync(path.join(dir, BUILD_CACHE_RELATIVE_PATH)), true);

    const s2 = createBufferedStreams();
    assert.equal(
      runDeployLocalMain(['--skip-db'], {
        cwd: dir,
        nodeVersion: '24.21.0',
        execFn: execMock,
        stdout: s2.stdout,
        stderr: s2.stderr,
      }),
      0,
    );
    assert.deepEqual(builtWorkspaces.splice(0), []);
    assert.match(s2.allOutput(), /@talentlens\/shared build skipped/);

    fs.writeFileSync(
      path.join(dir, 'packages/assessment-engine/src/index.ts'),
      "export const pkg = 'assessment-engine-v2';\n",
      'utf8',
    );
    const s3 = createBufferedStreams();
    assert.equal(
      runDeployLocalMain(['--skip-db'], {
        cwd: dir,
        nodeVersion: '24.21.0',
        execFn: execMock,
        stdout: s3.stdout,
        stderr: s3.stderr,
      }),
      0,
    );
    assert.deepEqual(builtWorkspaces.splice(0), ['@talentlens/assessment-engine']);

    const s4 = createBufferedStreams();
    assert.equal(
      runDeployLocalMain(['--skip-db', '--force'], {
        cwd: dir,
        nodeVersion: '24.21.0',
        execFn: execMock,
        stdout: s4.stdout,
        stderr: s4.stderr,
      }),
      0,
    );
    assert.deepEqual(builtWorkspaces.splice(0), [
      '@talentlens/shared',
      '@talentlens/document-processing',
      '@talentlens/database',
      '@talentlens/assessment-engine',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. deploy-production defaults dry-run, enforces confirmation + clean tree + safe SSH/remote inputs', () => {
  const defaultOpts = parseDeployProductionArgs([]);
  const defaultGuard = validateExecutionGuard(defaultOpts);
  assert.equal(defaultGuard.dryRun, true);
  assert.equal(defaultGuard.allowed, false);

  const missingConfirmGuard = validateExecutionGuard(parseDeployProductionArgs(['--execute']));
  assert.equal(missingConfirmGuard.allowed, false);
  assert.match(missingConfirmGuard.reason, /--confirm-production is required/);

  const badSsh = validateExecutionGuard(
    parseDeployProductionArgs([
      '--execute',
      '--confirm-production',
      '--ssh-host',
      'ubuntu@host;rm -rf /',
    ]),
  );
  assert.equal(badSsh.allowed, false);
  assert.match(badSsh.reason, /Unsafe or invalid --ssh-host/);

  const badRemoteDir = validateExecutionGuard(
    parseDeployProductionArgs([
      '--execute',
      '--confirm-production',
      '--ssh-host',
      'ubuntu@host',
      '--remote-dir',
      '/home/ubuntu/../etc',
    ]),
  );
  assert.equal(badRemoteDir.allowed, false);
  assert.match(badRemoteDir.reason, /Unsafe or invalid --remote-dir/);

  const dir = makeTempDir('tl-prod-dirty-');
  try {
    createFakeWorkspaceForDeploy(dir, {
      envContent: createProdFixtureEnv({ GEMINI_API_KEY: 'AIzaSyFixtureValidGeminiKey1234567890' }),
    });
    const dirtyStreams = createBufferedStreams();
    const dirtyExit = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@oci-host',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
      ],
      {
        cwd: dir,
        stdout: dirtyStreams.stdout,
        stderr: dirtyStreams.stderr,
        execFn: (cmd, args) => {
          if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
            return { status: 0, stdout: 'main\n', stderr: '' };
          }
          if (cmd === 'git' && args[0] === 'rev-parse') {
            return { status: 0, stdout: 'deadbeef12345678\n', stderr: '' };
          }
          if (cmd === 'git' && args[0] === 'status') {
            return { status: 0, stdout: ' M README.md\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(dirtyExit, 1);
    assert.match(dirtyStreams.allOutput(), /Working tree has 1 uncommitted file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7. preflight-env validates Gemini-only, Groq-only, Dual-provider, disallowed models & key non-leakage', () => {
  const dir = makeTempDir('tl-preflight-');
  try {
    const geminiOnlySecret = 'AIzaSyFixtureValidGeminiKey1234567890';
    const groqOnlySecret = 'gsk_fixture_valid_groq_key_1234567890';

    const geminiOnlyFile = path.join(dir, 'gemini-only.env');
    fs.writeFileSync(
      geminiOnlyFile,
      createProdFixtureEnv({ GEMINI_API_KEY: geminiOnlySecret }),
      'utf8',
    );
    const geminiOut = execFileSync(
      process.execPath,
      ['scripts/preflight-env.mjs', geminiOnlyFile],
      { encoding: 'utf8' },
    );
    assert.match(geminiOut, /PREFLIGHT VERDICT: \[PASS\]/);
    assert.equal(geminiOut.includes(geminiOnlySecret), false);

    const groqOnlyFile = path.join(dir, 'groq-only.env');
    fs.writeFileSync(
      groqOnlyFile,
      createProdFixtureEnv({
        GROQ_API_KEY: groqOnlySecret,
        ASSESSMENT_PROVIDER: 'groq',
        AI_PROVIDER_ORDER: 'groq,gemini',
      }),
      'utf8',
    );
    const groqOut = execFileSync(process.execPath, ['scripts/preflight-env.mjs', groqOnlyFile], {
      encoding: 'utf8',
    });
    assert.match(groqOut, /PREFLIGHT VERDICT: \[PASS\]/);
    assert.equal(groqOut.includes(groqOnlySecret), false);

    const dualFile = path.join(dir, 'dual.env');
    fs.writeFileSync(
      dualFile,
      createProdFixtureEnv({ GEMINI_API_KEY: geminiOnlySecret, GROQ_API_KEY: groqOnlySecret }),
      'utf8',
    );
    const dualOut = execFileSync(process.execPath, ['scripts/preflight-env.mjs', dualFile], {
      encoding: 'utf8',
    });
    assert.match(dualOut, /PREFLIGHT VERDICT: \[PASS\]/);
    assert.equal(dualOut.includes(geminiOnlySecret), false);
    assert.equal(dualOut.includes(groqOnlySecret), false);

    const missingKeysFile = path.join(dir, 'no-ai-keys.env');
    fs.writeFileSync(missingKeysFile, createProdFixtureEnv(), 'utf8');
    assert.throws(
      () =>
        execFileSync(process.execPath, ['scripts/preflight-env.mjs', missingKeysFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (err) =>
        err.status !== 0 && String(err.stderr || err.stdout).includes('AI_PROVIDER_CREDENTIALS'),
    );

    const badOrderFile = path.join(dir, 'bad-order.env');
    fs.writeFileSync(
      badOrderFile,
      createProdFixtureEnv({
        GEMINI_API_KEY: geminiOnlySecret,
        AI_PROVIDER_ORDER: 'gemini,unknown_vendor',
      }),
      'utf8',
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, ['scripts/preflight-env.mjs', badOrderFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (err) => err.status !== 0 && String(err.stderr || err.stdout).includes('AI_PROVIDER_ORDER'),
    );

    const disallowedModelFile = path.join(dir, 'bad-model.env');
    fs.writeFileSync(
      disallowedModelFile,
      createProdFixtureEnv({
        GEMINI_API_KEY: geminiOnlySecret,
        GEMINI_MODEL: 'gemini-3.8-flash',
      }),
      'utf8',
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, ['scripts/preflight-env.mjs', disallowedModelFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (err) => err.status !== 0 && String(err.stderr || err.stdout).includes('GEMINI_MODEL'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8. deploy-production createSanitizedSourceTarball excludes secrets/artifacts/OCI overlay & writes valid .sha256', () => {
  const dir = makeTempDir('tl-tarball-src-');
  const outDir = makeTempDir('tl-tarball-out-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const writeRaw = (rel, content = 'x') => {
      const abs = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    };
    writeRaw('deploy.sh', '#!/usr/bin/env bash\r\necho ok\r\n');
    writeRaw('.env', 'SECRET=1\n');
    writeRaw('.env.candidate', 'SECRET=2\n');
    writeRaw('.env.backup-20261110', 'SECRET=3\n');
    writeRaw('certs/private.pem', 'PEM');
    writeRaw('keys/api.key', 'KEY');
    writeRaw('backups/old.dump', 'DUMP');
    writeRaw('node_modules/dotenv/index.js', 'module.exports = {};');
    writeRaw('packages/shared/dist/index.js', 'export {};');
    writeRaw('.git/HEAD', 'ref: refs/heads/main\n');
    writeRaw('artifacts/screen.png', 'png');
    writeRaw('playwright-report/index.html', 'html');
    writeRaw('test-results/res.xml', 'xml');
    writeRaw('docker-compose.oci.yml', 'services: {}\n');
    writeRaw('storage/resumes/candidate.pdf', 'pdf');
    writeRaw('storage/resumes/.gitkeep', '');

    const result = createSanitizedSourceTarball({
      cwd: dir,
      outputDir: outDir,
      tarballName: 'release-test.tar.gz',
    });

    const gzBytes = fs.readFileSync(result.tarballPath);
    const actualSha = crypto.createHash('sha256').update(gzBytes).digest('hex');
    assert.equal(actualSha, result.tarballSha256);
    assert.equal(
      fs.readFileSync(result.checksumPath, 'utf8').trim(),
      `${result.tarballSha256}  release-test.tar.gz`,
    );

    const tarRaw = zlib.gunzipSync(gzBytes);
    assert.equal(
      tarRaw.includes(Buffer.from('#!/usr/bin/env bash\necho ok\n', 'utf8')),
      true,
      'Shell script should be normalized to LF line endings in tarball',
    );
    assert.equal(
      tarRaw.includes(Buffer.from('#!/usr/bin/env bash\r\n', 'utf8')),
      false,
      'Shell script must not contain CRLF bytes in tarball',
    );

    const entries = listTarGzEntries(gzBytes);
    assert.deepEqual(entries, result.includedFiles);
    for (const required of [
      '.env.example',
      'deploy.sh',
      'docker-compose.prod.yml',
      'package.json',
      'prisma/migrations/001/migration.sql',
      'storage/resumes/.gitkeep',
    ]) {
      assert.equal(entries.includes(required), true, `Missing required file: ${required}`);
    }
    for (const forbidden of [
      '.env',
      '.env.candidate',
      '.env.backup-20261110',
      'certs/private.pem',
      'keys/api.key',
      'backups/old.dump',
      'node_modules/dotenv/index.js',
      'packages/shared/dist/index.js',
      '.git/HEAD',
      'artifacts/screen.png',
      'playwright-report/index.html',
      'test-results/res.xml',
      'docker-compose.oci.yml',
      'storage/resumes/candidate.pdf',
    ]) {
      assert.equal(entries.includes(forbidden), false, `Forbidden file leaked: ${forbidden}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

function createSshRolloutMock({
  idempotentMatch = false,
  checksumFail = false,
  remotePreflightFail = false,
  remoteComposeFail = false,
  backupFail = false,
  deployFail = false,
  httpsFail = false,
  snapshotPath = '',
} = {}) {
  const sshCommands = [];
  let scpCalled = false;

  const execFn = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { status: 0, stdout: 'main\n', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { status: 0, stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'status') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'scp') {
      scpCalled = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'ssh') {
      const remoteCmd = args[args.length - 1] ?? '';
      sshCommands.push(remoteCmd);

      if (remoteCmd.includes('command -v tar sha256sum')) {
        return { status: 0, stdout: 'DOCKER_COMPOSE_V2\n', stderr: '' };
      }
      if (remoteCmd.includes('IDEMPOTENT_SKIP')) {
        return { status: 0, stdout: idempotentMatch ? 'IDEMPOTENT_SKIP\n' : '', stderr: '' };
      }
      if (remoteCmd.includes('mkdir -p') && !remoteCmd.includes('tar -xzf')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (remoteCmd.includes('sha256sum -c')) {
        return checksumFail
          ? { status: 1, stdout: '', stderr: 'FAILED checksum' }
          : { status: 0, stdout: 'OK\n', stderr: '' };
      }
      if (remoteCmd.includes('tar -xzf')) {
        return {
          status: 0,
          stdout: snapshotPath ? `SYNC_OK SNAPSHOT=${snapshotPath} REMOVED=1\n` : '',
          stderr: '',
        };
      }
      if (remoteCmd.includes('preflight-env.mjs')) {
        return remotePreflightFail
          ? { status: 1, stdout: '', stderr: 'preflight rejected' }
          : { status: 0, stdout: 'PASS', stderr: '' };
      }
      if (remoteCmd.includes('config --quiet')) {
        return remoteComposeFail
          ? { status: 1, stdout: '', stderr: 'compose error' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (remoteCmd.includes('scripts/backup.sh')) {
        return backupFail
          ? { status: 1, stdout: '', stderr: 'pg_dump failed' }
          : {
              status: 0,
              stdout:
                'Created archive /var/backups/talentlens/talentlens_db_20261110_120000Z.dump\n',
              stderr: '',
            };
      }
      if (remoteCmd.includes(':previous')) {
        return {
          status: 0,
          stdout: 'talentlens-web:previous\ntalentlens-api:previous\ntalentlens-worker:previous\n',
          stderr: '',
        };
      }
      if (remoteCmd.includes('bash deploy.sh')) {
        return deployFail
          ? { status: 1, stdout: '', stderr: 'deploy aborted' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (remoteCmd.includes('/api/v1/health/ready')) {
        return httpsFail
          ? { status: 1, stdout: '', stderr: '502' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (remoteCmd.includes('.current-release.json.tmp')) {
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  return { execFn, sshCommands, wasScpCalled: () => scpCalled };
}

test('9. deploy-production aborts on Stage 6 remote sha256sum mismatch BEFORE unpack or rollout', () => {
  const dir = makeTempDir('tl-prod-sha-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const mock = createSshRolloutMock({ checksumFail: true });
    const streams = createBufferedStreams();

    const code = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: mock.execFn, stdout: streams.stdout, stderr: streams.stderr },
    );

    assert.equal(code, 1);
    assert.equal(mock.wasScpCalled(), true);
    assert.equal(
      mock.sshCommands.some((c) => c.includes('sha256sum -c')),
      true,
    );
    assert.equal(
      mock.sshCommands.some((c) => c.includes('tar -xzf')),
      false,
    );
    assert.equal(
      mock.sshCommands.some((c) => c.includes('bash deploy.sh')),
      false,
    );
    assert.match(streams.allOutput(), /checksum verification FAILED before unpack/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('10. deploy-production aborts on Stage 7 remote preflight-env or compose failure BEFORE backup or rollout', () => {
  const dir = makeTempDir('tl-prod-stage7-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });

    const preflightMock = createSshRolloutMock({ remotePreflightFail: true });
    const s1 = createBufferedStreams();
    const exit1 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: preflightMock.execFn, stdout: s1.stdout, stderr: s1.stderr },
    );
    assert.equal(exit1, 1);
    assert.equal(
      preflightMock.sshCommands.some((c) => c.includes('scripts/backup.sh')),
      false,
    );
    assert.equal(
      preflightMock.sshCommands.some((c) => c.includes('bash deploy.sh')),
      false,
    );

    const composeMock = createSshRolloutMock({ remoteComposeFail: true });
    const s2 = createBufferedStreams();
    const exit2 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: composeMock.execFn, stdout: s2.stdout, stderr: s2.stderr },
    );
    assert.equal(exit2, 1);
    assert.equal(
      composeMock.sshCommands.some((c) => c.includes('config --quiet')),
      true,
    );
    assert.equal(
      composeMock.sshCommands.some((c) => c.includes('scripts/backup.sh')),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('11. deploy-production enforces mandatory pre-rollout custom backup and fails closed on --skip-backup', () => {
  const skipGuard = validateExecutionGuard(
    parseDeployProductionArgs(['--execute', '--confirm-production', '--skip-backup']),
  );
  assert.equal(skipGuard.allowed, false);
  assert.match(skipGuard.reason, /--skip-backup/);

  const dir = makeTempDir('tl-prod-backup-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });

    const backupFailMock = createSshRolloutMock({ backupFail: true });
    const s1 = createBufferedStreams();
    const exit1 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: backupFailMock.execFn, stdout: s1.stdout, stderr: s1.stderr },
    );
    assert.equal(exit1, 1);
    assert.equal(
      backupFailMock.sshCommands.some((c) => c.includes('--format custom')),
      true,
    );
    assert.equal(
      backupFailMock.sshCommands.some((c) => c.includes('bash deploy.sh')),
      false,
    );

    const skipMock = createSshRolloutMock();
    const s2 = createBufferedStreams();
    const exit2 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--skip-backup',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: skipMock.execFn, stdout: s2.stdout, stderr: s2.stderr },
    );
    assert.equal(exit2, 1);
    assert.equal(skipMock.sshCommands.length, 0);
    assert.equal(skipMock.wasScpCalled(), false);
    assert.match(
      s2.allOutput(),
      /Refusing live production execution with --skip-backup: mandatory pre-rollout PostgreSQL backup cannot be bypassed/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('12. deploy-production Stage 5 idempotency skips healthy unchanged release unless --force is passed', () => {
  const dir = makeTempDir('tl-prod-idem-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });

    const idemMock = createSshRolloutMock({ idempotentMatch: true });
    const s1 = createBufferedStreams();
    const exit1 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
      ],
      { cwd: dir, execFn: idemMock.execFn, stdout: s1.stdout, stderr: s1.stderr },
    );
    assert.equal(exit1, 0);
    assert.equal(idemMock.wasScpCalled(), false);
    assert.equal(
      idemMock.sshCommands.some((c) => c.includes('bash deploy.sh')),
      false,
    );
    assert.match(s1.allOutput(), /\[IDEMPOTENT SKIP\]/);

    const forceMock = createSshRolloutMock({ idempotentMatch: true });
    const s2 = createBufferedStreams();
    const exit2 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--force',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
      ],
      { cwd: dir, execFn: forceMock.execFn, stdout: s2.stdout, stderr: s2.stderr },
    );
    assert.equal(exit2, 0);
    assert.equal(forceMock.wasScpCalled(), true);
    assert.equal(
      forceMock.sshCommands.some((c) => c.includes('bash deploy.sh')),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('13. deploy-production tags :previous, records .current-release.json, and emits exact rollback commands', () => {
  const dir = makeTempDir('tl-prod-ok-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });

    const okMock = createSshRolloutMock();
    const s1 = createBufferedStreams();
    const fixedNow = () => new Date('2026-11-10T18:00:00.000Z');
    const exit1 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
        '--project-name',
        'talentlens',
      ],
      { cwd: dir, execFn: okMock.execFn, nowFn: fixedNow, stdout: s1.stdout, stderr: s1.stderr },
    );
    assert.equal(exit1, 0);
    const out1 = s1.allOutput();
    assert.match(
      out1,
      /talentlens-web:previous, talentlens-api:previous, talentlens-worker:previous/,
    );
    assert.match(
      out1,
      /--confirm-replace-existing \/var\/backups\/talentlens\/talentlens_db_20261110_120000Z\.dump/,
    );
    const metaCmd = okMock.sshCommands.find(
      (c) => c.includes('.current-release.json') && c.includes('fs.renameSync'),
    );
    assert.ok(metaCmd, 'Expected atomic .current-release.json write command');
    assert.equal(metaCmd.includes('2026-11-10T18:00:00.000Z'), true);

    const failMock = createSshRolloutMock({ deployFail: true });
    const s2 = createBufferedStreams();
    const exit2 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: failMock.execFn, nowFn: fixedNow, stdout: s2.stdout, stderr: s2.stderr },
    );
    assert.equal(exit2, 1);
    const out2 = s2.allOutput();
    assert.match(out2, /Rollback Procedure:/);
    assert.match(out2, /talentlens-web:previous/);
    assert.match(out2, /talentlens_db_20261110_120000Z\.dump/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('14. CLI real subprocess: deploy-local --dry-run succeeds for valid fixture and rejects invalid env', () => {
  const dir = makeTempDir('tl-cli-local-');
  try {
    const localEnv = path.join(dir, 'local.env');
    fs.writeFileSync(
      localEnv,
      'NODE_ENV=development\nAPI_PORT=4000\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\n',
      'utf8',
    );
    const localOut = execFileSync(
      process.execPath,
      ['--', 'scripts/deploy-local.mjs', '--dry-run', '--env-file', localEnv],
      { encoding: 'utf8' },
    );
    assert.match(localOut, /\[DRY RUN COMPLETE\]/);

    const prodLocalEnv = path.join(dir, 'prod.env');
    fs.writeFileSync(
      prodLocalEnv,
      'NODE_ENV=production\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\n',
      'utf8',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['--', 'scripts/deploy-local.mjs', '--dry-run', '--env-file', prodLocalEnv],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      (err) => err.status !== 0,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('15. CLI real subprocess: deploy-production dry-run succeeds cleanly and rejects --execute without confirmation', () => {
  const dir = makeTempDir('tl-cli-prod-');
  try {
    const validProdEnv = path.join(dir, 'prod.env');
    fs.writeFileSync(
      validProdEnv,
      createProdFixtureEnv({ GEMINI_API_KEY: 'AIzaSyFixtureValidGeminiKey1234567890' }),
      'utf8',
    );
    const prodOut = execFileSync(
      process.execPath,
      ['--', 'scripts/deploy-production.mjs', '--env-file', validProdEnv],
      { encoding: 'utf8' },
    );
    assert.match(prodOut, /\[DRY RUN COMPLETE\]/);

    const localEnv = path.join(dir, 'local.env');
    fs.writeFileSync(
      localEnv,
      'NODE_ENV=development\nDATABASE_URL=postgresql://talentlens:pw@localhost:5432/talentlens\n',
      'utf8',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['--', 'scripts/deploy-production.mjs', '--env-file', localEnv],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      (err) => err.status !== 0,
    );

    assert.throws(
      () =>
        execFileSync(process.execPath, ['--', 'scripts/deploy-production.mjs', '--execute'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (err) =>
        err.status !== 0 &&
        String(err.stderr || err.stdout).includes('--confirm-production is required'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('16. deploy-production preserves and auto-reuses server-only docker-compose.oci.yml across SSH stages', () => {
  const parsed = parseRemoteProbeOutput('DOCKER_COMPOSE_V2\nHAS_OCI_OVERLAY\n');
  assert.equal(parsed.compose?.display, 'docker compose');
  assert.equal(parsed.hasOciOverlay, true);

  const dir = makeTempDir('tl-prod-oci-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const sshCommands = [];
    const execFn = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { status: 0, stdout: 'main\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'status') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'scp') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ssh') {
        const remoteCmd = args[args.length - 1] ?? '';
        sshCommands.push(remoteCmd);
        if (remoteCmd.includes('command -v tar sha256sum')) {
          return { status: 0, stdout: 'DOCKER_COMPOSE_V2\nHAS_OCI_OVERLAY\n', stderr: '' };
        }
        if (remoteCmd.includes('scripts/backup.sh')) {
          return {
            status: 0,
            stdout: 'Created archive /var/backups/talentlens/talentlens_db_20261110_180000Z.dump\n',
            stderr: '',
          };
        }
        if (remoteCmd.includes(':previous')) {
          return {
            status: 0,
            stdout:
              'talentlens-web:previous\ntalentlens-api:previous\ntalentlens-worker:previous\n',
            stderr: '',
          };
        }
        return { status: 0, stdout: 'OK\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const streams = createBufferedStreams();
    const exit = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--env-file',
        '../.env.candidate',
        '--project-name',
        'talentlens',
      ],
      { cwd: dir, execFn, stdout: streams.stdout, stderr: streams.stderr },
    );

    assert.equal(exit, 0);
    assert.match(streams.allOutput(), /Detected server-only OCI overlay/);
    assert.match(streams.allOutput(), /-f docker-compose\.oci\.yml/);

    const stage7Compose = sshCommands.find((c) => c.includes('config --quiet'));
    assert.ok(stage7Compose, 'Expected Stage 7 compose validation');
    assert.match(stage7Compose, /test -f 'docker-compose\.oci\.yml'/);

    const backupCmd = sshCommands.find((c) => c.includes('scripts/backup.sh'));
    assert.ok(backupCmd?.includes("-f 'docker-compose.oci.yml'"));

    const deployCmd = sshCommands.find((c) => c.includes('bash deploy.sh'));
    assert.ok(deployCmd?.includes("COMPOSE_FILE='docker-compose.oci.yml'"));
    assert.ok(deployCmd?.includes("ENV_FILE='../.env.candidate'"));

    const metaCmd = sshCommands.find((c) => c.includes('.current-release.json'));
    assert.ok(metaCmd?.includes('docker-compose.oci.yml'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('17. Stage 5 idempotency + Stage 9 release marker hash compose/env without secret leaks and verify HTTP /', () => {
  const dir = makeTempDir('tl-prod-fingerprint-');
  try {
    const remoteSource = path.join(dir, 'source');
    fs.mkdirSync(remoteSource, { recursive: true });
    fs.writeFileSync(
      path.join(remoteSource, 'docker-compose.oci.yml'),
      'services:\n  web: {}\n',
      'utf8',
    );
    const envSecret = 'SUPER_SECRET_PASSWORD_FOR_FINGERPRINT_TEST';
    fs.writeFileSync(
      path.join(dir, '.env.candidate'),
      `APP_ORIGIN=https://talentlens.example.com\nPOSTGRES_PASSWORD=${envSecret}\n`,
      'utf8',
    );

    const releaseMeta = {
      deployedAt: '2026-11-10T18:00:00.000Z',
      commitSha: 'abcdef123456',
      shortSha: 'abcdef123456',
      sourceDigest: 'a'.repeat(64),
      tarballSha256: 'b'.repeat(64),
      composeFile: 'docker-compose.oci.yml',
      envFile: '../.env.candidate',
      projectName: 'talentlens',
      backupArchive: '/var/backups/talentlens/test.dump',
    };

    const writeCmd = buildRemoteReleaseWriteCommand({
      remoteDir: remoteSource,
      releaseMeta,
      composeFile: 'docker-compose.oci.yml',
      envFile: '../.env.candidate',
    });

    // Execute the exact generated node -e snippet against real temp files
    const nodeScriptMatch =
      /node -e '((?:[^']|'"'"')*)' '([^']*)' '([^']*)' '([^']*)' '((?:[^']|'"'"')*)'/.exec(
        writeCmd,
      );
    assert.ok(nodeScriptMatch, 'Expected valid quoted node -e arguments in release write command');
    const unquote = (s) => s.replace(/'"'"'/g, "'");
    execFileSync(
      process.execPath,
      [
        '-e',
        unquote(nodeScriptMatch[1]),
        nodeScriptMatch[2],
        nodeScriptMatch[3],
        nodeScriptMatch[4],
        unquote(nodeScriptMatch[5]),
      ],
      { cwd: remoteSource, encoding: 'utf8' },
    );

    const writtenPath = path.join(remoteSource, '.current-release.json');
    assert.equal(fs.existsSync(writtenPath), true);
    const writtenText = fs.readFileSync(writtenPath, 'utf8');
    assert.equal(
      writtenText.includes(envSecret),
      false,
      'Release marker must never store env secrets',
    );
    const written = JSON.parse(writtenText);
    assert.match(written.composeSha256, /^[0-9a-f]{64}$/);
    assert.match(written.envSha256, /^[0-9a-f]{64}$/);
    assert.equal(written.envFile, '../.env.candidate');

    const idemCmd = buildRemoteIdempotencyCommand({
      remoteDir: remoteSource,
      remoteCompose: { bin: 'docker', prefixArgs: ['compose'], display: 'docker compose' },
      options: {
        composeFile: 'docker-compose.oci.yml',
        envFile: '../.env.candidate',
        projectName: 'talentlens',
      },
      sourceDigest: 'a'.repeat(64),
    });
    assert.equal(idemCmd.includes('composeSha256'), true);
    assert.equal(idemCmd.includes('envSha256'), true);
    assert.equal(idemCmd.includes('origin + "/"'), true);
    assert.equal(idemCmd.includes('origin + "/api/v1/health/ready"'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('18. Rollback guidance emits container :previous recovery command and deploy.sh preserves PG/ClamAV volumes', () => {
  const dir = makeTempDir('tl-prod-rollback-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const okMock = createSshRolloutMock();
    const streams = createBufferedStreams();
    const exit = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: okMock.execFn, stdout: streams.stdout, stderr: streams.stderr },
    );
    assert.equal(exit, 0);
    const out = streams.allOutput();
    assert.match(out, /Container rollback: for svc in web api worker/);
    assert.match(out, /up -d --no-build --no-deps api worker web/);

    const tagCmd = okMock.sshCommands.find((c) => c.includes(':previous'));
    assert.ok(tagCmd?.includes("docker inspect --format '{{.Image}}'"));

    const realDeploySh = fs.readFileSync(path.resolve('deploy.sh'), 'utf8');
    assert.match(realDeploySh, /COMPOSE_VOLUMES/);
    assert.match(realDeploySh, /pgdata/);
    assert.match(realDeploySh, /clamav_db/);
    assert.equal(/\b(down\s+-v|volume\s+rm|rm\s+-v)\b/.test(realDeploySh), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function extractSingleQuotedArgsAfterNodeE(commandStr) {
  const marker = 'node -e ';
  const idx = commandStr.indexOf(marker);
  assert.notEqual(idx, -1, `Expected "${marker}" inside generated command`);
  let rest = commandStr.slice(idx + marker.length);
  const tokens = [];
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (!rest.startsWith("'")) break;
    let i = 1;
    let value = '';
    while (i < rest.length) {
      if (rest.startsWith("'\"'\"'", i)) {
        value += "'";
        i += 5;
        continue;
      }
      if (rest[i] === "'") {
        i += 1;
        break;
      }
      value += rest[i];
      i += 1;
    }
    tokens.push(value);
    rest = rest.slice(i);
  }
  return tokens;
}

test('19. preflight-env runs standalone without node_modules, parses .env faithfully, rejects symlinks, and enforces --strict-perms', () => {
  const isolatedRoot = makeTempDir('tl-isolated-preflight-');
  try {
    const isolatedScript = path.join(isolatedRoot, 'scripts', 'preflight-env.mjs');
    fs.mkdirSync(path.dirname(isolatedScript), { recursive: true });
    fs.copyFileSync(path.resolve('scripts/preflight-env.mjs'), isolatedScript);

    const envFile = path.join(isolatedRoot, '.env.candidate');
    fs.writeFileSync(
      envFile,
      createProdFixtureEnv({ GEMINI_API_KEY: 'AIzaSyFixtureValidGeminiKey1234567890' }),
      'utf8',
    );

    const out = execFileSync(process.execPath, [isolatedScript, envFile], {
      cwd: isolatedRoot,
      encoding: 'utf8',
    });
    assert.match(out, /PREFLIGHT VERDICT: \[PASS\]/);

    const parsed = parseDotEnvContent(
      [
        '# comment',
        'export APP_ORIGIN="https://talentlens.example.com" # inline',
        "SINGLE_QUOTED='value with # not comment'",
        'DOUBLE_ESCAPED="line1\\nline2"',
        'UNQUOTED=abc # trailing comment',
      ].join('\n'),
    );
    assert.equal(parsed.APP_ORIGIN, 'https://talentlens.example.com');
    assert.equal(parsed.SINGLE_QUOTED, 'value with # not comment');
    assert.equal(parsed.DOUBLE_ESCAPED, 'line1\nline2');
    assert.equal(parsed.UNQUOTED, 'abc');

    const symlinkStreams = createBufferedStreams();
    const symlinkExit = runPreflightEnv([envFile], {
      cwd: isolatedRoot,
      platform: 'linux',
      stdout: symlinkStreams.stdout,
      stderr: symlinkStreams.stderr,
      fsImpl: {
        existsSync: () => true,
        lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false, mode: 0o120777 }),
        readFileSync: () => fs.readFileSync(envFile, 'utf8'),
      },
    });
    assert.equal(symlinkExit, 1);
    assert.match(symlinkStreams.allOutput(), /regular non-symlink file/);

    const loosePermsStreams = createBufferedStreams();
    const looseFailExit = runPreflightEnv([envFile, '--strict-perms'], {
      cwd: isolatedRoot,
      platform: 'linux',
      stdout: loosePermsStreams.stdout,
      stderr: loosePermsStreams.stderr,
      fsImpl: {
        existsSync: () => true,
        lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o100644 }),
        readFileSync: () => fs.readFileSync(envFile, 'utf8'),
      },
    });
    assert.equal(looseFailExit, 1);
    assert.match(loosePermsStreams.allOutput(), /ENV_FILE_PERMISSIONS.*chmod 600/);

    const tightStreams = createBufferedStreams();
    const tightPassExit = runPreflightEnv([envFile, '--strict-perms'], {
      cwd: isolatedRoot,
      platform: 'linux',
      stdout: tightStreams.stdout,
      stderr: tightStreams.stderr,
      fsImpl: {
        existsSync: () => true,
        lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o100600 }),
        readFileSync: () => fs.readFileSync(envFile, 'utf8'),
      },
    });
    assert.equal(tightPassExit, 0);
    assert.match(tightStreams.allOutput(), /PASS.*ENV_FILE_PERMISSIONS/);
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('20. Stage 7 remote sync removes stale files, preserves OCI overlay/.env/node_modules, creates non-secret snapshot, and supports clean snapshot restore', () => {
  const baseDir = makeTempDir('tl-sync-snapshot-');
  try {
    const remoteDir = path.join(baseDir, 'source');
    const stagingDir = path.join(baseDir, '.release-staging');
    const timestampTag = '20261110T180000Z';
    const shortSha = 'abcdef123456';
    const suffix = `${timestampTag}-${shortSha}`;
    const unpackDir = path.join(stagingDir, `unpacked-${suffix}`);
    const snapshotDir = path.join(baseDir, '.release-previous', suffix);

    const write = (abs, content) => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    };

    // Old source tree on server (includes stale deleted files + preserved host-only files)
    write(path.join(remoteDir, 'package.json'), '{"version":"1.0.0"}\n');
    write(path.join(remoteDir, 'apps/api/src/obsolete-removed.ts'), 'export const old = 1;\n');
    write(
      path.join(remoteDir, 'prisma/migrations/999_obsolete/migration.sql'),
      '-- obsolete migration\n',
    );
    write(path.join(remoteDir, 'old-root-helper.sh'), '#!/bin/sh\necho old\n');
    write(path.join(remoteDir, 'docker-compose.oci.yml'), 'services:\n  api:\n    ports: []\n');
    write(path.join(remoteDir, '.current-release.json'), '{"shortSha":"prior000"}\n');
    write(path.join(remoteDir, '.env'), 'SECRET=keep_untouched\n');
    write(path.join(remoteDir, '.env.local'), 'LOCAL_SECRET=keep_untouched\n');
    write(path.join(remoteDir, 'node_modules/dotenv/index.js'), 'module.exports = {};\n');
    write(path.join(remoteDir, 'backups/existing.dump'), 'PGDMP_KEEP');
    write(path.join(stagingDir, `talentlens-release-${shortSha}.tar.gz`), 'tarbytes');

    // Newly unpacked release tree
    write(path.join(unpackDir, 'package.json'), '{"version":"2.0.0"}\n');
    write(
      path.join(unpackDir, 'packages/assessment-engine/src/ai-failover.ts'),
      'export const failover = true;\n',
    );
    write(
      path.join(unpackDir, 'packages/assessment-engine/src/groq-client.ts'),
      'export const groq = true;\n',
    );
    write(path.join(unpackDir, 'deploy.sh'), '#!/usr/bin/env bash\necho v2\n');

    const syncCmd = buildRemoteSyncCommand({
      remoteDir: remoteDir.replace(/\\/g, '/'),
      remoteStagingDir: stagingDir.replace(/\\/g, '/'),
      tarballName: `talentlens-release-${shortSha}.tar.gz`,
      shortSha,
      timestampTag,
      composeFile: 'docker-compose.oci.yml',
    });
    const syncNodeTokens = extractSingleQuotedArgsAfterNodeE(syncCmd);
    const syncOut = execFileSync(process.execPath, ['-e', ...syncNodeTokens], {
      encoding: 'utf8',
    });
    assert.match(syncOut, /SYNC_OK SNAPSHOT=.*REMOVED=3/);

    // Stale files & empty obsolete dirs removed
    assert.equal(fs.existsSync(path.join(remoteDir, 'apps/api/src/obsolete-removed.ts')), false);
    assert.equal(fs.existsSync(path.join(remoteDir, 'prisma/migrations/999_obsolete')), false);
    assert.equal(fs.existsSync(path.join(remoteDir, 'old-root-helper.sh')), false);

    // New files synced
    assert.equal(
      fs.readFileSync(path.join(remoteDir, 'package.json'), 'utf8'),
      '{"version":"2.0.0"}\n',
    );
    assert.equal(
      fs.existsSync(path.join(remoteDir, 'packages/assessment-engine/src/ai-failover.ts')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(remoteDir, 'packages/assessment-engine/src/groq-client.ts')),
      true,
    );
    assert.equal(fs.existsSync(unpackDir), false, 'unpackDir should be cleaned up');

    // Preserved host-only & secret files untouched
    assert.equal(
      fs.readFileSync(path.join(remoteDir, 'docker-compose.oci.yml'), 'utf8'),
      'services:\n  api:\n    ports: []\n',
    );
    assert.equal(
      fs.readFileSync(path.join(remoteDir, '.current-release.json'), 'utf8'),
      '{"shortSha":"prior000"}\n',
    );
    assert.equal(fs.readFileSync(path.join(remoteDir, '.env'), 'utf8'), 'SECRET=keep_untouched\n');
    assert.equal(
      fs.readFileSync(path.join(remoteDir, '.env.local'), 'utf8'),
      'LOCAL_SECRET=keep_untouched\n',
    );
    assert.equal(fs.existsSync(path.join(remoteDir, 'node_modules/dotenv/index.js')), true);
    assert.equal(fs.existsSync(path.join(remoteDir, 'backups/existing.dump')), true);

    // Snapshot captures old source + OCI overlay WITHOUT leaking .env*, node_modules, or backups
    assert.equal(fs.existsSync(path.join(snapshotDir, 'apps/api/src/obsolete-removed.ts')), true);
    assert.equal(fs.existsSync(path.join(snapshotDir, 'docker-compose.oci.yml')), true);
    assert.equal(fs.existsSync(path.join(snapshotDir, '.current-release.json')), true);
    assert.equal(fs.existsSync(path.join(snapshotDir, '.env')), false);
    assert.equal(fs.existsSync(path.join(snapshotDir, '.env.local')), false);
    assert.equal(fs.existsSync(path.join(snapshotDir, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(snapshotDir, 'backups')), false);

    // Execute snapshot restore and verify pre-rollout tree returns cleanly
    const restoreCmd = buildRemoteRestoreSnapshotCommand({
      remoteDir: remoteDir.replace(/\\/g, '/'),
      snapshotDir: snapshotDir.replace(/\\/g, '/'),
      composeFile: 'docker-compose.oci.yml',
    });
    const restoreTokens = extractSingleQuotedArgsAfterNodeE(restoreCmd);
    const restoreOut = execFileSync(process.execPath, ['-e', ...restoreTokens], {
      encoding: 'utf8',
    });
    assert.match(restoreOut, /RESTORE_SNAPSHOT_OK/);

    assert.equal(
      fs.readFileSync(path.join(remoteDir, 'package.json'), 'utf8'),
      '{"version":"1.0.0"}\n',
    );
    assert.equal(fs.existsSync(path.join(remoteDir, 'apps/api/src/obsolete-removed.ts')), true);
    assert.equal(
      fs.existsSync(path.join(remoteDir, 'packages/assessment-engine/src/ai-failover.ts')),
      false,
    );
    assert.equal(fs.readFileSync(path.join(remoteDir, '.env'), 'utf8'), 'SECRET=keep_untouched\n');
    assert.equal(fs.existsSync(path.join(remoteDir, 'node_modules/dotenv/index.js')), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('21. deploy-production auto-restores snapshot on Stage 7/8 failures, enforces --strict-perms, and prints snapshot+container+DB rollback on Stage 9 failure', () => {
  const dir = makeTempDir('tl-prod-snapshot-rollback-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const snapshotPath =
      '/home/ubuntu/talentlens-release-staging-20261110/.release-previous/20261110T180000Z-abcdef123456';

    // Stage 7 preflight failure auto-restores snapshot
    const preflightMock = createSshRolloutMock({ remotePreflightFail: true, snapshotPath });
    const s1 = createBufferedStreams();
    const exit1 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: preflightMock.execFn, stdout: s1.stdout, stderr: s1.stderr },
    );
    assert.equal(exit1, 1);
    assert.equal(
      preflightMock.sshCommands.some(
        (c) => c.includes('preflight-env.mjs') && c.includes('--strict-perms'),
      ),
      true,
    );
    assert.equal(
      preflightMock.sshCommands.some(
        (c) => c.includes('RESTORE_SNAPSHOT_OK') && c.includes(snapshotPath),
      ),
      true,
      'Expected automatic snapshot restore on Stage 7 preflight failure',
    );
    assert.match(s1.allOutput(), /\[ROLLBACK\] Automatically restored/);

    // Stage 8 backup failure auto-restores snapshot before deploy.sh ever runs
    const backupMock = createSshRolloutMock({ backupFail: true, snapshotPath });
    const s2 = createBufferedStreams();
    const exit2 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: backupMock.execFn, stdout: s2.stdout, stderr: s2.stderr },
    );
    assert.equal(exit2, 1);
    assert.equal(
      backupMock.sshCommands.some(
        (c) => c.includes('RESTORE_SNAPSHOT_OK') && c.includes(snapshotPath),
      ),
      true,
      'Expected automatic snapshot restore on Stage 8 backup failure',
    );

    // Stage 9 deploy failure prints full 3-part rollback (snapshot + :previous images + .dump) without silently reverting migrated state
    const deployFailMock = createSshRolloutMock({ deployFail: true, snapshotPath });
    const s3 = createBufferedStreams();
    const exit3 = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--env-file',
        '../.env.candidate',
      ],
      { cwd: dir, execFn: deployFailMock.execFn, stdout: s3.stdout, stderr: s3.stderr },
    );
    assert.equal(exit3, 1);
    assert.equal(
      deployFailMock.sshCommands.some((c) => c.includes('RESTORE_SNAPSHOT_OK')),
      false,
    );
    const out3 = s3.allOutput();
    assert.match(out3, /Previous source & Compose snapshot captured:/);
    assert.match(out3, new RegExp(snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(out3, /Container rollback: for svc in web api worker/);
    assert.match(out3, /Restore DB archive:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('22. Rejects unsafe root/system --remote-dir targets and preserves --project-directory for external OCI compose overlays', () => {
  for (const unsafeDir of [
    '/',
    '/etc',
    '/etc/ssh',
    '/home',
    '/var',
    '/home/ubuntu//source',
    '/home/ubuntu/./source',
  ]) {
    const res = validateExecutionGuard(
      parseDeployProductionArgs([
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        unsafeDir,
      ]),
    );
    assert.equal(res.allowed, false, `Expected --remote-dir "${unsafeDir}" to be rejected`);
    assert.match(res.reason, /Unsafe or invalid --remote-dir/);
  }

  const dir = makeTempDir('tl-prod-ext-compose-');
  try {
    createFakeWorkspaceForDeploy(dir, { includeEnv: false });
    const mock = createSshRolloutMock();
    const streams = createBufferedStreams();
    const exit = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@talentlens-demo-01',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261111/source',
        '--compose-file',
        '/home/ubuntu/talentlens-release-staging-20261110/source/docker-compose.oci.yml',
        '--env-file',
        '/home/ubuntu/talentlens-release-staging-20261110/.env.candidate',
        '--project-name',
        'talentlens',
      ],
      { cwd: dir, execFn: mock.execFn, stdout: streams.stdout, stderr: streams.stderr },
    );
    assert.equal(exit, 0);

    const idemCmd = mock.sshCommands.find((c) => c.includes('IDEMPOTENT_SKIP'));
    assert.ok(idemCmd?.includes('--project-directory .'));

    const stage7Compose = mock.sshCommands.find((c) => c.includes('config --quiet'));
    assert.ok(stage7Compose?.includes('docker compose --project-directory .'));

    const deployCmd = mock.sshCommands.find((c) => c.includes('bash deploy.sh'));
    assert.ok(
      deployCmd?.includes(
        "COMPOSE_FILE='/home/ubuntu/talentlens-release-staging-20261110/source/docker-compose.oci.yml'",
      ),
    );
    assert.ok(
      deployCmd?.includes(
        "ENV_FILE='/home/ubuntu/talentlens-release-staging-20261110/.env.candidate'",
      ),
    );

    const realDeploySh = fs.readFileSync(path.resolve('deploy.sh'), 'utf8');
    assert.match(realDeploySh, /COMPOSE_PROJECT_DIR_ARGS=\(--project-directory "\$\(pwd\)"\)/);
    assert.match(realDeploySh, /if \[ -L "\$\{ENV_FILE\}" \]; then/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('23. CLI regression: remote-only ../.env.candidate dry-run succeeds via npm run and direct node --remote-env-file on Windows without Node intercepting --env-file', () => {
  const pkgJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.match(pkgJson.scripts['deploy:production'], /^node -- scripts\/deploy-production\.mjs$/);
  assert.match(pkgJson.scripts['deploy:local'], /^node -- scripts\/deploy-local\.mjs$/);

  const npmArgs = [
    'run',
    'deploy:production',
    '--',
    '--ssh-host',
    'ubuntu@140.245.226.85',
    '--remote-dir',
    '/home/ubuntu/talentlens-release-staging-20261110/source',
    '--compose-file',
    'docker-compose.oci.yml',
    '--env-file',
    '../.env.candidate',
    '--project-name',
    'talentlens',
  ];
  const npmOut =
    process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/c', 'npm.cmd', ...npmArgs], { encoding: 'utf8' })
      : execFileSync('npm', npmArgs, { encoding: 'utf8' });
  assert.match(npmOut, /Deploy Target:\s+Remote OCI host via SSH \(ubuntu@140\.245\.226\.85\)/);
  assert.match(npmOut, /Remote Env File:\s+\.\.\/\.env\.candidate \(protected on OCI host/);
  assert.match(npmOut, /Local Env File:\s+not used for remote OCI rollout/);
  assert.match(npmOut, /were NOT executed \(pass --execute --confirm-production/);
  assert.equal(/\[PASS\]/.test(npmOut), false, 'Dry-run must not claim remote checks passed');
  assert.match(npmOut, /\[DRY RUN COMPLETE\]/);

  const directNodeOut = execFileSync(
    process.execPath,
    [
      'scripts/deploy-production.mjs',
      '--ssh-host',
      'ubuntu@140.245.226.85',
      '--remote-dir',
      '/home/ubuntu/talentlens-release-staging-20261110/source',
      '--compose-file',
      'docker-compose.oci.yml',
      '--remote-env-file',
      '../.env.candidate',
      '--project-name',
      'talentlens',
    ],
    { encoding: 'utf8' },
  );
  assert.match(directNodeOut, /Remote Env File:\s+\.\.\/\.env\.candidate/);
  assert.match(directNodeOut, /ENV_FILE=\.\.\/\.env\.candidate/);
  assert.match(directNodeOut, /\[DRY RUN COMPLETE\]/);

  // Explicit --env-file=../.env.candidate behind node -- must also reach script argv untouched
  const eqOut = execFileSync(
    process.execPath,
    [
      '--',
      'scripts/deploy-production.mjs',
      '--ssh-host',
      'ubuntu@140.245.226.85',
      '--remote-dir',
      '/home/ubuntu/talentlens-release-staging-20261110/source',
      '--compose-file',
      'docker-compose.oci.yml',
      '--env-file=../.env.candidate',
      '--project-name',
      'talentlens',
    ],
    { encoding: 'utf8' },
  );
  assert.match(eqOut, /Remote Env File:\s+\.\.\/\.env\.candidate/);
  assert.match(eqOut, /\[DRY RUN COMPLETE\]/);
});

test('24. Remote env targeting stays isolated from local .env, preserves fail-closed local checks, and forwards --remote-env-file to OCI Stages 5-9', () => {
  const dir = makeTempDir('tl-remote-env-iso-');
  try {
    createFakeWorkspaceForDeploy(dir, {
      includeEnv: true,
      envContent: 'NODE_ENV=development\nLOCAL_WORKSTATION_ONLY=must_never_leak_to_prod\n',
    });

    // Even with local .env present and --strict passed, remote dry-run never reads local .env or ../ .env.candidate
    const localReads = [];
    const spyingFs = {
      ...fs,
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p, enc) => {
        localReads.push(String(p));
        return fs.readFileSync(p, enc);
      },
    };
    const dryStreams = createBufferedStreams();
    const dryExit = runDeployProductionMain(
      [
        '--ssh-host',
        'ubuntu@140.245.226.85',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--remote-env-file',
        '../.env.candidate',
        '--project-name',
        'talentlens',
        '--strict',
      ],
      { cwd: dir, fsImpl: spyingFs, stdout: dryStreams.stdout, stderr: dryStreams.stderr },
    );
    assert.equal(dryExit, 0);
    assert.equal(
      localReads.some((p) => p.endsWith('.env') || p.includes('.env.candidate')),
      false,
      'Remote target mode must never read local .env or local .env.candidate',
    );
    const dryOut = dryStreams.allOutput();
    assert.equal(dryOut.includes('must_never_leak_to_prod'), false);
    assert.match(dryOut, /--strict local env validation does not apply to remote-only file/);
    assert.equal(/\[PASS\]/.test(dryOut), false);

    // Reject specifying both --env-file and --remote-env-file explicitly
    const conflictGuard = validateExecutionGuard(
      parseDeployProductionArgs(['--env-file', '.env', '--remote-env-file', '../.env.candidate']),
    );
    assert.equal(conflictGuard.allowed, false);
    assert.match(conflictGuard.reason, /Specify either --env-file or --remote-env-file, not both/);

    // Keep --execute --confirm-production gating intact and disallow --remote-env-file execute without --ssh-host
    const missingConfirmGuard = validateExecutionGuard(
      parseDeployProductionArgs(['--remote-env-file', '../.env.candidate', '--execute']),
    );
    assert.equal(missingConfirmGuard.allowed, false);
    assert.match(missingConfirmGuard.reason, /--confirm-production is required/);

    const missingHostGuard = validateExecutionGuard(
      parseDeployProductionArgs([
        '--remote-env-file',
        '../.env.candidate',
        '--execute',
        '--confirm-production',
      ]),
    );
    assert.equal(missingHostGuard.allowed, false);
    assert.match(missingHostGuard.reason, /requires --ssh-host/);

    // Local-host mode (no --ssh-host and no --remote-env-file) still fails closed on missing --env-file or --strict
    const localFailStreams = createBufferedStreams();
    const localFailExit = runDeployProductionMain(['--env-file', '../.env.nonexistent'], {
      cwd: dir,
      stdout: localFailStreams.stdout,
      stderr: localFailStreams.stderr,
    });
    assert.equal(localFailExit, 1);
    assert.match(localFailStreams.allOutput(), /Target environment file not found/);

    // Execute full mock-SSH rollout using --remote-env-file ../.env.candidate
    const sshMock = createSshRolloutMock();
    const execStreams = createBufferedStreams();
    const execExit = runDeployProductionMain(
      [
        '--execute',
        '--confirm-production',
        '--ssh-host',
        'ubuntu@140.245.226.85',
        '--remote-dir',
        '/home/ubuntu/talentlens-release-staging-20261110/source',
        '--compose-file',
        'docker-compose.oci.yml',
        '--remote-env-file',
        '../.env.candidate',
        '--project-name',
        'talentlens',
      ],
      { cwd: dir, execFn: sshMock.execFn, stdout: execStreams.stdout, stderr: execStreams.stderr },
    );
    assert.equal(execExit, 0);
    assert.ok(
      sshMock.sshCommands.some(
        (c) =>
          c.includes('scripts/preflight-env.mjs') &&
          c.includes("'../.env.candidate'") &&
          c.includes('--strict-perms'),
      ),
    );
    assert.ok(
      sshMock.sshCommands.some(
        (c) => c.includes('config --quiet') && c.includes("--env-file '../.env.candidate'"),
      ),
    );
    assert.ok(
      sshMock.sshCommands.some(
        (c) => c.includes('scripts/backup.sh') && c.includes("--env-file '../.env.candidate'"),
      ),
    );
    assert.ok(
      sshMock.sshCommands.some(
        (c) => c.includes('bash deploy.sh') && c.includes("ENV_FILE='../.env.candidate'"),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
