import { createHash, createHmac, randomUUID } from 'node:crypto';
import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { encryptEmailPayload, getIdempotencyHmacKey } from '../email/email.crypto.js';
import { StorageNotFoundError } from '../resumes/resume.storage.js';
import type {
  ConsentAcceptResult,
  ConsentDeclineResult,
  ConsentInvitationDto,
  ConsentNoticeData,
  ConsentWithdrawalConfirmResult,
  DeletionRequestDto,
  ProcessDeletionResult,
} from './consent.types.js';

export function computeContactFingerprint(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHmac('sha256', getIdempotencyHmacKey()).update(normalized).digest('hex');
}

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
    noticeText?: string | null;
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

  findCandidatesForDeletionByEmail(
    email: string,
    candidateCode?: string,
  ): Promise<
    Array<{
      organizationId: string;
      organizationName: string;
      candidateId: string;
    }>
  >;

  createDeletionVerification(data: {
    organizationId: string;
    candidateId: string;
    tokenHash: string;
    email: string;
    expiresAt: Date;
    coalesceWindowMs?: number;
    emailPayload?: {
      subject: string;
      html: string;
      text: string;
      idempotencyKey: string;
    };
  }): Promise<{ id: string; outboxId?: string | undefined; coalesced: boolean } | null>;

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
  }): Promise<{ id: string; outboxId?: string | undefined } | null>;

  confirmWithdrawal(tokenHash: string): Promise<ConsentWithdrawalConfirmResult | null>;

  isPolicyApprovedForOrganization?(organizationId: string, policyVersion: string): Promise<boolean>;

  recordOrganizationConsentPolicy?(
    organizationId: string,
    policyVersion: string,
    approvedById?: string,
  ): Promise<{ id: string; policyVersion: string; approvedAt: Date }>;

  createDeletionRequest(
    organizationId: string,
    candidateId: string,
    requestedById?: string | null,
  ): Promise<DeletionRequestDto>;

  findDeletionRequest(
    organizationId: string,
    requestId: string,
  ): Promise<DeletionRequestDto | null>;

  processDeletion(
    organizationId: string,
    requestId: string,
    storageDeleteFn: (objectKey: string) => Promise<void>,
    actorId?: string | null,
  ): Promise<ProcessDeletionResult>;

  confirmCandidateDeletion(
    tokenHash: string,
    storageDeleteFn: (objectKey: string) => Promise<void>,
  ): Promise<{ status: 'COMPLETED'; candidateId: string; deletionRequestId: string } | null>;
}

export function createConsentRepository(
  database: PrismaClient = getDatabaseClient(),
): ConsentRepository {
  async function eraseCandidateEmailOutbox(
    tx: Prisma.TransactionClient,
    organizationId: string,
    candidateId: string,
    now: Date,
  ): Promise<void> {
    if (typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function') {
      const erasedAtIso = now.toISOString();
      await tx.$executeRaw(Prisma.sql`
        UPDATE "email_outbox"
        SET
          status = CASE
            WHEN status IN ('PENDING', 'SENDING') THEN 'FAILED'::"EmailDeliveryStatus"
            ELSE status
          END,
          last_error = CASE
            WHEN status = 'SENT' THEN NULL
            WHEN status IN ('PENDING', 'SENDING') OR last_error_code = 'CANDIDATE_DELETION_PENDING'
              THEN 'Candidate deletion requested; pending email cancelled and erased to protect privacy'
            ELSE 'Delivery error details redacted following candidate deletion'
          END,
          last_error_code = CASE
            WHEN status = 'SENT' THEN NULL
            WHEN status IN ('PENDING', 'SENDING') OR last_error_code = 'CANDIDATE_DELETION_PENDING'
              THEN 'CANDIDATE_DELETION_PENDING'
            ELSE COALESCE(last_error_code, 'CANDIDATE_DATA_ERASED')
          END,
          idempotency_key = 'erased:' || id::text,
          encrypted_payload = NULL,
          key_id = NULL,
          recipient_email = NULL,
          html = NULL,
          text = NULL,
          subject = NULL,
          payload_json = CASE
            WHEN status = 'SENT'
                 AND payload_json IS NOT NULL
                 AND NULLIF(BTRIM(payload_json->>'messageId'), '') IS NOT NULL
              THEN jsonb_build_object(
                'erased', true,
                'erasedAt', ${erasedAtIso}::text,
                'messageId', payload_json->>'messageId'
              )
            ELSE jsonb_build_object(
              'erased', true,
              'erasedAt', ${erasedAtIso}::text
            )
          END,
          lease_token = NULL,
          lease_expires_at = NULL,
          locked_by = NULL,
          next_attempt_at = NULL,
          updated_at = NOW()
        WHERE (
          organization_id = ${organizationId}::uuid
          OR organization_id IS NULL
        )
        AND (
          payload_json->>'candidateId' = ${candidateId}::text
          OR STRPOS(idempotency_key, ${candidateId}::text) > 0
        )
      `);
      return;
    }

    const mockTx = tx as unknown as {
      emailOutbox?: {
        updateMany?(args: unknown): Promise<{ count: number }>;
        findMany?(args: unknown): Promise<Array<Record<string, unknown>>>;
        update?(args: unknown): Promise<unknown>;
      };
    };

    const erasedAtIso = now.toISOString();
    if (
      typeof mockTx.emailOutbox?.findMany === 'function' &&
      typeof mockTx.emailOutbox?.update === 'function'
    ) {
      const rows = await mockTx.emailOutbox.findMany({
        where: { organizationId },
      });
      for (const row of rows) {
        const pj = row['payloadJson'] as Record<string, unknown> | null | undefined;
        const idem = typeof row['idempotencyKey'] === 'string' ? row['idempotencyKey'] : '';
        if (pj?.['candidateId'] !== candidateId && !idem.includes(candidateId)) {
          continue;
        }
        const status = String(row['status'] ?? '');
        const lastErrorCode = row['lastErrorCode'] as string | null | undefined;
        const isPendingOrCancelled =
          status === 'PENDING' ||
          status === 'SENDING' ||
          lastErrorCode === 'CANDIDATE_DELETION_PENDING';
        const messageId =
          status === 'SENT' && typeof pj?.['messageId'] === 'string' && pj['messageId'].trim()
            ? pj['messageId']
            : undefined;
        await mockTx.emailOutbox.update({
          where: { id: row['id'] },
          data: {
            status: status === 'PENDING' || status === 'SENDING' ? 'FAILED' : status,
            lastErrorCode:
              status === 'SENT'
                ? null
                : isPendingOrCancelled
                  ? 'CANDIDATE_DELETION_PENDING'
                  : (lastErrorCode ?? 'CANDIDATE_DATA_ERASED'),
            lastError:
              status === 'SENT'
                ? null
                : isPendingOrCancelled
                  ? 'Candidate deletion requested; pending email cancelled and erased to protect privacy'
                  : 'Delivery error details redacted following candidate deletion',
            idempotencyKey: `erased:${String(row['id'])}`,
            encryptedPayload: null,
            keyId: null,
            recipientEmail: null,
            html: null,
            text: null,
            subject: null,
            payloadJson: messageId
              ? { erased: true, erasedAt: erasedAtIso, messageId }
              : { erased: true, erasedAt: erasedAtIso },
            leaseToken: null,
            leaseExpiresAt: null,
            lockedBy: null,
            nextAttemptAt: null,
            updatedAt: now,
          },
        });
      }
      return;
    }

    if (typeof mockTx.emailOutbox?.updateMany === 'function') {
      await mockTx.emailOutbox.updateMany({
        where: {
          organizationId,
          status: { in: ['PENDING', 'SENDING'] },
        },
        data: {
          status: 'FAILED',
          lastErrorCode: 'CANDIDATE_DELETION_PENDING',
          lastError:
            'Candidate deletion requested; pending email cancelled and erased to protect privacy',
          encryptedPayload: null,
          keyId: null,
          recipientEmail: null,
          html: null,
          text: null,
          subject: null,
          payloadJson: { erased: true, erasedAt: erasedAtIso },
          leaseToken: null,
          leaseExpiresAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          updatedAt: now,
        },
      });
    }
  }

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
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
            Prisma.sql`
              SELECT id, record_status
              FROM "candidates"
              WHERE id = ${data.candidateId}::uuid
                AND organization_id = ${data.organizationId}::uuid
              FOR UPDATE
            `,
          );
          if (!candidateRows?.[0] || candidateRows[0].record_status !== 'ACTIVE') {
            throw new Error('CANDIDATE_NOT_ACTIVE');
          }
        }

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
            noticeText: data.noticeText ?? null,
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
              policyVersion: data.policyVersion,
              noticeTextHash: data.noticeTextHash,
              expiresAt: data.expiresAt.toISOString(),
            },
          },
        });

        let outboxId: string | undefined;
        if (data.emailPayload) {
          outboxId = randomUUID();
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
              payloadJson: { candidateId: data.candidateId, requisitionId: data.requisitionId },
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
          noticeText: created.noticeText,
          deliveryStatus: created.deliveryStatus,
          deliveryError: created.deliveryError,
          expiresAt: created.expiresAt.toISOString(),
          createdAt: created.createdAt.toISOString(),
          outboxId,
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
        organizationId: invitation.organizationId,
        organizationName: invitation.organization.name,
        requisitionTitle: invitation.requisition.title,
        clientName: invitation.requisition.client.name,
        candidateCode: invitation.candidate.candidateCode,
        purpose: invitation.purpose,
        policyVersion: invitation.policyVersion,
        noticeTextHash: invitation.noticeTextHash,
        noticeText: invitation.noticeText,
        expiresAt: invitation.expiresAt.toISOString(),
      };
    },

    async acceptInvitation(tokenHash, confirmationName) {
      return database.$transaction(async (tx) => {
        // 1. Transaction-scoped serialization on the candidate record (global lock order: candidates -> consents -> processing_jobs)
        // Serializes concurrent acceptance requests for the same candidate to prevent racing duplicate active consents
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<
            Array<{ id: string; record_status?: string }>
          >(Prisma.sql`
            SELECT id, record_status FROM "candidates"
            WHERE id = (
              SELECT candidate_id FROM "consent_invitations" WHERE token_hash = ${tokenHash}
            )
            FOR UPDATE
          `);
          if (candidateRows?.[0]?.record_status && candidateRows[0].record_status !== 'ACTIVE') {
            return null;
          }
        }

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
              noticeText: invitation.noticeText ?? null,
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

    async findCandidatesForDeletionByEmail(email, candidateCode) {
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedCode = candidateCode?.trim();
      const hmacFingerprint = computeContactFingerprint(normalizedEmail);
      const sha256Fingerprint = createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
      const fingerprints = Array.from(new Set([hmacFingerprint, sha256Fingerprint]));

      const candidateFilter = {
        recordStatus: 'ACTIVE' as const,
        ...(normalizedCode
          ? { candidateCode: { equals: normalizedCode, mode: 'insensitive' as const } }
          : {}),
      };

      const [invitations, withdrawalRequests, identities] = await Promise.all([
        database.consentInvitation.findMany({
          where: {
            email: { equals: normalizedEmail, mode: 'insensitive' },
            candidate: candidateFilter,
          },
          select: {
            candidateId: true,
            organizationId: true,
            organization: { select: { id: true, name: true } },
          },
        }),
        database.consentWithdrawalRequest.findMany({
          where: {
            email: { equals: normalizedEmail, mode: 'insensitive' },
            candidate: candidateFilter,
          },
          select: {
            candidateId: true,
            organizationId: true,
            organization: { select: { id: true, name: true } },
          },
        }),
        database.candidateIdentity.findMany({
          where: {
            identityStatus: 'ACTIVE',
            contactFingerprint: { in: fingerprints },
            candidate: candidateFilter,
          },
          select: {
            candidateId: true,
            organizationId: true,
            candidate: {
              select: {
                organization: { select: { id: true, name: true } },
              },
            },
          },
        }),
      ]);

      const deduped = new Map<
        string,
        { organizationId: string; organizationName: string; candidateId: string }
      >();

      for (const inv of invitations) {
        const key = `${inv.organizationId}:${inv.candidateId}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            organizationId: inv.organization.id,
            organizationName: inv.organization.name,
            candidateId: inv.candidateId,
          });
        }
      }

      for (const wr of withdrawalRequests) {
        const key = `${wr.organizationId}:${wr.candidateId}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            organizationId: wr.organization.id,
            organizationName: wr.organization.name,
            candidateId: wr.candidateId,
          });
        }
      }

      for (const ident of identities) {
        const key = `${ident.organizationId}:${ident.candidateId}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            organizationId: ident.candidate.organization.id,
            organizationName: ident.candidate.organization.name,
            candidateId: ident.candidateId,
          });
        }
      }

      return Array.from(deduped.values());
    },

    async createDeletionVerification(data) {
      return database.$transaction(async (tx) => {
        // Lock candidate row FIRST (global lock order: candidates -> candidate_deletion_verifications -> email_outbox)
        let candidateStatus: string | undefined;
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<
            Array<{ id: string; record_status: string }>
          >(Prisma.sql`
            SELECT id, record_status
            FROM "candidates"
            WHERE id = ${data.candidateId}::uuid
              AND organization_id = ${data.organizationId}::uuid
            FOR UPDATE
          `);
          candidateStatus = candidateRows[0]?.record_status;
        } else if (typeof tx.candidate?.findFirst === 'function') {
          const candidate = await tx.candidate.findFirst({
            where: { id: data.candidateId, organizationId: data.organizationId },
            select: { id: true, recordStatus: true },
          });
          candidateStatus = candidate?.recordStatus;
        }

        if (candidateStatus !== 'ACTIVE') {
          return null;
        }

        const now = new Date();

        // Mark expired PENDING verifications for this candidate/organization as EXPIRED
        await tx.candidateDeletionVerification.updateMany({
          where: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            status: 'PENDING',
            expiresAt: { lte: now },
          },
          data: {
            status: 'EXPIRED',
            updatedAt: now,
          },
        });

        // Coalesce recent duplicate requests within cooldown window; otherwise supersede old PENDING row
        const existingPending = await tx.candidateDeletionVerification.findFirst({
          where: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            status: 'PENDING',
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        const coalesceWindowMs = data.coalesceWindowMs ?? 60_000;
        if (
          existingPending &&
          coalesceWindowMs > 0 &&
          now.getTime() - existingPending.createdAt.getTime() < coalesceWindowMs
        ) {
          return { id: existingPending.id, coalesced: true };
        }

        if (existingPending) {
          await tx.candidateDeletionVerification.updateMany({
            where: {
              organizationId: data.organizationId,
              candidateId: data.candidateId,
              status: 'PENDING',
            },
            data: {
              status: 'CANCELLED',
              updatedAt: now,
            },
          });
        }

        // Persist CandidateDeletionVerification without any plaintext PII
        const created = await tx.candidateDeletionVerification.create({
          data: {
            organizationId: data.organizationId,
            candidateId: data.candidateId,
            tokenHash: data.tokenHash,
            status: 'PENDING',
            expiresAt: data.expiresAt,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: data.organizationId,
            action: 'CANDIDATE_DELETION_VERIFICATION_REQUESTED',
            resourceType: 'CandidateDeletionVerification',
            resourceId: created.id,
            candidateId: data.candidateId,
            metadataJson: {
              verificationId: created.id,
              expiresAt: data.expiresAt.toISOString(),
            },
          },
        });

        let outboxId: string | undefined;
        if (data.emailPayload) {
          outboxId = randomUUID();
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
              messageType: 'candidate_deletion_verification',
              recipientEmail: null,
              recipientRole: 'CANDIDATE',
              subject: null,
              html: null,
              text: null,
              payloadJson: { candidateId: data.candidateId },
              encryptedPayload,
              keyId,
              status: 'PENDING',
              attempts: 0,
              maxAttempts: 3,
            },
          });
        }

        return { id: created.id, outboxId, coalesced: false };
      });
    },

    async createWithdrawalRequest(data) {
      return database.$transaction(async (tx) => {
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
            Prisma.sql`
              SELECT id, record_status
              FROM "candidates"
              WHERE id = ${data.candidateId}::uuid
                AND organization_id = ${data.organizationId}::uuid
              FOR UPDATE
            `,
          );
          if (!candidateRows?.[0] || candidateRows[0].record_status !== 'ACTIVE') {
            return null;
          }
        }

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
              expiresAt: data.expiresAt.toISOString(),
            },
          },
        });

        let outboxId: string | undefined;
        if (data.emailPayload) {
          outboxId = randomUUID();
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
              payloadJson: { candidateId: data.candidateId, consentId: data.consentId },
              encryptedPayload,
              keyId,
              status: 'PENDING',
              attempts: 0,
              maxAttempts: 3,
            },
          });
        }

        return { id: created.id, outboxId };
      });
    },

    async confirmWithdrawal(tokenHash) {
      return database.$transaction(async (tx) => {
        // Global lock order: lock candidate row FIRST (FOR UPDATE) before withdrawal_requests -> consents -> processing_jobs
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<Array<{ id: string; record_status: string }>>(
            Prisma.sql`
              SELECT c.id, c.record_status
              FROM "candidates" c
              INNER JOIN "consent_withdrawal_requests" cwr
                ON cwr.candidate_id = c.id
               AND cwr.organization_id = c.organization_id
              WHERE cwr.token_hash = ${tokenHash}
              FOR UPDATE OF c
            `,
          );
          if (!candidateRows?.[0] || candidateRows[0].record_status !== 'ACTIVE') {
            return null;
          }
        }

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

    async confirmCandidateDeletion(tokenHash, storageDeleteFn) {
      const now = new Date();
      // 1. Transactionally lock candidate FIRST, consume single-use deletion verification token,
      // cancel remaining pending tokens/jobs/emails, and create DeletionRequest
      const deletionResult = await database.$transaction(async (tx) => {
        let targetCandidateId: string | undefined;
        let targetOrganizationId: string | undefined;
        let candidateStatus: string | undefined;

        const hasRawQuery = typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function';
        const hasRawExecute = typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function';

        if (hasRawQuery && hasRawExecute) {
          // Lock candidate row FIRST (fail closed, zero catch fallback)
          const candidateRows = await tx.$queryRaw<
            Array<{ id: string; organization_id: string; record_status: string }>
          >(Prisma.sql`
            SELECT c.id, c.organization_id, c.record_status
            FROM "candidates" c
            INNER JOIN "candidate_deletion_verifications" cdv
              ON cdv.candidate_id = c.id
             AND cdv.organization_id = c.organization_id
            WHERE cdv.token_hash = ${tokenHash}
            FOR UPDATE OF c
          `);

          const candidateRow = candidateRows[0];
          if (!candidateRow || candidateRow.record_status !== 'ACTIVE') {
            return null;
          }

          targetCandidateId = candidateRow.id;
          targetOrganizationId = candidateRow.organization_id;
          candidateStatus = candidateRow.record_status;

          // Atomically consume the single-use verification token (rejects replay, cancelled, expired)
          const updated = await tx.$executeRaw(Prisma.sql`
            UPDATE "candidate_deletion_verifications"
            SET status = 'CONSUMED',
                consumed_at = NOW(),
                updated_at = NOW()
            WHERE token_hash = ${tokenHash}
              AND candidate_id = ${targetCandidateId}::uuid
              AND organization_id = ${targetOrganizationId}::uuid
              AND status = 'PENDING'
              AND expires_at > NOW()
          `);

          if (updated === 0) {
            return null;
          }
        } else {
          // Unit-test mock transaction fallback (only when raw SQL API is absent on mock)
          const verification = await tx.candidateDeletionVerification.findUnique({
            where: { tokenHash },
          });
          if (!verification || verification.status !== 'PENDING' || verification.expiresAt <= now) {
            return null;
          }

          const candidate = await tx.candidate.findFirst({
            where: { id: verification.candidateId, organizationId: verification.organizationId },
            select: { id: true, recordStatus: true },
          });
          if (!candidate || candidate.recordStatus !== 'ACTIVE') {
            return null;
          }

          const consumed = await tx.candidateDeletionVerification.updateMany({
            where: {
              tokenHash,
              status: 'PENDING',
              expiresAt: { gt: now },
            },
            data: {
              status: 'CONSUMED',
              consumedAt: now,
              updatedAt: now,
            },
          });
          if (consumed.count === 0) {
            return null;
          }

          targetCandidateId = verification.candidateId;
          targetOrganizationId = verification.organizationId;
          candidateStatus = candidate.recordStatus;
        }

        if (!targetCandidateId || !targetOrganizationId || candidateStatus !== 'ACTIVE') {
          return null;
        }

        if (
          typeof (tx as { candidateDeletionVerification?: { updateMany?: unknown } })
            .candidateDeletionVerification?.updateMany === 'function'
        ) {
          await tx.candidateDeletionVerification.updateMany({
            where: {
              organizationId: targetOrganizationId,
              candidateId: targetCandidateId,
              status: 'PENDING',
            },
            data: {
              status: 'CANCELLED',
              updatedAt: now,
            },
          });
        }

        // Atomically transition candidate to DELETION_PENDING
        await tx.candidate.update({
          where: { id: targetCandidateId },
          data: {
            recordStatus: 'DELETION_PENDING',
            updatedAt: now,
          },
        });

        // Abort/Cancel any pending or active processing jobs for this candidate
        await tx.processingJob.updateMany({
          where: {
            organizationId: targetOrganizationId,
            resumeDocument: { candidateId: targetCandidateId },
            status: { in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'] },
          },
          data: {
            status: 'FAILED',
            lastErrorCode: 'CANDIDATE_DELETION_PENDING',
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
            updatedAt: now,
          },
        });

        // Cancel and irreversibly erase all email outbox records for candidate across every state
        await eraseCandidateEmailOutbox(tx, targetOrganizationId, targetCandidateId, now);

        // Create the DeletionRequest record in REQUESTED status
        const deletionReq = await tx.deletionRequest.create({
          data: {
            organizationId: targetOrganizationId,
            candidateId: targetCandidateId,
            requestedById: null,
            status: 'REQUESTED',
          },
        });

        // Audit Log (no PII in metadata)
        await tx.auditLog.create({
          data: {
            organizationId: targetOrganizationId,
            action: 'CANDIDATE_DELETION_REQUESTED',
            resourceType: 'Candidate',
            resourceId: targetCandidateId,
            candidateId: targetCandidateId,
            metadataJson: {
              deletionRequestId: deletionReq.id,
              requestedVia: 'CANDIDATE_VERIFICATION_LINK',
            },
          },
        });

        return {
          candidateId: targetCandidateId,
          deletionRequestId: deletionReq.id,
          organizationId: targetOrganizationId,
        };
      });

      if (!deletionResult) {
        return null;
      }

      // Step 2: Execute durable processDeletion (cascades database deletions & object storage)
      await this.processDeletion(
        deletionResult.organizationId,
        deletionResult.deletionRequestId,
        storageDeleteFn,
        null,
      );

      return {
        status: 'COMPLETED',
        candidateId: deletionResult.candidateId,
        deletionRequestId: deletionResult.deletionRequestId,
      };
    },

    async isPolicyApprovedForOrganization(organizationId, policyVersion) {
      const record = await database.organizationConsentPolicy.findUnique({
        where: {
          organizationId_policyVersion: {
            organizationId,
            policyVersion,
          },
        },
      });
      return record !== null;
    },

    async recordOrganizationConsentPolicy(organizationId, policyVersion, approvedById) {
      return database.organizationConsentPolicy.upsert({
        where: {
          organizationId_policyVersion: {
            organizationId,
            policyVersion,
          },
        },
        create: {
          organizationId,
          policyVersion,
          approvedById: approvedById ?? null,
        },
        update: {
          approvedById: approvedById ?? null,
          approvedAt: new Date(),
        },
      });
    },

    async createDeletionRequest(organizationId, candidateId, requestedById) {
      return database.$transaction(async (tx) => {
        let candidateStatus: string | undefined;
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          const candidateRows = await tx.$queryRaw<
            Array<{ id: string; record_status: string }>
          >(Prisma.sql`
            SELECT id, record_status
            FROM "candidates"
            WHERE id = ${candidateId}::uuid
              AND organization_id = ${organizationId}::uuid
            FOR UPDATE
          `);
          candidateStatus = candidateRows[0]?.record_status;
        } else if (typeof tx.candidate?.findFirst === 'function') {
          const candidate = await tx.candidate.findFirst({
            where: { id: candidateId, organizationId },
            select: { id: true, recordStatus: true },
          });
          candidateStatus = candidate?.recordStatus;
        }

        if (!candidateStatus) {
          throw new Error('CANDIDATE_NOT_FOUND');
        }

        // If candidate was already deleted, ensure outbox erasure is idempotently complete and return existing completed request
        if (candidateStatus === 'DELETED') {
          await eraseCandidateEmailOutbox(tx, organizationId, candidateId, new Date());
          const existing = await tx.deletionRequest.findFirst({
            where: { organizationId, candidateId, status: 'COMPLETED' },
            orderBy: { requestedAt: 'desc' },
          });
          if (existing) {
            return {
              id: existing.id,
              candidateId: existing.candidateId,
              organizationId: existing.organizationId,
              status: existing.status,
              requestedAt: existing.requestedAt.toISOString(),
              processedAt: existing.processedAt?.toISOString() ?? null,
              resultSummary: existing.resultSummary,
            };
          }
        }

        const now = new Date();

        // Cancel any pending candidate self-deletion verification links for this candidate
        if (
          typeof (tx as { candidateDeletionVerification?: { updateMany?: unknown } })
            .candidateDeletionVerification?.updateMany === 'function'
        ) {
          await tx.candidateDeletionVerification.updateMany({
            where: {
              organizationId,
              candidateId,
              status: 'PENDING',
            },
            data: {
              status: 'CANCELLED',
              updatedAt: now,
            },
          });
        }

        // 1. Atomically set Candidate recordStatus = 'DELETION_PENDING'
        await tx.candidate.update({
          where: { id: candidateId },
          data: {
            recordStatus: 'DELETION_PENDING',
            updatedAt: now,
          },
        });

        // 2. Abort/Cancel any pending or active processing jobs for this candidate's documents
        await tx.processingJob.updateMany({
          where: {
            organizationId,
            resumeDocument: { candidateId },
            status: { in: ['QUEUED', 'PROCESSING', 'RETRYABLE_FAILURE', 'HELD_FOR_AUTHORIZATION'] },
          },
          data: {
            status: 'FAILED',
            lastErrorCode: 'CANDIDATE_DELETION_PENDING',
            leaseExpiresAt: null,
            lockedBy: null,
            leaseToken: null,
            updatedAt: now,
          },
        });

        // 2b. Cancel and irreversibly erase all email outbox records for candidate across every state
        await eraseCandidateEmailOutbox(tx, organizationId, candidateId, now);

        // 3. Create the DeletionRequest record in REQUESTED status
        const record = await tx.deletionRequest.create({
          data: {
            organizationId,
            candidateId,
            requestedById: requestedById ?? null,
            status: 'REQUESTED',
          },
        });

        // 4. Compliance Audit Log (no candidate PII in metadata)
        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: requestedById ?? null,
            action: 'CANDIDATE_DELETION_REQUESTED',
            resourceType: 'Candidate',
            resourceId: candidateId,
            candidateId,
            metadataJson: {
              deletionRequestId: record.id,
              requestedById: requestedById ?? null,
            },
          },
        });

        return {
          id: record.id,
          candidateId: record.candidateId,
          organizationId: record.organizationId,
          status: record.status,
          requestedAt: record.requestedAt.toISOString(),
          processedAt: record.processedAt?.toISOString() ?? null,
          resultSummary: record.resultSummary,
        };
      });
    },

    async findDeletionRequest(organizationId, requestId) {
      const record = await database.deletionRequest.findFirst({
        where: { id: requestId, organizationId },
      });

      if (!record) return null;

      return {
        id: record.id,
        candidateId: record.candidateId,
        organizationId: record.organizationId,
        status: record.status,
        requestedAt: record.requestedAt.toISOString(),
        processedAt: record.processedAt?.toISOString() ?? null,
        resultSummary: record.resultSummary,
      };
    },

    async processDeletion(organizationId, requestId, storageDeleteFn, actorId) {
      const deletionReq = await database.deletionRequest.findFirst({
        where: { id: requestId, organizationId },
      });

      if (!deletionReq) {
        throw new Error('DELETION_REQUEST_NOT_FOUND');
      }

      if (deletionReq.status === 'COMPLETED') {
        return {
          deletionRequestId: deletionReq.id,
          candidateId: deletionReq.candidateId,
          status: 'COMPLETED',
          deletedResumeCount: 0,
          anonymizedRecords: [
            'CandidateProfile',
            'CandidateSkill',
            'ResumeDocument',
            'DocumentExtraction',
            'CandidateAssessment',
            'CandidateSubmission',
            'InterviewProposal',
            'ClientDecision',
            'PipelineEvent',
            'CandidateIdentity',
          ],
          processedAt: deletionReq.processedAt?.toISOString() ?? new Date().toISOString(),
        };
      }

      // Durable state machine transition: REQUESTED -> PROCESSING
      await database.deletionRequest.update({
        where: { id: deletionReq.id },
        data: { status: 'PROCESSING' },
      });

      const candidateId = deletionReq.candidateId;

      const resumes = await database.resumeDocument.findMany({
        where: { candidateId, organizationId },
        select: { id: true, objectKey: true },
      });

      // Explicit object-storage deletion handling:
      // 404 / StorageNotFoundError / ENOENT counts as deleted
      // Network/timeout/500 errors remain retryable: update status to PARTIALLY_BLOCKED and abort
      for (const r of resumes) {
        try {
          await storageDeleteFn(r.objectKey);
        } catch (err: unknown) {
          if (
            err instanceof StorageNotFoundError ||
            (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
            (err as { status?: number })?.status === 404
          ) {
            continue;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          await database.deletionRequest.update({
            where: { id: deletionReq.id },
            data: {
              status: 'PARTIALLY_BLOCKED',
              resultSummary: `Storage deletion failed for ${r.objectKey}: ${errMsg}. Retryable.`,
            },
          });
          throw new Error(`STORAGE_DELETION_FAILED: ${errMsg}`);
        }
      }

      const resumeIds = resumes.map((r) => r.id);
      const now = new Date();

      // Right-to-erasure cascading cleanup in strict foreign-key dependency order
      await database.$transaction(async (tx) => {
        if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') {
          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM "candidates"
            WHERE id = ${candidateId}::uuid
              AND organization_id = ${organizationId}::uuid
            FOR UPDATE
          `);
        }

        // Step A: Terminate and detach processing jobs for candidate's resumes
        // (resume_document_id references resume_documents with ON DELETE RESTRICT)
        if (resumeIds.length > 0) {
          await tx.processingJob.updateMany({
            where: {
              organizationId,
              resumeDocumentId: { in: resumeIds },
            },
            data: {
              status: 'FAILED',
              lastErrorCode: 'CANDIDATE_DATA_DELETED',
              resumeDocumentId: null,
              leaseExpiresAt: null,
              lockedBy: null,
              leaseToken: null,
              updatedAt: now,
            },
          });
        }

        // Step A2: Defense-in-depth irreversible erasure of any candidate email_outbox records across all states
        await eraseCandidateEmailOutbox(tx, organizationId, candidateId, now);

        // Step B: Find candidate submissions
        const submissions = await tx.candidateSubmission.findMany({
          where: { candidateId, organizationId },
          select: { id: true },
        });
        const submissionIds = submissions.map((s) => s.id);

        // Step C: Delete ClientDecisions referencing these submissions
        if (submissionIds.length > 0) {
          await tx.clientDecision.deleteMany({
            where: {
              organizationId,
              submissionId: { in: submissionIds },
            },
          });

          // Step D: Delete InterviewProposals referencing candidate submissions
          await tx.interviewProposal.deleteMany({
            where: {
              organizationId,
              submissionId: { in: submissionIds },
            },
          });
        }

        // Also delete any other interview proposals for this candidate
        await tx.interviewProposal.deleteMany({
          where: {
            organizationId,
            submission: { candidateId },
          },
        });

        // Step E: Delete PipelineEvents referencing this candidate
        await tx.pipelineEvent.deleteMany({
          where: {
            organizationId,
            candidateId,
          },
        });

        // Step F: Delete CandidateSubmissions
        if (submissionIds.length > 0) {
          await tx.candidateSubmission.deleteMany({
            where: {
              organizationId,
              id: { in: submissionIds },
            },
          });
        }

        // Step G: Delete CandidateShortlists
        await tx.candidateShortlist.deleteMany({
          where: {
            organizationId,
            candidateId,
          },
        });

        // Step H: Delete CandidateReviews
        await tx.candidateReview.deleteMany({
          where: {
            organizationId,
            candidateId,
          },
        });

        // Step I: Delete CandidateAssessments, CriterionAssessments, EvidenceSnippets
        const assessments = await tx.candidateAssessment.findMany({
          where: { candidateId, organizationId },
          select: { id: true },
        });
        const assessmentIds = assessments.map((a) => a.id);

        if (assessmentIds.length > 0) {
          await tx.evidenceSnippet.deleteMany({
            where: {
              assessmentId: { in: assessmentIds },
            },
          });

          await tx.criterionAssessment.deleteMany({
            where: {
              assessmentId: { in: assessmentIds },
            },
          });

          await tx.candidateAssessment.deleteMany({
            where: { candidateId, organizationId },
          });
        }

        // Step J: Delete Resume Documents, AssessmentText, and DocumentExtraction
        if (resumeIds.length > 0) {
          await tx.evidenceSnippet.deleteMany({
            where: {
              organizationId,
              resumeDocumentId: { in: resumeIds },
            },
          });

          await tx.assessmentText.deleteMany({
            where: {
              organizationId,
              resumeDocumentId: { in: resumeIds },
            },
          });

          await tx.documentExtraction.deleteMany({
            where: {
              organizationId,
              resumeDocumentId: { in: resumeIds },
            },
          });

          await tx.resumeDocument.deleteMany({
            where: { candidateId, organizationId },
          });
        }

        // Step K: Delete CandidateSkills and CandidateProfiles
        const profiles = await tx.candidateProfile.findMany({
          where: { candidateId, organizationId },
          select: { id: true },
        });
        const profileIds = profiles.map((p) => p.id);

        if (profileIds.length > 0) {
          await tx.candidateSkill.deleteMany({
            where: {
              organizationId,
              candidateProfileId: { in: profileIds },
            },
          });
        }

        await tx.candidateProfile.deleteMany({
          where: { candidateId, organizationId },
        });

        // Step L: Delete Consent and Candidate Deletion Verification records
        if (
          typeof (tx as { candidateDeletionVerification?: { deleteMany?: unknown } })
            .candidateDeletionVerification?.deleteMany === 'function'
        ) {
          await tx.candidateDeletionVerification.deleteMany({
            where: { candidateId, organizationId },
          });
        }
        await tx.consentWithdrawalRequest.deleteMany({
          where: { candidateId, organizationId },
        });
        await tx.candidateConsent.deleteMany({
          where: { candidateId, organizationId },
        });
        await tx.consentInvitation.deleteMany({
          where: { candidateId, organizationId },
        });

        // Step M: Irreversibly redact CandidateIdentity PII
        await tx.candidateIdentity.updateMany({
          where: { candidateId, organizationId },
          data: {
            fullNameEncrypted: null,
            emailEncrypted: null,
            phoneEncrypted: null,
            contactFingerprint: null,
            identityStatus: 'REDACTED',
            updatedAt: now,
          },
        });

        // Step N: Set Candidate recordStatus to DELETED
        await tx.candidate.update({
          where: { id: candidateId },
          data: {
            recordStatus: 'DELETED',
            updatedAt: now,
          },
        });

        // Step O: Mark DeletionRequest COMPLETED
        await tx.deletionRequest.update({
          where: { id: deletionReq.id },
          data: {
            status: 'COMPLETED',
            processedAt: now,
            resultSummary: `Deleted ${resumes.length} resume documents and purged profile, skills, assessments, submissions, and consents. Identity redacted.`,
          },
        });

        // Step P: Audit Log with correct attribution to the actual processing recruiter (actorId)
        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: actorId ?? deletionReq.requestedById ?? null,
            action: 'CANDIDATE_DATA_DELETED',
            resourceType: 'Candidate',
            resourceId: candidateId,
            candidateId,
            metadataJson: {
              deletionRequestId: deletionReq.id,
              deletedResumeCount: resumes.length,
              processedBy: actorId ?? deletionReq.requestedById ?? 'SYSTEM',
            },
          },
        });
      });

      return {
        deletionRequestId: deletionReq.id,
        candidateId,
        status: 'COMPLETED',
        deletedResumeCount: resumes.length,
        anonymizedRecords: [
          'CandidateProfile',
          'CandidateSkill',
          'ResumeDocument',
          'DocumentExtraction',
          'CandidateAssessment',
          'CandidateSubmission',
          'InterviewProposal',
          'ClientDecision',
          'PipelineEvent',
          'CandidateIdentity',
        ],
        processedAt: now.toISOString(),
      };
    },
  };
}
