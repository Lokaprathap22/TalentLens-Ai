#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { parseDotEnvContent } from './preflight-env.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');

const SAFE_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SAFE_SSH_HOST_RE = /^[A-Za-z0-9._@-]{1,253}$/;
const SAFE_POSIX_ABS_DIR_RE = /^\/[A-Za-z0-9._/-]{1,511}$/;
const UNSAFE_ARG_CHARS_RE = /[\s;&|`$<>\\'"!\r\n\0]/;

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vitest',
  '.cache',
  '.turbo',
  '.vercel',
  '.gemini',
  '.vscode',
  '.idea',
  'backups',
  'artifacts',
  'playwright-report',
  'test-results',
  'secrets',
  '.secrets',
  'local-secrets',
  'uploads',
  'logs',
  'tmp',
  'temp',
  'audit-evidence',
]);

const EXCLUDED_BASENAMES = new Set(['docker-compose.oci.yml', '.current-release.json']);

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
}

export function shellQuotePosix(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

export function parseDeployProductionArgs(argv) {
  let envFile = '.env';
  let envFileExplicit = false;
  let remoteEnvFileExplicit = false;
  let conflictingEnvFlags = false;
  let composeFile = 'docker-compose.prod.yml';
  let composeFileExplicit = false;
  let projectName = 'talentlens';
  let sshHost = '';
  let remoteDir = '';
  let strict = false;
  let allowDirty = false;
  let force = false;
  let skipBackup = false;
  let execute = false;
  let confirmProduction = false;

  const readFlagValue = (flag, idx) => {
    const val = argv[idx + 1];
    if (!val || val.startsWith('-')) {
      throw new Error(`${flag} requires a value argument.`);
    }
    return String(val).trim();
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length).trim();
      envFileExplicit = true;
      if (remoteEnvFileExplicit) conflictingEnvFlags = true;
    } else if (arg === '--env-file') {
      envFile = readFlagValue('--env-file', i);
      envFileExplicit = true;
      if (remoteEnvFileExplicit) conflictingEnvFlags = true;
      i += 1;
    } else if (arg.startsWith('--remote-env-file=')) {
      envFile = arg.slice('--remote-env-file='.length).trim();
      remoteEnvFileExplicit = true;
      if (envFileExplicit) conflictingEnvFlags = true;
    } else if (arg === '--remote-env-file') {
      envFile = readFlagValue('--remote-env-file', i);
      remoteEnvFileExplicit = true;
      if (envFileExplicit) conflictingEnvFlags = true;
      i += 1;
    } else if (arg.startsWith('--compose-file=')) {
      composeFile = arg.slice('--compose-file='.length).trim();
      composeFileExplicit = true;
    } else if (arg === '--compose-file') {
      composeFile = readFlagValue('--compose-file', i);
      composeFileExplicit = true;
      i += 1;
    } else if (arg.startsWith('--project-name=')) {
      projectName = arg.slice('--project-name='.length).trim();
    } else if (arg === '--project-name') {
      projectName = readFlagValue('--project-name', i);
      i += 1;
    } else if (arg.startsWith('--ssh-host=')) {
      sshHost = arg.slice('--ssh-host='.length).trim();
    } else if (arg === '--ssh-host') {
      sshHost = readFlagValue('--ssh-host', i);
      i += 1;
    } else if (arg.startsWith('--remote-dir=')) {
      remoteDir = arg.slice('--remote-dir='.length).trim();
    } else if (arg === '--remote-dir') {
      remoteDir = readFlagValue('--remote-dir', i);
      i += 1;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--allow-dirty') {
      allowDirty = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--skip-backup') {
      skipBackup = true;
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--confirm-production') {
      confirmProduction = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(
        `Unknown flag "${arg}". Supported: --env-file <path> --remote-env-file <path> --compose-file <path> --project-name <name> --ssh-host <user@host> --remote-dir <path> --strict --allow-dirty --force --execute --confirm-production`,
      );
    }
  }

  return {
    help: false,
    envFile,
    envFileExplicit,
    remoteEnvFileExplicit,
    conflictingEnvFlags,
    composeFile,
    composeFileExplicit,
    projectName,
    sshHost,
    remoteDir,
    strict,
    allowDirty,
    force,
    skipBackup,
    execute,
    confirmProduction,
  };
}

const FORBIDDEN_EXACT_REMOTE_DIRS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);
const FORBIDDEN_SYSTEM_PREFIX_RE = /^\/(?:bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr)\//;

export function validateSafeInputs(options) {
  if (!SAFE_PROJECT_NAME_RE.test(options.projectName || '')) {
    return {
      valid: false,
      reason: `Invalid --project-name "${options.projectName}". Expected lowercase alphanumeric/hyphen/underscore identifier.`,
    };
  }
  if (options.sshHost) {
    if (options.sshHost.startsWith('-') || !SAFE_SSH_HOST_RE.test(options.sshHost)) {
      return {
        valid: false,
        reason: `Unsafe or invalid --ssh-host "${options.sshHost}". Expected <user@host> or <hostname> without leading "-" or shell metacharacters.`,
      };
    }
  }
  if (options.remoteDir) {
    if (
      !SAFE_POSIX_ABS_DIR_RE.test(options.remoteDir) ||
      options.remoteDir.includes('//') ||
      /(^|\/)\.\.?(\/|$)/.test(options.remoteDir)
    ) {
      return {
        valid: false,
        reason: `Unsafe or invalid --remote-dir "${options.remoteDir}". Expected absolute POSIX path without ".." traversal or shell metacharacters.`,
      };
    }
    const normalizedRemoteDir = path.posix.normalize(options.remoteDir).replace(/\/+$/, '') || '/';
    if (
      FORBIDDEN_EXACT_REMOTE_DIRS.has(normalizedRemoteDir) ||
      FORBIDDEN_SYSTEM_PREFIX_RE.test(normalizedRemoteDir)
    ) {
      return {
        valid: false,
        reason: `Unsafe or invalid --remote-dir "${options.remoteDir}". Must point to an application release subdirectory rather than a root or system directory.`,
      };
    }
  }
  if (options.conflictingEnvFlags) {
    return {
      valid: false,
      reason: 'Specify either --env-file or --remote-env-file, not both.',
    };
  }
  if (!options.envFile || options.envFile.startsWith('-')) {
    return {
      valid: false,
      reason: `Invalid ${options.remoteEnvFileExplicit ? '--remote-env-file' : '--env-file'} "${options.envFile}". Must be non-empty and must not start with "-".`,
    };
  }
  if (
    !options.composeFile ||
    options.composeFile.startsWith('-') ||
    UNSAFE_ARG_CHARS_RE.test(options.composeFile)
  ) {
    return {
      valid: false,
      reason: `Invalid --compose-file "${options.composeFile}". Must be non-empty, not start with "-", and contain no whitespace or shell metacharacters.`,
    };
  }
  if (
    (options.sshHost || options.remoteEnvFileExplicit) &&
    UNSAFE_ARG_CHARS_RE.test(options.envFile)
  ) {
    return {
      valid: false,
      reason: `Invalid remote env file "${options.envFile}" for SSH execution. Must not contain whitespace or shell metacharacters.`,
    };
  }
  return { valid: true };
}

export function validateExecutionGuard(options) {
  const safeInputs = validateSafeInputs(options);
  if (!safeInputs.valid) {
    return {
      allowed: false,
      dryRun: !options.execute,
      reason: safeInputs.reason,
    };
  }
  if (!options.execute) {
    return {
      allowed: false,
      dryRun: true,
      reason: 'Default safe dry-run mode (pass --execute --confirm-production to execute).',
    };
  }
  if (!options.confirmProduction) {
    return {
      allowed: false,
      dryRun: false,
      reason:
        'Refusing live production execution: --confirm-production is required alongside --execute.',
    };
  }
  if (options.skipBackup) {
    return {
      allowed: false,
      dryRun: false,
      reason:
        'Refusing live production execution with --skip-backup: mandatory pre-rollout PostgreSQL backup cannot be bypassed.',
    };
  }
  if (options.remoteEnvFileExplicit && !options.sshHost) {
    return {
      allowed: false,
      dryRun: false,
      reason:
        'Refusing live production execution: --remote-env-file targets a remote OCI environment file and requires --ssh-host <user@host> --remote-dir <path>.',
    };
  }
  return { allowed: true, dryRun: false };
}

export function defaultExec(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? rootDir,
    env: opts.env ?? process.env,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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

function shouldExcludeTarPath(posixRelPath, isDir) {
  const segments = posixRelPath.split('/');
  const baseName = segments[segments.length - 1] ?? '';

  if (isDir) {
    if (EXCLUDED_DIR_NAMES.has(baseName)) return true;
    return false;
  }

  if (EXCLUDED_BASENAMES.has(baseName)) return true;
  if (/^\.env(\.|$)/i.test(baseName) && baseName !== '.env.example') return true;
  if (/\.(pem|key|tsbuildinfo|log)$/i.test(baseName)) return true;
  if (/\.(dump|dump\.sha256|sql\.gz|sql\.gz\.sha256)$/i.test(baseName)) return true;
  if (/^temp-.*\.(pdf|docx)$/i.test(baseName)) return true;
  if (/\.sql$/i.test(baseName) && !posixRelPath.startsWith('prisma/migrations/')) return true;
  if (posixRelPath.startsWith('storage/resumes/') && baseName !== '.gitkeep') return true;
  return false;
}

function normalizeArchiveFileContent(relPath, rawBuffer) {
  if (!relPath.endsWith('.sh')) {
    return rawBuffer;
  }
  const text = rawBuffer.toString('utf8').replace(/\r\n/g, '\n');
  return Buffer.from(text, 'utf8');
}

export function collectSanitizedSourceFiles(cwd = rootDir, fsImpl = fs) {
  const files = [];
  const walk = (dirAbs, relPrefix) => {
    const entries = fsImpl.readdirSync(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
      const posixRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const absPath = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (shouldExcludeTarPath(posixRel, true)) continue;
        walk(absPath, posixRel);
      } else if (entry.isFile()) {
        if (shouldExcludeTarPath(posixRel, false)) continue;
        files.push(posixRel);
      }
    }
  };
  walk(cwd, '');
  files.sort((a, b) => a.localeCompare(b));

  const digestHash = crypto.createHash('sha256');
  for (const relPath of files) {
    const absPath = path.join(cwd, ...relPath.split('/'));
    const content = normalizeArchiveFileContent(relPath, fsImpl.readFileSync(absPath));
    const fileSha = crypto.createHash('sha256').update(content).digest('hex');
    digestHash.update(`${relPath}\0${fileSha}\n`);
  }

  return {
    files,
    sourceDigest: digestHash.digest('hex'),
  };
}

function writeOctalField(buf, offset, length, value) {
  const oct = value.toString(8).padStart(length - 1, '0');
  buf.write(oct.slice(-(length - 1)), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function splitUstarNameAndPrefix(posixPath) {
  const bytes = Buffer.from(posixPath, 'utf8');
  if (bytes.length <= 100) {
    return { name: posixPath, prefix: '', needsPax: false };
  }
  if (bytes.length <= 255) {
    const slashIdx = posixPath.lastIndexOf('/');
    if (slashIdx > 0) {
      const prefix = posixPath.slice(0, slashIdx);
      const name = posixPath.slice(slashIdx + 1);
      if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
        return { name, prefix, needsPax: false };
      }
    }
  }
  return { name: posixPath.slice(0, 100), prefix: '', needsPax: true };
}

function createUstarHeaderBlock({
  name,
  prefix = '',
  size,
  mode = 0o644,
  typeflag = '0',
  mtimeSec = 0,
}) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name, 'utf8'), 100), 'utf8');
  writeOctalField(header, 100, 8, mode);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeOctalField(header, 124, 12, size);
  writeOctalField(header, 136, 12, mtimeSec);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, Math.min(Buffer.byteLength(prefix, 'utf8'), 155), 'utf8');
  }
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    checksum += header[i];
  }
  const chkStr = checksum.toString(8).padStart(6, '0');
  header.write(chkStr, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildPaxPathRecord(posixPath) {
  const keyVal = `path=${posixPath}\n`;
  let totalLen = Buffer.byteLength(keyVal, 'utf8') + 2;
  for (;;) {
    const candidate = `${totalLen} ${keyVal}`;
    const candidateBytes = Buffer.byteLength(candidate, 'utf8');
    if (candidateBytes === totalLen) {
      return Buffer.from(candidate, 'utf8');
    }
    totalLen = candidateBytes;
  }
}

export function createSanitizedSourceTarball({
  cwd = rootDir,
  outputDir,
  tarballName = 'talentlens-release.tar.gz',
  fsImpl = fs,
}) {
  if (!outputDir) {
    throw new Error('outputDir is required to create sanitized source tarball.');
  }
  fsImpl.mkdirSync(outputDir, { recursive: true });
  const { files, sourceDigest } = collectSanitizedSourceFiles(cwd, fsImpl);
  const chunks = [];

  for (const relPath of files) {
    const absPath = path.join(cwd, ...relPath.split('/'));
    const data = normalizeArchiveFileContent(relPath, fsImpl.readFileSync(absPath));
    const mode = relPath.endsWith('.sh') ? 0o755 : 0o644;
    const { name, prefix, needsPax } = splitUstarNameAndPrefix(relPath);

    if (needsPax) {
      const paxPayload = buildPaxPathRecord(relPath);
      const paxName = `PaxHeader/${path.posix.basename(relPath)}`.slice(0, 100);
      chunks.push(
        createUstarHeaderBlock({
          name: paxName,
          size: paxPayload.length,
          mode: 0o644,
          typeflag: 'x',
        }),
      );
      chunks.push(paxPayload);
      const paxPad = (512 - (paxPayload.length % 512)) % 512;
      if (paxPad > 0) chunks.push(Buffer.alloc(paxPad, 0));
    }

    chunks.push(
      createUstarHeaderBlock({
        name,
        prefix,
        size: data.length,
        mode,
        typeflag: '0',
      }),
    );
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, 0));
    }
  }

  chunks.push(Buffer.alloc(1024, 0));
  const tarBuffer = Buffer.concat(chunks);
  const gzBuffer = zlib.gzipSync(tarBuffer, { level: 9 });
  const tarballSha256 = crypto.createHash('sha256').update(gzBuffer).digest('hex');

  const tarballPath = path.join(outputDir, tarballName);
  const checksumPath = path.join(outputDir, `${tarballName}.sha256`);
  fsImpl.writeFileSync(tarballPath, gzBuffer);
  fsImpl.writeFileSync(checksumPath, `${tarballSha256}  ${tarballName}\n`, 'utf8');

  return {
    tarballPath,
    checksumPath,
    tarballName,
    tarballSha256,
    sourceDigest,
    includedFiles: files,
  };
}

export function listTarGzEntries(gzBuffer) {
  const tarBuffer = zlib.gunzipSync(gzBuffer);
  const entries = [];
  let offset = 0;
  let pendingPaxPath = null;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeOct = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOct || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 48);
    offset += 512;

    const payload = tarBuffer.subarray(offset, offset + size);
    const padded = Math.ceil(size / 512) * 512;
    offset += padded;

    if (typeflag === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(payload.toString('utf8'));
      pendingPaxPath = match ? match[1] : null;
      continue;
    }

    const fullPath = pendingPaxPath ?? (prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw);
    pendingPaxPath = null;
    entries.push(fullPath);
  }
  return entries;
}

function inspectGitState(cwd = rootDir, execFn = defaultExec) {
  const branchRes = execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, capture: true });
  const shaRes = execFn('git', ['rev-parse', 'HEAD'], { cwd, capture: true });
  const statusRes = execFn('git', ['status', '--short'], { cwd, capture: true });
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : '(unknown)';
  const commitSha = shaRes.status === 0 ? shaRes.stdout.trim() : 'unknown';
  const shortSha = commitSha !== 'unknown' ? commitSha.slice(0, 12) : 'unknown';
  const dirtyLines =
    statusRes.status === 0
      ? statusRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  return {
    branch,
    commitSha,
    shortSha,
    isClean: dirtyLines.length === 0,
    dirtyCount: dirtyLines.length,
  };
}

function readSafeEnvMode(envPath, fsImpl = fs) {
  if (!fsImpl.existsSync(envPath)) {
    return { exists: false, nodeEnv: null };
  }
  const parsed = parseDotEnvContent(fsImpl.readFileSync(envPath, 'utf8'));
  return {
    exists: true,
    nodeEnv: (parsed.NODE_ENV || '').trim() || null,
  };
}

function hasExternalComposeDir(composeFile) {
  return String(composeFile || '').includes('/');
}

function formatComposeInline(composeCmd, options, remoteEnvTarget) {
  const projectDirFlag = hasExternalComposeDir(options.composeFile) ? ' --project-directory .' : '';
  return `${composeCmd}${projectDirFlag} -p ${shellQuotePosix(options.projectName)} --env-file ${shellQuotePosix(remoteEnvTarget)} -f ${shellQuotePosix(options.composeFile)}`;
}

function buildRemoteSshArgs(sshHost) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost];
}

function printRollbackGuidance({
  stdout,
  options,
  backupArchive,
  previousTags = [],
  snapshotDir = null,
}) {
  const projectDirPart = hasExternalComposeDir(options.composeFile) ? ' --project-directory .' : '';
  const composeStr = `docker compose${projectDirPart} -p ${options.projectName} --env-file ${options.envFile} -f ${options.composeFile}`;
  stdout('\nRollback Procedure:');
  let step = 1;
  if (snapshotDir && options.remoteDir) {
    stdout(`  ${step}. Previous source & Compose snapshot captured: ${snapshotDir}`);
    stdout(
      `     Source/Compose rollback (run before recreating :previous containers if Compose/source changed; preserves .env*, node_modules, backups):`,
    );
    stdout(
      `     rsync -a --delete --exclude='.env' --exclude='.env.*' --exclude='!.env.example' --exclude='node_modules' --exclude='backups' "${snapshotDir}/" "${options.remoteDir}/" || cp -af "${snapshotDir}/." "${options.remoteDir}/"`,
    );
    step += 1;
  }
  if (previousTags.length > 0) {
    stdout(`  ${step}. Previous image tags captured: ${previousTags.join(', ')}`);
    stdout(
      `     Container rollback: for svc in web api worker; do sudo docker tag "${options.projectName}-$svc:previous" "${options.projectName}-$svc:latest"; done && sudo ${composeStr} up -d --no-build --no-deps api worker web`,
    );
  } else {
    stdout(
      `  ${step}. Container rollback: inspect \`sudo docker images --filter "reference=${options.projectName}*"\` for :previous tags before recreating containers.`,
    );
  }
  step += 1;
  stdout(
    `  ${step}. Restore DB archive: sudo ${composeStr} stop api worker && sudo bash ./scripts/restore.sh -f ${options.composeFile} --env-file ${options.envFile} -p ${options.projectName} --confirm-replace-existing ${backupArchive || '<backup_archive.dump>'} <target_db>`,
  );
}

const REMOTE_SYNC_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [remoteDir, unpackDir, snapshotRoot, snapshotDir, composeFileArg, stagingRoot] = process.argv.slice(1);',
  'const resolvedRemote = path.resolve(remoteDir);',
  'const resolvedUnpack = path.resolve(unpackDir);',
  'if (!resolvedRemote || resolvedRemote === "/" || resolvedUnpack === resolvedRemote) process.exit(1);',
  'const isEnvSecretName = (base) => /^\\.env(\\.|$)/i.test(base) && base !== ".env.example";',
  'const PRESERVED_DIRS = new Set(["node_modules", "backups", ".git", ".release-staging", ".release-previous"]);',
  'const SKIP_SNAPSHOT_EXT = /\\.(dump|dump\\.sha256|sql\\.gz|sql\\.gz\\.sha256|pem|key|tsbuildinfo|log)$/i;',
  'const SKIP_SNAPSHOT_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".vitest", ".cache", ".turbo", "backups", ".git", "artifacts", "playwright-report", "test-results", "tmp", "temp"]);',
  'const customComposeRel = (composeFileArg && !composeFileArg.startsWith("/") && !composeFileArg.startsWith("../") && composeFileArg !== "..") ? composeFileArg : "";',
  'const walkTree = (baseDir, relPrefix = "", out = { files: [], dirs: [] }, skipCheck = null) => {',
  '  if (!fs.existsSync(baseDir)) return out;',
  '  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));',
  '  for (const entry of entries) {',
  '    const rel = relPrefix ? relPrefix + "/" + entry.name : entry.name;',
  '    const abs = path.join(baseDir, entry.name);',
  '    if (entry.isSymbolicLink()) continue;',
  '    if (skipCheck && skipCheck(rel, entry.name, entry.isDirectory())) continue;',
  '    if (entry.isDirectory()) { walkTree(abs, rel, out, skipCheck); out.dirs.push(rel); }',
  '    else if (entry.isFile()) { out.files.push(rel); }',
  '  }',
  '  return out;',
  '};',
  'const unpacked = walkTree(resolvedUnpack);',
  'if (unpacked.files.length === 0) process.exit(1);',
  'const unpackedSet = new Set(unpacked.files);',
  'const isPreservedRel = (rel, isDir) => {',
  '  const segs = rel.split("/");',
  '  const base = segs[segs.length - 1];',
  '  if (segs.some((s) => PRESERVED_DIRS.has(s))) return true;',
  '  if (isDir) return rel === "storage/resumes";',
  '  if (base === "docker-compose.oci.yml" || base === ".current-release.json") return true;',
  '  if (customComposeRel && rel === customComposeRel && !unpackedSet.has(rel)) return true;',
  '  if (isEnvSecretName(base)) return true;',
  '  if (rel.startsWith("storage/resumes/") && base !== ".gitkeep") return true;',
  '  return false;',
  '};',
  'const existingForSnapshot = walkTree(resolvedRemote, "", { files: [], dirs: [] }, (rel, name, isDir) => {',
  '  if (isDir) return SKIP_SNAPSHOT_DIRS.has(name);',
  '  if (isEnvSecretName(name) || SKIP_SNAPSHOT_EXT.test(name)) return true;',
  '  if (rel.startsWith("storage/resumes/") && name !== ".gitkeep") return true;',
  '  return false;',
  '});',
  'let recordedSnapshot = "NONE";',
  'if (existingForSnapshot.files.length > 0) {',
  '  fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });',
  '  try { fs.chmodSync(snapshotRoot, 0o700); } catch {}',
  '  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });',
  '  for (const rel of existingForSnapshot.files) {',
  '    const src = path.join(resolvedRemote, ...rel.split("/"));',
  '    const dst = path.join(snapshotDir, ...rel.split("/"));',
  '    fs.mkdirSync(path.dirname(dst), { recursive: true });',
  '    fs.copyFileSync(src, dst);',
  '    try { fs.chmodSync(dst, fs.statSync(src).mode & 0o777); } catch {}',
  '  }',
  '  recordedSnapshot = snapshotDir;',
  '  const prevSnaps = fs.readdirSync(snapshotRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();',
  '  for (const oldName of prevSnaps.slice(3)) { fs.rmSync(path.join(snapshotRoot, oldName), { recursive: true, force: true }); }',
  '}',
  'let removed = 0;',
  'const removeStale = (dirAbs, relPrefix = "") => {',
  '  if (!fs.existsSync(dirAbs)) return;',
  '  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {',
  '    const rel = relPrefix ? relPrefix + "/" + entry.name : entry.name;',
  '    const abs = path.join(dirAbs, entry.name);',
  '    if (entry.isSymbolicLink()) {',
  '      if (!isPreservedRel(rel, false)) { fs.rmSync(abs, { force: true }); removed += 1; }',
  '      continue;',
  '    }',
  '    if (entry.isDirectory()) {',
  '      if (isPreservedRel(rel, true)) continue;',
  '      if (unpackedSet.has(rel)) { fs.rmSync(abs, { recursive: true, force: true }); removed += 1; continue; }',
  '      removeStale(abs, rel);',
  '      if (rel !== "storage/resumes" && fs.readdirSync(abs).length === 0) { fs.rmdirSync(abs); }',
  '    } else if (entry.isFile()) {',
  '      if (isPreservedRel(rel, false)) continue;',
  '      if (!unpackedSet.has(rel)) { fs.rmSync(abs, { force: true }); removed += 1; }',
  '    }',
  '  }',
  '};',
  'removeStale(resolvedRemote);',
  'for (const rel of unpacked.files) {',
  '  if (isPreservedRel(rel, false)) continue;',
  '  const src = path.join(resolvedUnpack, ...rel.split("/"));',
  '  const dst = path.join(resolvedRemote, ...rel.split("/"));',
  '  if (fs.existsSync(dst) && fs.lstatSync(dst).isDirectory()) { fs.rmSync(dst, { recursive: true, force: true }); }',
  '  fs.mkdirSync(path.dirname(dst), { recursive: true });',
  '  fs.copyFileSync(src, dst);',
  '  const mode = rel.endsWith(".sh") ? 0o755 : (fs.statSync(src).mode & 0o777);',
  '  try { fs.chmodSync(dst, mode); } catch {}',
  '}',
  'fs.rmSync(resolvedUnpack, { recursive: true, force: true });',
  'if (stagingRoot && fs.existsSync(stagingRoot)) {',
  '  const oldTars = fs.readdirSync(stagingRoot).filter((n) => n.endsWith(".tar.gz")).map((n) => ({ n, m: fs.statSync(path.join(stagingRoot, n)).mtimeMs })).sort((a, b) => b.m - a.m);',
  '  for (const old of oldTars.slice(2)) { fs.rmSync(path.join(stagingRoot, old.n), { force: true }); fs.rmSync(path.join(stagingRoot, old.n + ".sha256"), { force: true }); }',
  '}',
  'console.log("SYNC_OK SNAPSHOT=" + recordedSnapshot + " REMOVED=" + removed);',
].join(' ');

const REMOTE_RESTORE_SNAPSHOT_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [remoteDir, snapshotDir, composeFileArg] = process.argv.slice(1);',
  'const resolvedRemote = path.resolve(remoteDir);',
  'const resolvedSnap = path.resolve(snapshotDir);',
  'if (!resolvedRemote || resolvedRemote === "/" || !fs.existsSync(resolvedSnap)) process.exit(1);',
  'const isEnvSecretName = (base) => /^\\.env(\\.|$)/i.test(base) && base !== ".env.example";',
  'const PRESERVED_DIRS = new Set(["node_modules", "backups", ".git", ".release-staging", ".release-previous"]);',
  'const walkFiles = (baseDir, relPrefix = "", out = []) => {',
  '  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {',
  '    const rel = relPrefix ? relPrefix + "/" + entry.name : entry.name;',
  '    const abs = path.join(baseDir, entry.name);',
  '    if (entry.isSymbolicLink()) continue;',
  '    if (entry.isDirectory()) walkFiles(abs, rel, out);',
  '    else if (entry.isFile()) out.push(rel);',
  '  }',
  '  return out;',
  '};',
  'const snapFiles = walkFiles(resolvedSnap);',
  'if (snapFiles.length === 0) process.exit(1);',
  'const snapSet = new Set(snapFiles);',
  'const customComposeRel = (composeFileArg && !composeFileArg.startsWith("/") && !composeFileArg.startsWith("../") && composeFileArg !== "..") ? composeFileArg : "";',
  'const isNeverDelete = (rel, isDir) => {',
  '  const segs = rel.split("/");',
  '  const base = segs[segs.length - 1];',
  '  if (segs.some((s) => PRESERVED_DIRS.has(s))) return true;',
  '  if (isDir) return rel === "storage/resumes";',
  '  if (isEnvSecretName(base)) return true;',
  '  if (rel.startsWith("storage/resumes/") && base !== ".gitkeep") return true;',
  '  if (!snapSet.has(rel) && (base === "docker-compose.oci.yml" || base === ".current-release.json" || (customComposeRel && rel === customComposeRel))) return true;',
  '  return false;',
  '};',
  'const removeNewer = (dirAbs, relPrefix = "") => {',
  '  if (!fs.existsSync(dirAbs)) return;',
  '  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {',
  '    const rel = relPrefix ? relPrefix + "/" + entry.name : entry.name;',
  '    const abs = path.join(dirAbs, entry.name);',
  '    if (entry.isSymbolicLink()) { if (!isNeverDelete(rel, false)) fs.rmSync(abs, { force: true }); continue; }',
  '    if (entry.isDirectory()) {',
  '      if (isNeverDelete(rel, true)) continue;',
  '      removeNewer(abs, rel);',
  '      if (rel !== "storage/resumes" && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);',
  '    } else if (entry.isFile()) {',
  '      if (!isNeverDelete(rel, false) && !snapSet.has(rel)) fs.rmSync(abs, { force: true });',
  '    }',
  '  }',
  '};',
  'removeNewer(resolvedRemote);',
  'for (const rel of snapFiles) {',
  '  if (isEnvSecretName(path.posix.basename(rel))) continue;',
  '  const src = path.join(resolvedSnap, ...rel.split("/"));',
  '  const dst = path.join(resolvedRemote, ...rel.split("/"));',
  '  if (fs.existsSync(dst) && fs.lstatSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true });',
  '  fs.mkdirSync(path.dirname(dst), { recursive: true });',
  '  fs.copyFileSync(src, dst);',
  '  try { fs.chmodSync(dst, fs.statSync(src).mode & 0o777); } catch {}',
  '}',
  'console.log("RESTORE_SNAPSHOT_OK FILES=" + snapFiles.length);',
].join(' ');

export function buildRemoteSyncCommand({
  remoteDir,
  remoteStagingDir,
  tarballName,
  shortSha,
  timestampTag,
  composeFile,
}) {
  const parentRemote = path.posix.dirname(remoteDir);
  const snapshotRoot =
    parentRemote && parentRemote !== '/'
      ? `${parentRemote}/.release-previous`
      : '/tmp/talentlens-release-previous';
  const suffix = `${timestampTag}-${shortSha || 'release'}`;
  const snapshotDir = path.posix.join(snapshotRoot, suffix);
  const unpackDir = path.posix.join(remoteStagingDir, `unpacked-${suffix}`);
  const tarballPath = path.posix.join(remoteStagingDir, tarballName);
  return [
    `rm -rf ${shellQuotePosix(unpackDir)}`,
    `mkdir -p ${shellQuotePosix(unpackDir)} ${shellQuotePosix(remoteDir)}`,
    `tar -xzf ${shellQuotePosix(tarballPath)} -C ${shellQuotePosix(unpackDir)}`,
    [
      'node -e',
      shellQuotePosix(REMOTE_SYNC_SCRIPT),
      shellQuotePosix(remoteDir),
      shellQuotePosix(unpackDir),
      shellQuotePosix(snapshotRoot),
      shellQuotePosix(snapshotDir),
      shellQuotePosix(composeFile),
      shellQuotePosix(remoteStagingDir),
    ].join(' '),
  ].join(' && ');
}

export function buildRemoteRestoreSnapshotCommand({ remoteDir, snapshotDir, composeFile }) {
  return [
    'node -e',
    shellQuotePosix(REMOTE_RESTORE_SNAPSHOT_SCRIPT),
    shellQuotePosix(remoteDir),
    shellQuotePosix(snapshotDir),
    shellQuotePosix(composeFile),
  ].join(' ');
}

export function buildRemoteIdempotencyCommand({ remoteDir, remoteCompose, options, sourceDigest }) {
  const projectDirExtra = hasExternalComposeDir(options.composeFile) ? '--project-directory .' : '';
  const inlineScript = [
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    'const [releaseFile, envFile, expectedDigest, expectedCompose, expectedProject, composeBin, composePrefix, composeFile, projectDirExtra] = process.argv.slice(1);',
    'if (!fs.existsSync(releaseFile) || !fs.existsSync(composeFile) || !fs.existsSync(envFile)) process.exit(0);',
    'let rel;',
    'try { rel = JSON.parse(fs.readFileSync(releaseFile, "utf8")); } catch { process.exit(0); }',
    'const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");',
    'const composeSha = sha(composeFile);',
    'const envSha = sha(envFile);',
    'if (rel.sourceDigest !== expectedDigest || rel.composeFile !== expectedCompose || rel.projectName !== expectedProject || rel.envFile !== envFile || !rel.composeSha256 || rel.composeSha256 !== composeSha || !rel.envSha256 || rel.envSha256 !== envSha) process.exit(0);',
    'const envContent = fs.readFileSync(envFile, "utf8");',
    'const originLine = envContent.split(/\\r?\\n/).filter((l) => /^\\s*(?:export\\s+)?APP_ORIGIN=/.test(l)).pop() || "";',
    'const originRaw = originLine.replace(/^[^=]*=/, "").trim();',
    'const originMatch = /^([\'"])(.*)\\1(?:\\s+#.*)?$/.exec(originRaw);',
    'const origin = (originMatch ? originMatch[2] : originRaw.replace(/\\s+#.*$/, "")).trim();',
    'if (!origin || !origin.startsWith("https://")) process.exit(0);',
    'const prefixArgs = composePrefix ? composePrefix.split(" ") : [];',
    'const dirArgs = projectDirExtra ? projectDirExtra.split(" ") : [];',
    'for (const svc of ["postgres", "clamav", "api", "worker", "web"]) {',
    '  const st = execFileSync(composeBin, [...prefixArgs, ...dirArgs, "-p", expectedProject, "--env-file", envFile, "-f", composeFile, "ps", svc, "--format", "{{.State}} {{.Health}}"], { encoding: "utf8" }).trim();',
    '  if (!/(running|up)/i.test(st)) process.exit(0);',
    '  if ((svc === "postgres" || svc === "clamav" || svc === "api" || svc === "worker") && !/healthy/i.test(st)) process.exit(0);',
    '}',
    'const rootCode = execFileSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", origin + "/"], { encoding: "utf8" }).trim();',
    'if (rootCode !== "200") process.exit(0);',
    'const body = execFileSync("curl", ["-fsS", "--max-time", "8", origin + "/api/v1/health/ready"], { encoding: "utf8" });',
    'const json = JSON.parse(body);',
    'if (json.status === "ready" && json.database === "connected") console.log("IDEMPOTENT_SKIP");',
  ].join(' ');

  const releaseFile = path.posix.join(remoteDir, '.current-release.json');
  const composePrefix = remoteCompose.prefixArgs.join(' ');
  return [
    `cd ${shellQuotePosix(remoteDir)}`,
    [
      'node -e',
      shellQuotePosix(inlineScript),
      shellQuotePosix(releaseFile),
      shellQuotePosix(options.envFile),
      shellQuotePosix(sourceDigest),
      shellQuotePosix(options.composeFile),
      shellQuotePosix(options.projectName),
      shellQuotePosix(remoteCompose.bin),
      shellQuotePosix(composePrefix),
      shellQuotePosix(options.composeFile),
      shellQuotePosix(projectDirExtra),
    ].join(' '),
  ].join(' && ');
}

export function buildRemoteReleaseWriteCommand({ remoteDir, releaseMeta, composeFile, envFile }) {
  const inlineScript = [
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    'const [targetPath, composePath, envPath, payloadJson] = process.argv.slice(1);',
    'const sha = (p) => (p && fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null);',
    'const meta = JSON.parse(payloadJson);',
    'meta.composeSha256 = sha(composePath);',
    'meta.envSha256 = sha(envPath);',
    'const tmpPath = targetPath + ".tmp";',
    'fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\\n", "utf8");',
    'fs.renameSync(tmpPath, targetPath);',
  ].join(' ');
  const releaseFile = path.posix.join(remoteDir, '.current-release.json');
  return [
    `cd ${shellQuotePosix(remoteDir)}`,
    [
      'node -e',
      shellQuotePosix(inlineScript),
      shellQuotePosix(releaseFile),
      shellQuotePosix(composeFile),
      shellQuotePosix(envFile),
      shellQuotePosix(JSON.stringify(releaseMeta)),
    ].join(' '),
  ].join(' && ');
}

export function parseRemoteProbeOutput(stdoutText) {
  const tokens = String(stdoutText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let compose = null;
  if (tokens.includes('DOCKER_COMPOSE_V2')) {
    compose = { bin: 'docker', prefixArgs: ['compose'], display: 'docker compose' };
  } else if (tokens.includes('DOCKER_COMPOSE_V1')) {
    compose = { bin: 'docker-compose', prefixArgs: [], display: 'docker-compose' };
  }
  return {
    compose,
    hasOciOverlay: tokens.includes('HAS_OCI_OVERLAY'),
  };
}

function extractBackupArchivePath(outputText) {
  const matches = String(outputText || '').match(/(\/[^\s'"]+\.dump|backups\/[^\s'"]+\.dump)/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

function executeSshProductionDeploy({
  options,
  gitState,
  cwd,
  fsImpl,
  osImpl,
  env,
  execFn,
  nowFn,
  stdout,
  stderr,
}) {
  if (!options.remoteDir) {
    stderr('\n[FAIL] --remote-dir is required when using --ssh-host.');
    return 1;
  }

  let tempStagingDir = null;
  let capturedBackupPath = null;
  let capturedSnapshotPath = null;
  let previousTags = [];

  try {
    stdout('\n[STAGE 1/10] Recording verified Git metadata...');
    stdout(`  Commit: ${gitState.commitSha} (${gitState.branch})`);

    stdout('\n[STAGE 2/10] Creating sanitized release tarball and SHA-256 sidecar...');
    tempStagingDir = fsImpl.mkdtempSync(path.join(osImpl.tmpdir(), 'talentlens-release-'));
    const tarballName = `talentlens-release-${gitState.shortSha}.tar.gz`;
    const artifact = createSanitizedSourceTarball({
      cwd,
      outputDir: tempStagingDir,
      tarballName,
      fsImpl,
    });
    stdout(
      `  Tarball: ${artifact.tarballName} (${artifact.includedFiles.length} files, sha256=${artifact.tarballSha256.slice(0, 16)}...)`,
    );

    stdout('\n[STAGE 3/10] Local release artifact checks passed.');

    const normalizedRemoteDir = path.posix.normalize(options.remoteDir).replace(/\/+$/, '') || '/';
    stdout(`\n[STAGE 4/10] Probing SSH connectivity and remote toolchain on ${options.sshHost}...`);
    const remoteOciOverlayPath = path.posix.join(normalizedRemoteDir, 'docker-compose.oci.yml');
    const probeCmd = `command -v tar sha256sum node docker curl >/dev/null && (if docker compose version >/dev/null 2>&1; then echo DOCKER_COMPOSE_V2; elif docker-compose version >/dev/null 2>&1; then echo DOCKER_COMPOSE_V1; else exit 1; fi) && (if [ -f ${shellQuotePosix(remoteOciOverlayPath)} ]; then echo HAS_OCI_OVERLAY; fi)`;
    const probeRes = execFn('ssh', [...buildRemoteSshArgs(options.sshHost), probeCmd], {
      cwd,
      env,
      capture: true,
    });
    if (!probeRes || probeRes.status !== 0) {
      stderr(
        `[FAIL] Remote SSH connectivity or required toolchain probe failed on ${options.sshHost}.${probeRes?.stderr ? ` ${probeRes.stderr.trim()}` : ''}`,
      );
      return 1;
    }
    const remoteProbe = parseRemoteProbeOutput(probeRes.stdout);
    const remoteCompose = remoteProbe.compose;
    if (!remoteCompose) {
      stderr('[FAIL] Remote host has neither `docker compose` (V2) nor `docker-compose`.');
      return 1;
    }
    const baseOptions = { ...options, remoteDir: normalizedRemoteDir };
    const effectiveOptions =
      !baseOptions.composeFileExplicit && remoteProbe.hasOciOverlay
        ? { ...baseOptions, composeFile: 'docker-compose.oci.yml' }
        : baseOptions;
    stdout(`  Remote Compose binary: ${remoteCompose.display}`);
    if (!baseOptions.composeFileExplicit && remoteProbe.hasOciOverlay) {
      stdout(
        `  Detected server-only OCI overlay (${remoteOciOverlayPath}); preserving and reusing --compose-file docker-compose.oci.yml.`,
      );
    }

    stdout('\n[STAGE 5/10] Checking remote release idempotency and live readiness...');
    if (effectiveOptions.force) {
      stdout('  --force specified; bypassing remote idempotency skip.');
    } else {
      const idempotencyCmd = buildRemoteIdempotencyCommand({
        remoteDir: effectiveOptions.remoteDir,
        remoteCompose,
        options: effectiveOptions,
        sourceDigest: artifact.sourceDigest,
      });
      const idemRes = execFn(
        'ssh',
        [...buildRemoteSshArgs(effectiveOptions.sshHost), idempotencyCmd],
        {
          cwd,
          env,
          capture: true,
        },
      );
      if (idemRes && idemRes.status === 0 && idemRes.stdout.trim() === 'IDEMPOTENT_SKIP') {
        stdout(
          `  [IDEMPOTENT SKIP] Remote release (${artifact.sourceDigest.slice(0, 12)}) already matches current source, config/env checksums, healthy containers, HTTP /, and HTTPS readiness. Pass --force to redeploy.`,
        );
        return 0;
      }
      stdout(
        '  Proceeding with release rollout (new source/config digest or initial/unhealthy state).',
      );
    }

    const parentRemote = path.posix.dirname(effectiveOptions.remoteDir);
    const remoteStagingDir =
      parentRemote && parentRemote !== '/'
        ? `${parentRemote}/.release-staging`
        : '/tmp/talentlens-release-staging';

    stdout(
      `\n[STAGE 6/10] Uploading release archive to ${effectiveOptions.sshHost}:${remoteStagingDir} and verifying SHA-256 BEFORE unpack...`,
    );
    const mkdirStagingRes = execFn(
      'ssh',
      [
        ...buildRemoteSshArgs(effectiveOptions.sshHost),
        `mkdir -p ${shellQuotePosix(remoteStagingDir)}`,
      ],
      { cwd, env, capture: true },
    );
    if (!mkdirStagingRes || mkdirStagingRes.status !== 0) {
      stderr(`[FAIL] Unable to create remote staging directory ${remoteStagingDir}.`);
      return 1;
    }

    const scpRes = execFn(
      'scp',
      [
        '-o',
        'BatchMode=yes',
        artifact.tarballPath,
        artifact.checksumPath,
        `${effectiveOptions.sshHost}:${remoteStagingDir}/`,
      ],
      { cwd, env },
    );
    if (!scpRes || scpRes.status !== 0) {
      stderr('[FAIL] SCP upload of sanitized release tarball failed.');
      return 1;
    }

    const verifyChecksumCmd = `cd ${shellQuotePosix(remoteStagingDir)} && sha256sum -c ${shellQuotePosix(`${artifact.tarballName}.sha256`)}`;
    const verifyRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), verifyChecksumCmd],
      {
        cwd,
        env,
        capture: true,
      },
    );
    if (!verifyRes || verifyRes.status !== 0) {
      stderr(
        '[FAIL] Remote SHA-256 checksum verification FAILED before unpack; aborting rollout cleanly.',
      );
      return 1;
    }
    stdout('  [PASS] Remote SHA-256 checksum verified cleanly.');

    stdout(
      `\n[STAGE 7/10] Snapshotting prior config, clean-syncing ${effectiveOptions.remoteDir} (removing stale files while preserving host overlays/env), and running remote preflight + Compose checks BEFORE rollout...`,
    );
    const timestampTag = `${nowFn().toISOString().replace(/[:.-]/g, '').slice(0, 15)}Z`;
    const syncCmd = buildRemoteSyncCommand({
      remoteDir: effectiveOptions.remoteDir,
      remoteStagingDir,
      tarballName: artifact.tarballName,
      shortSha: gitState.shortSha,
      timestampTag,
      composeFile: effectiveOptions.composeFile,
    });
    const unpackRes = execFn('ssh', [...buildRemoteSshArgs(effectiveOptions.sshHost), syncCmd], {
      cwd,
      env,
      capture: true,
    });
    if (!unpackRes || unpackRes.status !== 0) {
      stderr('[FAIL] Failed to extract and clean-sync verified tarball into remote directory.');
      return 1;
    }
    const snapMatch = /SNAPSHOT=([^\s]+)/.exec(unpackRes.stdout || '');
    if (snapMatch && snapMatch[1] && snapMatch[1] !== 'NONE') {
      capturedSnapshotPath = snapMatch[1];
      stdout(`  [PASS] Pre-rollout source/Compose snapshot saved: ${capturedSnapshotPath}`);
    }

    const rollbackPreMutationSnapshot = (stageLabel) => {
      if (!capturedSnapshotPath) return;
      const restoreCmd = buildRemoteRestoreSnapshotCommand({
        remoteDir: effectiveOptions.remoteDir,
        snapshotDir: capturedSnapshotPath,
        composeFile: effectiveOptions.composeFile,
      });
      const restoreRes = execFn(
        'ssh',
        [...buildRemoteSshArgs(effectiveOptions.sshHost), restoreCmd],
        { cwd, env, capture: true },
      );
      if (restoreRes && restoreRes.status === 0) {
        stdout(
          `  [ROLLBACK] Automatically restored ${effectiveOptions.remoteDir} from ${capturedSnapshotPath} after ${stageLabel} failure.`,
        );
      } else {
        stderr(
          `  [WARN] Failed to auto-restore ${effectiveOptions.remoteDir} from ${capturedSnapshotPath} after ${stageLabel} failure.`,
        );
      }
    };

    const remotePreflightCmd = `cd ${shellQuotePosix(effectiveOptions.remoteDir)} && node scripts/preflight-env.mjs ${shellQuotePosix(effectiveOptions.envFile)} --strict-perms`;
    const remotePreflightRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), remotePreflightCmd],
      { cwd, env },
    );
    if (!remotePreflightRes || remotePreflightRes.status !== 0) {
      stderr('[FAIL] Remote scripts/preflight-env.mjs rejected target environment BEFORE rollout.');
      rollbackPreMutationSnapshot('Stage 7 env preflight');
      return 1;
    }

    const composePrefixStr = formatComposeInline(
      remoteCompose.display,
      effectiveOptions,
      effectiveOptions.envFile,
    );
    const remoteComposeCheckCmd = `cd ${shellQuotePosix(effectiveOptions.remoteDir)} && test -f ${shellQuotePosix(effectiveOptions.composeFile)} && ${composePrefixStr} config --quiet`;
    const remoteComposeRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), remoteComposeCheckCmd],
      { cwd, env },
    );
    if (!remoteComposeRes || remoteComposeRes.status !== 0) {
      stderr('[FAIL] Remote Docker Compose configuration validation failed BEFORE rollout.');
      rollbackPreMutationSnapshot('Stage 7 Compose validation');
      return 1;
    }

    stdout('\n[STAGE 8/10] Pre-rollout PostgreSQL custom backup gate (mandatory)...');
    const backupCmd = [
      `cd ${shellQuotePosix(effectiveOptions.remoteDir)}`,
      'chmod +x deploy.sh scripts/backup.sh scripts/restore.sh',
      `sudo -n bash ./scripts/backup.sh -f ${shellQuotePosix(effectiveOptions.composeFile)} --env-file ${shellQuotePosix(effectiveOptions.envFile)} -p ${shellQuotePosix(effectiveOptions.projectName)} --format custom`,
    ].join(' && ');
    const backupRes = execFn('ssh', [...buildRemoteSshArgs(effectiveOptions.sshHost), backupCmd], {
      cwd,
      env,
      capture: true,
    });
    if (backupRes?.stdout) stdout(backupRes.stdout.trimEnd());
    if (backupRes?.stderr) stderr(backupRes.stderr.trimEnd());
    if (!backupRes || backupRes.status !== 0) {
      stderr('[FAIL] Pre-rollout PostgreSQL backup failed; aborting rollout before mutation.');
      rollbackPreMutationSnapshot('Stage 8 pre-rollout backup');
      return 1;
    }
    capturedBackupPath = extractBackupArchivePath(backupRes.stdout);
    stdout(
      `  [PASS] Pre-rollout custom backup verified${capturedBackupPath ? `: ${capturedBackupPath}` : ''}.`,
    );

    stdout(
      '\n[STAGE 9/10] Tagging :previous images, rolling out via deploy.sh, verifying HTTPS, and recording release...',
    );
    const tagPreviousCmd = [
      `cd ${shellQuotePosix(effectiveOptions.remoteDir)}`,
      `for svc in web api worker; do img=$(sudo -n ${composePrefixStr} images -q "$svc" 2>/dev/null | head -n 1 || true); if [ -z "$img" ]; then cid=$(sudo -n ${composePrefixStr} ps -q "$svc" 2>/dev/null | head -n 1 || true); if [ -n "$cid" ]; then img=$(sudo -n docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true); fi; fi; if [ -n "$img" ]; then sudo -n docker tag "$img" "${effectiveOptions.projectName}-$svc:previous" && echo "${effectiveOptions.projectName}-$svc:previous"; fi; done`,
    ].join(' && ');
    const tagRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), tagPreviousCmd],
      {
        cwd,
        env,
        capture: true,
      },
    );
    if (tagRes && tagRes.status === 0 && tagRes.stdout.trim()) {
      previousTags = tagRes.stdout
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const deployCmd = [
      `cd ${shellQuotePosix(effectiveOptions.remoteDir)}`,
      `sudo -n env COMPOSE_FILE=${shellQuotePosix(effectiveOptions.composeFile)} ENV_FILE=${shellQuotePosix(effectiveOptions.envFile)} COMPOSE_PROJECT_NAME=${shellQuotePosix(effectiveOptions.projectName)} bash ./deploy.sh`,
    ].join(' && ');
    const deployRes = execFn('ssh', [...buildRemoteSshArgs(effectiveOptions.sshHost), deployCmd], {
      cwd,
      env,
    });
    if (!deployRes || deployRes.status !== 0) {
      stderr('\n[FAIL] Remote deploy.sh rollout failed.');
      printRollbackGuidance({
        stdout,
        options: effectiveOptions,
        backupArchive: capturedBackupPath,
        previousTags,
        snapshotDir: capturedSnapshotPath,
      });
      return 1;
    }

    const httpsScript = [
      "const fs = require('node:fs');",
      "const { execFileSync } = require('node:child_process');",
      'const [envFile] = process.argv.slice(1);',
      'const originLine = fs.readFileSync(envFile, "utf8").split(/\\r?\\n/).filter((l) => /^\\s*(?:export\\s+)?APP_ORIGIN=/.test(l)).pop() || "";',
      'const originRaw = originLine.replace(/^[^=]*=/, "").trim();',
      'const originMatch = /^([\'"])(.*)\\1(?:\\s+#.*)?$/.exec(originRaw);',
      'const origin = (originMatch ? originMatch[2] : originRaw.replace(/\\s+#.*$/, "")).trim();',
      'if (!origin.startsWith("https://")) process.exit(1);',
      'const rootCode = execFileSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", origin + "/"], { encoding: "utf8" }).trim();',
      'if (rootCode !== "200") process.exit(1);',
      'const readyJson = JSON.parse(execFileSync("curl", ["-fsS", "--max-time", "10", origin + "/api/v1/health/ready"], { encoding: "utf8" }));',
      'if (readyJson.status !== "ready" || readyJson.database !== "connected") process.exit(1);',
    ].join(' ');
    const verifyHttpsCmd = `cd ${shellQuotePosix(effectiveOptions.remoteDir)} && node -e ${shellQuotePosix(httpsScript)} ${shellQuotePosix(effectiveOptions.envFile)}`;
    const httpsRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), verifyHttpsCmd],
      {
        cwd,
        env,
        capture: true,
      },
    );
    if (!httpsRes || httpsRes.status !== 0) {
      stderr('\n[FAIL] Post-deploy public HTTPS (/) + (/api/v1/health/ready) check failed.');
      printRollbackGuidance({
        stdout,
        options: effectiveOptions,
        backupArchive: capturedBackupPath,
        previousTags,
        snapshotDir: capturedSnapshotPath,
      });
      return 1;
    }

    const releaseMeta = {
      deployedAt: nowFn().toISOString(),
      commitSha: gitState.commitSha,
      shortSha: gitState.shortSha,
      sourceDigest: artifact.sourceDigest,
      tarballSha256: artifact.tarballSha256,
      composeFile: effectiveOptions.composeFile,
      envFile: effectiveOptions.envFile,
      projectName: effectiveOptions.projectName,
      backupArchive: capturedBackupPath,
      previousSnapshotDir: capturedSnapshotPath,
    };
    const writeMetaCmd = buildRemoteReleaseWriteCommand({
      remoteDir: effectiveOptions.remoteDir,
      releaseMeta,
      composeFile: effectiveOptions.composeFile,
      envFile: effectiveOptions.envFile,
    });
    const writeMetaRes = execFn(
      'ssh',
      [...buildRemoteSshArgs(effectiveOptions.sshHost), writeMetaCmd],
      {
        cwd,
        env,
        capture: true,
      },
    );
    if (!writeMetaRes || writeMetaRes.status !== 0) {
      stderr('[WARN] Rollout succeeded, but failed to write .current-release.json marker.');
    }

    stdout('\n[STAGE 10/10] Production deployment verified and release marker recorded.');
    printRollbackGuidance({
      stdout,
      options: effectiveOptions,
      backupArchive: capturedBackupPath,
      previousTags,
      snapshotDir: capturedSnapshotPath,
    });
    stdout('================================================================================');
    return 0;
  } finally {
    if (tempStagingDir && fsImpl.existsSync(tempStagingDir)) {
      fsImpl.rmSync(tempStagingDir, { recursive: true, force: true });
    }
  }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const cwd = deps.cwd ?? rootDir;
  const fsImpl = deps.fsImpl ?? fs;
  const osImpl = deps.osImpl ?? os;
  const env = deps.env ?? process.env;
  const execFn = deps.execFn ?? defaultExec;
  const nowFn = deps.nowFn ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const stdout = deps.stdout ?? ((msg) => console.log(msg));
  const stderr = deps.stderr ?? ((msg) => console.error(msg));

  const options = parseDeployProductionArgs(argv);
  if (options.help) {
    stdout(
      'Usage: node -- scripts/deploy-production.mjs [--env-file <path> | --remote-env-file <path>] [--compose-file <path>] [--project-name <name>] [--strict] [--force] [--allow-dirty] [--execute --confirm-production [--ssh-host <user@host> --remote-dir <path>]]',
    );
    return 0;
  }

  const guard = validateExecutionGuard(options);
  if (options.execute && !guard.allowed) {
    stderr(`\n[FAIL] ${guard.reason}`);
    stdout('================================================================================');
    return 1;
  }
  const safeCheck = validateSafeInputs(options);
  if (!safeCheck.valid) {
    stderr(`\n[FAIL] ${safeCheck.reason}`);
    stdout('================================================================================');
    return 1;
  }

  const isRemoteTarget = Boolean(options.sshHost || options.remoteEnvFileExplicit);
  const resolvedEnvPath = isRemoteTarget ? null : path.resolve(cwd, options.envFile);
  const resolvedComposePath = path.resolve(cwd, options.composeFile);
  const canonicalComposePath = path.resolve(cwd, 'docker-compose.prod.yml');
  const gitState = inspectGitState(cwd, execFn);
  const envMode = isRemoteTarget
    ? { exists: false, nodeEnv: null, remoteOnly: true }
    : readSafeEnvMode(resolvedEnvPath, fsImpl);
  const mustFailClosedLocalPreflight =
    !isRemoteTarget && (options.execute || options.strict || options.envFileExplicit);

  stdout('================================================================================');
  stdout('TALENTLENS AI — PRODUCTION DEPLOYMENT & PREFLIGHT CONTROLLER');
  stdout('================================================================================');
  stdout(
    `Mode:                ${guard.dryRun ? 'SAFE DRY-RUN / PREFLIGHT (default)' : guard.allowed ? 'LIVE PRODUCTION EXECUTION' : 'BLOCKED'}`,
  );
  stdout(
    `Deploy Target:       ${isRemoteTarget ? `Remote OCI host via SSH (${options.sshHost || 'pending --ssh-host'})` : 'Local host controller'}`,
  );
  stdout(
    `Git Branch:          ${gitState.branch} (${gitState.isClean ? 'clean' : `${gitState.dirtyCount} uncommitted change(s)`})`,
  );
  if (isRemoteTarget) {
    stdout(
      `Remote Env File:     ${options.envFile} (protected on OCI host; never copied to or read locally)`,
    );
    stdout('Local Env File:      not used for remote OCI rollout (workstation env untouched)');
    stdout(
      `Compose File Target: ${options.composeFile} (${fsImpl.existsSync(resolvedComposePath) ? 'present locally' : 'remote OCI overlay / validated on remote host'})`,
    );
  } else {
    stdout(
      `Env File Target:     ${resolvedEnvPath} (${envMode.exists ? `exists locally, NODE_ENV=${envMode.nodeEnv ?? 'unset'}` : 'missing locally'})`,
    );
    stdout(
      `Compose File Target: ${resolvedComposePath} (${fsImpl.existsSync(resolvedComposePath) ? 'exists locally' : 'missing'})`,
    );
  }
  stdout(`Project Name:        ${options.projectName}`);

  if (isRemoteTarget) {
    if (!fsImpl.existsSync(canonicalComposePath) && !fsImpl.existsSync(resolvedComposePath)) {
      stderr(`\n[FAIL] Missing canonical production compose file: ${canonicalComposePath}`);
      stdout('================================================================================');
      return 1;
    }
  } else if (!fsImpl.existsSync(resolvedComposePath)) {
    stderr(`\n[FAIL] Missing production compose file: ${resolvedComposePath}`);
    stdout('================================================================================');
    return 1;
  }

  if (gitState.branch !== 'main') {
    const msg = `Current Git branch is "${gitState.branch}", expected "main" for production releases.`;
    if (options.execute) {
      stderr(`\n[FAIL] ${msg}`);
      return 1;
    }
    stdout(`  [WARN] ${msg}`);
  }

  if (!gitState.isClean) {
    const msg = `Working tree has ${gitState.dirtyCount} uncommitted file(s). Production releases must match reviewed Git commits.`;
    if (options.execute && !options.allowDirty) {
      stderr(`\n[FAIL] ${msg} Pass --allow-dirty only for explicit hotfix diagnostics.`);
      return 1;
    }
    stdout(`  [WARN] ${msg}`);
  }

  let preflightPassed = false;
  if (isRemoteTarget) {
    stdout(
      `  [INFO] Remote OCI env target "${options.envFile}" resides on ${options.sshHost || 'the remote OCI host'}; skipping local filesystem read and local env preflight.`,
    );
    if (guard.dryRun) {
      stdout(
        '  [INFO] Dry-run scope: remote SSH connectivity, remote preflight-env.mjs --strict-perms, remote Docker Compose validation, mandatory PostgreSQL backup, and live HTTPS checks were NOT executed (pass --execute --confirm-production to run them).',
      );
      if (options.remoteEnvFileExplicit && !options.sshHost) {
        stdout(
          `  [WARN] --ssh-host <user@host>${options.remoteDir ? '' : ' and --remote-dir <path>'} required before running --execute --confirm-production with --remote-env-file.`,
        );
      } else if (options.sshHost && !options.remoteDir) {
        stdout(
          '  [WARN] --remote-dir <path> is required alongside --ssh-host before executing --execute --confirm-production.',
        );
      }
      if (options.strict) {
        stdout(
          `  [INFO] --strict local env validation does not apply to remote-only file "${options.envFile}"; Stage 7 runs preflight-env.mjs --strict-perms on the OCI host during --execute.`,
        );
      }
    }
  } else if (!envMode.exists) {
    if (mustFailClosedLocalPreflight) {
      stderr(`\n[FAIL] Target environment file not found: ${resolvedEnvPath}`);
      stdout('================================================================================');
      return 1;
    }
    stdout(
      '  [INFO] No local production env file present; skipping local preflight during default dry-run (pass --env-file <prod.env> or --strict for local validation).',
    );
  } else if (envMode.nodeEnv !== 'production' && !mustFailClosedLocalPreflight) {
    stdout(
      `  [INFO] Target env file has NODE_ENV="${envMode.nodeEnv ?? 'unset'}" (local workstation mode); skipping fail-closed production preflight in default dry-run. Pass --env-file <prod.env> or --strict to validate a production file.`,
    );
  } else {
    stdout('\n[CHECK] Running fail-closed environment preflight...');
    const preflight = execFn(process.execPath, ['scripts/preflight-env.mjs', resolvedEnvPath], {
      cwd,
      env,
    });
    if (!preflight || preflight.status !== 0) {
      stderr('\n[FAIL] Production preflight rejected environment configuration.');
      stdout('================================================================================');
      return 1;
    }
    preflightPassed = true;
  }

  if (!isRemoteTarget && preflightPassed && fsImpl.existsSync(resolvedComposePath)) {
    const compose = detectComposeCommand(execFn, { cwd, env });
    if (compose) {
      stdout(
        `\n[CHECK] Validating Docker Compose config syntax (${compose.display}) without exposing secrets...`,
      );
      const projectDirArgs = hasExternalComposeDir(options.composeFile)
        ? ['--project-directory', '.']
        : [];
      const composeCheck = execFn(
        compose.bin,
        [
          ...compose.prefixArgs,
          ...projectDirArgs,
          '-p',
          options.projectName,
          '--env-file',
          resolvedEnvPath,
          '-f',
          options.composeFile,
          'config',
          '--quiet',
        ],
        { cwd, env },
      );
      if (!composeCheck || composeCheck.status !== 0) {
        stderr('\n[FAIL] Docker Compose configuration validation failed.');
        stdout('================================================================================');
        return 1;
      }
      stdout('  [PASS] Docker Compose configuration syntax is valid.');
    }
  }

  stdout('\nMandatory Release Gates (Sequential Execution):');
  stdout('  1. npm run build');
  stdout('  2. npm run typecheck');
  stdout('  3. npm run lint');
  stdout('  4. npm test');
  stdout('  5. npm run format:check');
  stdout('  6. node --test scripts/e2e-safety-guard.test.mjs');
  stdout('  7. node --test scripts/deploy-scripts.test.mjs');
  stdout('  8. node scripts/preflight-env.mjs <production-env-file>');

  stdout('\nOCI Ubuntu 24.04 Production Deploy & Rollback Commands:');
  const projectDirPart = hasExternalComposeDir(options.composeFile) ? ' --project-directory .' : '';
  stdout(
    `  Deploy:   sudo env COMPOSE_FILE=${options.composeFile} ENV_FILE=${options.envFile} COMPOSE_PROJECT_NAME=${options.projectName} bash ./deploy.sh`,
  );
  stdout(
    `  Backup:   sudo bash ./scripts/backup.sh -f ${options.composeFile} --env-file ${options.envFile} -p ${options.projectName} --format custom`,
  );
  stdout(
    `  Rollback: sudo docker compose${projectDirPart} -p ${options.projectName} --env-file ${options.envFile} -f ${options.composeFile} stop api worker && sudo bash ./scripts/restore.sh -f ${options.composeFile} --env-file ${options.envFile} -p ${options.projectName} --confirm-replace-existing <archive.dump> <db>`,
  );

  if (guard.dryRun) {
    if (options.skipBackup) {
      stdout(
        '\n[WARN] --skip-backup is prohibited by production safety policy; live --execute runs refuse --skip-backup.',
      );
    }
    stdout('\n[DRY RUN COMPLETE] No live services or databases were modified.');
    stdout('Pass --execute --confirm-production to initiate a controlled rollout.');
    stdout('================================================================================');
    return 0;
  }

  if (options.sshHost) {
    return executeSshProductionDeploy({
      options,
      gitState,
      cwd,
      fsImpl,
      osImpl,
      env,
      execFn,
      nowFn,
      stdout,
      stderr,
    });
  }

  if (platform === 'win32') {
    stderr(
      '\n[FAIL] Direct container deployment (deploy.sh) targets OCI Ubuntu 24.04 Linux hosts. Pass --ssh-host <user@host> --remote-dir <path> from Windows, or execute `bash deploy.sh` directly on the OCI VM.',
    );
    return 1;
  }

  stdout('\n[EXECUTE] Running mandatory pre-rollout PostgreSQL custom backup...');
  const backupRes = execFn(
    'bash',
    [
      'scripts/backup.sh',
      '-f',
      options.composeFile,
      '--env-file',
      resolvedEnvPath,
      '-p',
      options.projectName,
      '--format',
      'custom',
    ],
    { cwd, env, capture: true },
  );
  if (backupRes?.stdout) stdout(backupRes.stdout.trimEnd());
  if (backupRes?.stderr) stderr(backupRes.stderr.trimEnd());
  if (!backupRes || backupRes.status !== 0) {
    stderr('[FAIL] Pre-rollout backup failed; aborting deploy.sh execution.');
    return 1;
  }
  const localBackupPath = extractBackupArchivePath(backupRes.stdout);

  stdout('\n[EXECUTE] Launching deploy.sh...');
  const deployResult = execFn('bash', ['deploy.sh'], {
    cwd,
    env: {
      ...env,
      COMPOSE_FILE: options.composeFile,
      ENV_FILE: resolvedEnvPath,
      COMPOSE_PROJECT_NAME: options.projectName,
    },
  });
  if (!deployResult || deployResult.status !== 0) {
    printRollbackGuidance({ stdout, options, backupArchive: localBackupPath });
    return 1;
  }

  printRollbackGuidance({ stdout, options, backupArchive: localBackupPath });
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
