import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkerReadinessState,
  evaluateWorkerReadiness,
  verifyWorkerStartupDependencies,
  writeWorkerReadinessState,
  type WorkerReadinessState,
} from './readiness.js';

function makeTempReadinessFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talentlens-worker-ready-test-'));
  return path.join(dir, 'worker-ready.json');
}

describe('Worker Readiness & Healthcheck', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const filePath of createdFiles) {
      clearWorkerReadinessState(filePath);
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
    createdFiles.length = 0;
  });

  function trackFile(): string {
    const f = makeTempReadinessFile();
    createdFiles.push(f);
    return f;
  }

  function validReadyState(overrides: Partial<WorkerReadinessState> = {}): WorkerReadinessState {
    const nowIso = new Date().toISOString();
    return {
      status: 'ready',
      pid: process.pid,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      pollCount: 1,
      databaseConnected: true,
      storageConfigured: true,
      emailCryptoInitialized: true,
      fatalError: null,
      ...overrides,
    };
  }

  it('fails healthcheck when readiness file is missing', async () => {
    const filePath = trackFile();
    const res = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: async () => undefined,
    });
    expect(res.healthy).toBe(false);
    expect(res.reason).toContain('does not exist');
  });

  it('fails healthcheck while worker is still starting or shutting down', async () => {
    const filePath = trackFile();

    writeWorkerReadinessState(filePath, validReadyState({ status: 'starting', pollCount: 0 }));
    const startingRes = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: async () => undefined,
    });
    expect(startingRes.healthy).toBe(false);

    writeWorkerReadinessState(filePath, validReadyState({ status: 'shutting_down' }));
    const stoppingRes = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: async () => undefined,
    });
    expect(stoppingRes.healthy).toBe(false);
  });

  it('fails healthcheck when worker reported fatal error or unhealthy status', async () => {
    const filePath = trackFile();
    writeWorkerReadinessState(
      filePath,
      validReadyState({
        status: 'unhealthy',
        fatalError: 'Database connection lost',
      }),
    );

    const res = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: async () => undefined,
    });
    expect(res.healthy).toBe(false);
    expect(res.reason).toContain('Database connection lost');
  });

  it('fails healthcheck when heartbeat is stale', async () => {
    const filePath = trackFile();
    const staleDate = new Date(Date.now() - 120_000).toISOString();
    writeWorkerReadinessState(filePath, validReadyState({ lastHeartbeatAt: staleDate }));

    const res = await evaluateWorkerReadiness({
      filePath,
      maxHeartbeatAgeMs: 45_000,
      checkDatabase: async () => undefined,
    });
    expect(res.healthy).toBe(false);
    expect(res.reason).toContain('stale');
  });

  it('fails healthcheck when live database connectivity check fails even with fresh heartbeat', async () => {
    const filePath = trackFile();
    writeWorkerReadinessState(filePath, validReadyState());

    const res = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: async () => {
        throw new Error('postgresql://user:SecretPW@db:5432/talentlens ECONNREFUSED');
      },
    });
    expect(res.healthy).toBe(false);
    expect(res.reason).toContain('database connectivity check failed');
    expect(res.reason).not.toContain('SecretPW');
  });

  it('passes healthcheck when state is ready, heartbeat is fresh, and DB probe succeeds', async () => {
    const filePath = trackFile();
    writeWorkerReadinessState(filePath, validReadyState({ pollCount: 4 }));
    const dbCheck = vi.fn(async () => undefined);

    const res = await evaluateWorkerReadiness({
      filePath,
      checkDatabase: dbCheck,
    });
    expect(res.healthy).toBe(true);
    expect(dbCheck).toHaveBeenCalledTimes(1);
  });

  it('fails startup dependency verification in production when crypto, storage, or DB fails', async () => {
    await expect(
      verifyWorkerStartupDependencies({
        env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/EMAIL_OUTBOX_IDEMPOTENCY_SECRET/);

    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => {
          throw new Error('DB unreachable');
        },
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/DB unreachable/);
  });
});
