import { describe, expect, it } from 'vitest';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createRequisitionRouter } from './modules/requisitions/requisition.routes.js';
import { createScorecardRouter } from './modules/scorecards/scorecard.routes.js';
import { createResumeRouter } from './modules/resumes/resume.routes.js';
import { createConsentRouter } from './modules/consent/consent.routes.js';
import { createAssessmentRouter } from './modules/assessments/assessment.routes.js';
import { createWorkflowRouter } from './modules/workflow/workflow.routes.js';

interface ExpressLayer {
  route?: {
    methods: Record<string, boolean>;
    path: string | string[];
  };
}

interface RouterWithStack {
  stack: ExpressLayer[];
}

const mockService = new Proxy({}, { get: () => () => ({}) }) as never;

describe('API Endpoint Inventory Verification', () => {
  it('enumerates all registered Express endpoints under /api/v1', () => {
    const routers = [
      {
        prefix: '/api/v1/auth',
        r: createAuthRouter({
          authService: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1/requisitions',
        r: createRequisitionRouter({
          service: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1/requisitions',
        r: createScorecardRouter({
          service: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1/requisitions',
        r: createResumeRouter({
          service: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1',
        r: createConsentRouter({
          consentService: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1',
        r: createAssessmentRouter({
          service: mockService,
          sessionService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
      {
        prefix: '/api/v1',
        r: createWorkflowRouter({
          service: mockService,
          sessionService: mockService,
          authorizationService: mockService,
          applicationOrigin: 'http://localhost:5173',
          isProduction: false,
        }),
      },
    ];

    const enumeratedEndpoints: { method: string; path: string; router: string }[] = [];

    for (const { prefix, r } of routers) {
      const routerStack = (r as unknown as RouterWithStack).stack;
      for (const layer of routerStack) {
        const route = layer.route;
        if (route) {
          const methods = Object.keys(route.methods)
            .filter((m) => route.methods[m])
            .map((m) => m.toUpperCase());
          const routePath = Array.isArray(route.path) ? route.path : [route.path];
          for (const p of routePath) {
            for (const m of methods) {
              enumeratedEndpoints.push({
                method: m,
                path: `${prefix}${p}`.replace(/\/+/g, '/').replace(/\/$/, ''),
                router: prefix,
              });
            }
          }
        }
      }
    }

    // Add root /api/v1 health endpoints registered directly on app
    enumeratedEndpoints.push(
      { method: 'GET', path: '/api/v1/health', router: 'app' },
      { method: 'GET', path: '/api/v1/health/ready', router: 'app' },
    );

    console.log(`\n========================================`);
    console.log(`TOTAL REGISTERED /api/v1 ENDPOINTS: ${enumeratedEndpoints.length}`);
    console.log(`========================================`);
    enumeratedEndpoints
      .sort((a, b) =>
        a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
      )
      .forEach((e, idx) => console.log(`${idx + 1}. [${e.method}] ${e.path}`));
    console.log(`========================================\n`);

    const uniqueSet = new Set(enumeratedEndpoints.map((e) => `${e.method} ${e.path}`));
    console.log(`DISTINCT METHOD+PATH COUNT: ${uniqueSet.size}`);

    expect(enumeratedEndpoints.length).toBe(71);
    expect(uniqueSet.size).toBe(71);
  });
});
