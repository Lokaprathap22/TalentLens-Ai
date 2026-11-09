import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeIdempotencySecret,
  initializeKeyRing,
  resolveValidNodeEnv,
} from './email-crypto.js';
import { WorkerStorageService } from './storage.js';

export type WorkerReadinessStatus = 'starting' | 'ready' | 'unhealthy' | 'shutting_down';

export interface WorkerReadinessState {
  status: WorkerReadinessStatus;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  pollCount: number;
  databaseConnected: boolean;
  storageConfigured: boolean;
  emailCryptoInitialized: boolean;
  fatalError: string | null;
}

export const DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

export function sanitizeWorkerErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown worker error');
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function getWorkerReadinessFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['WORKER_READINESS_FILE']?.trim();
  if (configured) {
    return configured;
  }
  return path.join(os.tmpdir(), 'talentlens-worker-ready.json');
}

export function writeWorkerReadinessState(filePath: string, state: WorkerReadinessState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
}

export function clearWorkerReadinessState(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup during shutdown
  }
}

export interface VerifyWorkerDependenciesOptions {
  env?: NodeJS.ProcessEnv | undefined;
  checkDatabase: () => Promise<void>;
  verifyStorage?: (() => void) | undefined;
}

export interface VerifiedWorkerDependencies {
  emailCryptoInitialized: boolean;
  storageConfigured: boolean;
  databaseConnected: boolean;
}

export async function verifyWorkerStartupDependencies(
  options: VerifyWorkerDependenciesOptions,
): Promise<VerifiedWorkerDependencies> {
  const env = options.env ?? process.env;
  initializeIdempotencySecret(env);
  initializeKeyRing(env);

  const verifyStorage =
    options.verifyStorage ??
    (() => {
      new WorkerStorageService();
    });
  verifyStorage();

  const nodeEnv = resolveValidNodeEnv(env);
  if ((nodeEnv === 'production' || nodeEnv === 'staging') && !env['SMTP_HOST']?.trim()) {
    throw new Error('SMTP_HOST is required in production/staging worker configuration');
  }

  await options.checkDatabase();

  return {
    emailCryptoInitialized: true,
    storageConfigured: true,
    databaseConnected: true,
  };
}

export interface EvaluateWorkerReadinessOptions {
  filePath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  checkDatabase: () => Promise<void>;
  maxHeartbeatAgeMs?: number | undefined;
  nowMs?: number | undefined;
}

export interface WorkerHealthResult {
  healthy: boolean;
  reason?: string | undefined;
  state?: WorkerReadinessState | undefined;
}

export async function evaluateWorkerReadiness(
  options: EvaluateWorkerReadinessOptions,
): Promise<WorkerHealthResult> {
  const filePath = options.filePath ?? getWorkerReadinessFilePath(options.env);
  const maxHeartbeatAgeMs =
    options.maxHeartbeatAgeMs ??
    (Number(options.env?.['WORKER_HEARTBEAT_MAX_AGE_MS']) || DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS);
  const nowMs = options.nowMs ?? Date.now();

  if (!fs.existsSync(filePath)) {
    return {
      healthy: false,
      reason: 'Worker readiness heartbeat file does not exist',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {
      healthy: false,
      reason: 'Worker readiness heartbeat file contains malformed JSON',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      healthy: false,
      reason: 'Worker readiness state payload is invalid',
    };
  }

  const state = parsed as Partial<WorkerReadinessState>;
  if (state.status !== 'ready') {
    return {
      healthy: false,
      reason: `Worker status is "${String(state.status ?? 'unknown')}"${state.fatalError ? `: ${state.fatalError}` : ''}`,
    };
  }

  if (state.fatalError) {
    return {
      healthy: false,
      reason: `Worker reported fatal error: ${state.fatalError}`,
    };
  }

  if (!state.emailCryptoInitialized || !state.storageConfigured || !state.databaseConnected) {
    return {
      healthy: false,
      reason: 'Worker dependency initialization flags are incomplete',
    };
  }

  if (typeof state.pollCount !== 'number' || state.pollCount < 1) {
    return {
      healthy: false,
      reason: 'Worker polling loop has not completed its initial readiness cycle',
    };
  }

  const heartbeatMs =
    typeof state.lastHeartbeatAt === 'string' ? Date.parse(state.lastHeartbeatAt) : Number.NaN;
  if (!Number.isFinite(heartbeatMs)) {
    return {
      healthy: false,
      reason: 'Worker heartbeat timestamp is invalid',
    };
  }

  const ageMs = nowMs - heartbeatMs;
  if (ageMs > maxHeartbeatAgeMs) {
    return {
      healthy: false,
      reason: `Worker heartbeat is stale (${ageMs}ms old > ${maxHeartbeatAgeMs}ms limit)`,
    };
  }

  if (heartbeatMs > nowMs + 10_000) {
    return {
      healthy: false,
      reason: 'Worker heartbeat timestamp is unexpectedly skewed in the future',
    };
  }

  try {
    await options.checkDatabase();
  } catch (error) {
    return {
      healthy: false,
      reason: `Worker database connectivity check failed: ${sanitizeWorkerErrorMessage(error)}`,
    };
  }

  return {
    healthy: true,
    state: state as WorkerReadinessState,
  };
}
