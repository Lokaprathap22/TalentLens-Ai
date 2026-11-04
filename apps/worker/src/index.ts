import 'dotenv/config';
import { disconnectDatabase } from '@talentlens/database';
import { WorkerJobProcessor } from './processor.js';

console.log('TalentLens document processing worker started.');

const processor = new WorkerJobProcessor();
let running = true;
let pollTimer: NodeJS.Timeout | null = null;

async function runLoop() {
  while (running) {
    try {
      let processed = true;
      while (processed && running) {
        processed = await processor.processNextJob();
      }
    } catch (err) {
      console.error('Worker loop encountered an error:', (err as Error).message);
    }

    if (running) {
      await new Promise((resolve) => {
        pollTimer = setTimeout(resolve, 2000);
      });
    }
  }
}

void runLoop();

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  if (pollTimer) clearTimeout(pollTimer);

  console.log(`Received ${signal}; shutting down worker gracefully...`);
  await disconnectDatabase();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
