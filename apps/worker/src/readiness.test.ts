import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkerReadinessState,
  evaluateWorkerReadiness,
  startWorkerHeartbeatRefresher,
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
          GEMINI_MODEL: 'gemini-3.8-flash',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/Unsupported Gemini model/);

    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          GEMINI_FALLBACK_MODEL: 'gemini-3.6-flash-lite',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/Flash-Lite/);

    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          GEMINI_MODEL: 'gemini-3.6-flash',
          GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => {
          throw new Error('DB unreachable');
        },
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/DB unreachable/);

    // Rejects invalid AI_PROVIDER_ORDER, insecure http GROQ_BASE_URL in prod, and invalid GROQ_TIMEOUT_MS
    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          AI_PROVIDER_ORDER: 'gemini,unknown_ai',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/AI_PROVIDER_ORDER/);

    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          GROQ_BASE_URL: 'http://api.groq.com/openai/v1',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/GROQ_BASE_URL/);

    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          GROQ_TIMEOUT_MS: '50',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).rejects.toThrow(/GROQ_TIMEOUT_MS/);

    // Gemini-only configuration without GROQ_API_KEY still starts cleanly when DB is ready
    await expect(
      verifyWorkerStartupDependencies({
        env: {
          NODE_ENV: 'production',
          EMAIL_OUTBOX_IDEMPOTENCY_SECRET: 'a'.repeat(64),
          EMAIL_OUTBOX_ENCRYPTION_KEY: 'b'.repeat(64),
          SMTP_HOST: 'smtp.example.internal',
          AI_PROVIDER_ORDER: 'gemini,groq',
          GROQ_MODEL: 'openai/gpt-oss-120b',
          GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
        } as NodeJS.ProcessEnv,
        checkDatabase: async () => undefined,
        verifyStorage: () => undefined,
      }),
    ).resolves.toEqual({
      emailCryptoInitialized: true,
      storageConfigured: true,
      databaseConnected: true,
    });
  });

  it('refreshes heartbeat periodically only while ready and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const filePath = trackFile();
      let state = validReadyState({
        status: 'starting',
        pollCount: 0,
        lastHeartbeatAt: '2026-11-10T00:00:00.000Z',
      });
      writeWorkerReadinessState(filePath, state);

      let tickMs = Date.parse('2026-11-10T00:00:10.000Z');
      const refresher = startWorkerHeartbeatRefresher({
        filePath,
        intervalMs: 10_000,
        getState: () => state,
        now: () => new Date(tickMs),
        onStateUpdated: (next) => {
          state = next;
        },
      });

      // Does not refresh while starting
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.lastHeartbeatAt).toBe('2026-11-10T00:00:00.000Z');

      // Refreshes while ready with fresh poll
      state = {
        ...state,
        status: 'ready',
        pollCount: 1,
        fatalError: null,
      };
      tickMs = Date.parse('2026-11-10T00:00:25.000Z');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.lastHeartbeatAt).toBe('2026-11-10T00:00:25.000Z');

      const diskPayload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkerReadinessState;
      expect(diskPayload.lastHeartbeatAt).toBe('2026-11-10T00:00:25.000Z');

      // Does not overwrite unhealthy/fatal states
      state = {
        ...state,
        status: 'unhealthy',
        fatalError: 'Connection lost',
      };
      tickMs = Date.parse('2026-11-10T00:00:40.000Z');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.lastHeartbeatAt).toBe('2026-11-10T00:00:25.000Z');

      // Stops cleanly and ignores further ticks
      state = {
        ...state,
        status: 'ready',
        fatalError: null,
      };
      refresher.stop();
      tickMs = Date.parse('2026-11-10T00:00:55.000Z');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.lastHeartbeatAt).toBe('2026-11-10T00:00:25.000Z');
      expect(refresher.tick()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
