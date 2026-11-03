import { createServer } from 'node:http';

import { disconnectDatabase } from '@talentlens/database';

import { createApp } from './app.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import type { AuthRepository } from './modules/auth/auth.repository.js';
import type { SessionRepository } from './modules/auth/session.repository.js';
import { createSessionRepository } from './modules/auth/session.repository.js';
import { createSessionService, type SessionService } from './modules/auth/session.service.js';
import { loadEnvironment } from './config/env.js';
import { createShutdownHandler } from './lifecycle.js';

const environment = loadEnvironment();
let sessionService: SessionService | undefined;
let sessionRepository: SessionRepository | undefined;
let authRepository: AuthRepository | undefined;
const lazySessionService: SessionService = {
  createSession: (...args) => {
    sessionService ??= createSessionService({
      repository: getSessionRepository(),
    });
    return sessionService.createSession(...args);
  },
  validateSession: (...args) => {
    sessionService ??= createSessionService({
      repository: getSessionRepository(),
    });
    return sessionService.validateSession(...args);
  },
  revokeSession: (...args) => {
    sessionService ??= createSessionService({
      repository: getSessionRepository(),
    });
    return sessionService.revokeSession(...args);
  },
};
const lazyAuthRepository: AuthRepository = {
  findUserByOrganizationAndEmail: (...args) => {
    authRepository ??= createAuthRepository();
    return authRepository.findUserByOrganizationAndEmail(...args);
  },
};

function getSessionRepository(): SessionRepository {
  sessionRepository ??= createSessionRepository();
  return sessionRepository;
}

const server = createServer(
  createApp({
    auth: {
      authService: createAuthService({
        repository: lazyAuthRepository,
        sessionService: lazySessionService,
      }),
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
  }),
);

server.listen(environment.apiPort, () => {
  console.log(`TalentLens API listening on http://localhost:${environment.apiPort}`);
});

const shutdown = createShutdownHandler(server, disconnectDatabase);

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
