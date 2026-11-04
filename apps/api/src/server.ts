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
import { createRequisitionRepository } from './modules/requisitions/requisition.repository.js';
import { createRequisitionService } from './modules/requisitions/requisition.service.js';
import { createOpenAiCompatibleProvider } from './modules/scorecards/jd-extraction.provider.js';
import { createScorecardRepository } from './modules/scorecards/scorecard.repository.js';
import { createScorecardService } from './modules/scorecards/scorecard.service.js';
import { createResumeRepository } from './modules/resumes/resume.repository.js';
import { createResumeService } from './modules/resumes/resume.service.js';
import { createConsentRepository } from './modules/consent/consent.repository.js';
import { createConsentService } from './modules/consent/consent.service.js';
import { DefaultEmailDeliveryService } from './modules/consent/consent.email.js';
import { createAssessmentRepository } from './modules/assessments/assessment.repository.js';
import { createAssessmentService } from './modules/assessments/assessment.service.js';
import { createWorkflowRepository } from './modules/workflow/workflow.repository.js';
import { createWorkflowService } from './modules/workflow/workflow.service.js';
import { createAuthorizationService } from './modules/authorization/authorization.service.js';

const environment = loadEnvironment();
let sessionService: SessionService | undefined;
let sessionRepository: SessionRepository | undefined;
let authRepository: AuthRepository | undefined;
let requisitionRepository: ReturnType<typeof createRequisitionRepository> | undefined;
let requisitionService: ReturnType<typeof createRequisitionService> | undefined;
let scorecardRepository: ReturnType<typeof createScorecardRepository> | undefined;
let scorecardService: ReturnType<typeof createScorecardService> | undefined;
let resumeRepository: ReturnType<typeof createResumeRepository> | undefined;
let resumeService: ReturnType<typeof createResumeService> | undefined;
let consentRepository: ReturnType<typeof createConsentRepository> | undefined;
let consentService: ReturnType<typeof createConsentService> | undefined;
let assessmentRepository: ReturnType<typeof createAssessmentRepository> | undefined;
let assessmentService: ReturnType<typeof createAssessmentService> | undefined;
let workflowRepository: ReturnType<typeof createWorkflowRepository> | undefined;
let workflowService: ReturnType<typeof createWorkflowService> | undefined;
let authorizationService: ReturnType<typeof createAuthorizationService> | undefined;
const emailDeliveryService = new DefaultEmailDeliveryService();
const extractionProvider = createOpenAiCompatibleProvider({
  apiKey: environment.aiApiKey,
  baseUrl: environment.aiBaseUrl,
  model: environment.aiModel,
  timeoutMs: environment.aiTimeoutMs,
});
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

function getRequisitionService(): ReturnType<typeof createRequisitionService> {
  requisitionRepository ??= createRequisitionRepository();
  requisitionService ??= createRequisitionService({
    repository: requisitionRepository,
  });
  return requisitionService;
}

function getScorecardService(): ReturnType<typeof createScorecardService> {
  scorecardRepository ??= createScorecardRepository();
  scorecardService ??= createScorecardService({
    repository: scorecardRepository,
    extractionProvider,
  });
  return scorecardService;
}

function getResumeService(): ReturnType<typeof createResumeService> {
  resumeRepository ??= createResumeRepository();
  resumeService ??= createResumeService({
    repository: resumeRepository,
  });
  return resumeService;
}

function getConsentService(): ReturnType<typeof createConsentService> {
  consentRepository ??= createConsentRepository();
  consentService ??= createConsentService({
    repository: consentRepository,
    emailDeliveryService,
    applicationOrigin: environment.appOrigin,
    approvedPolicies: environment.approvedPolicies,
  });
  return consentService;
}

function getAssessmentService(): ReturnType<typeof createAssessmentService> {
  assessmentRepository ??= createAssessmentRepository();
  assessmentService ??= createAssessmentService(assessmentRepository);
  return assessmentService;
}

function getWorkflowService(): ReturnType<typeof createWorkflowService> {
  workflowRepository ??= createWorkflowRepository();
  workflowService ??= createWorkflowService(workflowRepository);
  return workflowService;
}

function getAuthorizationService(): ReturnType<typeof createAuthorizationService> {
  authorizationService ??= createAuthorizationService();
  return authorizationService;
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
    requisitions: {
      service: {
        create: (...args) => getRequisitionService().create(...args),
        list: (...args) => getRequisitionService().list(...args),
        get: (...args) => getRequisitionService().get(...args),
        update: (...args) => getRequisitionService().update(...args),
      },
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
    scorecards: {
      service: {
        generate: (...args) => getScorecardService().generate(...args),
        list: (...args) => getScorecardService().list(...args),
        get: (...args) => getScorecardService().get(...args),
        update: (...args) => getScorecardService().update(...args),
        approve: (...args) => getScorecardService().approve(...args),
      },
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
    resumes: {
      service: {
        uploadResumes: (...args) => getResumeService().uploadResumes(...args),
        listResumes: (...args) => getResumeService().listResumes(...args),
        getResumeDetails: (...args) => getResumeService().getResumeDetails(...args),
        getExtraction: (...args) => getResumeService().getExtraction(...args),
        getResumeFile: (...args) => getResumeService().getResumeFile(...args),
        releaseHeldProcessingJobs: (...args) =>
          getResumeService().releaseHeldProcessingJobs(...args),
        reuseCandidateResumeForRequisition: (...args) =>
          getResumeService().reuseCandidateResumeForRequisition(...args),
      },
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
    consent: {
      consentService: {
        createInvitation: (...args) => getConsentService().createInvitation(...args),
        inspectNotice: (...args) => getConsentService().inspectNotice(...args),
        acceptConsent: (...args) => getConsentService().acceptConsent(...args),
        declineConsent: (...args) => getConsentService().declineConsent(...args),
        requestWithdrawal: (...args) => getConsentService().requestWithdrawal(...args),
        confirmWithdrawal: (...args) => getConsentService().confirmWithdrawal(...args),
      },
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
    assessments: {
      service: {
        enqueue: (...args) => getAssessmentService().enqueue(...args),
        getById: (...args) => getAssessmentService().getById(...args),
        list: (...args) => getAssessmentService().list(...args),
      },
      sessionService: lazySessionService,
      applicationOrigin: environment.appOrigin,
      isProduction: environment.nodeEnv === 'production',
    },
    workflow: {
      service: {
        listCandidatesForRequisition: (...args) =>
          getWorkflowService().listCandidatesForRequisition(...args),
        getCandidateDetail: (...args) => getWorkflowService().getCandidateDetail(...args),
        recordCandidateReview: (...args) => getWorkflowService().recordCandidateReview(...args),
        recordShortlist: (...args) => getWorkflowService().recordShortlist(...args),
        submitCandidateToClient: (...args) => getWorkflowService().submitCandidateToClient(...args),
        listSubmissionsForRequisition: (...args) =>
          getWorkflowService().listSubmissionsForRequisition(...args),
        getSubmissionForRequisition: (...args) =>
          getWorkflowService().getSubmissionForRequisition(...args),
        listSubmissionsForClient: (...args) =>
          getWorkflowService().listSubmissionsForClient(...args),
        getSubmissionForClient: (...args) => getWorkflowService().getSubmissionForClient(...args),
        recordClientFeedback: (...args) => getWorkflowService().recordClientFeedback(...args),
        recordClientInterviewProposal: (...args) =>
          getWorkflowService().recordClientInterviewProposal(...args),
        respondToInterview: (...args) => getWorkflowService().respondToInterview(...args),
        respondToInterviewAsClient: (...args) =>
          getWorkflowService().respondToInterviewAsClient(...args),
        listAuthorizedClients: (...args) => getWorkflowService().listAuthorizedClients(...args),
        getCandidateTimeline: (...args) => getWorkflowService().getCandidateTimeline(...args),
      },
      sessionService: lazySessionService,
      authorizationService: {
        authorizeClientMembership: (...args) =>
          getAuthorizationService().authorizeClientMembership(...args),
      },
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
