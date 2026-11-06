import { randomUUID } from 'node:crypto';
import {
  getDatabaseClient,
  type ClientDecisionType,
  type InterviewFormat,
  type InterviewProposalStatus,
  type PrismaClient,
  type ResumeParseStatus,
  type ReviewDecision,
  type SubmissionStatus,
  type UserRole,
} from '@talentlens/database';
import { redactCandidateIdentifiers } from '../assessments/assessment.redactor.js';
import { createEmailIdempotencyKey, encryptEmailPayload } from '../email/email.crypto.js';
import {
  renderClientFeedback,
  renderClientSubmission,
  renderInterviewNotification,
} from '../email/email.templates.js';
import { evaluateFeedbackFairness } from './feedback.fairness.js';
import { isValidIanaTimezone } from './workflow.schemas.js';
import {
  WorkflowClientConflictError,
  WorkflowConsentRequiredError,
  WorkflowInterviewNotFoundError,
  WorkflowInterviewStateError,
  WorkflowProhibitedFeedbackError,
  WorkflowRequisitionAccessDeniedError,
  WorkflowShortlistRequiredError,
  WorkflowSubmissionNotFoundError,
  WorkflowSubmissionStateError,
} from './workflow.errors.js';

function normalizeClientDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizeClientLookupName(name: string): string {
  return normalizeClientDisplayName(name).toLocaleLowerCase('en-US');
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export interface WorkflowRepository {
  findAuthorizedRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    clientId: string;
    client: {
      id: string;
      name: string;
      status: string;
    };
  } | null>;

  hasRecruiterInspectedResume(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    resumeDocumentId: string,
  ): Promise<boolean>;

  findActiveConsentForRequisition(
    organizationId: string,
    candidateId: string,
    requisitionId: string,
  ): Promise<{
    id: string;
    status: string;
    policyVersion: string;
    noticeTextHash: string | null;
    capturedAt: Date;
  } | null>;

  listCandidatesForRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    options: {
      limit: number;
      offset: number;
      processingStatus?: string | undefined;
      assessmentStatus?: string | undefined;
      reviewDecision?: string | undefined;
      submissionStatus?: string | undefined;
    },
  ): Promise<{
    items: Array<{
      candidateId: string;
      candidateCode: string;
      resumeDocumentId: string;
      resumeFileName: string;
      parseStatus: string;
      assessment: {
        id: string;
        status: string;
        score: number | null;
        coverage: number;
        formulaVersion: string;
        criteriaCount: number;
        criteriaMetCount: number;
      } | null;
      review: {
        id: string;
        decision: ReviewDecision;
        reviewedAt: Date;
      } | null;
      shortlist?: {
        id: string;
        shortlistedAt: Date;
      } | null;
      submission: {
        id: string;
        status: SubmissionStatus;
        submittedAt: Date;
      } | null;
      lastActivityAt: Date;
    }>;
    total: number;
  }>;

  getCandidateDetail(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    candidateId: string,
  ): Promise<{
    candidate: { id: string; candidateCode: string };
    requisition: {
      id: string;
      title: string;
      client: { id: string; name: string };
    };
    resume: {
      id: string;
      fileName: string;
      fileType: string;
      sizeBytes: bigint;
      uploadedAt: Date;
    } | null;
    hasInspectedOriginalResume: boolean;
    consent: {
      id: string;
      status: string;
      policyVersion: string;
      capturedAt: Date;
    } | null;
    assessment: {
      id: string;
      status: string;
      score: number | null;
      coverage: number;
      formulaVersion: string;
      criteria: Array<{
        id: string;
        key: string;
        label: string;
        category: string;
        requirementType: string;
        weight: number;
        status: string;
        confidence: string;
        score: number | null;
        reasoning: string;
        evidence: Array<{
          quote: string;
          pageNumber: number | null;
          startOffset: number | null;
          endOffset: number | null;
          verified: boolean;
        }>;
      }>;
    } | null;
    review: {
      id: string;
      decision: ReviewDecision;
      reviewedAt: Date;
      reviewerId: string;
      notesInternal: string | null;
    } | null;
    shortlist: {
      id: string;
      candidateId: string;
      requisitionId: string;
      shortlistedById: string;
      shortlistedAt: Date;
      notesInternal: string | null;
    } | null;
    submission: {
      id: string;
      status: SubmissionStatus;
      submittedAt: Date;
      submittedById: string;
    } | null;
    clientFeedback: Array<{
      id: string;
      decision: ClientDecisionType;
      reason: string | null;
      proposedAt: Date | null;
      timezone: string | null;
      createdAt: Date;
    }>;
    interviews?: Array<{
      id: string;
      submissionId: string;
      requisitionId: string;
      proposerUserId: string;
      proposerRole: UserRole;
      startAt: Date;
      endAt: Date;
      timezone: string;
      format: InterviewFormat;
      status: InterviewProposalStatus;
      reason: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
  } | null>;

  recordCandidateReview(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    candidateId: string,
    resumeDocumentId: string,
    decision: ReviewDecision,
    notesInternal?: string,
  ): Promise<{ id: string; decision: ReviewDecision; reviewedAt: Date }>;

  recordShortlist(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    candidateId: string,
    notesInternal?: string,
  ): Promise<{
    id: string;
    organizationId: string;
    candidateId: string;
    requisitionId: string;
    shortlistedById: string;
    shortlistedAt: Date;
    notesInternal: string | null;
  }>;

  findShortlist(
    organizationId: string,
    requisitionId: string,
    candidateId: string,
  ): Promise<{
    id: string;
    organizationId: string;
    candidateId: string;
    requisitionId: string;
    shortlistedById: string;
    shortlistedAt: Date;
    notesInternal: string | null;
  } | null>;

  createSubmission(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    clientId: string,
    candidateId: string,
    resumeDocumentId: string,
    assessmentId: string,
    reviewId: string,
  ): Promise<{
    id: string;
    organizationId: string;
    candidateId: string;
    requisitionId: string;
    clientId: string;
    submittedById: string;
    assessmentId: string;
    reviewId: string;
    resumeDocumentId: string;
    status: SubmissionStatus;
    submittedAt: Date;
    updatedAt: Date;
  }>;

  listSubmissionsForRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
  ): Promise<
    Array<{
      id: string;
      candidateId: string;
      candidateCode: string;
      status: SubmissionStatus;
      submittedAt: Date;
      score: number | null;
      clientName: string;
    }>
  >;

  getSubmissionForRequisition(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    submissionId: string,
  ): Promise<{
    id: string;
    organizationId: string;
    candidateId: string;
    candidateCode: string;
    requisitionId: string;
    requisitionTitle: string;
    clientId: string;
    clientName: string;
    submittedById: string;
    assessmentId: string;
    reviewId: string;
    resumeDocumentId: string;
    status: SubmissionStatus;
    submittedAt: Date;
    updatedAt: Date;
    feedbackHistory: Array<{
      id: string;
      decision: ClientDecisionType;
      reason: string | null;
      proposedAt: Date | null;
      timezone: string | null;
      createdAt: Date;
    }>;
    interviews?: Array<{
      id: string;
      startAt: string;
      endAt: string;
      timezone: string;
      format: string;
      status: string;
      reason: string | null;
      createdAt: string;
    }>;
  } | null>;

  listSubmissionsForClient(
    organizationId: string,
    clientId: string,
  ): Promise<
    Array<{
      submissionId: string;
      candidateRef: string;
      requisitionId: string;
      requisitionTitle: string;
      status: SubmissionStatus;
      submittedAt: Date;
      score: number | null;
      coverage: number;
      assessmentStatus: string;
      criteriaCount: number;
      latestDecision: {
        decision: ClientDecisionType;
        createdAt: Date;
      } | null;
    }>
  >;

  getSubmissionForClient(
    organizationId: string,
    clientId: string,
    submissionId: string,
  ): Promise<{
    submissionId: string;
    candidateRef: string;
    requisitionId: string;
    requisitionTitle: string;
    status: SubmissionStatus;
    submittedAt: Date;
    assessment: {
      score: number | null;
      coverage: number;
      status: string;
      criteria: Array<{
        label: string;
        category: string;
        requirementType: string;
        status: string;
        reasoning: string;
        verifiedQuotes: string[];
      }>;
    } | null;
    feedbackHistory: Array<{
      id: string;
      decision: ClientDecisionType;
      reason: string | null;
      proposedAt: Date | null;
      timezone: string | null;
      createdAt: Date;
    }>;
    interviews?: Array<{
      id: string;
      startAt: string;
      endAt: string;
      timezone: string;
      format: string;
      status: string;
      reason: string | null;
      createdAt: string;
    }>;
  } | null>;

  recordClientFeedback(
    organizationId: string,
    clientId: string,
    submissionId: string,
    clientUserId: string,
    membershipId: string,
    decision: 'SHORTLIST' | 'REJECT',
    reason?: string,
  ): Promise<{ id: string; decision: string; createdAt: Date }>;

  recordClientInterviewProposal(
    organizationId: string,
    clientId: string,
    submissionId: string,
    clientUserId: string,
    membershipId: string,
    startAt: Date,
    endAt: Date,
    timezone: string,
    format?: InterviewFormat,
    reason?: string,
  ): Promise<{
    id: string;
    decision: string;
    proposedAt: Date;
    startAt: Date;
    endAt: Date;
    timezone: string;
    format: InterviewFormat;
    status: InterviewProposalStatus;
    createdAt: Date;
  }>;

  respondToInterview(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    submissionId: string,
    decisionId: string,
    action: 'ACCEPT' | 'REJECT' | 'PROPOSE_ALTERNATIVE' | 'COMPLETE',
    payload?: {
      reason?: string | undefined;
      startAt?: Date | undefined;
      endAt?: Date | undefined;
      proposedAt?: Date | undefined;
      timezone?: string | undefined;
      format?: InterviewFormat | undefined;
    },
  ): Promise<{ success: boolean; action: string; proposalId?: string | undefined }>;

  respondToInterviewAsClient(
    organizationId: string,
    clientId: string,
    submissionId: string,
    proposalId: string,
    clientUserId: string,
    membershipId: string,
    action: 'ACCEPT' | 'REJECT',
    reason?: string,
  ): Promise<{
    success: boolean;
    action: string;
    proposalId: string;
    status: InterviewProposalStatus;
  }>;

  listAuthorizedClients?(
    organizationId: string,
    userId: string,
    role: UserRole,
    options?: { includeInactive?: boolean | undefined },
  ): Promise<
    Array<{
      id: string;
      name: string;
      status: string;
      createdAt?: Date | string | undefined;
      updatedAt?: Date | string | undefined;
      membershipId?: string | undefined;
      membershipRole?: string | undefined;
    }>
  >;

  createClient?(
    organizationId: string,
    recruiterId: string,
    input: { name: string },
  ): Promise<{
    id: string;
    name: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }>;

  updateClient?(
    organizationId: string,
    recruiterId: string,
    clientId: string,
    input: { name?: string | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined },
  ): Promise<{
    id: string;
    name: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  } | null>;

  getCandidateTimeline?(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    candidateId: string,
    options: { limit: number; offset: number },
  ): Promise<{
    candidate: { id: string; candidateCode: string };
    items: Array<{
      id: string;
      fromStage: string | null;
      toStage: string;
      actorRole: string;
      submissionId: string | null;
      reason: string | null;
      createdAt: Date;
    }>;
    total: number;
  } | null>;
}

export function createWorkflowRepository(
  database: PrismaClient = getDatabaseClient(),
): WorkflowRepository {
  return {
    async findAuthorizedRequisition(organizationId, recruiterId, requisitionId) {
      return database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: {
          id: true,
          title: true,
          status: true,
          clientId: true,
          client: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
      });
    },

    async hasRecruiterInspectedResume(
      organizationId,
      recruiterId,
      requisitionId,
      resumeDocumentId,
    ) {
      const inspectionEvent = await database.auditLog.findFirst({
        where: {
          organizationId,
          actorId: recruiterId,
          requisitionId,
          resourceType: 'ResumeDocument',
          resourceId: resumeDocumentId,
          action: 'ORIGINAL_RESUME_INSPECTED',
        },
        select: { id: true },
      });
      return inspectionEvent !== null;
    },

    async findActiveConsentForRequisition(organizationId, candidateId, requisitionId) {
      return database.candidateConsent.findFirst({
        where: {
          organizationId,
          candidateId,
          requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
        },
        select: {
          id: true,
          status: true,
          policyVersion: true,
          noticeTextHash: true,
          capturedAt: true,
        },
      });
    },

    async listCandidatesForRequisition(organizationId, recruiterId, requisitionId, options) {
      const requisition = await database.requisition.findFirst({
        where: { id: requisitionId, organizationId, assignedRecruiterId: recruiterId },
        select: { id: true },
      });
      if (!requisition) {
        return { items: [], total: 0 };
      }

      // Base query: find all resume documents ingested for this requisition
      const resumes = await database.resumeDocument.findMany({
        where: {
          organizationId,
          processingJobs: {
            some: {
              batch: {
                requisitionId,
              },
            },
          },
          ...(options.processingStatus
            ? { parseStatus: options.processingStatus as ResumeParseStatus }
            : {}),
        },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              createdAt: true,
              shortlists: {
                where: { requisitionId },
                take: 1,
                select: {
                  id: true,
                  shortlistedAt: true,
                },
              },
            },
          },
          assessments: {
            where: { requisitionId },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              criterionAssessments: {
                select: { id: true, status: true },
              },
            },
          },
          reviews: {
            where: { requisitionId },
            orderBy: { reviewedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              decision: true,
              reviewedAt: true,
            },
          },
          candidateSubmissions: {
            where: { requisitionId },
            take: 1,
            select: {
              id: true,
              status: true,
              submittedAt: true,
            },
          },
        },
        orderBy: { uploadedAt: 'desc' },
      });

      // Filter in memory for criteria that span relations if needed
      let filtered = resumes;
      if (options.assessmentStatus) {
        filtered = filtered.filter((r) => r.assessments[0]?.status === options.assessmentStatus);
      }
      if (options.reviewDecision) {
        filtered = filtered.filter((r) => r.reviews[0]?.decision === options.reviewDecision);
      }
      if (options.submissionStatus) {
        filtered = filtered.filter(
          (r) => r.candidateSubmissions[0]?.status === options.submissionStatus,
        );
      }

      const total = filtered.length;
      const paginated = filtered.slice(options.offset, options.offset + options.limit);

      const items = paginated.map((r) => {
        const assessment = r.assessments[0] ?? null;
        const review = r.reviews[0] ?? null;
        const shortlist = r.candidate.shortlists[0] ?? null;
        const submission = r.candidateSubmissions[0] ?? null;

        const criteriaCount = assessment?.criterionAssessments.length ?? 0;
        const criteriaMetCount =
          assessment?.criterionAssessments.filter((c) => c.status === 'MATCH').length ?? 0;

        return {
          candidateId: r.candidate.id,
          candidateCode: r.candidate.candidateCode,
          resumeDocumentId: r.id,
          resumeFileName: r.objectKey.split('/').pop() || 'resume',
          parseStatus: r.parseStatus,
          assessment: assessment
            ? {
                id: assessment.id,
                status: assessment.status,
                score: assessment.score !== null ? Number(assessment.score) : null,
                coverage: Number(assessment.coverage),
                formulaVersion: assessment.formulaVersion,
                criteriaCount,
                criteriaMetCount,
              }
            : null,
          review: review
            ? {
                id: review.id,
                decision: review.decision,
                reviewedAt: review.reviewedAt,
              }
            : null,
          shortlist: shortlist
            ? {
                id: shortlist.id,
                shortlistedAt: shortlist.shortlistedAt,
              }
            : null,
          submission: submission
            ? {
                id: submission.id,
                status: submission.status,
                submittedAt: submission.submittedAt,
              }
            : null,
          lastActivityAt: r.updatedAt,
        };
      });

      return { items, total };
    },

    async getCandidateDetail(organizationId, recruiterId, requisitionId, candidateId) {
      const requisition = await database.requisition.findFirst({
        where: { id: requisitionId, organizationId, assignedRecruiterId: recruiterId },
        select: {
          id: true,
          title: true,
          client: { select: { id: true, name: true } },
        },
      });
      if (!requisition) return null;

      const candidate = await database.candidate.findFirst({
        where: { id: candidateId, organizationId },
        select: { id: true, candidateCode: true },
      });
      if (!candidate) return null;

      const resume = await database.resumeDocument.findFirst({
        where: {
          candidateId,
          organizationId,
          processingJobs: {
            some: {
              batch: { requisitionId },
            },
          },
        },
        orderBy: { uploadedAt: 'desc' },
      });

      const hasInspected = resume
        ? await this.hasRecruiterInspectedResume(
            organizationId,
            recruiterId,
            requisitionId,
            resume.id,
          )
        : false;

      const consent = await database.candidateConsent.findFirst({
        where: {
          candidateId,
          requisitionId,
          organizationId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
        },
        orderBy: { capturedAt: 'desc' },
        select: {
          id: true,
          status: true,
          policyVersion: true,
          capturedAt: true,
        },
      });

      const assessmentRecord = await database.candidateAssessment.findFirst({
        where: {
          candidateId,
          requisitionId,
          organizationId,
        },
        orderBy: { createdAt: 'desc' },
        include: {
          criterionAssessments: {
            include: {
              criterion: {
                select: {
                  id: true,
                  key: true,
                  label: true,
                  category: true,
                  requirementType: true,
                  weight: true,
                },
              },
              evidence: true,
            },
          },
        },
      });

      const assessment = assessmentRecord
        ? {
            id: assessmentRecord.id,
            status: assessmentRecord.status,
            score: assessmentRecord.score !== null ? Number(assessmentRecord.score) : null,
            coverage: Number(assessmentRecord.coverage),
            formulaVersion: assessmentRecord.formulaVersion,
            criteria: assessmentRecord.criterionAssessments.map((c) => ({
              id: c.criterion.id,
              key: c.criterion.key,
              label: c.criterion.label,
              category: c.criterion.category,
              requirementType: c.criterion.requirementType,
              weight: Number(c.criterion.weight),
              status: c.status,
              confidence: 'VERIFIED',
              score: c.normalizedValue !== null ? Number(c.normalizedValue) : null,
              reasoning: c.explanation ?? '',
              evidence: c.evidence.map((e) => ({
                quote: e.quote,
                pageNumber: e.pageNumber,
                startOffset: e.startOffset,
                endOffset: e.endOffset,
                verified: e.verified,
              })),
            })),
          }
        : null;

      const review = await database.candidateReview.findFirst({
        where: {
          candidateId,
          requisitionId,
          organizationId,
        },
        orderBy: { reviewedAt: 'desc' },
        select: {
          id: true,
          decision: true,
          reviewedAt: true,
          reviewerId: true,
          notesInternal: true,
        },
      });

      const shortlist = await database.candidateShortlist.findFirst({
        where: {
          candidateId,
          requisitionId,
          organizationId,
        },
        select: {
          id: true,
          candidateId: true,
          requisitionId: true,
          shortlistedById: true,
          shortlistedAt: true,
          notesInternal: true,
        },
      });

      const submission = await database.candidateSubmission.findFirst({
        where: {
          candidateId,
          requisitionId,
          organizationId,
        },
        orderBy: { submittedAt: 'desc' },
        include: {
          decisions: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              decision: true,
              reason: true,
              proposedAt: true,
              timezone: true,
              createdAt: true,
            },
          },
        },
      });

      const interviews = submission
        ? await database.interviewProposal.findMany({
            where: {
              submissionId: submission.id,
              organizationId,
            },
            orderBy: { createdAt: 'desc' },
          })
        : [];

      return {
        candidate,
        requisition,
        resume: resume
          ? {
              id: resume.id,
              fileName: resume.objectKey.split('/').pop() || 'resume',
              fileType: resume.fileType,
              sizeBytes: resume.sizeBytes,
              uploadedAt: resume.uploadedAt,
            }
          : null,
        hasInspectedOriginalResume: hasInspected,
        consent,
        assessment,
        review,
        shortlist,
        submission: submission
          ? {
              id: submission.id,
              status: submission.status,
              submittedAt: submission.submittedAt,
              submittedById: submission.submittedById,
            }
          : null,
        clientFeedback: submission?.decisions ?? [],
        interviews,
      };
    },

    async recordCandidateReview(
      organizationId,
      recruiterId,
      requisitionId,
      candidateId,
      resumeDocumentId,
      decision,
      notesInternal,
    ) {
      return database.$transaction(async (tx) => {
        const review = await tx.candidateReview.create({
          data: {
            organizationId,
            reviewerId: recruiterId,
            requisitionId,
            candidateId,
            resumeDocumentId,
            decision,
            notesInternal: notesInternal ?? null,
          },
          select: {
            id: true,
            decision: true,
            reviewedAt: true,
          },
        });

        // If review is downgraded to NEEDS_REVIEW or CLOSED, invalidate any existing shortlist
        // so stale shortlist state cannot be used to submit the candidate.
        if (decision !== 'REVIEWED') {
          await tx.candidateShortlist.deleteMany({
            where: {
              organizationId,
              requisitionId,
              candidateId,
            },
          });
        }

        const toStage =
          decision === 'REVIEWED'
            ? 'RECRUITER_REVIEW'
            : decision === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'RECRUITER_CLOSED';

        await tx.pipelineEvent.create({
          data: {
            organizationId,
            requisitionId,
            candidateId,
            fromStage: 'ASSESSED',
            toStage,
            actorId: recruiterId,
            reason: notesInternal ?? `Recruiter recorded review decision: ${decision}`,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: recruiterId,
            action: 'CANDIDATE_REVIEWED',
            resourceType: 'CandidateReview',
            resourceId: review.id,
            requisitionId,
            candidateId,
            metadataJson: {
              decision,
              hasNotes: Boolean(notesInternal),
            },
          },
        });

        return review;
      });
    },

    async findShortlist(organizationId, requisitionId, candidateId) {
      return database.candidateShortlist.findFirst({
        where: {
          organizationId,
          requisitionId,
          candidateId,
        },
      });
    },

    async recordShortlist(organizationId, recruiterId, requisitionId, candidateId, notesInternal) {
      return database.$transaction(async (tx) => {
        const latestReview = await tx.candidateReview.findFirst({
          where: {
            organizationId,
            requisitionId,
            candidateId,
          },
          orderBy: { reviewedAt: 'desc' },
          select: { id: true, decision: true },
        });

        if (!latestReview || latestReview.decision !== 'REVIEWED') {
          throw new WorkflowShortlistRequiredError(
            'Candidate must have an explicit REVIEWED decision before being shortlisted.',
          );
        }

        const shortlist = await tx.candidateShortlist.upsert({
          where: {
            requisitionId_candidateId: {
              requisitionId,
              candidateId,
            },
          },
          create: {
            organizationId,
            requisitionId,
            candidateId,
            shortlistedById: recruiterId,
            notesInternal: notesInternal ?? null,
          },
          update: {
            shortlistedById: recruiterId,
            shortlistedAt: new Date(),
            notesInternal: notesInternal ?? null,
          },
        });

        await tx.pipelineEvent.create({
          data: {
            organizationId,
            requisitionId,
            candidateId,
            fromStage: 'RECRUITER_REVIEW',
            toStage: 'RECRUITER_SHORTLISTED',
            actorId: recruiterId,
            reason: 'Shortlisted by recruiter',
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: recruiterId,
            action: 'CANDIDATE_SHORTLISTED',
            resourceType: 'CandidateShortlist',
            resourceId: shortlist.id,
            requisitionId,
            candidateId,
            metadataJson: {
              shortlistedAt: shortlist.shortlistedAt.toISOString(),
            },
          },
        });

        return shortlist;
      });
    },

    async createSubmission(
      organizationId,
      recruiterId,
      requisitionId,
      clientId,
      candidateId,
      resumeDocumentId,
      assessmentId,
      reviewId,
    ) {
      return database.$transaction(async (tx) => {
        const latestReview = await tx.candidateReview.findFirst({
          where: {
            organizationId,
            requisitionId,
            candidateId,
          },
          orderBy: { reviewedAt: 'desc' },
          select: { id: true, decision: true },
        });

        if (!latestReview || latestReview.decision !== 'REVIEWED') {
          throw new WorkflowShortlistRequiredError(
            'Candidate must have a current explicit REVIEWED decision before submission to a client.',
          );
        }

        const shortlist = await tx.candidateShortlist.findFirst({
          where: {
            organizationId,
            requisitionId,
            candidateId,
          },
          select: { id: true },
        });

        if (!shortlist) {
          throw new WorkflowShortlistRequiredError(
            'Candidate must be shortlisted by a recruiter before submission to a client.',
          );
        }

        const activeSubmission = await tx.candidateSubmission.findFirst({
          where: {
            requisitionId,
            candidateId,
            status: { notIn: ['WITHDRAWN', 'CLIENT_REJECTED'] },
          },
        });

        if (activeSubmission) {
          // Idempotent duplicate return: preserve active submission without overwrite
          return activeSubmission;
        }

        const submission = await tx.candidateSubmission.create({
          data: {
            organizationId,
            requisitionId,
            clientId,
            candidateId,
            resumeDocumentId,
            assessmentId,
            reviewId: latestReview.id || reviewId,
            submittedById: recruiterId,
            status: 'SUBMITTED',
          },
        });

        await tx.pipelineEvent.create({
          data: {
            organizationId,
            requisitionId,
            candidateId,
            submissionId: submission.id,
            fromStage: 'RECRUITER_SHORTLISTED',
            toStage: 'SUBMITTED_TO_CLIENT',
            actorId: recruiterId,
            reason: 'Submitted to client by recruiter',
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: recruiterId,
            action: 'CANDIDATE_SUBMITTED_TO_CLIENT',
            resourceType: 'CandidateSubmission',
            resourceId: submission.id,
            requisitionId,
            clientId,
            candidateId,
            metadataJson: {
              submissionId: submission.id,
              assessmentId,
              reviewId,
            },
          },
        });

        // Enqueue transactional email notifications to active client hiring managers
        const clientManagers = await tx.clientMembership.findMany({
          where: { clientId, organizationId, status: 'ACTIVE' },
          include: { user: { select: { email: true } } },
        });

        if (clientManagers.length > 0) {
          const [cand, req] = await Promise.all([
            tx.candidate.findUnique({
              where: { id: candidateId },
              select: { candidateCode: true },
            }),
            tx.requisition.findUnique({
              where: { id: requisitionId },
              select: { title: true, client: { select: { name: true } } },
            }),
          ]);

          const appOrigin = process.env['APP_ORIGIN'] ?? 'http://localhost:5173';
          const rendered = renderClientSubmission({
            clientName: req?.client?.name ?? 'Client',
            requisitionTitle: req?.title ?? 'Requisition',
            candidateRef: cand?.candidateCode ?? 'Candidate',
            portalUrl: `${appOrigin}/portal/submissions/${submission.id}`,
          });

          for (const manager of clientManagers) {
            const outboxId = randomUUID();
            const idempotencyKey = createEmailIdempotencyKey(
              'client_submission',
              manager.user.email,
              submission.id,
            );
            const { encryptedPayload, keyId } = encryptEmailPayload(
              {
                recipientEmail: manager.user.email.trim().toLowerCase(),
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              },
              { recordId: outboxId, idempotencyKey },
            );

            await tx.emailOutbox.create({
              data: {
                id: outboxId,
                organizationId,
                idempotencyKey,
                messageType: 'client_submission',
                recipientEmail: null,
                recipientRole: 'CLIENT_HIRING_MANAGER',
                subject: null,
                html: null,
                text: null,
                encryptedPayload,
                keyId,
                status: 'PENDING',
                attempts: 0,
                maxAttempts: 3,
              },
            });
          }
        }

        return submission;
      });
    },

    async listSubmissionsForRequisition(organizationId, recruiterId, requisitionId) {
      const requisition = await database.requisition.findFirst({
        where: { id: requisitionId, organizationId, assignedRecruiterId: recruiterId },
        select: { id: true, client: { select: { name: true } } },
      });
      if (!requisition) return [];

      const records = await database.candidateSubmission.findMany({
        where: { requisitionId, organizationId },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              profiles: {
                orderBy: { profileVersion: 'desc' },
                select: { location: true },
                take: 1,
              },
            },
          },
          assessment: { select: { score: true } },
        },
        orderBy: { submittedAt: 'desc' },
      });

      return records.map((r) => ({
        id: r.id,
        candidateId: r.candidate.id,
        candidateCode: r.candidate.candidateCode,
        status: r.status,
        submittedAt: r.submittedAt,
        score: r.assessment.score !== null ? Number(r.assessment.score) : null,
        clientName: requisition.client.name,
      }));
    },

    async getSubmissionForRequisition(organizationId, recruiterId, requisitionId, submissionId) {
      const requisition = await database.requisition.findFirst({
        where: { id: requisitionId, organizationId, assignedRecruiterId: recruiterId },
        select: { id: true, title: true, client: { select: { id: true, name: true } } },
      });
      if (!requisition) return null;

      const record = await database.candidateSubmission.findFirst({
        where: { id: submissionId, requisitionId, organizationId },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              profiles: {
                orderBy: { profileVersion: 'desc' },
                select: { location: true },
                take: 1,
              },
            },
          },
          decisions: {
            orderBy: { createdAt: 'desc' },
          },
          interviewProposals: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      if (!record) return null;

      return {
        id: record.id,
        organizationId: record.organizationId,
        candidateId: record.candidateId,
        candidateCode: record.candidate.candidateCode,
        requisitionId: record.requisitionId,
        requisitionTitle: requisition.title,
        clientId: record.clientId,
        clientName: requisition.client.name,
        submittedById: record.submittedById,
        assessmentId: record.assessmentId,
        reviewId: record.reviewId,
        resumeDocumentId: record.resumeDocumentId,
        status: record.status,
        submittedAt: record.submittedAt,
        updatedAt: record.updatedAt,
        feedbackHistory: record.decisions,
        interviews: record.interviewProposals.map((ip) => ({
          id: ip.id,
          startAt: ip.startAt.toISOString(),
          endAt: ip.endAt.toISOString(),
          timezone: ip.timezone,
          format: ip.format,
          status: ip.status,
          reason: ip.reason,
          createdAt: ip.createdAt.toISOString(),
        })),
      };
    },

    async listSubmissionsForClient(organizationId, clientId) {
      const submissions = await database.candidateSubmission.findMany({
        where: {
          organizationId,
          clientId,
          status: { not: 'WITHDRAWN' },
        },
        include: {
          requisition: { select: { id: true, title: true } },
          assessment: {
            include: {
              criterionAssessments: { select: { id: true } },
            },
          },
          decisions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { decision: true, createdAt: true },
          },
        },
        orderBy: { submittedAt: 'desc' },
      });

      if (submissions.length === 0) {
        return [];
      }

      // Verify active exact-scope HIRING_USE consent for every candidate-requisition pair without N+1 queries
      const candidateIds = Array.from(new Set(submissions.map((s) => s.candidateId)));
      const requisitionIds = Array.from(new Set(submissions.map((s) => s.requisitionId)));

      const activeConsents = await database.candidateConsent.findMany({
        where: {
          organizationId,
          candidateId: { in: candidateIds },
          requisitionId: { in: requisitionIds },
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
        },
        select: {
          candidateId: true,
          requisitionId: true,
        },
      });

      const consentedScopes = new Set(
        activeConsents.map((c) => `${c.candidateId}:${c.requisitionId}`),
      );

      const authorizedSubmissions = submissions.filter((s) =>
        consentedScopes.has(`${s.candidateId}:${s.requisitionId}`),
      );

      return authorizedSubmissions.map((s) => ({
        submissionId: s.id,
        candidateRef: `CAND-SUB-${s.id.slice(0, 8).toUpperCase()}`,
        requisitionId: s.requisition.id,
        requisitionTitle: s.requisition.title,
        status: s.status,
        submittedAt: s.submittedAt,
        score: s.assessment.score !== null ? Number(s.assessment.score) : null,
        coverage: Number(s.assessment.coverage),
        assessmentStatus: s.assessment.status,
        criteriaCount: s.assessment.criterionAssessments.length,
        latestDecision: s.decisions[0] ?? null,
      }));
    },

    async getSubmissionForClient(organizationId, clientId, submissionId) {
      const record = await database.candidateSubmission.findFirst({
        where: {
          id: submissionId,
          clientId,
          organizationId,
          status: { not: 'WITHDRAWN' },
        },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              profiles: {
                orderBy: { profileVersion: 'desc' },
                select: { location: true },
                take: 1,
              },
            },
          },
          requisition: { select: { id: true, title: true } },
          assessment: {
            include: {
              criterionAssessments: {
                include: {
                  criterion: {
                    select: {
                      label: true,
                      category: true,
                      requirementType: true,
                    },
                  },
                  evidence: {
                    where: { verified: true },
                    select: { quote: true },
                  },
                },
              },
            },
          },
          decisions: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              decision: true,
              reason: true,
              proposedAt: true,
              timezone: true,
              createdAt: true,
            },
          },
          interviewProposals: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!record) return null;

      // Ensure active exact-scope HIRING_USE consent covers this candidate and requisition
      const activeConsent = await database.candidateConsent.findFirst({
        where: {
          organizationId,
          candidateId: record.candidateId,
          requisitionId: record.requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
        },
        select: { id: true, confirmationName: true },
      });

      if (!activeConsent) {
        // Privacy safeguard: If consent is withdrawn, expired, or missing, fail closed and conceal submission
        return null;
      }

      await database.auditLog.create({
        data: {
          organizationId,
          action: 'CLIENT_ACCESSED_SUBMISSION',
          resourceType: 'CandidateSubmission',
          resourceId: record.id,
          requisitionId: record.requisitionId,
          clientId,
          metadataJson: {
            submissionId: record.id,
          },
        },
      });

      return {
        submissionId: record.id,
        candidateRef: `CAND-SUB-${record.id.slice(0, 8).toUpperCase()}`,
        requisitionId: record.requisition.id,
        requisitionTitle: record.requisition.title,
        status: record.status,
        submittedAt: record.submittedAt,
        assessment: {
          score: record.assessment.score !== null ? Number(record.assessment.score) : null,
          coverage: Number(record.assessment.coverage),
          status: record.assessment.status,
          criteria: record.assessment.criterionAssessments.map((c) => ({
            label: c.criterion.label,
            category: c.criterion.category,
            requirementType: c.criterion.requirementType,
            status: c.status,
            reasoning: c.explanation ?? '',
            verifiedQuotes: c.evidence.map((e) => {
              const candidateNames: string[] = [];
              if (activeConsent.confirmationName) {
                candidateNames.push(activeConsent.confirmationName);
              }
              const candidateAddress = record.candidate.profiles[0]?.location ?? undefined;
              const redacted = redactCandidateIdentifiers(e.quote, {
                candidateNames,
                candidateAddress,
                extraIdentifiers: [record.candidate.candidateCode],
              });
              return redacted.redactedText;
            }),
          })),
        },
        feedbackHistory: record.decisions,
        interviews: record.interviewProposals.map((ip) => ({
          id: ip.id,
          startAt: ip.startAt.toISOString(),
          endAt: ip.endAt.toISOString(),
          timezone: ip.timezone,
          format: ip.format,
          status: ip.status,
          reason: ip.reason,
          createdAt: ip.createdAt.toISOString(),
        })),
      };
    },

    async recordClientFeedback(
      organizationId,
      clientId,
      submissionId,
      clientUserId,
      membershipId,
      decision,
      reason,
    ) {
      if (reason) {
        const fairnessResult = evaluateFeedbackFairness(reason);
        if (fairnessResult.isProhibited) {
          const sub = await database.candidateSubmission.findFirst({
            where: { id: submissionId, clientId, organizationId },
            select: { requisitionId: true, candidateId: true },
          });

          await database.auditLog.create({
            data: {
              organizationId,
              actorId: clientUserId,
              action: 'CLIENT_FEEDBACK_PROHIBITED_DETECTED',
              resourceType: 'CandidateSubmission',
              resourceId: submissionId,
              requisitionId: sub?.requisitionId ?? null,
              clientId,
              candidateId: sub?.candidateId ?? null,
              metadataJson: {
                submissionId,
                decision,
                submittedReason: reason,
                prohibitedCategory: fairnessResult.category,
                prohibitedReason: fairnessResult.reason,
              },
            },
          });

          throw new WorkflowProhibitedFeedbackError(
            `Feedback contains prohibited discriminatory content (${fairnessResult.category}): ${fairnessResult.reason}`,
            fairnessResult.category,
          );
        }
      }

      return database.$transaction(async (tx) => {
        const submission = await tx.candidateSubmission.findFirst({
          where: {
            id: submissionId,
            clientId,
            organizationId,
          },
          select: {
            id: true,
            requisitionId: true,
            candidateId: true,
            status: true,
            requisition: {
              select: {
                title: true,
                assignedRecruiter: { select: { email: true } },
              },
            },
            candidate: {
              select: { candidateCode: true },
            },
          },
        });

        if (!submission) {
          throw new WorkflowSubmissionNotFoundError();
        }

        const activeConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidateId: submission.candidateId,
            requisitionId: submission.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
          },
          select: { id: true },
        });
        if (!activeConsent || submission.status === 'WITHDRAWN') {
          throw new WorkflowConsentRequiredError(
            'Active candidate consent is required to record client feedback.',
          );
        }

        if (submission.status === 'CLIENT_REJECTED') {
          throw new WorkflowSubmissionStateError(
            'Cannot record feedback on a rejected submission. Recruiter resubmission is required.',
          );
        }

        const decisionRecord = await tx.clientDecision.create({
          data: {
            organizationId,
            clientId,
            submissionId,
            clientUserId,
            membershipId,
            decision,
            reason: reason ?? null,
          },
          select: {
            id: true,
            decision: true,
            createdAt: true,
          },
        });

        const newStatus: SubmissionStatus =
          decision === 'SHORTLIST' ? 'CLIENT_SHORTLISTED' : 'CLIENT_REJECTED';

        const priorStage =
          submission.status === 'CLIENT_SHORTLISTED'
            ? 'CLIENT_SHORTLISTED'
            : submission.status === 'INTERVIEW_PROPOSED'
              ? 'INTERVIEW_PROPOSED'
              : 'SUBMITTED_TO_CLIENT';

        await tx.candidateSubmission.update({
          where: { id: submissionId },
          data: {
            status: newStatus,
            updatedAt: new Date(),
          },
        });

        await tx.pipelineEvent.create({
          data: {
            organizationId,
            requisitionId: submission.requisitionId,
            candidateId: submission.candidateId,
            submissionId,
            fromStage: priorStage,
            toStage: newStatus === 'CLIENT_SHORTLISTED' ? 'CLIENT_SHORTLISTED' : 'CLIENT_REJECTED',
            actorId: clientUserId,
            reason: reason ?? `Client marked candidate as ${decision}`,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: clientUserId,
            action: 'CLIENT_FEEDBACK_RECORDED',
            resourceType: 'ClientDecision',
            resourceId: decisionRecord.id,
            requisitionId: submission.requisitionId,
            clientId,
            candidateId: submission.candidateId,
            metadataJson: {
              submissionId,
              decision,
              hasReason: Boolean(reason),
            },
          },
        });

        // Enqueue transactional email notification to assigned recruiter
        const [req, cand] = await Promise.all([
          tx.requisition.findUnique({
            where: { id: submission.requisitionId },
            include: {
              assignedRecruiter: { select: { email: true } },
              createdBy: { select: { email: true } },
            },
          }),
          tx.candidate.findUnique({
            where: { id: submission.candidateId },
            select: { candidateCode: true },
          }),
        ]);

        const recruiterEmail = req?.assignedRecruiter?.email ?? req?.createdBy?.email;
        if (recruiterEmail) {
          const appOrigin = process.env['APP_ORIGIN'] ?? 'http://localhost:5173';
          const rendered = renderClientFeedback({
            recruiterName: 'Recruiter',
            requisitionTitle: req?.title ?? 'Requisition',
            candidateCode: cand?.candidateCode ?? 'Candidate',
            decision,
            reason: reason ?? undefined,
            dashboardUrl: `${appOrigin}/requisitions/${submission.requisitionId}/candidates/${submission.candidateId}`,
          });

          const outboxId = randomUUID();
          const idempotencyKey = createEmailIdempotencyKey(
            'client_feedback',
            recruiterEmail,
            `${submission.id}:${decisionRecord.id}`,
          );
          const { encryptedPayload, keyId } = encryptEmailPayload(
            {
              recipientEmail: recruiterEmail.trim().toLowerCase(),
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            },
            { recordId: outboxId, idempotencyKey },
          );

          await tx.emailOutbox.create({
            data: {
              id: outboxId,
              organizationId,
              idempotencyKey,
              messageType: 'client_feedback',
              recipientEmail: null,
              recipientRole: 'RECRUITER',
              subject: null,
              html: null,
              text: null,
              encryptedPayload,
              keyId,
              status: 'PENDING',
              attempts: 0,
              maxAttempts: 3,
            },
          });
        }

        return decisionRecord;
      });
    },

    async recordClientInterviewProposal(
      organizationId,
      clientId,
      submissionId,
      clientUserId,
      membershipId,
      startAt,
      endAt,
      timezone,
      format,
      reason,
    ) {
      if (reason) {
        const fairnessResult = evaluateFeedbackFairness(reason);
        if (fairnessResult.isProhibited) {
          const sub = await database.candidateSubmission.findFirst({
            where: { id: submissionId, clientId, organizationId },
            select: { requisitionId: true, candidateId: true },
          });

          await database.auditLog.create({
            data: {
              organizationId,
              actorId: clientUserId,
              action: 'CLIENT_FEEDBACK_PROHIBITED_DETECTED',
              resourceType: 'CandidateSubmission',
              resourceId: submissionId,
              requisitionId: sub?.requisitionId ?? null,
              clientId,
              candidateId: sub?.candidateId ?? null,
              metadataJson: {
                submissionId,
                decision: 'PROPOSE_INTERVIEW',
                submittedReason: reason,
                prohibitedCategory: fairnessResult.category,
                prohibitedReason: fairnessResult.reason,
              },
            },
          });

          throw new WorkflowProhibitedFeedbackError(
            `Feedback contains prohibited discriminatory content (${fairnessResult.category}): ${fairnessResult.reason}`,
            fairnessResult.category,
          );
        }
      }

      const now = new Date();
      if (!startAt || Number.isNaN(startAt.getTime()) || startAt.getTime() <= now.getTime()) {
        throw new WorkflowInterviewStateError(
          'Proposed interview start time must be strictly in the future.',
        );
      }

      if (!endAt || Number.isNaN(endAt.getTime()) || endAt.getTime() <= startAt.getTime()) {
        throw new WorkflowInterviewStateError(
          'Proposed interview end time must be strictly after start time.',
        );
      }

      if (!timezone || !isValidIanaTimezone(timezone)) {
        throw new WorkflowInterviewStateError(`Invalid IANA timezone identifier: "${timezone}".`);
      }

      return database.$transaction(async (tx) => {
        const submission = await tx.candidateSubmission.findFirst({
          where: {
            id: submissionId,
            clientId,
            organizationId,
          },
          select: {
            id: true,
            requisitionId: true,
            candidateId: true,
            status: true,
            requisition: {
              select: {
                title: true,
                assignedRecruiter: { select: { email: true } },
              },
            },
            candidate: {
              select: { candidateCode: true },
            },
          },
        });

        if (!submission) {
          throw new WorkflowSubmissionNotFoundError();
        }

        const activeConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidateId: submission.candidateId,
            requisitionId: submission.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
          },
          select: { id: true },
        });
        if (!activeConsent || submission.status === 'WITHDRAWN') {
          throw new WorkflowConsentRequiredError(
            'Active candidate consent is required to propose an interview.',
          );
        }

        if (submission.status === 'CLIENT_REJECTED') {
          throw new WorkflowSubmissionStateError(
            'Cannot propose an interview on a rejected submission. Recruiter resubmission is required.',
          );
        }

        const priorStage =
          submission.status === 'CLIENT_SHORTLISTED'
            ? 'CLIENT_SHORTLISTED'
            : submission.status === 'INTERVIEW_PROPOSED'
              ? 'INTERVIEW_PROPOSED'
              : 'SUBMITTED_TO_CLIENT';

        const proposal = await tx.interviewProposal.create({
          data: {
            organizationId,
            submissionId,
            requisitionId: submission.requisitionId,
            proposerUserId: clientUserId,
            proposerRole: 'CLIENT_HIRING_MANAGER',
            startAt,
            endAt,
            timezone,
            format: format ?? 'VIDEO',
            status: 'PROPOSED',
            reason: reason ?? null,
          },
        });

        const decisionRecord = await tx.clientDecision.create({
          data: {
            organizationId,
            clientId,
            submissionId,
            clientUserId,
            membershipId,
            decision: 'PROPOSE_INTERVIEW',
            proposedAt: startAt,
            timezone,
            reason: reason ?? null,
          },
          select: {
            id: true,
            decision: true,
            proposedAt: true,
            timezone: true,
            createdAt: true,
          },
        });

        await tx.candidateSubmission.update({
          where: { id: submissionId },
          data: {
            status: 'INTERVIEW_PROPOSED',
            updatedAt: new Date(),
          },
        });

        await tx.pipelineEvent.create({
          data: {
            organizationId,
            requisitionId: submission.requisitionId,
            candidateId: submission.candidateId,
            submissionId,
            fromStage: priorStage,
            toStage: 'INTERVIEW_PROPOSED',
            actorId: clientUserId,
            reason: reason ?? 'Client proposed interview window',
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: clientUserId,
            action: 'INTERVIEW_PROPOSED',
            resourceType: 'InterviewProposal',
            resourceId: proposal.id,
            requisitionId: submission.requisitionId,
            clientId,
            candidateId: submission.candidateId,
            metadataJson: {
              submissionId,
              proposalId: proposal.id,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
              timezone,
              format: proposal.format,
            },
          },
        });

        const recruiterEmail = submission.requisition.assignedRecruiter?.email;
        if (recruiterEmail) {
          const outboxId = randomUUID();
          const idempotencyKey = createEmailIdempotencyKey(
            'interview_notification',
            recruiterEmail,
            `${proposal.id}:PROPOSED`,
          );
          const rendered = renderInterviewNotification({
            recipientRole: 'RECRUITER',
            candidateCode: submission.candidate.candidateCode,
            requisitionTitle: submission.requisition.title,
            format: proposal.format,
            scheduledAt: proposal.startAt.toISOString(),
            timezone: proposal.timezone,
          });

          const { encryptedPayload, keyId } = encryptEmailPayload(
            {
              recipientEmail: recruiterEmail.trim().toLowerCase(),
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            },
            { recordId: outboxId, idempotencyKey },
          );

          await tx.emailOutbox.create({
            data: {
              id: outboxId,
              organizationId,
              idempotencyKey,
              messageType: 'interview_notification',
              recipientEmail: null,
              recipientRole: 'RECRUITER',
              subject: null,
              html: null,
              text: null,
              encryptedPayload,
              keyId,
              status: 'PENDING',
              attempts: 0,
              maxAttempts: 3,
            },
          });
        }

        return {
          id: proposal.id,
          decision: decisionRecord.decision,
          proposedAt: proposal.startAt,
          startAt: proposal.startAt,
          endAt: proposal.endAt,
          timezone: proposal.timezone,
          format: proposal.format,
          status: proposal.status,
          createdAt: proposal.createdAt,
        };
      });
    },

    async respondToInterview(
      organizationId,
      recruiterId,
      requisitionId,
      submissionId,
      decisionId,
      action,
      payload,
    ) {
      return database.$transaction(async (tx) => {
        const requisition = await tx.requisition.findFirst({
          where: { id: requisitionId, organizationId, assignedRecruiterId: recruiterId },
          select: { id: true, clientId: true, title: true },
        });
        if (!requisition) {
          throw new WorkflowRequisitionAccessDeniedError();
        }

        const submission = await tx.candidateSubmission.findFirst({
          where: { id: submissionId, requisitionId, organizationId },
          select: {
            id: true,
            candidateId: true,
            status: true,
            candidate: { select: { candidateCode: true } },
          },
        });
        if (!submission) {
          throw new WorkflowSubmissionNotFoundError();
        }

        const activeConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidateId: submission.candidateId,
            requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
          },
          select: { id: true },
        });
        if (!activeConsent || submission.status === 'WITHDRAWN') {
          throw new WorkflowConsentRequiredError();
        }

        if (submission.status === 'CLIENT_REJECTED') {
          throw new WorkflowSubmissionStateError(
            'Cannot respond to interview proposal on a rejected submission.',
          );
        }

        const trimmedDecisionId = decisionId?.trim() ?? '';
        let proposal = null;

        if (trimmedDecisionId.length > 0) {
          proposal = await tx.interviewProposal.findFirst({
            where: {
              id: trimmedDecisionId,
              submissionId: submission.id,
              organizationId,
              requisitionId,
            },
          });
          if (!proposal) {
            throw new WorkflowInterviewNotFoundError();
          }
        } else if (action !== 'PROPOSE_ALTERNATIVE') {
          throw new WorkflowInterviewNotFoundError();
        } else {
          // When recruiter proposes an alternative without specifying a proposalId,
          // check if there is an existing PROPOSED slot to mark RESCHEDULED.
          proposal = await tx.interviewProposal.findFirst({
            where: {
              submissionId: submission.id,
              organizationId,
              requisitionId,
              status: 'PROPOSED',
            },
            orderBy: { createdAt: 'desc' },
          });
        }

        const now = new Date();

        if (action === 'ACCEPT') {
          if (!proposal) {
            throw new WorkflowInterviewNotFoundError();
          }
          if (proposal.status !== 'PROPOSED') {
            throw new WorkflowInterviewStateError(
              `Cannot accept interview proposal with status "${proposal.status}". Must be PROPOSED.`,
            );
          }
          if (
            proposal.proposerRole !== 'CLIENT_HIRING_MANAGER' ||
            proposal.proposerUserId === recruiterId
          ) {
            throw new WorkflowInterviewStateError(
              'Recruiter cannot accept a proposal created by a recruiter; client counterparty acceptance is required.',
            );
          }
          if (
            (proposal.expiresAt && proposal.expiresAt.getTime() <= now.getTime()) ||
            proposal.startAt.getTime() <= now.getTime() ||
            proposal.endAt.getTime() <= now.getTime()
          ) {
            throw new WorkflowInterviewStateError('Interview proposal has expired.');
          }

          const updated = await tx.interviewProposal.updateMany({
            where: {
              id: proposal.id,
              submissionId: submission.id,
              organizationId,
              status: 'PROPOSED',
            },
            data: { status: 'ACCEPTED', updatedAt: now },
          });
          if (updated.count === 0) {
            throw new WorkflowInterviewStateError('Interview proposal state has already changed.');
          }

          await tx.candidateSubmission.update({
            where: { id: submissionId },
            data: { updatedAt: now },
          });

          await tx.pipelineEvent.create({
            data: {
              organizationId,
              requisitionId,
              candidateId: submission.candidateId,
              submissionId,
              fromStage: 'INTERVIEW_PROPOSED',
              toStage: 'INTERVIEW_SCHEDULED',
              actorId: recruiterId,
              reason: 'Recruiter accepted client interview proposal',
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'INTERVIEW_ACCEPTED',
              resourceType: 'InterviewProposal',
              resourceId: proposal.id,
              requisitionId,
              clientId: requisition.clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                scheduledAt: proposal.startAt.toISOString(),
                timezone: proposal.timezone,
              },
            },
          });

          const clientManagers = await tx.clientMembership.findMany({
            where: { clientId: requisition.clientId, organizationId, status: 'ACTIVE' },
            include: { user: { select: { email: true } } },
          });

          for (const manager of clientManagers) {
            const outboxId = randomUUID();
            const idempotencyKey = createEmailIdempotencyKey(
              'interview_notification',
              manager.user.email,
              `${proposal.id}:ACCEPTED`,
            );
            const rendered = renderInterviewNotification({
              recipientRole: 'CLIENT_HIRING_MANAGER',
              candidateCode: submission.candidate?.candidateCode ?? 'Candidate',
              requisitionTitle: requisition.title,
              format: proposal.format,
              scheduledAt: proposal.startAt.toISOString(),
              timezone: proposal.timezone,
            });

            const { encryptedPayload, keyId } = encryptEmailPayload(
              {
                recipientEmail: manager.user.email.trim().toLowerCase(),
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              },
              { recordId: outboxId, idempotencyKey },
            );

            await tx.emailOutbox.create({
              data: {
                id: outboxId,
                organizationId,
                idempotencyKey,
                messageType: 'interview_notification',
                recipientEmail: null,
                recipientRole: 'CLIENT_HIRING_MANAGER',
                subject: null,
                html: null,
                text: null,
                encryptedPayload,
                keyId,
                status: 'PENDING',
                attempts: 0,
                maxAttempts: 3,
              },
            });
          }
        } else if (action === 'REJECT') {
          if (!proposal) {
            throw new WorkflowInterviewNotFoundError();
          }
          if (proposal.status !== 'PROPOSED') {
            throw new WorkflowInterviewStateError(
              `Cannot reject interview proposal with status "${proposal.status}". Must be PROPOSED.`,
            );
          }
          if (
            proposal.proposerRole !== 'CLIENT_HIRING_MANAGER' ||
            proposal.proposerUserId === recruiterId
          ) {
            throw new WorkflowInterviewStateError(
              'Recruiter cannot reject a proposal created by a recruiter; counterparty response is required.',
            );
          }

          const updated = await tx.interviewProposal.updateMany({
            where: {
              id: proposal.id,
              submissionId: submission.id,
              organizationId,
              status: 'PROPOSED',
            },
            data: {
              status: 'REJECTED',
              reason: payload?.reason ?? null,
              updatedAt: now,
            },
          });
          if (updated.count === 0) {
            throw new WorkflowInterviewStateError('Interview proposal state has already changed.');
          }

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'INTERVIEW_PROPOSAL_REJECTED',
              resourceType: 'InterviewProposal',
              resourceId: proposal.id,
              requisitionId,
              clientId: requisition.clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                reason: payload?.reason,
              },
            },
          });
        } else if (action === 'PROPOSE_ALTERNATIVE') {
          const start = payload?.startAt ?? payload?.proposedAt;
          if (!start || Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) {
            throw new WorkflowInterviewStateError(
              'Proposed interview start time must be strictly in the future.',
            );
          }
          const end = payload?.endAt ?? new Date(start.getTime() + 60 * 60 * 1000);
          if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
            throw new WorkflowInterviewStateError(
              'Proposed interview end time must be strictly after start time.',
            );
          }
          const tz = payload?.timezone ?? 'UTC';
          if (!isValidIanaTimezone(tz)) {
            throw new WorkflowInterviewStateError(`Invalid IANA timezone identifier: "${tz}".`);
          }

          if (proposal) {
            if (proposal.status !== 'PROPOSED') {
              throw new WorkflowInterviewStateError(
                `Cannot propose alternative for interview proposal with status "${proposal.status}". Must be PROPOSED.`,
              );
            }
            const updated = await tx.interviewProposal.updateMany({
              where: {
                id: proposal.id,
                submissionId: submission.id,
                organizationId,
                status: 'PROPOSED',
              },
              data: { status: 'RESCHEDULED', updatedAt: now },
            });
            if (updated.count === 0) {
              throw new WorkflowInterviewStateError(
                'Interview proposal state has already changed.',
              );
            }
          }

          const altProposal = await tx.interviewProposal.create({
            data: {
              organizationId,
              submissionId,
              requisitionId,
              proposerUserId: recruiterId,
              proposerRole: 'RECRUITER',
              startAt: start,
              endAt: end,
              timezone: tz,
              format: payload?.format ?? 'VIDEO',
              status: 'PROPOSED',
              reason: payload?.reason ?? 'Alternative interview window proposed by recruiter',
            },
          });

          if (submission.status !== 'INTERVIEW_PROPOSED') {
            await tx.candidateSubmission.update({
              where: { id: submissionId },
              data: { status: 'INTERVIEW_PROPOSED', updatedAt: now },
            });
          }

          await tx.pipelineEvent.create({
            data: {
              organizationId,
              requisitionId,
              candidateId: submission.candidateId,
              submissionId,
              fromStage:
                submission.status === 'CLIENT_SHORTLISTED'
                  ? 'CLIENT_SHORTLISTED'
                  : submission.status === 'INTERVIEW_PROPOSED'
                    ? 'INTERVIEW_PROPOSED'
                    : 'SUBMITTED_TO_CLIENT',
              toStage: 'INTERVIEW_PROPOSED',
              actorId: recruiterId,
              reason: 'Recruiter proposed alternative interview window',
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'INTERVIEW_ALTERNATIVE_PROPOSED',
              resourceType: 'InterviewProposal',
              resourceId: altProposal.id,
              requisitionId,
              clientId: requisition.clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                proposalId: altProposal.id,
                startAt: start.toISOString(),
                endAt: end.toISOString(),
                timezone: altProposal.timezone,
                reason: payload?.reason,
              },
            },
          });

          const clientManagers = await tx.clientMembership.findMany({
            where: { clientId: requisition.clientId, organizationId, status: 'ACTIVE' },
            include: { user: { select: { email: true } } },
          });

          for (const manager of clientManagers) {
            const outboxId = randomUUID();
            const idempotencyKey = createEmailIdempotencyKey(
              'interview_notification',
              manager.user.email,
              `${altProposal.id}:PROPOSED`,
            );
            const rendered = renderInterviewNotification({
              recipientRole: 'CLIENT_HIRING_MANAGER',
              candidateCode: submission.candidate?.candidateCode ?? 'Candidate',
              requisitionTitle: requisition.title,
              format: altProposal.format,
              scheduledAt: altProposal.startAt.toISOString(),
              timezone: altProposal.timezone,
            });

            const { encryptedPayload, keyId } = encryptEmailPayload(
              {
                recipientEmail: manager.user.email.trim().toLowerCase(),
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              },
              { recordId: outboxId, idempotencyKey },
            );

            await tx.emailOutbox.create({
              data: {
                id: outboxId,
                organizationId,
                idempotencyKey,
                messageType: 'interview_notification',
                recipientEmail: null,
                recipientRole: 'CLIENT_HIRING_MANAGER',
                subject: null,
                html: null,
                text: null,
                encryptedPayload,
                keyId,
                status: 'PENDING',
                attempts: 0,
                maxAttempts: 3,
              },
            });
          }

          return { success: true, action, proposalId: altProposal.id };
        } else if (action === 'COMPLETE') {
          if (!proposal) {
            throw new WorkflowInterviewNotFoundError();
          }
          if (proposal.status !== 'ACCEPTED') {
            throw new WorkflowInterviewStateError(
              `Cannot complete interview proposal with status "${proposal.status}". Only ACCEPTED interviews can be marked completed.`,
            );
          }

          const updated = await tx.interviewProposal.updateMany({
            where: {
              id: proposal.id,
              submissionId: submission.id,
              organizationId,
              status: 'ACCEPTED',
            },
            data: { status: 'COMPLETED', updatedAt: now },
          });
          if (updated.count === 0) {
            throw new WorkflowInterviewStateError('Interview proposal state has already changed.');
          }

          await tx.pipelineEvent.create({
            data: {
              organizationId,
              requisitionId,
              candidateId: submission.candidateId,
              submissionId,
              fromStage: 'INTERVIEW_SCHEDULED',
              toStage: 'INTERVIEW_COMPLETED',
              actorId: recruiterId,
              reason: 'Interview marked as completed',
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'INTERVIEW_COMPLETED',
              resourceType: 'CandidateSubmission',
              resourceId: submissionId,
              requisitionId,
              clientId: requisition.clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                proposalId: proposal.id,
              },
            },
          });
        }

        return { success: true, action };
      });
    },

    async respondToInterviewAsClient(
      organizationId,
      clientId,
      submissionId,
      proposalId,
      clientUserId,
      membershipId,
      action,
      reason,
    ) {
      if (action === 'REJECT') {
        if (!reason || reason.trim().length < 3) {
          throw new WorkflowInterviewStateError('Rejection reason must be at least 3 characters.');
        }
      }

      if (reason) {
        const fairnessResult = evaluateFeedbackFairness(reason);
        if (fairnessResult.isProhibited) {
          const sub = await database.candidateSubmission.findFirst({
            where: { id: submissionId, clientId, organizationId },
            select: { requisitionId: true, candidateId: true },
          });
          await database.auditLog.create({
            data: {
              organizationId,
              actorId: clientUserId,
              action: 'CLIENT_FEEDBACK_PROHIBITED_DETECTED',
              resourceType: 'InterviewProposal',
              resourceId: proposalId,
              requisitionId: sub?.requisitionId ?? null,
              clientId,
              candidateId: sub?.candidateId ?? null,
              metadataJson: {
                submissionId,
                proposalId,
                action,
                submittedReason: reason,
                prohibitedCategory: fairnessResult.category,
                prohibitedReason: fairnessResult.reason,
              },
            },
          });
          throw new WorkflowProhibitedFeedbackError(
            `Feedback contains prohibited discriminatory content (${fairnessResult.category}): ${fairnessResult.reason}`,
            fairnessResult.category,
          );
        }
      }

      return database.$transaction(async (tx) => {
        const submission = await tx.candidateSubmission.findFirst({
          where: {
            id: submissionId,
            clientId,
            organizationId,
          },
          select: {
            id: true,
            requisitionId: true,
            candidateId: true,
            status: true,
            requisition: {
              select: {
                title: true,
                assignedRecruiter: { select: { email: true } },
              },
            },
            candidate: {
              select: { candidateCode: true },
            },
          },
        });

        if (!submission) {
          throw new WorkflowSubmissionNotFoundError();
        }

        const activeConsent = await tx.candidateConsent.findFirst({
          where: {
            organizationId,
            candidateId: submission.candidateId,
            requisitionId: submission.requisitionId,
            purpose: 'HIRING_USE',
            status: 'ACTIVE',
            withdrawnAt: null,
            policyVersion: { not: '' },
          },
          select: { id: true },
        });

        if (!activeConsent || submission.status === 'WITHDRAWN') {
          throw new WorkflowConsentRequiredError();
        }

        if (submission.status === 'CLIENT_REJECTED') {
          throw new WorkflowSubmissionStateError(
            'Cannot respond to interview proposal on a rejected submission.',
          );
        }

        const proposal = await tx.interviewProposal.findFirst({
          where: {
            id: proposalId,
            submissionId,
            organizationId,
            requisitionId: submission.requisitionId,
          },
        });

        if (!proposal) {
          throw new WorkflowInterviewNotFoundError();
        }

        if (proposal.status !== 'PROPOSED') {
          throw new WorkflowInterviewStateError(
            `Cannot ${action.toLowerCase()} interview proposal with status "${proposal.status}". Must be PROPOSED.`,
          );
        }

        if (proposal.proposerRole !== 'RECRUITER' || proposal.proposerUserId === clientUserId) {
          throw new WorkflowInterviewStateError(
            'Client cannot respond to a proposal created by a client; recruiter counterparty proposal is required.',
          );
        }

        const now = new Date();
        if (
          action === 'ACCEPT' &&
          ((proposal.expiresAt && proposal.expiresAt.getTime() <= now.getTime()) ||
            proposal.startAt.getTime() <= now.getTime() ||
            proposal.endAt.getTime() <= now.getTime())
        ) {
          throw new WorkflowInterviewStateError('Interview proposal has expired.');
        }

        if (action === 'ACCEPT') {
          const updated = await tx.interviewProposal.updateMany({
            where: {
              id: proposal.id,
              submissionId,
              organizationId,
              status: 'PROPOSED',
            },
            data: {
              status: 'ACCEPTED',
              updatedAt: now,
            },
          });
          if (updated.count === 0) {
            throw new WorkflowInterviewStateError('Interview proposal state has already changed.');
          }

          await tx.candidateSubmission.update({
            where: { id: submissionId },
            data: {
              updatedAt: now,
            },
          });

          await tx.pipelineEvent.create({
            data: {
              organizationId,
              requisitionId: submission.requisitionId,
              candidateId: submission.candidateId,
              submissionId,
              fromStage: 'INTERVIEW_PROPOSED',
              toStage: 'INTERVIEW_SCHEDULED',
              actorId: clientUserId,
              reason: reason ?? 'Client accepted interview proposal',
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: clientUserId,
              action: 'INTERVIEW_ACCEPTED',
              resourceType: 'InterviewProposal',
              resourceId: proposal.id,
              requisitionId: submission.requisitionId,
              clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                proposalId: proposal.id,
                startAt: proposal.startAt.toISOString(),
                endAt: proposal.endAt.toISOString(),
                timezone: proposal.timezone,
                membershipId,
              },
            },
          });

          const recruiterEmail = submission.requisition.assignedRecruiter?.email;
          if (recruiterEmail) {
            const outboxId = randomUUID();
            const idempotencyKey = createEmailIdempotencyKey(
              'interview_notification',
              recruiterEmail,
              `${proposal.id}:ACCEPTED`,
            );
            const rendered = renderInterviewNotification({
              recipientRole: 'RECRUITER',
              candidateCode: submission.candidate.candidateCode,
              requisitionTitle: submission.requisition.title,
              format: proposal.format,
              scheduledAt: proposal.startAt.toISOString(),
              timezone: proposal.timezone,
            });

            const { encryptedPayload, keyId } = encryptEmailPayload(
              {
                recipientEmail: recruiterEmail.trim().toLowerCase(),
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              },
              { recordId: outboxId, idempotencyKey },
            );

            await tx.emailOutbox.create({
              data: {
                id: outboxId,
                organizationId,
                idempotencyKey,
                messageType: 'interview_notification',
                recipientEmail: null,
                recipientRole: 'RECRUITER',
                subject: null,
                html: null,
                text: null,
                encryptedPayload,
                keyId,
                status: 'PENDING',
                attempts: 0,
                maxAttempts: 3,
              },
            });
          }

          return {
            success: true,
            action: 'ACCEPT',
            proposalId: proposal.id,
            status: 'ACCEPTED' as const,
          };
        } else {
          const updated = await tx.interviewProposal.updateMany({
            where: {
              id: proposal.id,
              submissionId,
              organizationId,
              status: 'PROPOSED',
            },
            data: {
              status: 'REJECTED',
              reason: reason!.trim(),
              updatedAt: now,
            },
          });
          if (updated.count === 0) {
            throw new WorkflowInterviewStateError('Interview proposal state has already changed.');
          }

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: clientUserId,
              action: 'INTERVIEW_PROPOSAL_REJECTED',
              resourceType: 'InterviewProposal',
              resourceId: proposal.id,
              requisitionId: submission.requisitionId,
              clientId,
              candidateId: submission.candidateId,
              metadataJson: {
                submissionId,
                proposalId: proposal.id,
                reason: reason!.trim(),
                membershipId,
              },
            },
          });

          const recruiterEmail = submission.requisition.assignedRecruiter?.email;
          if (recruiterEmail) {
            const outboxId = randomUUID();
            const idempotencyKey = createEmailIdempotencyKey(
              'interview_notification',
              recruiterEmail,
              `${proposal.id}:REJECTED`,
            );
            const rendered = renderInterviewNotification({
              recipientRole: 'RECRUITER',
              candidateCode: submission.candidate.candidateCode,
              requisitionTitle: submission.requisition.title,
              format: proposal.format,
              scheduledAt: proposal.startAt.toISOString(),
              timezone: proposal.timezone,
            });

            const { encryptedPayload, keyId } = encryptEmailPayload(
              {
                recipientEmail: recruiterEmail.trim().toLowerCase(),
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              },
              { recordId: outboxId, idempotencyKey },
            );

            await tx.emailOutbox.create({
              data: {
                id: outboxId,
                organizationId,
                idempotencyKey,
                messageType: 'interview_notification',
                recipientEmail: null,
                recipientRole: 'RECRUITER',
                subject: null,
                html: null,
                text: null,
                encryptedPayload,
                keyId,
                status: 'PENDING',
                attempts: 0,
                maxAttempts: 3,
              },
            });
          }

          return {
            success: true,
            action: 'REJECT',
            proposalId: proposal.id,
            status: 'REJECTED' as const,
          };
        }
      });
    },

    async listAuthorizedClients(organizationId, userId, role, options) {
      if (role === 'RECRUITER') {
        const includeInactive = options?.includeInactive === true;
        const clients = await database.client.findMany({
          where: {
            organizationId,
            ...(includeInactive ? {} : { status: 'ACTIVE' }),
          },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        return clients;
      }

      if (role === 'CLIENT_HIRING_MANAGER') {
        const memberships = await database.clientMembership.findMany({
          where: {
            organizationId,
            userId,
            status: 'ACTIVE',
            client: {
              organizationId,
              status: 'ACTIVE',
            },
          },
          include: {
            client: {
              select: {
                id: true,
                name: true,
                status: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
          orderBy: {
            client: { name: 'asc' },
          },
        });

        return memberships.map((m) => ({
          id: m.client.id,
          name: m.client.name,
          status: m.client.status,
          createdAt: m.client.createdAt,
          updatedAt: m.client.updatedAt,
          membershipId: m.id,
          membershipRole: m.role,
        }));
      }

      return [];
    },

    async createClient(organizationId, recruiterId, input) {
      const displayName = normalizeClientDisplayName(input.name);
      const normalizedName = normalizeClientLookupName(input.name);

      try {
        return await database.$transaction(async (tx) => {
          const created = await tx.client.create({
            data: {
              organizationId,
              name: displayName,
              normalizedName,
              status: 'ACTIVE',
            },
            select: {
              id: true,
              name: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'CLIENT_CREATED',
              resourceType: 'Client',
              resourceId: created.id,
              clientId: created.id,
              metadataJson: {
                name: created.name,
                status: created.status,
              },
            },
          });

          return created;
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new WorkflowClientConflictError();
        }
        throw error;
      }
    },

    async updateClient(organizationId, recruiterId, clientId, input) {
      const data: {
        name?: string;
        normalizedName?: string;
        status?: 'ACTIVE' | 'INACTIVE';
      } = {};

      if (input.name !== undefined) {
        data.name = normalizeClientDisplayName(input.name);
        data.normalizedName = normalizeClientLookupName(input.name);
      }
      if (input.status !== undefined) {
        data.status = input.status;
      }

      try {
        return await database.$transaction(async (tx) => {
          const existing = await tx.client.findFirst({
            where: {
              id: clientId,
              organizationId,
            },
            select: {
              id: true,
              name: true,
              status: true,
            },
          });

          if (!existing) {
            return null;
          }

          const updatedCount = await tx.client.updateMany({
            where: {
              id: clientId,
              organizationId,
            },
            data,
          });

          if (updatedCount.count !== 1) {
            return null;
          }

          const updated = await tx.client.findFirst({
            where: {
              id: clientId,
              organizationId,
            },
            select: {
              id: true,
              name: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          if (!updated) {
            return null;
          }

          await tx.auditLog.create({
            data: {
              organizationId,
              actorId: recruiterId,
              action: 'CLIENT_UPDATED',
              resourceType: 'Client',
              resourceId: updated.id,
              clientId: updated.id,
              metadataJson: {
                previousName: existing.name,
                name: updated.name,
                previousStatus: existing.status,
                status: updated.status,
              },
            },
          });

          return updated;
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new WorkflowClientConflictError();
        }
        throw error;
      }
    },

    async getCandidateTimeline(organizationId, recruiterId, requisitionId, candidateId, options) {
      if (!organizationId || !recruiterId || !requisitionId || !candidateId) {
        return null;
      }
      const requisition = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        select: { id: true },
      });
      if (!requisition) return null;

      const candidate = await database.candidate.findFirst({
        where: {
          id: candidateId,
          organizationId,
          resumes: {
            some: {
              processingJobs: {
                some: {
                  batch: {
                    requisitionId,
                  },
                },
              },
            },
          },
        },
        select: { id: true, candidateCode: true },
      });
      if (!candidate) return null;

      const [events, total] = await Promise.all([
        database.pipelineEvent.findMany({
          where: {
            organizationId,
            requisitionId,
            candidateId,
          },
          include: {
            actor: {
              select: { role: true },
            },
          },
          orderBy: { createdAt: 'asc' },
          take: options.limit,
          skip: options.offset,
        }),
        database.pipelineEvent.count({
          where: {
            organizationId,
            requisitionId,
            candidateId,
          },
        }),
      ]);

      return {
        candidate,
        items: events.map((ev) => ({
          id: ev.id,
          fromStage: ev.fromStage,
          toStage: ev.toStage,
          actorRole: ev.actor.role,
          submissionId: ev.submissionId,
          reason: ev.reason,
          createdAt: ev.createdAt,
        })),
        total,
      };
    },
  };
}
