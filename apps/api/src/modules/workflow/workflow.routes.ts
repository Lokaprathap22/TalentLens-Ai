import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import { createRequireClientMembership } from '../../middleware/require-client-membership.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import {
  candidateTimelineQuerySchema,
  listCandidatesQuerySchema,
  proposeAlternativeInterviewSchema,
  proposeInterviewSchema,
  recordReviewSchema,
  rejectInterviewProposalSchema,
  shortlistCandidateSchema,
  submitCandidateSchema,
  clientFeedbackSchema,
} from './workflow.schemas.js';
import {
  WorkflowCandidateNotFoundError,
  WorkflowClientUnauthorizedError,
  WorkflowConsentMissingClientSharingError,
  WorkflowConsentRequiredError,
  WorkflowDuplicateSubmissionError,
  WorkflowInterviewNotFoundError,
  WorkflowInterviewStateError,
  WorkflowProhibitedFeedbackError,
  WorkflowRequisitionAccessDeniedError,
  WorkflowRequisitionStatusError,
  WorkflowResumeNotInspectedError,
  WorkflowShortlistRequiredError,
  WorkflowSubmissionNotFoundError,
  WorkflowSubmissionStateError,
  type WorkflowService,
} from './workflow.service.js';

const uuidSchema = z.string().uuid();

export interface WorkflowRouterDependencies {
  service: WorkflowService;
  sessionService: Pick<SessionService, 'validateSession'>;
  authorizationService: Pick<AuthorizationService, 'authorizeClientMembership'>;
  applicationOrigin: string;
  isProduction: boolean;
}

function parseUuid(value: string | string[] | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function handleWorkflowError(error: unknown, response: Response): void {
  if (
    error instanceof WorkflowCandidateNotFoundError ||
    error instanceof WorkflowSubmissionNotFoundError ||
    error instanceof WorkflowInterviewNotFoundError
  ) {
    response.status(404).json({ error: 'not_found', message: error.message });
  } else if (
    error instanceof WorkflowRequisitionAccessDeniedError ||
    error instanceof WorkflowClientUnauthorizedError
  ) {
    response.status(403).json({ error: 'forbidden', message: error.message });
  } else if (
    error instanceof WorkflowRequisitionStatusError ||
    error instanceof WorkflowResumeNotInspectedError ||
    error instanceof WorkflowConsentRequiredError ||
    error instanceof WorkflowConsentMissingClientSharingError ||
    error instanceof WorkflowShortlistRequiredError ||
    error instanceof WorkflowDuplicateSubmissionError ||
    error instanceof WorkflowSubmissionStateError ||
    error instanceof WorkflowInterviewStateError ||
    error instanceof WorkflowProhibitedFeedbackError
  ) {
    response.status(400).json({ error: 'invalid_request', message: error.message });
  } else {
    response.status(503).json({ error: 'service_unavailable' });
  }
}

export function createWorkflowRouter(dependencies: WorkflowRouterDependencies): Router {
  const router = express.Router();

  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });

  const requireRecruiter = createRequireRole(['RECRUITER']);
  const requireClientHiringManager = createRequireRole(['CLIENT_HIRING_MANAGER']);
  const requireRecruiterOrClientHiringManager = createRequireRole([
    'RECRUITER',
    'CLIENT_HIRING_MANAGER',
  ]);
  const requireClientMembership = createRequireClientMembership({
    authorizationService: dependencies.authorizationService,
    clientParam: 'clientId',
  });
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);

  // ==========================================
  // SHARED DISCOVERY ROUTES
  // ==========================================

  // 0. List authorized clients for the authenticated principal
  router.get(
    '/clients',
    requireSession,
    requireRecruiterOrClientHiringManager,
    async (_request, response) => {
      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const clients = await dependencies.service.listAuthorizedClients(principal);
        response.status(200).json({ clients });
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // ==========================================
  // RECRUITER ROUTES
  // ==========================================

  // 1. List candidates for review under a requisition
  router.get(
    '/requisitions/:requisitionId/candidates',
    requireSession,
    requireRecruiter,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      if (!requisitionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid requisition ID' });
        return;
      }

      const queryParsed = listCandidatesQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: queryParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.listCandidatesForRequisition(
          principal,
          requisitionId,
          queryParsed.data,
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 2. Candidate review detail
  router.get(
    '/requisitions/:requisitionId/candidates/:candidateId',
    requireSession,
    requireRecruiter,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const detail = await dependencies.service.getCandidateDetail(
          principal,
          requisitionId,
          candidateId,
        );
        response.status(200).json(detail);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 2b. Candidate pipeline timeline for a requisition
  router.get(
    '/requisitions/:requisitionId/candidates/:candidateId/timeline',
    requireSession,
    requireRecruiter,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const queryParsed = candidateTimelineQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: queryParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const timeline = await dependencies.service.getCandidateTimeline(
          principal,
          requisitionId,
          candidateId,
          queryParsed.data,
        );
        response.status(200).json(timeline);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 3. Record recruiter review
  router.post(
    '/requisitions/:requisitionId/candidates/:candidateId/reviews',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = recordReviewSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const review = await dependencies.service.recordCandidateReview(
          principal,
          requisitionId,
          candidateId,
          bodyParsed.data.decision,
          bodyParsed.data.notesInternal,
        );
        response.status(200).json(review);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 4. Record shortlist decision
  router.post(
    '/requisitions/:requisitionId/candidates/:candidateId/shortlist',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = shortlistCandidateSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const review = await dependencies.service.recordShortlist(
          principal,
          requisitionId,
          candidateId,
          bodyParsed.data.notesInternal,
        );
        response.status(200).json(review);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 5. Submit candidate to hiring client
  router.post(
    '/requisitions/:requisitionId/candidates/:candidateId/submissions',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = submitCandidateSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const submission = await dependencies.service.submitCandidateToClient(
          principal,
          requisitionId,
          candidateId,
        );
        response.status(201).json(submission);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 6. List submissions for a requisition
  router.get(
    '/requisitions/:requisitionId/submissions',
    requireSession,
    requireRecruiter,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      if (!requisitionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid requisition ID' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const submissions = await dependencies.service.listSubmissionsForRequisition(
          principal,
          requisitionId,
        );
        response.status(200).json({ submissions });
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 7. Get submission detail for recruiter
  router.get(
    '/requisitions/:requisitionId/submissions/:submissionId',
    requireSession,
    requireRecruiter,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const submissionId = parseUuid(request.params['submissionId']);
      if (!requisitionId || !submissionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const submission = await dependencies.service.getSubmissionForRequisition(
          principal,
          requisitionId,
          submissionId,
        );
        response.status(200).json(submission);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 8. Accept client interview proposal
  router.post(
    '/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/accept',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const submissionId = parseUuid(request.params['submissionId']);
      const decisionId = parseUuid(request.params['decisionId']);
      if (!requisitionId || !submissionId || !decisionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.respondToInterview(
          principal,
          requisitionId,
          submissionId,
          decisionId,
          'ACCEPT',
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 9. Reject client interview proposal
  router.post(
    '/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/reject',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const submissionId = parseUuid(request.params['submissionId']);
      const decisionId = parseUuid(request.params['decisionId']);
      if (!requisitionId || !submissionId || !decisionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = rejectInterviewProposalSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.respondToInterview(
          principal,
          requisitionId,
          submissionId,
          decisionId,
          'REJECT',
          { reason: bodyParsed.data.reason },
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 10. Propose alternative interview time
  router.post(
    '/requisitions/:requisitionId/submissions/:submissionId/interviews/propose',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const submissionId = parseUuid(request.params['submissionId']);
      if (!requisitionId || !submissionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = proposeAlternativeInterviewSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.respondToInterview(
          principal,
          requisitionId,
          submissionId,
          bodyParsed.data.proposalId ?? '',
          'PROPOSE_ALTERNATIVE',
          {
            startAt: bodyParsed.data.startAt,
            endAt: bodyParsed.data.endAt,
            proposedAt: bodyParsed.data.proposedAt ?? bodyParsed.data.startAt,
            timezone: bodyParsed.data.timezone,
            format: bodyParsed.data.format,
            reason: bodyParsed.data.reason,
          },
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 11. Complete interview
  router.post(
    '/requisitions/:requisitionId/submissions/:submissionId/interviews/:decisionId/complete',
    requireSession,
    requireRecruiter,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const submissionId = parseUuid(request.params['submissionId']);
      const decisionId = parseUuid(request.params['decisionId']);
      if (!requisitionId || !submissionId || !decisionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.respondToInterview(
          principal,
          requisitionId,
          submissionId,
          decisionId,
          'COMPLETE',
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // ==========================================
  // CLIENT ROUTES
  // ==========================================

  // 12. List submissions for client
  router.get(
    '/clients/:clientId/submissions',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      if (!clientId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid client ID' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const submissions = await dependencies.service.listSubmissionsForClient(
          principal,
          clientId,
        );
        response.status(200).json({ submissions });
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 13. Get masked submission detail for client
  router.get(
    '/clients/:clientId/submissions/:submissionId',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      const submissionId = parseUuid(request.params['submissionId']);
      if (!clientId || !submissionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const submission = await dependencies.service.getSubmissionForClient(
          principal,
          clientId,
          submissionId,
        );
        response.status(200).json(submission);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 14. Record client feedback (shortlist or decline)
  router.post(
    '/clients/:clientId/submissions/:submissionId/feedback',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      const submissionId = parseUuid(request.params['submissionId']);
      if (!clientId || !submissionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = clientFeedbackSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const membershipContext = response.locals['authorizationContext'] as {
          membershipId: string;
        };

        const result = await dependencies.service.recordClientFeedback(
          principal,
          clientId,
          membershipContext.membershipId,
          submissionId,
          bodyParsed.data.decision,
          bodyParsed.data.reason,
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 15. Client propose interview
  router.post(
    '/clients/:clientId/submissions/:submissionId/interviews',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      const submissionId = parseUuid(request.params['submissionId']);
      if (!clientId || !submissionId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = proposeInterviewSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const membershipContext = response.locals['authorizationContext'] as {
          membershipId: string;
        };

        const startAt = bodyParsed.data.startAt ?? bodyParsed.data.proposedAt!;
        const result = await dependencies.service.recordClientInterviewProposal(
          principal,
          clientId,
          membershipContext.membershipId,
          submissionId,
          startAt,
          bodyParsed.data.timezone,
          bodyParsed.data.reason,
          bodyParsed.data.endAt,
          bodyParsed.data.format,
        );
        response.status(201).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 16. Client accept interview proposal
  router.post(
    '/clients/:clientId/submissions/:submissionId/interviews/:proposalId/accept',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      const submissionId = parseUuid(request.params['submissionId']);
      const proposalId = parseUuid(request.params['proposalId']);
      if (!clientId || !submissionId || !proposalId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const membershipContext = response.locals['authorizationContext'] as {
          membershipId: string;
        };

        const result = await dependencies.service.respondToInterviewAsClient(
          principal,
          clientId,
          membershipContext.membershipId,
          submissionId,
          proposalId,
          'ACCEPT',
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  // 17. Client reject interview proposal
  router.post(
    '/clients/:clientId/submissions/:submissionId/interviews/:proposalId/reject',
    requireSession,
    requireClientHiringManager,
    requireClientMembership,
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const clientId = parseUuid(request.params['clientId']);
      const submissionId = parseUuid(request.params['submissionId']);
      const proposalId = parseUuid(request.params['proposalId']);
      if (!clientId || !submissionId || !proposalId) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid ID parameters' });
        return;
      }

      const bodyParsed = rejectInterviewProposalSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        response.status(400).json({ error: 'invalid_request', details: bodyParsed.error.issues });
        return;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const membershipContext = response.locals['authorizationContext'] as {
          membershipId: string;
        };

        const result = await dependencies.service.respondToInterviewAsClient(
          principal,
          clientId,
          membershipContext.membershipId,
          submissionId,
          proposalId,
          'REJECT',
          bodyParsed.data.reason,
        );
        response.status(200).json(result);
      } catch (error) {
        handleWorkflowError(error, response);
      }
    },
  );

  return router;
}
