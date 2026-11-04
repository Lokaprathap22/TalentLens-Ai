import type { ProcessingJobStatus } from '@talentlens/database';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import { validateScorecardCriterionWeights } from './assessment.scoring.js';
import type { AssessmentJobDto, CandidateAssessmentDto } from './assessment.types.js';
import type { AssessmentRepository } from './assessment.repository.js';

export class AssessmentRequisitionAccessDeniedError extends Error {
  constructor(message = 'Recruiter does not have access to this requisition') {
    super(message);
    this.name = 'AssessmentRequisitionAccessDeniedError';
  }
}

export class AssessmentScorecardNotApprovedError extends Error {
  constructor(message = 'Requisition does not have an approved scorecard version') {
    super(message);
    this.name = 'AssessmentScorecardNotApprovedError';
  }
}

export class AssessmentResumeUnavailableError extends Error {
  constructor(message = 'Resume extraction is not complete or usable') {
    super(message);
    this.name = 'AssessmentResumeUnavailableError';
  }
}

export class AssessmentConsentRequiredError extends Error {
  constructor(
    message = 'Candidate consent for hiring use is missing or not active for this requisition',
  ) {
    super(message);
    this.name = 'AssessmentConsentRequiredError';
  }
}

export class AssessmentScorecardInvalidWeightsError extends Error {
  constructor(
    message = 'Approved scorecard has invalid criterion weights (weights must be finite and strictly positive)',
  ) {
    super(message);
    this.name = 'AssessmentScorecardInvalidWeightsError';
  }
}

export class AssessmentNotFoundError extends Error {
  constructor(message = 'Assessment not found') {
    super(message);
    this.name = 'AssessmentNotFoundError';
  }
}

export interface AssessmentEnqueueResult {
  job: AssessmentJobDto | null;
  assessment: CandidateAssessmentDto | null;
  isExisting: boolean;
}

export interface AssessmentService {
  enqueue(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    resumeDocumentId: string,
  ): Promise<AssessmentEnqueueResult>;

  getById(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    assessmentId: string,
  ): Promise<CandidateAssessmentDto>;

  list(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    resumeDocumentId?: string | undefined,
  ): Promise<CandidateAssessmentDto[]>;
}

export function createAssessmentService(repository: AssessmentRepository): AssessmentService {
  return {
    async enqueue(principal, requisitionId, resumeDocumentId) {
      if (principal.role !== 'RECRUITER') {
        throw new AssessmentRequisitionAccessDeniedError(
          'Only recruiters can request candidate assessments',
        );
      }

      // 1. Authorize context: requisition assignment, resume parse status, approved scorecard, candidate consent
      const context = await repository.findAuthorizedContext(
        principal,
        requisitionId,
        resumeDocumentId,
      );

      if (!context) {
        // Detailed check to throw accurate semantic error
        throw new AssessmentConsentRequiredError(
          'Assessment cannot be enqueued: verify requisition assignment, approved scorecard, parsed resume, and active consent.',
        );
      }

      // Validate approved scorecard criterion weights before enqueueing
      const weightValidation = validateScorecardCriterionWeights(context.criteria);
      if (!weightValidation.valid) {
        throw new AssessmentScorecardInvalidWeightsError(weightValidation.reason);
      }

      // 2. Idempotency Check: Already completed assessment for this exact scorecard version?
      const existingAssessment = await repository.findExistingAssessment(
        principal.organizationId,
        requisitionId,
        context.candidateId,
        resumeDocumentId,
        context.scorecardVersionId,
      );

      if (existingAssessment) {
        return {
          job: null,
          assessment: existingAssessment,
          isExisting: true,
        };
      }

      // 3. Idempotency Check: Already queued/processing job?
      const existingJob = await repository.findActiveJob(
        principal.organizationId,
        requisitionId,
        resumeDocumentId,
      );

      if (existingJob) {
        return {
          job: {
            jobId: existingJob.id,
            batchId: '',
            requisitionId,
            candidateId: context.candidateId,
            resumeDocumentId,
            jobType: 'ASSESS_CANDIDATE',
            status: existingJob.status as ProcessingJobStatus,
            attempts: 0,
            lastErrorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          assessment: null,
          isExisting: true,
        };
      }

      // 4. Enqueue new assessment job
      const created = await repository.enqueueAssessmentJob(
        principal,
        requisitionId,
        context.candidateId,
        resumeDocumentId,
      );

      return {
        job: {
          jobId: created.jobId,
          batchId: created.batchId,
          requisitionId,
          candidateId: context.candidateId,
          resumeDocumentId,
          jobType: 'ASSESS_CANDIDATE',
          status: 'QUEUED',
          attempts: 0,
          lastErrorCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        assessment: null,
        isExisting: false,
      };
    },

    async getById(principal, requisitionId, assessmentId) {
      if (principal.role !== 'RECRUITER') {
        throw new AssessmentRequisitionAccessDeniedError();
      }

      const assessment = await repository.getAssessmentById(principal, requisitionId, assessmentId);

      if (!assessment) {
        throw new AssessmentNotFoundError();
      }

      return assessment;
    },

    async list(principal, requisitionId, resumeDocumentId) {
      if (principal.role !== 'RECRUITER') {
        throw new AssessmentRequisitionAccessDeniedError();
      }

      return repository.listAssessments(principal, requisitionId, resumeDocumentId);
    },
  };
}
