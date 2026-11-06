import { randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { encryptEmailPayload } from '../email/email.crypto.js';
import type {
  ConsentAcceptResult,
  ConsentDeclineResult,
  ConsentInvitationDto,
  ConsentNoticeData,
  ConsentWithdrawalConfirmResult,
} from './consent.types.js';

export interface AuthorizedInvitationContext {
  requisition: {
    id: string;
    organizationId: string;
    title: string;
    clientName: string;
    organizationName: string;
  };
  candidate: {
    id: string;
    organizationId: string;
    candidateCode: string;
  };
}

export interface ConsentRepository {
  findAuthorizedInvitationContext(
    organizationId: string,
    recruiterId: string,
    requisitionId: string,
    candidateId: string,
  ): Promise<AuthorizedInvitationContext | null>;

  createInvitation(data: {
    organizationId: string;
    candidateId: string;
    requisitionId: string;
    createdById: string;
    tokenHash: string;
    email: string;
    policyVersion: string;
    noticeTextHash: string;
    expiresAt: Date;
    emailPayload?: {
      subject: string;
      html: string;
      text: string;
      idempotencyKey: string;
    };
  }): Promise<ConsentInvitationDto>;

  updateInvitationDelivery(
    invitationId: string,
    deliveryStatus: 'SENT' | 'FAILED' | 'NOT_CONFIGURED',
    deliveryError?: string | null,
  ): Promise<void>;

  findPendingNoticeByTokenHash(tokenHash: string): Promise<ConsentNoticeData | null>;

  acceptInvitation(
    tokenHash: string,
    confirmationName: string,
  ): Promise<ConsentAcceptResult | null>;

  declineInvitation(tokenHash: string, reason?: string): Promise<ConsentDeclineResult | null>;

  findActiveConsentsForEmail(
    email: string,
    candidateCode?: string,
  ): Promise<
    Array<{
      organizationId: string;
      organizationName: string;
      candidateId: string;
      consentId: string;
      requisitionId?: string | null;
    }>
  >;

  createWithdrawalRequest(data: {
    organizationId: string;
    candidateId: string;
    consentId: string;
    tokenHash: string;
    email: string;
    expiresAt: Date;
    emailPayload?: {
      subject: string;
      html: string;
      text: string;
      idempotencyKey: string;
    };
  }): Promise<{ id: string }>;

  confirmWithdrawal(tokenHash: string): Promise<ConsentWithdrawalConfirmResult | null>;
}

export function createConsentRepository(
  database: PrismaClient = getDatabaseClient(),
): ConsentRepository {
  return {
    async findAuthorizedInvitationContext(organizationId, recruiterId, requisitionId, candidateId) {
      // 1. Requisition must belong to organization and be assigned to recruiter
      const requisition = await database.requisition.findFirst({
        where: {
          id: requisitionId,
          organizationId,
          assignedRecruiterId: recruiterId,
        },
        include: {
          client: { select: { name: true } },
          organization: { select: { name: true } },
        },
      });

      if (!requisition) return null;

      // 2. Candidate must belong to organization
      const candidate = await database.candidate.findFirst({
        where: { id: candidateId, organizationId },
        select: { id: true, organizationId: true, candidateCode: true },
      });

      if (!candidate) return null;

      // 3. Candidate must be legitimately associated with this requisition
      const associatedViaResume = await database.resumeDocument.findFirst({
        where: {
          candidateId,
          organizationId,
          processingJobs: {
            some: {
              batch: { requisitionId },
            },
          },
        },
        select: { id: true },
      });

      const associatedViaSubmission = associatedViaResume
        ? null
        : await database.candidateSubmission.findFirst({
            where: {
              candidateId,
              requisitionId,
              organizationId,
            },
            select: { id: true },
          });

      if (!associatedViaResume && !associatedViaSubmission) {
        return null;
      }

      return {
        requisition: {
          id: requisition.id,
          organizationId: requisition.organizationId,
          title: requisition.title,
          clientName: requisition.client.name,
          organizationName: requisition.organization.name,
        },
        candidate: {
          id: candidate.id,
          organizationId: candidate.organizationId,
          candidateCode: candidate.candidateCode,
        },
      };
    },

    async createInvitation(data) {
      return database.$transaction(async (tx) => {
        // Invalidate older pending invitations for the same candidate + requisition
        await tx.consentInvitation.updateMany({
          where: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            requisitionId: data.requisitionId,
            status: 'PENDING',
          },
          data: {
            status: 'SUPERSEDED',
            consumedAt: new Date(),
          },
        });

        const created = await tx.consentInvitation.create({
          data: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            requisitionId: data.requisitionId,
            createdById: data.createdById,
            tokenHash: data.tokenHash,
            email: data.email,
            purpose: 'HIRING_USE',
            status: 'PENDING',
            policyVersion: data.policyVersion,
            noticeTextHash: data.noticeTextHash,
            deliveryStatus: 'PENDING',
            expiresAt: data.expiresAt,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: data.organizationId,
            action: 'CONSENT_INVITATION_CREATED',
            resourceType: 'ConsentInvitation',
            resourceId: created.id,
            metadataJson: {
              candidateId: data.candidateId,
              requisitionId: data.requisitionId,
              email: data.email,
              policyVersion: data.policyVersion,
              noticeTextHash: data.noticeTextHash,
              expiresAt: data.expiresAt.toISOString(),
            },
          },
        });

        if (data.emailPayload) {
          const outboxId = randomUUID();
          const { encryptedPayload, keyId } = encryptEmailPayload(
            {
              recipientEmail: data.email.trim().toLowerCase(),
              subject: data.emailPayload.subject,
              html: data.emailPayload.html,
              text: data.emailPayload.text,
            },
            { recordId: outboxId, idempotencyKey: data.emailPayload.idempotencyKey },
          );

          await tx.emailOutbox.create({
            data: {
              id: outboxId,
              organizationId: data.organizationId,
              idempotencyKey: data.emailPayload.idempotencyKey,
              messageType: 'consent_invitation',
              recipientEmail: null,
              recipientRole: 'CANDIDATE',
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
          id: created.id,
          candidateId: created.candidateId,
          requisitionId: created.requisitionId,
          email: created.email,
          purpose: created.purpose,
          status: created.status,
          policyVersion: created.policyVersion,
          noticeTextHash: created.noticeTextHash,
          deliveryStatus: created.deliveryStatus,
          deliveryError: created.deliveryError,
          expiresAt: created.expiresAt.toISOString(),
          createdAt: created.createdAt.toISOString(),
        };
      });
    },

    async updateInvitationDelivery(invitationId, deliveryStatus, deliveryError) {
      await database.consentInvitation.update({
        where: { id: invitationId },
        data: {
          deliveryStatus,
          deliveryError: deliveryError?.slice(0, 500) ?? null,
        },
      });
    },

    async findPendingNoticeByTokenHash(tokenHash) {
      const invitation = await database.consentInvitation.findFirst({
        where: {
          tokenHash,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        include: {
          organization: { select: { name: true } },
          requisition: {
            select: {
              title: true,
              client: { select: { name: true } },
            },
          },
          candidate: { select: { candidateCode: true } },
        },
      });

      if (!invitation) return null;

      return {
        organizationName: invitation.organization.name,
        requisitionTitle: invitation.requisition.title,
        clientName: invitation.requisition.client.name,
        candidateCode: invitation.candidate.candidateCode,
        purpose: invitation.purpose,
        policyVersion: invitation.policyVersion,
        noticeTextHash: invitation.noticeTextHash,
        expiresAt: invitation.expiresAt.toISOString(),
      };
    },

    async acceptInvitation(tokenHash, confirmationName) {
      return database.$transaction(async (tx) => {
        // 1. Transaction-scoped serialization on the candidate record
        // Serializes concurrent acceptance requests for the same candidate to prevent racing duplicate active consents
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM "candidates"
          WHERE id = (
            SELECT candidate_id FROM "consent_invitations" WHERE token_hash = ${tokenHash}
          )
          FOR UPDATE
        `);

        // 2. Atomic conditional consumption of the invitation
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "consent_invitations"
          SET status = 'ACCEPTED',
              consumed_at = NOW(),
              updated_at = NOW()
          WHERE token_hash = ${tokenHash}
            AND status = 'PENDING'
            AND expires_at > NOW()
        `);

        if (updated === 0) {
          // Token expired, already consumed, superseded, or invalid
          return null;
        }

        const invitation = await tx.consentInvitation.findUnique({
          where: { tokenHash },
        });

        if (!invitation) return null;

        // 3. Prevent duplicate ACTIVE consent for the same scope.
        // Retire any prior active consent for this candidate, organization, requisition, and purpose
        // so repeated invitations cannot create ambiguous authorization.
        await tx.candidateConsent.updateMany({
          where: {
            organizationId: invitation.organizationId,
            candidateId: invitation.candidateId,
            requisitionId: invitation.requisitionId,
            purpose: invitation.purpose,
            status: 'ACTIVE',
          },
          data: {
            status: 'EXPIRED',
            updatedAt: new Date(),
          },
        });

        // 4. Insert fresh ACTIVE CandidateConsent record with requisition scope.
        // Protected by transaction serialization and PostgreSQL partial unique index
        // "candidate_consents_active_scope_unique_idx".
        let createdConsent;
        try {
          createdConsent = await tx.candidateConsent.create({
            data: {
              organizationId: invitation.organizationId,
              candidateId: invitation.candidateId,
              requisitionId: invitation.requisitionId,
              purpose: invitation.purpose,
              status: 'ACTIVE',
              policyVersion: invitation.policyVersion,
              noticeTextHash: invitation.noticeTextHash,
              confirmationName: confirmationName.trim(),
              captureMethod: 'CANDIDATE_PORTAL',
              capturedAt: new Date(),
            },
          });
        } catch (err: unknown) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Concurrency collision on partial unique index: competing request established active consent.
            // Transition this competing invitation to SUPERSEDED terminal state.
            await tx.consentInvitation.update({
              where: { id: invitation.id },
              data: { status: 'SUPERSEDED' },
            });
            return null;
          }
          throw err;
        }

        // 3. Atomically release ONLY held jobs matching this candidate AND this requisition.
        // Heal any inconsistent ResumeDocument marked PARSED without a valid COMPLETE extraction.
        await tx.$executeRaw(Prisma.sql`
          UPDATE "resume_documents" rd
          SET parse_status = 'PENDING',
              updated_at = NOW()
          WHERE rd.candidate_id = ${invitation.candidateId}::uuid
            AND rd.organization_id = ${invitation.organizationId}::uuid
            AND rd.parse_status = 'PARSED'
            AND NOT EXISTS (
              SELECT 1 FROM "document_extractions" de
              WHERE de.resume_document_id = rd.id
                AND de.organization_id = rd.organization_id
                AND de.version >= 1
                AND de.quality_status = 'COMPLETE'
                AND LENGTH(BTRIM(de.extracted_text)) > 0
            )
        `);

        // 3a. For held EXTRACT_TEXT jobs whose resume document is already validly PARSED with a COMPLETE extraction,
        // complete the job immediately without queuing redundant re-extraction.
        const reusedCompleted = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs" pj
          SET status = 'SUCCEEDED',
              finished_at = NOW(),
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE pj.organization_id = ${invitation.organizationId}::uuid
            AND pj.status = 'HELD_FOR_AUTHORIZATION'
            AND pj.job_type = 'EXTRACT_TEXT'
            AND pj.resume_document_id IN (
              SELECT rd.id FROM "resume_documents" rd
              WHERE rd.candidate_id = ${invitation.candidateId}::uuid
                AND rd.organization_id = ${invitation.organizationId}::uuid
                AND rd.parse_status = 'PARSED'
                AND rd.version >= 1
                AND EXISTS (
                  SELECT 1 FROM "document_extractions" de
                  WHERE de.resume_document_id = rd.id
                    AND de.organization_id = rd.organization_id
                    AND de.version >= 1
                    AND de.quality_status = 'COMPLETE'
                    AND LENGTH(BTRIM(de.extracted_text)) > 0
                )
            )
            AND pj.batch_id IN (
              SELECT pb.id FROM "processing_batches" pb
              WHERE pb.requisition_id = ${invitation.requisitionId}::uuid
                AND pb.organization_id = ${invitation.organizationId}::uuid
            )
        `);

        if (reusedCompleted > 0) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_batches" pb
            SET status = 'COMPLETED',
                updated_at = NOW()
            WHERE pb.organization_id = ${invitation.organizationId}::uuid
              AND pb.requisition_id = ${invitation.requisitionId}::uuid
              AND pb.status <> 'COMPLETED'
              AND EXISTS (
                SELECT 1 FROM "processing_jobs" pj
                WHERE pj.batch_id = pb.id
                  AND pj.organization_id = pb.organization_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM "processing_jobs" pj
                WHERE pj.batch_id = pb.id
                  AND pj.organization_id = pb.organization_id
                  AND pj.status <> 'SUCCEEDED'
              )
          `);
        }

        // 3b. Release remaining held jobs (unparsed EXTRACT_TEXT or ASSESS_CANDIDATE) to QUEUED.
        const releasedQueued = await tx.$executeRaw(Prisma.sql`
          UPDATE "processing_jobs"
          SET status = 'QUEUED',
              lease_expires_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              updated_at = NOW()
          WHERE organization_id = ${invitation.organizationId}::uuid
            AND status = 'HELD_FOR_AUTHORIZATION'
            AND resume_document_id IN (
              SELECT id FROM "resume_documents"
              WHERE candidate_id = ${invitation.candidateId}::uuid
                AND organization_id = ${invitation.organizationId}::uuid
            )
            AND batch_id IN (
              SELECT id FROM "processing_batches"
              WHERE requisition_id = ${invitation.requisitionId}::uuid
                AND organization_id = ${invitation.organizationId}::uuid
            )
        `);

        const released = Number(reusedCompleted) + Number(releasedQueued);

        // 4. Audit Log
        await tx.auditLog.create({
          data: {
            organizationId: invitation.organizationId,
            action: 'CONSENT_ACCEPTED_AND_RECORDED',
            resourceType: 'CandidateConsent',
            resourceId: invitation.candidateId,
            metadataJson: {
              invitationId: invitation.id,
              candidateId: invitation.candidateId,
              requisitionId: invitation.requisitionId,
              confirmationName: confirmationName.trim(),
              policyVersion: invitation.policyVersion,
              noticeTextHash: invitation.noticeTextHash,
              releasedJobCount: released,
            },
          },
        });

        return {
          status: 'ACCEPTED',
          consentId: createdConsent.id,
          candidateId: invitation.candidateId,
          requisitionId: invitation.requisitionId,
          purpose: invitation.purpose,
          policyVersion: invitation.policyVersion,
          capturedAt: createdConsent.capturedAt.toISOString(),
          releasedJobCount: released,
        };
      });
    },

    async declineInvitation(tokenHash, reason) {
      return database.$transaction(async (tx) => {
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "consent_invitations"
          SET status = 'DECLINED',
              consumed_at = NOW(),
              updated_at = NOW()
          WHERE token_hash = ${tokenHash}
            AND status = 'PENDING'
            AND expires_at > NOW()
        `);

        if (updated === 0) return null;

        const invitation = await tx.consentInvitation.findUnique({
          where: { tokenHash },
        });
        if (!invitation) return null;

        await tx.auditLog.create({
          data: {
            organizationId: invitation.organizationId,
            action: 'CONSENT_DECLINED',
            resourceType: 'ConsentInvitation',
            resourceId: invitation.id,
            metadataJson: {
              candidateId: invitation.candidateId,
              requisitionId: invitation.requisitionId,
              reason: reason ?? null,
            },
          },
        });

        return {
          status: 'DECLINED',
          candidateId: invitation.candidateId,
          requisitionId: invitation.requisitionId,
        };
      });
    },

    async findActiveConsentsForEmail(email, candidateCode) {
      // Find invitations accepted for this email address
      const invitations = await database.consentInvitation.findMany({
        where: {
          email: email.trim().toLowerCase(),
          status: 'ACCEPTED',
          ...(candidateCode ? { candidate: { candidateCode } } : {}),
        },
        include: {
          organization: { select: { id: true, name: true } },
          candidate: {
            select: {
              id: true,
              consents: {
                where: {
                  status: 'ACTIVE',
                  withdrawnAt: null,
                },
                select: {
                  id: true,
                  requisitionId: true,
                },
              },
            },
          },
        },
      });

      const results: Array<{
        organizationId: string;
        organizationName: string;
        candidateId: string;
        consentId: string;
        requisitionId?: string | null;
      }> = [];

      for (const inv of invitations) {
        for (const consent of inv.candidate.consents) {
          if (!results.some((r) => r.consentId === consent.id)) {
            results.push({
              organizationId: inv.organization.id,
              organizationName: inv.organization.name,
              candidateId: inv.candidate.id,
              consentId: consent.id,
              requisitionId: consent.requisitionId,
            });
          }
        }
      }

      return results;
    },

    async createWithdrawalRequest(data) {
      return database.$transaction(async (tx) => {
        const created = await tx.consentWithdrawalRequest.create({
          data: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            consentId: data.consentId,
            tokenHash: data.tokenHash,
            email: data.email,
            status: 'PENDING',
            expiresAt: data.expiresAt,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: data.organizationId,
            action: 'CONSENT_WITHDRAWAL_REQUESTED',
            resourceType: 'ConsentWithdrawalRequest',
            resourceId: created.id,
            metadataJson: {
              candidateId: data.candidateId,
              consentId: data.consentId,
              email: data.email,
              expiresAt: data.expiresAt.toISOString(),
            },
          },
        });

        if (data.emailPayload) {
          const outboxId = randomUUID();
          const { encryptedPayload, keyId } = encryptEmailPayload(
            {
              recipientEmail: data.email.trim().toLowerCase(),
              subject: data.emailPayload.subject,
              html: data.emailPayload.html,
              text: data.emailPayload.text,
            },
            { recordId: outboxId, idempotencyKey: data.emailPayload.idempotencyKey },
          );

          await tx.emailOutbox.create({
            data: {
              id: outboxId,
              organizationId: data.organizationId,
              idempotencyKey: data.emailPayload.idempotencyKey,
              messageType: 'withdrawal_verification',
              recipientEmail: null,
              recipientRole: 'CANDIDATE',
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

        return { id: created.id };
      });
    },

    async confirmWithdrawal(tokenHash) {
      return database.$transaction(async (tx) => {
        // 1. Atomically consume the withdrawal request
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "consent_withdrawal_requests"
          SET status = 'COMPLETED',
              consumed_at = NOW(),
              updated_at = NOW()
          WHERE token_hash = ${tokenHash}
            AND status = 'PENDING'
            AND expires_at > NOW()
        `);

        if (updated === 0) return null;

        const request = await tx.consentWithdrawalRequest.findUnique({
          where: { tokenHash },
          include: { consent: true },
        });

        if (!request) return null;

        // 2. Mark consent as WITHDRAWN.
        // Scope strictly to this organization, candidate, and requisition so that
        // withdrawing consent for a requisition marks ALL matching active consents withdrawn
        // (preventing any duplicate active consent from silently continuing to authorize the requisition),
        // while preserving independent active consents for other requisitions.
        const now = new Date();
        await tx.candidateConsent.updateMany({
          where: {
            organizationId: request.organizationId,
            candidateId: request.candidateId,
            requisitionId: request.consent.requisitionId,
            purpose: request.consent.purpose,
            status: 'ACTIVE',
          },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt: now,
          },
        });

        // Also ensure the specific request.consentId is marked WITHDRAWN if not already active
        await tx.candidateConsent.updateMany({
          where: { id: request.consentId },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt: now,
          },
        });

        // 3. Immediately hold matching processing jobs and clear lease fields strictly for this requisition
        let heldCount = 0;
        if (request.consent.requisitionId) {
          heldCount = await tx.$executeRaw(Prisma.sql`
            UPDATE "processing_jobs"
            SET status = 'HELD_FOR_AUTHORIZATION',
                lease_expires_at = NULL,
                locked_by = NULL,
                lease_token = NULL,
                updated_at = NOW()
            WHERE organization_id = ${request.organizationId}::uuid
              AND status IN ('QUEUED', 'RETRYABLE_FAILURE', 'PROCESSING')
              AND resume_document_id IN (
                SELECT id FROM "resume_documents"
                WHERE candidate_id = ${request.candidateId}::uuid
                  AND organization_id = ${request.organizationId}::uuid
              )
              AND batch_id IN (
                SELECT id FROM "processing_batches"
                WHERE requisition_id = ${request.consent.requisitionId}::uuid
                  AND organization_id = ${request.organizationId}::uuid
              )
          `);

          // 3b. Mark genuinely active submissions for this requisition as WITHDRAWN and emit pipeline events
          // Terminal submissions (CLIENT_REJECTED, WITHDRAWN, or those whose latest pipeline stage is JOINED) are preserved.
          const candidateSubmissions = await tx.candidateSubmission.findMany({
            where: {
              organizationId: request.organizationId,
              candidateId: request.candidateId,
              requisitionId: request.consent.requisitionId,
              status: { in: ['SUBMITTED', 'CLIENT_SHORTLISTED', 'INTERVIEW_PROPOSED'] },
            },
            include: {
              pipelineEvents: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { toStage: true },
              },
            },
          });

          const terminalPipelineStages = new Set<string>([
            'JOINED',
            'CLIENT_REJECTED',
            'RECRUITER_CLOSED',
            'CANDIDATE_WITHDREW',
          ]);

          const openSubmissions = candidateSubmissions.filter((sub) => {
            const latestStage = sub.pipelineEvents[0]?.toStage;
            return !latestStage || !terminalPipelineStages.has(latestStage);
          });

          if (openSubmissions.length > 0) {
            const openSubmissionIds = openSubmissions.map((sub) => sub.id);

            await tx.candidateSubmission.updateMany({
              where: {
                id: { in: openSubmissionIds },
                organizationId: request.organizationId,
                candidateId: request.candidateId,
                requisitionId: request.consent.requisitionId,
                status: { in: ['SUBMITTED', 'CLIENT_SHORTLISTED', 'INTERVIEW_PROPOSED'] },
              },
              data: {
                status: 'WITHDRAWN',
                updatedAt: now,
              },
            });

            // Cancel pending proposals (PROPOSED, RESCHEDULED) and invalidate future ACCEPTED interviews (start_at > NOW())
            // while strictly preserving completed interviews (COMPLETED) and past records (start_at <= NOW()).
            await tx.$executeRaw(Prisma.sql`
              UPDATE "interview_proposals"
              SET status = 'CANCELLED',
                  reason = 'Candidate consent withdrawn',
                  updated_at = NOW()
              WHERE organization_id = ${request.organizationId}::uuid
                AND requisition_id = ${request.consent.requisitionId}::uuid
                AND submission_id IN (${Prisma.join(
                  openSubmissionIds.map((id) => Prisma.sql`${id}::uuid`),
                )})
                AND (
                  status IN ('PROPOSED', 'RESCHEDULED')
                  OR (status = 'ACCEPTED' AND start_at > NOW())
                )
            `);

            const req = await tx.requisition.findUnique({
              where: { id: request.consent.requisitionId },
              select: { assignedRecruiterId: true },
            });
            const actorId = req?.assignedRecruiterId ?? request.consent.capturedById;

            for (const sub of openSubmissions) {
              const priorStage =
                sub.pipelineEvents[0]?.toStage ??
                (sub.status === 'CLIENT_SHORTLISTED'
                  ? 'CLIENT_SHORTLISTED'
                  : sub.status === 'INTERVIEW_PROPOSED'
                    ? 'INTERVIEW_PROPOSED'
                    : 'SUBMITTED_TO_CLIENT');

              if (actorId) {
                await tx.pipelineEvent.create({
                  data: {
                    organizationId: request.organizationId,
                    requisitionId: request.consent.requisitionId,
                    candidateId: request.candidateId,
                    submissionId: sub.id,
                    fromStage: priorStage,
                    toStage: 'CANDIDATE_WITHDREW',
                    actorId,
                    reason: 'Candidate consent withdrawn',
                  },
                });
              }

              await tx.auditLog.create({
                data: {
                  organizationId: request.organizationId,
                  action: 'SUBMISSION_WITHDRAWN_DUE_TO_CONSENT_REVOCATION',
                  resourceType: 'CandidateSubmission',
                  resourceId: sub.id,
                  requisitionId: request.consent.requisitionId,
                  candidateId: request.candidateId,
                  metadataJson: {
                    previousStatus: sub.status,
                    previousStage: priorStage,
                    consentId: request.consentId,
                  },
                },
              });
            }
          }
        }

        // 4. Audit Log
        await tx.auditLog.create({
          data: {
            organizationId: request.organizationId,
            action: 'CONSENT_WITHDRAWN_BY_CANDIDATE',
            resourceType: 'CandidateConsent',
            resourceId: request.consentId,
            metadataJson: {
              candidateId: request.candidateId,
              withdrawnAt: now.toISOString(),
              heldJobsCount: heldCount,
            },
          },
        });

        return {
          status: 'WITHDRAWN',
          candidateId: request.candidateId,
          withdrawnAt: now.toISOString(),
          heldJobCount: heldCount,
        };
      });
    },
  };
}
