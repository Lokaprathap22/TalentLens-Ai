import express, { type Express } from 'express';
import helmet from 'helmet';

import { healthResponseSchema } from '@talentlens/shared';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/v1/health', (_request, response) => {
    const payload = healthResponseSchema.parse({
      status: 'ok',
      service: 'talentlens-api',
      timestamp: new Date().toISOString(),
    });

    response.json(payload);
  });

  return app;
}
