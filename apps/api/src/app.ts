import express, { type Express } from 'express';
import helmet from 'helmet';

import { healthResponseSchema } from '@talentlens/shared';

import { createDatabaseHealthChecker, type DatabaseHealthChecker } from './database/readiness.js';
import { createAuthRouter, type AuthRouterDependencies } from './modules/auth/auth.routes.js';
import {
  createRequisitionRouter,
  type RequisitionRouterDependencies,
} from './modules/requisitions/requisition.routes.js';
import {
  createScorecardRouter,
  type ScorecardRouterDependencies,
} from './modules/scorecards/scorecard.routes.js';
import {
  createResumeRouter,
  type ResumeRouterDependencies,
} from './modules/resumes/resume.routes.js';
import {
  createConsentRouter,
  type ConsentRouterDependencies,
} from './modules/consent/consent.routes.js';
import {
  createAssessmentRouter,
  type AssessmentRouterDependencies,
} from './modules/assessments/assessment.routes.js';
import {
  createWorkflowRouter,
  type WorkflowRouterDependencies,
} from './modules/workflow/workflow.routes.js';

export interface AppDependencies {
  databaseHealthChecker?: DatabaseHealthChecker;
  auth?: AuthRouterDependencies;
  requisitions?: RequisitionRouterDependencies;
  scorecards?: ScorecardRouterDependencies;
  resumes?: ResumeRouterDependencies;
  consent?: ConsentRouterDependencies;
  assessments?: AssessmentRouterDependencies;
  workflow?: WorkflowRouterDependencies;
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
  if (dependencies.requisitions) {
    app.use('/api/v1/requisitions', createRequisitionRouter(dependencies.requisitions));
  }
  if (dependencies.scorecards) {
    app.use('/api/v1/requisitions', createScorecardRouter(dependencies.scorecards));
  }
  if (dependencies.resumes) {
    app.use('/api/v1/requisitions', createResumeRouter(dependencies.resumes));
  }
  if (dependencies.consent) {
    app.use('/api/v1', createConsentRouter(dependencies.consent));
  }
  if (dependencies.assessments) {
    app.use('/api/v1', createAssessmentRouter(dependencies.assessments));
  }
  if (dependencies.workflow) {
    app.use('/api/v1', createWorkflowRouter(dependencies.workflow));
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
