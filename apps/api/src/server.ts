import { createServer } from 'node:http';

import { disconnectDatabase } from '@talentlens/database';

import { createApp } from './app.js';
import { loadEnvironment } from './config/env.js';
import { createShutdownHandler } from './lifecycle.js';

const environment = loadEnvironment();
const server = createServer(createApp());

server.listen(environment.apiPort, () => {
  console.log(`TalentLens API listening on http://localhost:${environment.apiPort}`);
});

const shutdown = createShutdownHandler(server, disconnectDatabase);

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
