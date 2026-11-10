#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);
const DOCKER_DB_HOST_ALIASES = new Set(['postgres', 'db']);
const SUPPORTED_AI_PROVIDERS = new Set(['gemini', 'groq']);

export const LOCAL_WORKSPACE_PACKAGES = [
  {
    name: '@talentlens/shared',
    dir: 'packages/shared',
    outputs: ['dist/index.js'],
    dependsOn: [],
  },
  {
    name: '@talentlens/document-processing',
    dir: 'packages/document-processing',
    outputs: ['dist/index.js'],
    dependsOn: ['@talentlens/shared'],
  },
  {
    name: '@talentlens/database',
    dir: 'packages/database',
    outputs: ['dist/index.js', 'src/generated/prisma/client.ts'],
    dependsOn: [],
  },
  {
    name: '@talentlens/assessment-engine',
    dir: 'packages/assessment-engine',
    outputs: ['dist/index.js'],
    dependsOn: ['@talentlens/shared', '@talentlens/database'],
  },
];

export const BUILD_CACHE_RELATIVE_PATH = 'node_modules/.cache/talentlens-local-deploy.json';

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
}

export function checkNodeVersion(versionString = process.versions.node) {
  const [majorStr, minorStr] = String(versionString).split('.');
  const major = Number.parseInt(majorStr ?? '0', 10);
  const minor = Number.parseInt(minorStr ?? '0', 10);
  const valid = major === 24 && minor >= 11;
  return {
    valid,
    version: versionString,
    requirement: '>=24.11.0 <25',
  };
}

export function parseDeployLocalArgs(argv) {
  let dryRun = false;
  let skipBuild = false;
  let skipDb = false;
  let skipPreflight = false;
  let applyMigrations = false;
  let start = false;
  let force = false;
  let envFile = '.env';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else if (arg === '--skip-db') {
      skipDb = true;
    } else if (arg === '--skip-preflight') {
      skipPreflight = true;
    } else if (arg === '--apply-migrations') {
      applyMigrations = true;
    } else if (arg === '--start') {
      start = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length).trim();
      if (!envFile) {
        throw new Error('--env-file requires a non-empty file path.');
      }
    } else if (arg === '--env-file') {
      const nextArg = argv[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        throw new Error('--env-file requires a file path argument.');
      }
      envFile = String(nextArg).trim();
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(
        `Unknown flag "${arg}". Supported: --dry-run --skip-build --skip-db --skip-preflight --apply-migrations --start --force --env-file <path>`,
      );
    }
  }

  return {
    help: false,
    dryRun,
    skipBuild,
    skipDb,
    skipPreflight,
    applyMigrations,
    start,
    force,
    envFile,
  };
}

export function isPlaceholderValue(val) {
  const normalized = String(val ?? '')
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.includes('placeholder') ||
    normalized.includes('your_') ||
    normalized.includes('change_this') ||
    normalized.includes('replace_with') ||
    normalized.includes('insert_') ||
    normalized.includes('aizasysynthetic') ||
    normalized.startsWith('<') ||
    normalized === 'none' ||
    normalized === 'null' ||
    normalized === 'undefined'
  );
}

function readSafeEnvSnapshot(envPath, fsImpl = fs) {
  if (!fsImpl.existsSync(envPath)) {
    return null;
  }
  return dotenv.parse(fsImpl.readFileSync(envPath, 'utf8'));
}

export function inspectLocalEnvFile(envPath, { fsImpl = fs, skipPreflight = false } = {}) {
  const parsed = readSafeEnvSnapshot(envPath, fsImpl);
  if (!parsed) {
    return {
      exists: false,
      nodeEnv: null,
      apiPort: null,
      appOrigin: null,
      dbHostPort: null,
      postgresUser: 'talentlens',
      postgresDb: 'talentlens',
      storageDriver: null,
      scannerDriver: null,
      aiProviderOrder: null,
      hasGeminiKey: false,
      hasGroqKey: false,
      warnings: [
        `Env file not found at ${envPath}. Copy .env.example to .env and configure local values.`,
      ],
      errors: [`Missing ${envPath}`],
    };
  }

  const warnings = [];
  const errors = [];

  const nodeEnv = (parsed.NODE_ENV || 'development').trim();
  const apiPort = (parsed.API_PORT || parsed.PORT || '4000').trim();
  const appOrigin = (parsed.APP_ORIGIN || 'http://localhost:5173').trim();
  const storageDriver = (parsed.STORAGE_DRIVER || 'local').trim();
  const scannerDriver = (parsed.SCANNER_DRIVER || 'mock').trim();
  const aiProviderOrder = (parsed.AI_PROVIDER_ORDER || 'gemini,groq').trim();
  const postgresUser = (parsed.POSTGRES_USER || 'talentlens').trim() || 'talentlens';
  const postgresDb = (parsed.POSTGRES_DB || 'talentlens').trim() || 'talentlens';
  const geminiRaw = (parsed.GEMINI_API_KEY || parsed.AI_API_KEY || '').trim();
  const groqRaw = (parsed.GROQ_API_KEY || '').trim();
  const hasGeminiKey = Boolean(geminiRaw && !isPlaceholderValue(geminiRaw));
  const hasGroqKey = Boolean(groqRaw && !isPlaceholderValue(groqRaw));

  if (nodeEnv === 'production') {
    errors.push(
      'Refusing local workflow against NODE_ENV=production; set NODE_ENV=development or use `npm run deploy:production`.',
    );
  }

  let dbHostPort = null;
  if (!parsed.DATABASE_URL?.trim()) {
    errors.push('DATABASE_URL is missing or empty');
  } else {
    try {
      const dbUrl = new URL(parsed.DATABASE_URL);
      if (dbUrl.protocol !== 'postgresql:' && dbUrl.protocol !== 'postgres:') {
        errors.push(
          `DATABASE_URL must use postgresql:// or postgres:// protocol (found ${dbUrl.protocol}).`,
        );
      } else {
        const host = dbUrl.hostname.toLowerCase();
        dbHostPort = `${dbUrl.hostname}:${dbUrl.port || '5432'}/${dbUrl.pathname.replace(/^\//, '')}`;
        if (DOCKER_DB_HOST_ALIASES.has(host)) {
          warnings.push(
            `DATABASE_URL targets Docker hostname "${dbUrl.hostname}" rather than "localhost:5432" for host dev.`,
          );
        } else if (!LOCAL_DB_HOSTS.has(host)) {
          errors.push(
            `Refusing local workflow against non-local remote DATABASE_URL host "${dbUrl.hostname}". Target localhost/127.0.0.1 only.`,
          );
        }
      }
    } catch {
      errors.push('DATABASE_URL is not a valid URL');
    }
  }

  if (!skipPreflight) {
    if (geminiRaw && isPlaceholderValue(geminiRaw)) {
      errors.push(
        'GEMINI_API_KEY contains a placeholder value; configure a valid key or clear it for non-AI dev.',
      );
    }
    if (groqRaw && isPlaceholderValue(groqRaw)) {
      errors.push(
        'GROQ_API_KEY contains a placeholder value; configure a valid key or clear it for non-AI dev.',
      );
    }

    const orderTokens = aiProviderOrder.split(',').map((token) => token.trim().toLowerCase());
    if (
      orderTokens.some((token) => !token || !SUPPORTED_AI_PROVIDERS.has(token)) ||
      orderTokens.length === 0
    ) {
      errors.push(
        `AI_PROVIDER_ORDER contains unsupported provider(s); expected comma-separated values from: gemini, groq.`,
      );
    }

    if (apiPort !== '4000') {
      warnings.push(
        `API_PORT is "${apiPort}" (note apps/web/vite.config.ts proxies /api to http://localhost:4000).`,
      );
    }
    if (storageDriver === 's3' && !parsed.S3_ENDPOINT?.trim()) {
      warnings.push(
        'STORAGE_DRIVER=s3 without S3_ENDPOINT in local env; set STORAGE_DRIVER=local for workstation dev.',
      );
    }
    if (
      scannerDriver === 'clamav' &&
      (!parsed.CLAMAV_HOST?.trim() || parsed.CLAMAV_HOST === 'clamav')
    ) {
      warnings.push(
        'SCANNER_DRIVER=clamav targeting host "clamav"; set SCANNER_DRIVER=mock for host dev unless ClamAV is port-forwarded.',
      );
    }
    if (!hasGeminiKey && !hasGroqKey) {
      warnings.push(
        'Neither GEMINI_API_KEY nor GROQ_API_KEY is set; live AI JD extraction and CV assessment will report provider_not_configured.',
      );
    }
  }

  return {
    exists: true,
    nodeEnv,
    apiPort,
    appOrigin,
    dbHostPort,
    postgresUser,
    postgresDb,
    storageDriver,
    scannerDriver,
    aiProviderOrder,
    hasGeminiKey,
    hasGroqKey,
    warnings,
    errors,
  };
}

export function defaultExec(command, args, opts = {}) {
  const npmCmd = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const npxCmd = process.platform === 'win32' && command === 'npx' ? 'npx.cmd' : command;
  const bin = command === 'npm' ? npmCmd : command === 'npx' ? npxCmd : command;
  const useShell = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const result = spawnSync(bin, args, {
    cwd: opts.cwd ?? rootDir,
    env: opts.env ?? process.env,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: useShell,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function defaultSleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function detectComposeCommand(
  execFn = defaultExec,
  { cwd = rootDir, env = process.env } = {},
) {
  const v2 = execFn('docker', ['compose', 'version'], { cwd, env, capture: true });
  if (v2 && v2.status === 0) {
    return { bin: 'docker', prefixArgs: ['compose'], display: 'docker compose' };
  }
  const v1 = execFn('docker-compose', ['version'], { cwd, env, capture: true });
  if (v1 && v1.status === 0) {
    return { bin: 'docker-compose', prefixArgs: [], display: 'docker-compose' };
  }
  return null;
}

export function waitForLocalDb({
  compose,
  execFn = defaultExec,
  cwd = rootDir,
  env = process.env,
  envPath,
  fsImpl = fs,
  pgUser = 'talentlens',
  pgDb = 'talentlens',
  maxAttempts = 15,
  intervalMs = 1000,
  sleepFn = defaultSleep,
}) {
  const envArgs = envPath && fsImpl.existsSync(envPath) ? ['--env-file', envPath] : [];
  let lastOutput = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = execFn(
      compose.bin,
      [
        ...compose.prefixArgs,
        ...envArgs,
        '-f',
        'docker-compose.yml',
        'exec',
        '-T',
        'db',
        'pg_isready',
        '-U',
        pgUser,
        '-d',
        pgDb,
      ],
      { cwd, env, capture: true },
    );
    if (res && res.status === 0) {
      return { ready: true, attempts: attempt, lastOutput: (res.stdout || '').trim() };
    }
    lastOutput = String(res?.stderr || res?.stdout || '').trim();
    if (attempt < maxAttempts) {
      sleepFn(intervalMs);
    }
  }
  return { ready: false, attempts: maxAttempts, lastOutput };
}

function walkSourceFiles(dirPath, fsImpl, out = []) {
  if (!fsImpl.existsSync(dirPath)) return out;
  const entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'generated' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      walkSourceFiles(fullPath, fsImpl, out);
    } else if (entry.isFile()) {
      if (/(\.test\.|\.spec\.|\.tsbuildinfo$)/i.test(entry.name)) {
        continue;
      }
      out.push(fullPath);
    }
  }
  return out;
}

function hashFileInto(hash, relLabel, absPath, fsImpl) {
  if (!fsImpl.existsSync(absPath)) return;
  hash.update(`FILE:${relLabel}\n`);
  hash.update(fsImpl.readFileSync(absPath));
  hash.update('\n');
}

export function computeBuildFingerprint(cwd = rootDir, fsImpl = fs) {
  const globalHash = crypto.createHash('sha256');
  for (const sharedFile of ['package-lock.json', 'tsconfig.base.json', 'prisma/schema.prisma']) {
    hashFileInto(globalHash, sharedFile, path.join(cwd, sharedFile), fsImpl);
  }
  const sharedInputsDigest = globalHash.digest('hex');

  const overallHash = crypto.createHash('sha256');
  overallHash.update(`SHARED:${sharedInputsDigest}\n`);

  const packages = {};
  for (const pkg of LOCAL_WORKSPACE_PACKAGES) {
    const pkgHash = crypto.createHash('sha256');
    pkgHash.update(`SHARED:${sharedInputsDigest}\n`);
    const pkgRoot = path.join(cwd, pkg.dir);

    for (const metaFile of ['package.json', 'tsconfig.json', 'tsconfig.build.json']) {
      hashFileInto(pkgHash, `${pkg.dir}/${metaFile}`, path.join(pkgRoot, metaFile), fsImpl);
    }

    const srcFiles = walkSourceFiles(path.join(pkgRoot, 'src'), fsImpl);
    for (const filePath of srcFiles) {
      const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
      hashFileInto(pkgHash, rel, filePath, fsImpl);
    }

    const fingerprint = pkgHash.digest('hex');
    overallHash.update(`${pkg.name}:${fingerprint}\n`);

    const outputsExist = pkg.outputs.every((relOut) =>
      fsImpl.existsSync(path.join(pkgRoot, relOut)),
    );
    packages[pkg.name] = {
      fingerprint,
      outputsExist,
    };
  }

  return {
    overallFingerprint: overallHash.digest('hex'),
    packages,
  };
}

export function readBuildCache(cwd = rootDir, fsImpl = fs) {
  const cachePath = path.join(cwd, BUILD_CACHE_RELATIVE_PATH);
  if (!fsImpl.existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeBuildCache(cwd = rootDir, cacheData, fsImpl = fs) {
  const cachePath = path.join(cwd, BUILD_CACHE_RELATIVE_PATH);
  fsImpl.mkdirSync(path.dirname(cachePath), { recursive: true });
  fsImpl.writeFileSync(cachePath, `${JSON.stringify(cacheData, null, 2)}\n`, 'utf8');
  return cachePath;
}

export function planPackageBuilds({ cwd = rootDir, fsImpl = fs, force = false } = {}) {
  const current = computeBuildFingerprint(cwd, fsImpl);
  const cached = force ? null : readBuildCache(cwd, fsImpl);
  const dirtyPackages = new Set();

  const plan = LOCAL_WORKSPACE_PACKAGES.map((pkg) => {
    const info = current.packages[pkg.name];
    const cachedPkg = cached?.packages?.[pkg.name];
    const depRebuilt = pkg.dependsOn.some((dep) => dirtyPackages.has(dep));

    let shouldBuild = false;
    let reason = 'unchanged (cache hit)';

    if (force) {
      shouldBuild = true;
      reason = '--force specified';
    } else if (depRebuilt) {
      shouldBuild = true;
      reason = 'dependency rebuilt';
    } else if (!info.outputsExist) {
      shouldBuild = true;
      reason = 'missing compiled dist output';
    } else if (!cachedPkg || cachedPkg.fingerprint !== info.fingerprint) {
      shouldBuild = true;
      reason = cachedPkg ? 'source fingerprint changed' : 'no prior build cache';
    }

    if (shouldBuild) {
      dirtyPackages.add(pkg.name);
    }

    return {
      name: pkg.name,
      shouldBuild,
      reason,
      fingerprint: info.fingerprint,
    };
  });

  return {
    overallFingerprint: current.overallFingerprint,
    packages: plan,
  };
}

export function buildLocalExecutionPlan(options) {
  const steps = [];
  if (!options.skipDb) {
    steps.push('docker compose up -d db');
    steps.push('wait for local PostgreSQL readiness (pg_isready)');
  }
  if (!options.skipBuild) {
    const suffix = options.force ? ' (--force)' : ' (SHA-256 fingerprint cached)';
    steps.push(`npm run build --workspace @talentlens/shared${suffix}`);
    steps.push(`npm run build --workspace @talentlens/document-processing${suffix}`);
    steps.push(`npm run build --workspace @talentlens/database${suffix}`);
    steps.push(`npm run build --workspace @talentlens/assessment-engine${suffix}`);
  }
  steps.push(options.applyMigrations ? 'npm run db:migrate:deploy' : 'npx prisma migrate status');
  if (options.start) {
    steps.push('npm run dev');
  }
  return steps;
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const cwd = deps.cwd ?? rootDir;
  const fsImpl = deps.fsImpl ?? fs;
  const env = deps.env ?? process.env;
  const execFn = deps.execFn ?? defaultExec;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  const stdout = deps.stdout ?? ((msg) => console.log(msg));
  const stderr = deps.stderr ?? ((msg) => console.error(msg));
  const maxDbWaitAttempts = deps.maxDbWaitAttempts ?? 15;
  const dbWaitIntervalMs = deps.dbWaitIntervalMs ?? 1000;

  const options = parseDeployLocalArgs(argv);
  if (options.help) {
    stdout(
      'Usage: node scripts/deploy-local.mjs [--dry-run] [--skip-build] [--skip-db] [--skip-preflight] [--apply-migrations] [--start] [--force] [--env-file <path>]',
    );
    return 0;
  }

  const nodeCheck = checkNodeVersion(deps.nodeVersion ?? process.versions.node);
  const resolvedEnvPath = path.resolve(cwd, options.envFile);
  const envReport = inspectLocalEnvFile(resolvedEnvPath, {
    fsImpl,
    skipPreflight: options.skipPreflight,
  });
  const plan = buildLocalExecutionPlan(options);

  stdout('================================================================================');
  stdout('TALENTLENS AI — LOCAL DEVELOPMENT DEPLOYMENT HELPER');
  stdout('================================================================================');
  stdout(
    `Mode:                ${options.dryRun ? 'DRY RUN (no commands executed)' : 'LOCAL PREPARE'}`,
  );
  stdout(
    `Node.js:             v${nodeCheck.version} (${nodeCheck.valid ? 'PASS' : `FAIL: requires ${nodeCheck.requirement}`})`,
  );
  stdout(`Env File:            ${resolvedEnvPath} (${envReport.exists ? 'FOUND' : 'MISSING'})`);
  if (envReport.exists) {
    stdout(
      `Runtime Mode:        NODE_ENV=${envReport.nodeEnv}, API_PORT=${envReport.apiPort}, APP_ORIGIN=${envReport.appOrigin}`,
    );
    stdout(`Database Target:     ${envReport.dbHostPort ?? 'INVALID'}`);
    stdout(
      `Storage / Scanner:   STORAGE_DRIVER=${envReport.storageDriver}, SCANNER_DRIVER=${envReport.scannerDriver}`,
    );
    stdout(
      `AI Failover Chain:   order=${envReport.aiProviderOrder}, geminiKey=${envReport.hasGeminiKey ? 'configured' : 'unset'}, groqKey=${envReport.hasGroqKey ? 'configured' : 'unset'}`,
    );
  }
  for (const warn of envReport.warnings) {
    stdout(`  [WARN] ${warn}`);
  }
  for (const err of envReport.errors) {
    stderr(`  [FAIL] ${err}`);
  }

  stdout('\nSequential Step Plan:');
  plan.forEach((step, idx) => stdout(`  ${idx + 1}. ${step}`));

  if (!nodeCheck.valid || envReport.errors.length > 0) {
    stderr('\n[FAIL] Resolve the local prerequisite/env error(s) above before running.');
    stdout('================================================================================');
    return 1;
  }

  if (options.dryRun) {
    stdout('\n[DRY RUN COMPLETE] No containers started, builds run, or DB commands executed.');
    stdout('Next local runtime commands:');
    stdout('  npm run dev');
    stdout('  npm run test:gemini');
    stdout('  npm run test:groq');
    stdout('================================================================================');
    return 0;
  }

  if (!options.skipDb) {
    const compose = detectComposeCommand(execFn, { cwd, env });
    if (!compose) {
      stderr('[FAIL] Neither `docker compose` (V2) nor `docker-compose` is available on PATH.');
      return 1;
    }
    const envArgs = fsImpl.existsSync(resolvedEnvPath) ? ['--env-file', resolvedEnvPath] : [];
    stdout(`\n[STEP] Starting local PostgreSQL 17 service via ${compose.display}...`);
    const upRes = execFn(
      compose.bin,
      [...compose.prefixArgs, ...envArgs, '-f', 'docker-compose.yml', 'up', '-d', 'db'],
      { cwd, env },
    );
    if (!upRes || upRes.status !== 0) {
      stderr('[FAIL] Failed to start local PostgreSQL service.');
      return 1;
    }

    stdout('[STEP] Waiting for PostgreSQL 17 readiness (pg_isready)...');
    const readiness = waitForLocalDb({
      compose,
      execFn,
      cwd,
      env,
      envPath: resolvedEnvPath,
      fsImpl,
      pgUser: envReport.postgresUser,
      pgDb: envReport.postgresDb,
      maxAttempts: maxDbWaitAttempts,
      intervalMs: dbWaitIntervalMs,
      sleepFn,
    });
    if (!readiness.ready) {
      stderr(
        `[FAIL] Local PostgreSQL did not become ready after ${readiness.attempts} attempt(s).${readiness.lastOutput ? ` Last output: ${readiness.lastOutput}` : ''}`,
      );
      return 1;
    }
    stdout(`  [PASS] PostgreSQL ready after ${readiness.attempts} attempt(s).`);
  }

  if (!options.skipBuild) {
    const buildPlan = planPackageBuilds({ cwd, fsImpl, force: options.force });
    const builtAny = buildPlan.packages.some((item) => item.shouldBuild);
    const cacheMap = {};
    for (const item of buildPlan.packages) {
      if (!item.shouldBuild) {
        stdout(`\n[SKIP] ${item.name} build skipped (${item.reason}).`);
        cacheMap[item.name] = {
          fingerprint: item.fingerprint,
          builtAt: new Date().toISOString(),
        };
        continue;
      }
      stdout(`\n[STEP] Building ${item.name} (${item.reason})...`);
      const res = execFn('npm', ['run', 'build', '--workspace', item.name], { cwd, env });
      if (!res || res.status !== 0) {
        stderr(`[FAIL] Workspace build failed for ${item.name}.`);
        return 1;
      }
      const after = computeBuildFingerprint(cwd, fsImpl);
      cacheMap[item.name] = {
        fingerprint: after.packages[item.name]?.fingerprint ?? item.fingerprint,
        builtAt: new Date().toISOString(),
      };
    }

    if (builtAny || options.force) {
      const latest = computeBuildFingerprint(cwd, fsImpl);
      writeBuildCache(
        cwd,
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          overallFingerprint: latest.overallFingerprint,
          packages: cacheMap,
        },
        fsImpl,
      );
    }
  }

  const parsedRawEnv = readSafeEnvSnapshot(resolvedEnvPath, fsImpl) ?? {};
  const prismaEnv = parsedRawEnv.DATABASE_URL
    ? { ...env, DATABASE_URL: parsedRawEnv.DATABASE_URL }
    : env;

  stdout(
    options.applyMigrations
      ? '\n[STEP] Applying Prisma migrations (npm run db:migrate:deploy)...'
      : '\n[STEP] Checking Prisma migration status (read-only)...',
  );
  const migrateRes = options.applyMigrations
    ? execFn('npm', ['run', 'db:migrate:deploy'], { cwd, env: prismaEnv })
    : execFn('npx', ['prisma', 'migrate', 'status'], { cwd, env: prismaEnv });
  if (!migrateRes || migrateRes.status !== 0) {
    stderr(
      '[FAIL] Prisma migration status check returned non-zero. Review status or pass --apply-migrations intentionally.',
    );
    return 1;
  }

  stdout('\n[PASS] Local workspace dependencies and database are ready.');
  stdout('Run concurrently in dev mode: npm run dev');
  stdout('Frontend URL:               http://localhost:5173');
  stdout('API Readiness URL:          http://localhost:4000/api/v1/health/ready');

  if (options.start) {
    stdout('\n[STEP] Starting full-stack dev servers (npm run dev)...');
    const devRes = execFn('npm', ['run', 'dev'], { cwd, env });
    return devRes?.status ?? 1;
  }

  stdout('================================================================================');
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
