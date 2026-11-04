import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import {
  AssessmentConsentRequiredError,
  AssessmentNotFoundError,
  AssessmentRequisitionAccessDeniedError,
  AssessmentResumeUnavailableError,
  AssessmentScorecardInvalidWeightsError,
  AssessmentScorecardNotApprovedError,
  type AssessmentService,
} from './assessment.service.js';

const uuidSchema = z.string().uuid();

export interface AssessmentRouterDependencies {
  service: AssessmentService;
  sessionService: Pick<SessionService, 'validateSession'>;
  applicationOrigin: string;
  isProduction: boolean;
}

function parseUuid(value: string | string[] | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function handleAssessmentError(error: unknown, response: Response): void {
  if (error instanceof AssessmentNotFoundError) {
    response.status(404).json({ error: 'not_found', message: error.message });
  } else if (error instanceof AssessmentRequisitionAccessDeniedError) {
    response.status(403).json({ error: 'forbidden', message: error.message });
  } else if (
    error instanceof AssessmentScorecardNotApprovedError ||
    error instanceof AssessmentScorecardInvalidWeightsError ||
    error instanceof AssessmentResumeUnavailableError ||
    error instanceof AssessmentConsentRequiredError
  ) {
    response.status(400).json({ error: 'invalid_request', message: error.message });
  } else {
    response.status(503).json({ error: 'service_unavailable' });
  }
}

export function createAssessmentRouter(deps: AssessmentRouterDependencies): Router {
  const router = express.Router();

  const requireSession = createRequireSession({
    sessionService: deps.sessionService,
    isProduction: deps.isProduction,
  });
  const requireRecruiter = createRequireRole(['RECRUITER']);
  const requireSameOrigin = createRequireSameOrigin(deps.applicationOrigin);

  // 1. Enqueue assessment for a specific resume on a requisition
  router.post(
    '/requisitions/:requisitionId/resumes/:resumeId/assessments',
    requireSession,
    requireRecruiter,
    requireSameOrigin,
    requireCsrf,
    async (req, res) => {
      const requisitionId = parseUuid(req.params['requisitionId']);
      const resumeId = parseUuid(req.params['resumeId']);

      if (!requisitionId || !resumeId) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'Invalid requisitionId or resumeId' });
        return;
      }

      const principal = res.locals.authPrincipal as AuthenticatedPrincipal;
      try {
        const result = await deps.service.enqueue(principal, requisitionId, resumeId);
        const statusCode = result.isExisting ? 200 : 202;
        res.status(statusCode).json({
          status: 'success',
          data: result,
        });
      } catch (err) {
        handleAssessmentError(err, res);
      }
    },
  );

  // 2. List assessments for a resume
  router.get(
    '/requisitions/:requisitionId/resumes/:resumeId/assessments',
    requireSession,
    requireRecruiter,
    async (req, res) => {
      const requisitionId = parseUuid(req.params['requisitionId']);
      const resumeId = parseUuid(req.params['resumeId']);

      if (!requisitionId || !resumeId) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'Invalid requisitionId or resumeId' });
        return;
      }

      const principal = res.locals.authPrincipal as AuthenticatedPrincipal;
      try {
        const assessments = await deps.service.list(principal, requisitionId, resumeId);
        res.json({
          status: 'success',
          data: assessments,
        });
      } catch (err) {
        handleAssessmentError(err, res);
      }
    },
  );

  // 3. List all assessments for a requisition
  router.get(
    '/requisitions/:requisitionId/assessments',
    requireSession,
    requireRecruiter,
    async (req, res) => {
      const requisitionId = parseUuid(req.params['requisitionId']);

      if (!requisitionId) {
        res.status(400).json({ error: 'invalid_request', message: 'Invalid requisitionId' });
        return;
      }

      const principal = res.locals.authPrincipal as AuthenticatedPrincipal;
      try {
        const assessments = await deps.service.list(principal, requisitionId);
        res.json({
          status: 'success',
          data: assessments,
        });
      } catch (err) {
        handleAssessmentError(err, res);
      }
    },
  );

  // 4. Retrieve specific assessment details
  router.get(
    '/requisitions/:requisitionId/assessments/:assessmentId',
    requireSession,
    requireRecruiter,
    async (req, res) => {
      const requisitionId = parseUuid(req.params['requisitionId']);
      const assessmentId = parseUuid(req.params['assessmentId']);

      if (!requisitionId || !assessmentId) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'Invalid requisitionId or assessmentId' });
        return;
      }

      const principal = res.locals.authPrincipal as AuthenticatedPrincipal;
      try {
        const assessment = await deps.service.getById(principal, requisitionId, assessmentId);
        res.json({
          status: 'success',
          data: assessment,
        });
      } catch (err) {
        handleAssessmentError(err, res);
      }
    },
  );

  return router;
}
