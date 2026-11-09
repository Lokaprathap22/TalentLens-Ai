import { describe, expect, it } from 'vitest';
import { getDatabaseClient } from '@talentlens/database';
import { decryptEmailPayload } from '../email/email.crypto.js';
import { createAuthRepository } from '../auth/auth.repository.js';
import { createAuthService } from '../auth/auth.service.js';
import { createSessionService } from '../auth/session.service.js';
import { createSecurityTokenService } from '../auth/token.service.js';
import { createWorkflowRepository } from './workflow.repository.js';
import { createWorkflowService } from './workflow.service.js';
import {
  WorkflowClientMemberConflictError,
  WorkflowClientNotFoundError,
} from './workflow.errors.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)(
  'Client Hiring Manager Provisioning PostgreSQL Integration Suite',
  () => {
    it('atomically provisions User, ClientMembership, UserSecurityToken, and EmailOutbox in a single transaction', async () => {
      const db = getDatabaseClient();
      const repo = createWorkflowRepository(db);
      const service = createWorkflowService(repo, {
        applicationOrigin: 'https://app.talentlens.ai',
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Provisioning Org ${suffix}`,
          normalizedName: `provisioning-org-${suffix}`,
        },
      });

      const recruiter = await db.user.create({
        data: {
          organizationId: org.id,
          email: `recruiter-${suffix}@example.com`,
          normalizedEmail: `recruiter-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'ACTIVE',
          passwordHash: 'dummy-hash',
        },
      });

      const client = await db.client.create({
        data: {
          organizationId: org.id,
          name: `Acme Corp ${suffix}`,
          normalizedName: `acme-corp-${suffix}`,
          status: 'ACTIVE',
        },
      });

      const recruiterPrincipal = {
        userId: recruiter.id,
        organizationId: org.id,
        role: 'RECRUITER' as const,
      };

      const invitedEmail = `hiring.manager-${suffix}@acme.com`;
      const invitedName = 'Eleanor Vance';

      // 1. Recruiter invites the client hiring manager
      const memberDto = await service.inviteClientMember(recruiterPrincipal, client.id, {
        email: invitedEmail,
        name: invitedName,
      });

      expect(memberDto.id).toBeDefined();
      expect(memberDto.email).toBe(invitedEmail);
      expect(memberDto.name).toBe(invitedName);
      expect(memberDto.role).toBe('CLIENT_HIRING_MANAGER');
      expect(memberDto.membershipStatus).toBe('ACTIVE');
      expect(memberDto.userStatus).toBe('INVITED');

      // 2. Verify all records in PostgreSQL
      const createdUser = await db.user.findUniqueOrThrow({
        where: { id: memberDto.userId },
      });
      expect(createdUser.status).toBe('INVITED');
      expect(createdUser.role).toBe('CLIENT_HIRING_MANAGER');
      expect(createdUser.passwordHash).toBeNull();
      expect(createdUser.organizationId).toBe(org.id);

      const createdMembership = await db.clientMembership.findUniqueOrThrow({
        where: { id: memberDto.membershipId },
      });
      expect(createdMembership.clientId).toBe(client.id);
      expect(createdMembership.userId).toBe(createdUser.id);
      expect(createdMembership.role).toBe('CLIENT_HIRING_MANAGER');
      expect(createdMembership.status).toBe('ACTIVE');

      const createdToken = await db.userSecurityToken.findFirstOrThrow({
        where: {
          userId: createdUser.id,
          type: 'ACTIVATION',
        },
      });
      expect(createdToken.consumedAt).toBeNull();
      expect(createdToken.tokenHash).toHaveLength(64); // SHA-256 hex
      expect(createdToken.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const outboxRecord = await db.emailOutbox.findFirstOrThrow({
        where: {
          organizationId: org.id,
          messageType: 'account_activation',
          recipientRole: 'CLIENT_HIRING_MANAGER',
        },
      });
      expect(outboxRecord.status).toBe('PENDING');

      // Decrypt outbox payload and verify token URL fragment
      const decrypted = decryptEmailPayload(outboxRecord.encryptedPayload!, {
        recordId: outboxRecord.id,
        idempotencyKey: outboxRecord.idempotencyKey,
      });
      expect(decrypted.recipientEmail).toBe(invitedEmail);
      expect(decrypted.html).toContain('https://app.talentlens.ai/activate#token=');

      // Extract bearer token from activation URL fragment
      const tokenMatch = decrypted.html.match(/activate#token=([A-Za-z0-9_-]+)/);
      expect(tokenMatch).not.toBeNull();
      const bearerToken = tokenMatch![1]!;

      // 3. Activation compatibility: invited user activates their account using Batch 1 authService
      const authRepo = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });
      const authService = createAuthService({
        repository: authRepo,
        sessionService,
        tokenService,
      });

      const activationResult = await authService.activate(bearerToken, 'SecureHiringManager123!');
      expect(activationResult.token).toBeDefined();

      // Verify user is now ACTIVE in database
      const activatedUser = await db.user.findUniqueOrThrow({
        where: { id: createdUser.id },
      });
      expect(activatedUser.status).toBe('ACTIVE');
      expect(activatedUser.passwordHash).not.toBeNull();

      // 4. Listing client members reflects updated userStatus
      const membersList = await service.listClientMembers(recruiterPrincipal, client.id);
      expect(membersList).toHaveLength(1);
      expect(membersList[0]!.userStatus).toBe('ACTIVE');
    });

    it('enforces conflict detection and cross-organization denial in PostgreSQL', async () => {
      const db = getDatabaseClient();
      const repo = createWorkflowRepository(db);
      const service = createWorkflowService(repo);

      const suffix = Date.now().toString(36);
      const orgA = await db.organization.create({
        data: {
          name: `Org A ${suffix}`,
          normalizedName: `org-a-${suffix}`,
        },
      });
      const orgB = await db.organization.create({
        data: {
          name: `Org B ${suffix}`,
          normalizedName: `org-b-${suffix}`,
        },
      });

      const recruiterA = await db.user.create({
        data: {
          organizationId: orgA.id,
          email: `recruiter-a-${suffix}@example.com`,
          normalizedEmail: `recruiter-a-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'ACTIVE',
          passwordHash: 'dummy-hash',
        },
      });

      const clientA = await db.client.create({
        data: {
          organizationId: orgA.id,
          name: `Client A ${suffix}`,
          normalizedName: `client-a-${suffix}`,
          status: 'ACTIVE',
        },
      });

      const clientB = await db.client.create({
        data: {
          organizationId: orgB.id,
          name: `Client B ${suffix}`,
          normalizedName: `client-b-${suffix}`,
          status: 'ACTIVE',
        },
      });

      const principalA = {
        userId: recruiterA.id,
        organizationId: orgA.id,
        role: 'RECRUITER' as const,
      };

      // 1. Cross-organization denial: Recruiter from Org A cannot invite to Org B client
      await expect(
        service.inviteClientMember(principalA, clientB.id, {
          email: `cross.org-${suffix}@example.com`,
        }),
      ).rejects.toBeInstanceOf(WorkflowClientNotFoundError);

      // 2. Existing-account role conflict: cannot invite an existing recruiter as a client manager
      await expect(
        service.inviteClientMember(principalA, clientA.id, {
          email: recruiterA.email,
        }),
      ).rejects.toBeInstanceOf(WorkflowClientMemberConflictError);

      // 3. Successful first invitation
      const firstInvite = await service.inviteClientMember(principalA, clientA.id, {
        email: `invited-${suffix}@acme.com`,
      });
      expect(firstInvite.userStatus).toBe('INVITED');

      // 4. Duplicate invitation conflict: attempting to invite same email again is rejected
      await expect(
        service.inviteClientMember(principalA, clientA.id, {
          email: `invited-${suffix}@acme.com`,
        }),
      ).rejects.toBeInstanceOf(WorkflowClientMemberConflictError);
    });
  },
);
