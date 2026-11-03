import express, { type Express } from 'express';
import helmet from 'helmet';

import { healthResponseSchema } from '@talentlens/shared';

import { createDatabaseHealthChecker, type DatabaseHealthChecker } from './database/readiness.js';
import { createAuthRouter, type AuthRouterDependencies } from './modules/auth/auth.routes.js';

export interface AppDependencies {
  databaseHealthChecker?: DatabaseHealthChecker;
  auth?: AuthRouterDependencies;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  const databaseHealthChecker = dependencies.databaseHealthChecker ?? createDatabaseHealthChecker();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  if (dependencies.auth) {
    app.use('/api/v1/auth', createAuthRouter(dependencies.auth));
  }

  app.get('/api/v1/health', (_request, response) => {
    const payload = healthResponseSchema.parse({
      status: 'ok',
      service: 'talentlens-api',
      timestamp: new Date().toISOString(),
    });

    response.json(payload);
  });

  app.get('/api/v1/health/ready', async (_request, response) => {
    try {
      await databaseHealthChecker();
      response.status(200).json({
        status: 'ready',
        database: 'connected',
      });
    } catch {
      response.status(503).json({
        status: 'not_ready',
        database: 'unavailable',
      });
    }
  });

  return app;
}
