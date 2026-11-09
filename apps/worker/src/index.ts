import 'dotenv/config';
import { disconnectDatabase, getDatabaseClient } from '@talentlens/database';
import { WorkerJobProcessor } from './processor.js';
import { WorkerEmailDispatcher } from './email-dispatcher.js';
import {
  clearWorkerReadinessState,
  getWorkerReadinessFilePath,
  sanitizeWorkerErrorMessage,
  verifyWorkerStartupDependencies,
  writeWorkerReadinessState,
  type WorkerReadinessState,
} from './readiness.js';

const readinessFilePath = getWorkerReadinessFilePath(process.env);
const startedAt = new Date().toISOString();
let running = true;
let pollTimer: NodeJS.Timeout | null = null;
let pollCount = 0;

let currentState: WorkerReadinessState = {
  status: 'starting',
  pid: process.pid,
  startedAt,
  lastHeartbeatAt: startedAt,
  pollCount: 0,
  databaseConnected: false,
  storageConfigured: false,
  emailCryptoInitialized: false,
  fatalError: null,
};

function persistState(partial: Partial<WorkerReadinessState>): void {
  currentState = {
    ...currentState,
    ...partial,
    lastHeartbeatAt: new Date().toISOString(),
  };
  writeWorkerReadinessState(readinessFilePath, currentState);
}

async function main(): Promise<void> {
  persistState({ status: 'starting' });

  const verified = await verifyWorkerStartupDependencies({
    env: process.env,
    checkDatabase: async () => {
      await getDatabaseClient().$queryRawUnsafe('SELECT 1');
    },
  });

  persistState({
    status: 'starting',
    emailCryptoInitialized: verified.emailCryptoInitialized,
    storageConfigured: verified.storageConfigured,
    databaseConnected: verified.databaseConnected,
  });

  console.log('TalentLens document processing worker started.');

  const processor = new WorkerJobProcessor();
  const emailDispatcher = new WorkerEmailDispatcher();

  while (running) {
    try {
      let processed = true;
      while (processed && running) {
        processed = await processor.processNextJob();
        if (processed && running) {
          pollCount += 1;
          persistState({
            status: 'ready',
            pollCount,
            databaseConnected: true,
            fatalError: null,
          });
        }
      }

      let emailProcessed = true;
      while (emailProcessed && running) {
        emailProcessed = await emailDispatcher.processNextEmail();
        if (emailProcessed && running) {
          pollCount += 1;
          persistState({
            status: 'ready',
            pollCount,
            databaseConnected: true,
            fatalError: null,
          });
        }
      }

      if (running) {
        pollCount += 1;
        persistState({
          status: 'ready',
          pollCount,
          databaseConnected: true,
          fatalError: null,
        });
      }
    } catch (err) {
      const safeMessage = sanitizeWorkerErrorMessage(err);
      console.error('Worker loop encountered an error:', safeMessage);
      persistState({
        status: 'unhealthy',
        databaseConnected: false,
        fatalError: safeMessage,
      });
    }

    if (running) {
      await new Promise((resolve) => {
        pollTimer = setTimeout(resolve, 2000);
      });
    }
  }
}

void main().catch(async (err) => {
  const safeMessage = sanitizeWorkerErrorMessage(err);
  console.error('Worker failed startup initialization:', safeMessage);
  persistState({
    status: 'unhealthy',
    databaseConnected: false,
    fatalError: safeMessage,
  });
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  if (pollTimer) clearTimeout(pollTimer);

  console.log(`Received ${signal}; shutting down worker gracefully...`);
  persistState({ status: 'shutting_down' });
  clearWorkerReadinessState(readinessFilePath);
  await disconnectDatabase();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
