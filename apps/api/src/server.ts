import { createServer } from 'node:http';

import { createApp } from './app.js';

const port = Number.parseInt(process.env.API_PORT ?? '4000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('API_PORT must be an integer between 1 and 65535');
}

const server = createServer(createApp());

server.listen(port, () => {
  console.log(`TalentLens API listening on http://localhost:${port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down API`);
  server.close((error) => {
    if (error) {
      console.error('API shutdown failed', error);
      process.exitCode = 1;
      return;
    }

    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
