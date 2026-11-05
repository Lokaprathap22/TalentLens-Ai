import type { Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type { SessionService } from '../auth/session.service.js';
import {
  RequisitionClientNotFoundError,
  RequisitionNotFoundError,
  RequisitionRoleError,
  RequisitionScorecardNotApprovedError,
  RequisitionStatusTransitionError,
  type RequisitionService,
} from './requisition.service.js';
import {
  createRequisitionSchema,
  transitionRequisitionStatusSchema,
  updateRequisitionSchema,
} from './requisition.schemas.js';

const requisitionIdSchema = z.string().uuid();

export interface RequisitionRouterDependencies {
  service: RequisitionService;
  sessionService: Pick<SessionService, 'validateSession'>;
  applicationOrigin: string;
  isProduction: boolean;
}

export function createRequisitionRouter(dependencies: RequisitionRouterDependencies): Router {
  const router = express.Router();
  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });
  const requireRecruiter = createRequireRole(['RECRUITER']);
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);

  router.use(requireSession, requireRecruiter);

  router.post('/', sameOrigin, requireCsrf, async (request, response) => {
    const parsed = createRequisitionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      const requisition = await dependencies.service.create(principal, parsed.data);
      response.status(201).json({ requisition });
    } catch (error) {
      if (error instanceof RequisitionClientNotFoundError) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      if (error instanceof RequisitionRoleError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      response.status(503).json({ error: 'service_unavailable' });
    }
  });

  router.get('/', async (_request, response) => {
    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      const requisitions = await dependencies.service.list(principal);
      response.status(200).json({ requisitions });
    } catch (error) {
      if (error instanceof RequisitionRoleError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      response.status(503).json({ error: 'service_unavailable' });
    }
  });

  router.get('/:id', async (request, response) => {
    const parsedId = requisitionIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const requisitionId = parsedId.data;

    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      const requisition = await dependencies.service.get(principal, requisitionId);
      response.status(200).json({ requisition });
    } catch (error) {
      if (error instanceof RequisitionNotFoundError) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      if (error instanceof RequisitionRoleError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      response.status(503).json({ error: 'service_unavailable' });
    }
  });

  router.patch('/:id', sameOrigin, requireCsrf, async (request, response) => {
    const parsedId = requisitionIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const requisitionId = parsedId.data;

    const parsed = updateRequisitionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      const requisition = await dependencies.service.update(principal, requisitionId, parsed.data);
      response.status(200).json({ requisition });
    } catch (error) {
      if (
        error instanceof RequisitionNotFoundError ||
        error instanceof RequisitionClientNotFoundError
      ) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      if (error instanceof RequisitionRoleError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      response.status(503).json({ error: 'service_unavailable' });
    }
  });

  router.post('/:id/status', sameOrigin, requireCsrf, async (request, response) => {
    const parsedId = requisitionIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    const requisitionId = parsedId.data;

    const parsed = transitionRequisitionStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals.authPrincipal as AuthenticatedPrincipal;
      const requisition = await dependencies.service.transitionStatus(
        principal,
        requisitionId,
        parsed.data,
      );
      response.status(200).json({ requisition });
    } catch (error) {
      if (error instanceof RequisitionNotFoundError) {
        response.status(404).json({ error: 'not_found' });
        return;
      }
      if (error instanceof RequisitionRoleError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      if (
        error instanceof RequisitionStatusTransitionError ||
        error instanceof RequisitionScorecardNotApprovedError
      ) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      response.status(503).json({ error: 'service_unavailable' });
    }
  });

  return router;
}
