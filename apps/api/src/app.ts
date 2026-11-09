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

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let res = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    res = (res << 8) | n;
  }
  return res >>> 0;
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split('/');
  if (!rangeIp) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangeIp);
  if (ipInt === null || rangeInt === null) return false;

  if (prefixStr === undefined) {
    return ipInt === rangeInt;
  }

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isIpInTrustedList(addr: string, trustedList: string[]): boolean {
  const cleanAddr = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  for (const entry of trustedList) {
    const cleanEntry = entry.startsWith('::ffff:') ? entry.slice(7) : entry;
    if (cleanAddr === cleanEntry) return true;
    if (cleanEntry.includes('/')) {
      if (matchIpv4Cidr(cleanAddr, cleanEntry)) return true;
    }
  }
  return false;
}

export function createTrustProxyEvaluator(
  trustedIps?: readonly string[] | string[],
  maxHops = 2,
): (addr: string, distance: number) => boolean {
  const isLoopback = (addr: string) => {
    const clean = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return clean === '127.0.0.1' || clean === '::1' || clean.startsWith('127.');
  };
  const trustedList = trustedIps?.map((ip) => ip.trim()).filter(Boolean) ?? [];

  return (addr: string, distance: number) => {
    if (distance >= maxHops) {
      return false;
    }
    if (trustedList.length > 0) {
      return isLoopback(addr) || isIpInTrustedList(addr, trustedList);
    }
    return distance === 0;
  };
}

export interface AppDependencies {
  databaseHealthChecker?: DatabaseHealthChecker;
  auth?: AuthRouterDependencies;
  requisitions?: RequisitionRouterDependencies;
  scorecards?: ScorecardRouterDependencies;
  resumes?: ResumeRouterDependencies;
  consent?: ConsentRouterDependencies;
  assessments?: AssessmentRouterDependencies;
  workflow?: WorkflowRouterDependencies;
  trustProxy?: boolean | number | string | ((addr: string, i: number) => boolean) | undefined;
  trustedProxyIps?: string[] | undefined;
  maxProxyHops?: number | undefined;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  const databaseHealthChecker = dependencies.databaseHealthChecker ?? createDatabaseHealthChecker();

  app.disable('x-powered-by');
  const trustProxySetting =
    dependencies.trustProxy !== undefined
      ? dependencies.trustProxy
      : dependencies.trustedProxyIps && dependencies.trustedProxyIps.length > 0
        ? createTrustProxyEvaluator(dependencies.trustedProxyIps, dependencies.maxProxyHops ?? 2)
        : 1;
  app.set('trust proxy', trustProxySetting);
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

  app.get(['/api/v1/health', '/api/health'], (_request, response) => {
    const payload = healthResponseSchema.parse({
      status: 'ok',
      service: 'talentlens-api',
      timestamp: new Date().toISOString(),
    });

    response.json(payload);
  });

  app.get(['/api/v1/health/ready', '/api/health/ready'], async (_request, response) => {
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

  // Return clean JSON 404 for unmapped API endpoints
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  // Global error handler: prevent HTML error responses and stack trace leakage
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (
        error instanceof SyntaxError &&
        'status' in error &&
        (error as { status?: number }).status === 400
      ) {
        response.status(400).json({ error: 'invalid_json' });
        return;
      }
      response.status(500).json({ error: 'internal_error' });
    },
  );

  return app;
}
