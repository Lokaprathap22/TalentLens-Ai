import 'dotenv/config';
import { disconnectDatabase, getDatabaseClient } from '@talentlens/database';
import { evaluateWorkerReadiness, getWorkerReadinessFilePath } from './readiness.js';

async function main(): Promise<void> {
  const filePath = getWorkerReadinessFilePath(process.env);
  try {
    const result = await evaluateWorkerReadiness({
      filePath,
      env: process.env,
      checkDatabase: async () => {
        const db = getDatabaseClient();
        await db.$queryRawUnsafe('SELECT 1');
      },
    });

    if (!result.healthy) {
      console.error(`[WORKER HEALTHCHECK FAIL] ${result.reason ?? 'Worker is not ready'}`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  } finally {
    await disconnectDatabase();
  }
}

void main().catch((err) => {
  console.error(`[WORKER HEALTHCHECK ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
