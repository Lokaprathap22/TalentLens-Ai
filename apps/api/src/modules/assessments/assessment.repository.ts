import { randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import type { AuthenticatedPrincipal } from '../auth/session.service.js';
import type {
  AssessmentModelMetadata,
  CalculatedAssessmentSummary,
  CandidateAssessmentDto,
  CriterionAssessmentDto,
  EvidenceSnippetDto,
  ScorecardCriterionDefinition,
} from './assessment.types.js';

export interface AuthorizedAssessmentContext {
  requisitionId: string;
  candidateId: string;
  resumeDocumentId: string;
  documentExtractionId: string;
  scorecardVersionId: string;
  extractedText: string;
  pageMapJson: unknown;
  criteria: ScorecardCriterionDefinition[];
  consentId: string;
  consentNoticeHash: string;
}

export interface AssessmentRepository {
  findAuthorizedContext(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    resumeDocumentId: string,
  ): Promise<AuthorizedAssessmentContext | null>;

  findExistingAssessment(
    organizationId: string,
    requisitionId: string,
    candidateId: string,
    resumeDocumentId: string,
    scorecardVersionId: string,
  ): Promise<CandidateAssessmentDto | null>;

  findActiveJob(
    organizationId: string,
    requisitionId: string,
    resumeDocumentId: string,
  ): Promise<{ id: string; status: string } | null>;

  enqueueAssessmentJob(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    candidateId: string,
    resumeDocumentId: string,
  ): Promise<{ jobId: string; batchId: string; status: string }>;

  getAssessmentById(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    assessmentId: string,
  ): Promise<CandidateAssessmentDto | null>;

  listAssessments(
    principal: AuthenticatedPrincipal,
    requisitionId: string,
    resumeDocumentId?: string | undefined,
  ): Promise<CandidateAssessmentDto[]>;

  completeAssessment(params: {
    workerId: string;
    leaseToken: string;
    jobId: string;
    organizationId: string;
    requisitionId: string;
    candidateId: string;
    resumeDocumentId: string;
    documentExtractionId: string;
    scorecardVersionId: string;
    redactedText: string;
    pageMapJson: unknown;
    redactionMapJson: unknown;
    summary: CalculatedAssessmentSummary;
    metadata: AssessmentModelMetadata;
  }): Promise<boolean>;

  failAssessmentJob(params: {
    workerId: string;
    leaseToken: string;
    jobId: string;
    status: 'FAILED' | 'RETRYABLE_FAILURE';
    errorCode: string;
    attempts: number;
  }): Promise<boolean>;
}

export function createAssessmentRepository(
  database: PrismaClient = getDatabaseClient(),
): AssessmentRepository {
  return {
    async findAuthorizedContext(principal, requisitionId, resumeDocumentId) {
      // 1. Requisition check (must belong to organization and be assigned to recruiter)
      const requisition = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId: principal.organizationId,
          assignedRecruiterId: principal.userId,
        },
        include: {
          scorecardVersions: {
            where: { status: 'APPROVED' },
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              criteria: {
                where: { active: true },
                orderBy: { displayOrder: 'asc' },
              },
            },
          },
        },
      });

      if (!requisition) return null;
      const approvedScorecard = requisition.scorecardVersions[0];
      if (!approvedScorecard || approvedScorecard.criteria.length === 0) return null;

      // 2. Resume Document check
      const resume = await database.resumeDocument.findFirst({
        where: {
          id: resumeDocumentId,
          organizationId: principal.organizationId,
          parseStatus: 'PARSED',
        },
        include: {
          extractions: {
            orderBy: { version: 'desc' },
            take: 1,
          },
        },
      });

      if (!resume || resume.extractions.length === 0) return null;
      const extraction = resume.extractions[0]!;

      // 3. Active Candidate Consent check strictly scoped to this requisition
      const consent = await database.candidateConsent.findFirst({
        where: {
          organizationId: principal.organizationId,
          candidateId: resume.candidateId,
          requisitionId,
          purpose: 'HIRING_USE',
          status: 'ACTIVE',
          withdrawnAt: null,
          policyVersion: { not: '' },
        },
        select: {
          id: true,
          noticeTextHash: true,
        },
      });

      if (!consent) return null;

      const criteria: ScorecardCriterionDefinition[] = approvedScorecard.criteria.map((c) => {
        let minScore: number | undefined;
        let maxScore: number | undefined;
        if (c.ruleJson && typeof c.ruleJson === 'object' && !Array.isArray(c.ruleJson)) {
          const rule = c.ruleJson as Record<string, unknown>;
          if (typeof rule['minScore'] === 'number') minScore = rule['minScore'];
          if (typeof rule['maxScore'] === 'number') maxScore = rule['maxScore'];
        }
        return {
          id: c.id,
          key: c.key,
          label: c.label,
          category: c.category,
          requirementType: c.requirementType as 'MUST_HAVE' | 'PREFERRED',
          weight: Number(c.weight),
          minScore,
          maxScore,
        };
      });

      return {
        requisitionId,
        candidateId: resume.candidateId,
        resumeDocumentId,
        documentExtractionId: extraction.id,
        scorecardVersionId: approvedScorecard.id,
        extractedText: extraction.extractedText,
        pageMapJson: extraction.pageMapJson,
        criteria,
        consentId: consent.id,
        consentNoticeHash: consent.noticeTextHash ?? '',
      };
    },

    async findExistingAssessment(
      organizationId,
      requisitionId,
      candidateId,
      resumeDocumentId,
      scorecardVersionId,
    ) {
      const assessment = await database.candidateAssessment.findFirst({
        where: {
          organizationId,
          requisitionId,
          candidateId,
          resumeDocumentId,
          scorecardVersionId,
        },
        include: {
          criterionAssessments: {
            include: {
              criterion: true,
              evidence: true,
            },
            orderBy: { criterion: { displayOrder: 'asc' } },
          },
        },
      });

      if (!assessment) return null;

      const criteriaDtos: CriterionAssessmentDto[] = assessment.criterionAssessments.map((ca) => ({
        id: ca.id,
        criterionId: ca.criterionId,
        criterionKey: ca.criterion.key,
        criterionLabel: ca.criterion.label,
        criterionCategory: ca.criterion.category,
        requirementType: ca.criterion.requirementType,
        weight: Number(ca.criterion.weight),
        status: ca.status,
        normalizedValue: ca.normalizedValue !== null ? Number(ca.normalizedValue) : null,
        explanation: ca.explanation,
        evidence: ca.evidence.map((e): EvidenceSnippetDto => ({
          id: e.id,
          quote: e.quote,
          pageNumber: e.pageNumber,
          startOffset: e.startOffset,
          endOffset: e.endOffset,
          verified: e.verified,
          verificationMethod: e.verificationMethod,
        })),
      }));

      return {
        id: assessment.id,
        organizationId: assessment.organizationId,
        requisitionId: assessment.requisitionId,
        candidateId: assessment.candidateId,
        resumeDocumentId: assessment.resumeDocumentId,
        scorecardVersionId: assessment.scorecardVersionId,
        score: assessment.score !== null ? Number(assessment.score) : null,
        coverage: assessment.coverage !== null ? Number(assessment.coverage) : null,
        isComplete: assessment.status === 'COMPLETE',
        status: assessment.status,
        formulaVersion: assessment.formulaVersion,
        modelMetadata: assessment.modelMetadataJson as unknown as AssessmentModelMetadata,
        createdAt: assessment.createdAt.toISOString(),
        updatedAt: assessment.updatedAt.toISOString(),
        criteria: criteriaDtos,
        humanReviewRequired: assessment.status === 'NEEDS_REVIEW',
      };
    },

    async findActiveJob(organizationId, requisitionId, resumeDocumentId) {
      const job = await database.processingJob.findFirst({
        where: {
          organizationId,
          resumeDocumentId,
          jobType: 'ASSESS_CANDIDATE',
          status: { in: ['QUEUED', 'PROCESSING', 'HELD_FOR_AUTHORIZATION'] },
          batch: { requisitionId },
        },
        select: { id: true, status: true },
      });
      return job ? { id: job.id, status: job.status } : null;
    },

    async enqueueAssessmentJob(principal, requisitionId, candidateId, resumeDocumentId) {
      return database.$transaction(async (tx) => {
        // Create an assessment batch
        const batch = await tx.processingBatch.create({
          data: {
            organizationId: principal.organizationId,
            requisitionId,
            createdById: principal.userId,
            totalFiles: 1,
            status: 'PROCESSING',
          },
        });

        // Create the processing job
        const job = await tx.processingJob.create({
          data: {
            batchId: batch.id,
            organizationId: principal.organizationId,
            resumeDocumentId,
            jobType: 'ASSESS_CANDIDATE',
            status: 'QUEUED',
            attempts: 0,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            action: 'ASSESSMENT_QUEUED',
            resourceType: 'ProcessingJob',
            resourceId: job.id,
            requisitionId,
            candidateId,
            metadataJson: { resumeDocumentId, batchId: batch.id },
          },
        });

        return {
          jobId: job.id,
          batchId: batch.id,
          status: job.status,
        };
      });
    },

    async getAssessmentById(principal, requisitionId, assessmentId) {
      const requisition = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId: principal.organizationId,
          assignedRecruiterId: principal.userId,
        },
        select: { id: true },
      });
      if (!requisition) return null;

      const assessment = await database.candidateAssessment.findFirst({
        where: {
          id: assessmentId,
          organizationId: principal.organizationId,
          requisitionId,
        },
        include: {
          criterionAssessments: {
            include: {
              criterion: true,
              evidence: true,
            },
            orderBy: { criterion: { displayOrder: 'asc' } },
          },
        },
      });

      if (!assessment) return null;

      const criteriaDtos: CriterionAssessmentDto[] = assessment.criterionAssessments.map((ca) => ({
        id: ca.id,
        criterionId: ca.criterionId,
        criterionKey: ca.criterion.key,
        criterionLabel: ca.criterion.label,
        criterionCategory: ca.criterion.category,
        requirementType: ca.criterion.requirementType,
        weight: Number(ca.criterion.weight),
        status: ca.status,
        normalizedValue: ca.normalizedValue !== null ? Number(ca.normalizedValue) : null,
        explanation: ca.explanation,
        evidence: ca.evidence.map((e): EvidenceSnippetDto => ({
          id: e.id,
          quote: e.quote,
          pageNumber: e.pageNumber,
          startOffset: e.startOffset,
          endOffset: e.endOffset,
          verified: e.verified,
          verificationMethod: e.verificationMethod,
        })),
      }));

      return {
        id: assessment.id,
        organizationId: assessment.organizationId,
        requisitionId: assessment.requisitionId,
        candidateId: assessment.candidateId,
        resumeDocumentId: assessment.resumeDocumentId,
        scorecardVersionId: assessment.scorecardVersionId,
        score: assessment.score !== null ? Number(assessment.score) : null,
        coverage: assessment.coverage !== null ? Number(assessment.coverage) : null,
        isComplete: assessment.status === 'COMPLETE',
        status: assessment.status,
        formulaVersion: assessment.formulaVersion,
        modelMetadata: assessment.modelMetadataJson as unknown as AssessmentModelMetadata,
        createdAt: assessment.createdAt.toISOString(),
        updatedAt: assessment.updatedAt.toISOString(),
        criteria: criteriaDtos,
        humanReviewRequired: assessment.status === 'NEEDS_REVIEW',
      };
    },

    async listAssessments(principal, requisitionId, resumeDocumentId) {
      const requisition = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId: principal.organizationId,
          assignedRecruiterId: principal.userId,
        },
        select: { id: true },
      });
      if (!requisition) return [];

      const assessments = await database.candidateAssessment.findMany({
        where: {
          organizationId: principal.organizationId,
          requisitionId,
          ...(resumeDocumentId ? { resumeDocumentId } : {}),
        },
        include: {
          criterionAssessments: {
            include: {
              criterion: true,
              evidence: true,
            },
            orderBy: { criterion: { displayOrder: 'asc' } },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return assessments.map((assessment) => ({
        id: assessment.id,
        organizationId: assessment.organizationId,
        requisitionId: assessment.requisitionId,
        candidateId: assessment.candidateId,
        resumeDocumentId: assessment.resumeDocumentId,
        scorecardVersionId: assessment.scorecardVersionId,
        score: assessment.score !== null ? Number(assessment.score) : null,
        coverage: assessment.coverage !== null ? Number(assessment.coverage) : null,
        isComplete: assessment.status === 'COMPLETE',
        status: assessment.status,
        formulaVersion: assessment.formulaVersion,
        modelMetadata: assessment.modelMetadataJson as unknown as AssessmentModelMetadata,
        createdAt: assessment.createdAt.toISOString(),
        updatedAt: assessment.updatedAt.toISOString(),
        criteria: assessment.criterionAssessments.map((ca) => ({
          id: ca.id,
          criterionId: ca.criterionId,
          criterionKey: ca.criterion.key,
          criterionLabel: ca.criterion.label,
          criterionCategory: ca.criterion.category,
          requirementType: ca.criterion.requirementType,
          weight: Number(ca.criterion.weight),
          status: ca.status,
          normalizedValue: ca.normalizedValue !== null ? Number(ca.normalizedValue) : null,
          explanation: ca.explanation,
          evidence: ca.evidence.map((e): EvidenceSnippetDto => ({
            id: e.id,
            quote: e.quote,
            pageNumber: e.pageNumber,
            startOffset: e.startOffset,
            endOffset: e.endOffset,
            verified: e.verified,
            verificationMethod: e.verificationMethod,
          })),
        })),
        humanReviewRequired: assessment.status === 'NEEDS_REVIEW',
      }));
    },

    async completeAssessment(params) {
      try {
        return await database.$transaction(async (tx) => {
          // 1a. Acquire row-level lock on the processing job
          const leaseLock = await tx.$executeRaw(Prisma.sql`
            SELECT id FROM "processing_jobs"
            WHERE id = ${params.jobId}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${params.workerId}
              AND lease_token = ${params.leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
            FOR UPDATE
          `);

          if (leaseLock === 0) {
            // Worker lost lease or lease expired prior to lock acquisition
            return false;
          }

          // 1b. Separately verify lease validity against actual wall-clock time AFTER the row lock is held,
          // because PostgreSQL's IndexScan may evaluate WHERE predicates before LockRows finishes waiting on a row lock.
          const postLockVerification = await tx.$executeRaw(Prisma.sql`
            SELECT id FROM "processing_jobs"
            WHERE id = ${params.jobId}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${params.workerId}
              AND lease_token = ${params.leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
          `);

          if (postLockVerification === 0) {
            // Lease expired while waiting for the processing_jobs row lock
            return false;
          }

          // 2. Re-validate candidate consent
          const consent = await tx.candidateConsent.findFirst({
            where: {
              organizationId: params.organizationId,
              candidateId: params.candidateId,
              requisitionId: params.requisitionId,
              purpose: 'HIRING_USE',
              status: 'ACTIVE',
              withdrawnAt: null,
              policyVersion: { not: '' },
            },
            select: { id: true },
          });

          if (!consent) {
            // Consent was withdrawn during inference!
            // Mark job held and clear lease (fenced by active worker lease)
            await tx.$executeRaw(Prisma.sql`
              UPDATE "processing_jobs"
              SET status = 'HELD_FOR_AUTHORIZATION',
                  lease_expires_at = NULL,
                  locked_by = NULL,
                  lease_token = NULL,
                  updated_at = NOW()
              WHERE id = ${params.jobId}::uuid
                AND status = 'PROCESSING'
                AND locked_by = ${params.workerId}
                AND lease_token = ${params.leaseToken}::uuid
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at > clock_timestamp()
            `);
            return false;
          }

          // 3. Upsert AssessmentText
          let assessmentText = await tx.assessmentText.findFirst({
            where: {
              resumeDocumentId: params.resumeDocumentId,
              version: 1,
            },
          });

          if (!assessmentText) {
            assessmentText = await tx.assessmentText.create({
              data: {
                organizationId: params.organizationId,
                documentExtractionId: params.documentExtractionId,
                resumeDocumentId: params.resumeDocumentId,
                version: 1,
                redactedText: params.redactedText,
                pageMapJson: params.pageMapJson as Prisma.InputJsonValue,
                redactionMapJson: params.redactionMapJson as Prisma.InputJsonValue,
                redactorVersion: '2026-11-redactor-v2',
              },
            });
          }

          // 4. Upsert CandidateAssessment
          const assessmentId = randomUUID();
          const candidateAssessment = await tx.candidateAssessment.upsert({
            where: {
              requisitionId_candidateId_resumeDocumentId_scorecardVersionId: {
                requisitionId: params.requisitionId,
                candidateId: params.candidateId,
                resumeDocumentId: params.resumeDocumentId,
                scorecardVersionId: params.scorecardVersionId,
              },
            },
            create: {
              id: assessmentId,
              organizationId: params.organizationId,
              requisitionId: params.requisitionId,
              candidateId: params.candidateId,
              resumeDocumentId: params.resumeDocumentId,
              documentExtractionId: params.documentExtractionId,
              scorecardVersionId: params.scorecardVersionId,
              assessmentTextId: assessmentText.id,
              score:
                params.summary.score !== null ? new Prisma.Decimal(params.summary.score) : null,
              coverage: new Prisma.Decimal(params.summary.coverage),
              status: params.summary.status,
              formulaVersion: params.summary.formulaVersion,
              modelMetadataJson: params.metadata as unknown as Prisma.InputJsonValue,
            },
            update: {
              score:
                params.summary.score !== null ? new Prisma.Decimal(params.summary.score) : null,
              coverage: new Prisma.Decimal(params.summary.coverage),
              status: params.summary.status,
              formulaVersion: params.summary.formulaVersion,
              modelMetadataJson: params.metadata as unknown as Prisma.InputJsonValue,
              updatedAt: new Date(),
            },
          });

          // 5. Replace existing criterion assessments and evidence snippets if updating
          await tx.evidenceSnippet.deleteMany({
            where: { assessmentId: candidateAssessment.id },
          });
          await tx.criterionAssessment.deleteMany({
            where: { assessmentId: candidateAssessment.id },
          });

          // 6. Persist CriterionAssessments and EvidenceSnippets
          for (const crit of params.summary.criterionResults) {
            const criterionAssessmentId = randomUUID();
            await tx.criterionAssessment.create({
              data: {
                id: criterionAssessmentId,
                organizationId: params.organizationId,
                assessmentId: candidateAssessment.id,
                criterionId: crit.criterionId,
                scorecardVersionId: params.scorecardVersionId,
                resumeDocumentId: params.resumeDocumentId,
                assessmentTextId: assessmentText.id,
                documentExtractionId: params.documentExtractionId,
                status: crit.status,
                normalizedValue:
                  crit.normalizedValue !== null ? new Prisma.Decimal(crit.normalizedValue) : null,
                explanation: crit.explanation,
              },
            });

            for (const ev of crit.evidenceSnippets) {
              await tx.evidenceSnippet.create({
                data: {
                  organizationId: params.organizationId,
                  criterionAssessmentId,
                  assessmentId: candidateAssessment.id,
                  scorecardVersionId: params.scorecardVersionId,
                  assessmentTextId: assessmentText.id,
                  resumeDocumentId: params.resumeDocumentId,
                  documentExtractionId: params.documentExtractionId,
                  quote: ev.quote,
                  pageNumber: ev.pageNumber,
                  startOffset: ev.startOffset,
                  endOffset: ev.endOffset,
                  verified: ev.verified,
                  verificationMethod: ev.verificationMethod,
                },
              });
            }
          }

          // 7. Fenced completion of ProcessingJob — if 0 rows match, throw to roll back all assessment writes
          const updatedJobCount = await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'SUCCEEDED',
                finished_at = NOW(),
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE id = ${params.jobId}::uuid
              AND status = 'PROCESSING'
              AND locked_by = ${params.workerId}
              AND lease_token = ${params.leaseToken}::uuid
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > clock_timestamp()
          `);

          if (updatedJobCount === 0) {
            throw new Error('STALE_WORKER_LEASE');
          }

          // 8. Audit log
          await tx.auditLog.create({
            data: {
              organizationId: params.organizationId,
              action: 'ASSESSMENT_COMPLETED',
              resourceType: 'CandidateAssessment',
              resourceId: candidateAssessment.id,
              requisitionId: params.requisitionId,
              candidateId: params.candidateId,
              metadataJson: {
                score: params.summary.score,
                coverage: params.summary.coverage,
                status: params.summary.status,
                jobId: params.jobId,
              },
            },
          });

          return true;
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'STALE_WORKER_LEASE') {
          return false;
        }
        throw err;
      }
    },

    async failAssessmentJob(params) {
      return database.$transaction(async (tx) => {
        const leaseLock = await tx.$executeRaw(Prisma.sql`
          SELECT id FROM "processing_jobs"
          WHERE id = ${params.jobId}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${params.workerId}
            AND lease_token = ${params.leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE
        `);

        if (leaseLock === 0) {
          return false;
        }

        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = ${params.status}::"ProcessingJobStatus",
              attempts = ${params.attempts},
              last_error_code = ${params.errorCode},
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              finished_at = CASE WHEN ${params.status} = 'FAILED' THEN NOW() ELSE finished_at END,
              updated_at = NOW()
          WHERE id = ${params.jobId}::uuid
            AND status = 'PROCESSING'
            AND locked_by = ${params.workerId}
            AND lease_token = ${params.leaseToken}::uuid
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > clock_timestamp()
        `);
        return updated > 0;
      });
    },
  };
}
