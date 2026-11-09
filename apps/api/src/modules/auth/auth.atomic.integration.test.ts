import { describe, expect, it } from 'vitest';
import { getDatabaseClient } from '@talentlens/database';
import { createAuthRepository } from './auth.repository.js';
import { createAuthService, InvalidTokenError } from './auth.service.js';
import { verifyPassword } from './password.service.js';
import { createSessionService } from './session.service.js';
import { createSecurityTokenService } from './token.service.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)(
  'Auth & Security Token Atomic Concurrency Integration Tests',
  () => {
    it('enforces atomic single-use on simultaneous activation attempts with PostgreSQL: exactly one succeeds, loser rejected and cannot overwrite password', async () => {
      const db = getDatabaseClient();
      const repository = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });

      const authService = createAuthService({
        repository,
        sessionService,
        tokenService,
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Atomic Act Org ${suffix}`,
          normalizedName: `atomic-act-org-${suffix}`,
        },
      });

      const user = await db.user.create({
        data: {
          organizationId: org.id,
          email: `recruiter-${suffix}@example.com`,
          normalizedEmail: `recruiter-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'INVITED',
          passwordHash: null,
        },
      });

      const { token } = await tokenService.createToken({
        userId: user.id,
        organizationId: org.id,
        type: 'ACTIVATION',
      });

      const passwordCandidate1 = 'WinningPassword123!';
      const passwordCandidate2 = 'LosingPassword456!';

      // Execute simultaneous activation attempts with exact same token
      const [res1, res2] = await Promise.allSettled([
        authService.activate(token, passwordCandidate1),
        authService.activate(token, passwordCandidate2),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly one must succeed, exactly one must fail
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTokenError);

      // Verify database state: token is consumed and user is ACTIVE
      const updatedUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updatedUser.status).toBe('ACTIVE');
      expect(updatedUser.passwordHash).not.toBeNull();

      // The losing request must not overwrite the winner's password
      const winningSession = (fulfilled[0] as PromiseFulfilledResult<{ token: string }>).value;
      expect(winningSession.token).toBeDefined();

      const matchesWinner1 = await verifyPassword(passwordCandidate1, updatedUser.passwordHash!);
      const matchesWinner2 = await verifyPassword(passwordCandidate2, updatedUser.passwordHash!);
      expect(matchesWinner1 !== matchesWinner2).toBe(true);
      expect(matchesWinner1 || matchesWinner2).toBe(true);

      // Further redemption attempt with the now-consumed token must fail
      await expect(authService.activate(token, 'AnotherAttempt789!')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
    });

    it('enforces atomic single-use on simultaneous password reset attempts with PostgreSQL: exactly one succeeds, loser rejected and previous sessions revoked', async () => {
      const db = getDatabaseClient();
      const repository = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });

      const authService = createAuthService({
        repository,
        sessionService,
        tokenService,
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Reset Test Org ${suffix}`,
          normalizedName: `reset-test-org-${suffix}`,
        },
      });

      const user = await db.user.create({
        data: {
          organizationId: org.id,
          email: `reset-${suffix}@example.com`,
          normalizedEmail: `reset-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'ACTIVE',
          passwordHash: 'initial-stored-hash',
        },
      });

      // Create 3 active sessions prior to reset
      await sessionService.createSession(user.id);
      await sessionService.createSession(user.id);
      await sessionService.createSession(user.id);

      const initialActiveSessions = await db.session.findMany({
        where: { userId: user.id, revokedAt: null },
      });
      expect(initialActiveSessions).toHaveLength(3);

      const { token } = await tokenService.createToken({
        userId: user.id,
        organizationId: org.id,
        type: 'PASSWORD_RESET',
      });

      const resetPass1 = 'BrandNewPassword123!';
      const resetPass2 = 'LosingResetPassword456!';

      // Execute simultaneous reset attempts
      const [res1, res2] = await Promise.allSettled([
        authService.confirmPasswordReset(token, resetPass1),
        authService.confirmPasswordReset(token, resetPass2),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTokenError);

      // Verify existing sessions were atomically revoked in database
      const activeSessionsAfter = await db.session.findMany({
        where: { userId: user.id, revokedAt: null },
      });
      expect(activeSessionsAfter).toHaveLength(0);

      const allSessions = await db.session.findMany({
        where: { userId: user.id },
      });
      expect(allSessions).toHaveLength(3);
      for (const s of allSessions) {
        expect(s.revokedAt).not.toBeNull();
      }

      // Verify password was updated to the winner's password
      const updatedUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      const matches1 = await verifyPassword(resetPass1, updatedUser.passwordHash!);
      const matches2 = await verifyPassword(resetPass2, updatedUser.passwordHash!);
      expect(matches1 !== matches2).toBe(true);

      // Subsequent reset attempt with the same token is rejected
      await expect(
        authService.confirmPasswordReset(token, 'LatePassword789!'),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects redemption of expired activation tokens and expired password reset tokens in PostgreSQL', async () => {
      const db = getDatabaseClient();
      const repository = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });

      const authService = createAuthService({
        repository,
        sessionService,
        tokenService,
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Expired Test Org ${suffix}`,
          normalizedName: `expired-test-org-${suffix}`,
        },
      });

      const user = await db.user.create({
        data: {
          organizationId: org.id,
          email: `expired-${suffix}@example.com`,
          normalizedEmail: `expired-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'INVITED',
          passwordHash: null,
        },
      });

      // Create an expired activation token (expiresInMs negative)
      const { token: expiredActivationToken } = await tokenService.createToken({
        userId: user.id,
        organizationId: org.id,
        type: 'ACTIVATION',
        expiresInMs: -10000,
      });

      await expect(
        authService.activate(expiredActivationToken, 'NewPassword123!'),
      ).rejects.toBeInstanceOf(InvalidTokenError);

      // Verify user remains INVITED with no password set
      const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(userAfter.status).toBe('INVITED');
      expect(userAfter.passwordHash).toBeNull();

      // Create active user and expired reset token
      const activeUser = await db.user.create({
        data: {
          organizationId: org.id,
          email: `active-exp-${suffix}@example.com`,
          normalizedEmail: `active-exp-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'ACTIVE',
          passwordHash: 'original-hash',
        },
      });

      const { token: expiredResetToken } = await tokenService.createToken({
        userId: activeUser.id,
        organizationId: org.id,
        type: 'PASSWORD_RESET',
        expiresInMs: -10000,
      });

      await expect(
        authService.confirmPasswordReset(expiredResetToken, 'NewPassword123!'),
      ).rejects.toBeInstanceOf(InvalidTokenError);

      // Password remains original
      const activeUserAfter = await db.user.findUniqueOrThrow({ where: { id: activeUser.id } });
      expect(activeUserAfter.passwordHash).toBe('original-hash');
    });

    it('refuses to activate SUSPENDED or DEACTIVATED accounts in PostgreSQL', async () => {
      const db = getDatabaseClient();
      const repository = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });

      const authService = createAuthService({
        repository,
        sessionService,
        tokenService,
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Status Guard Org ${suffix}`,
          normalizedName: `status-guard-org-${suffix}`,
        },
      });

      // 1. Suspended account
      const suspendedUser = await db.user.create({
        data: {
          organizationId: org.id,
          email: `suspended-${suffix}@example.com`,
          normalizedEmail: `suspended-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'SUSPENDED',
          passwordHash: null,
        },
      });

      const { token: suspendedToken } = await tokenService.createToken({
        userId: suspendedUser.id,
        organizationId: org.id,
        type: 'ACTIVATION',
      });

      await expect(authService.activate(suspendedToken, 'NewPassword123!')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );

      const suspendedCheck = await db.user.findUniqueOrThrow({ where: { id: suspendedUser.id } });
      expect(suspendedCheck.status).toBe('SUSPENDED');
      expect(suspendedCheck.passwordHash).toBeNull();

      // 2. Deactivated account
      const deactivatedUser = await db.user.create({
        data: {
          organizationId: org.id,
          email: `deactivated-${suffix}@example.com`,
          normalizedEmail: `deactivated-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'DEACTIVATED',
          passwordHash: null,
        },
      });

      const { token: deactivatedToken } = await tokenService.createToken({
        userId: deactivatedUser.id,
        organizationId: org.id,
        type: 'ACTIVATION',
      });

      await expect(
        authService.activate(deactivatedToken, 'NewPassword123!'),
      ).rejects.toBeInstanceOf(InvalidTokenError);

      const deactivatedCheck = await db.user.findUniqueOrThrow({
        where: { id: deactivatedUser.id },
      });
      expect(deactivatedCheck.status).toBe('DEACTIVATED');
      expect(deactivatedCheck.passwordHash).toBeNull();
    });

    it('rolls back token consumption when account update fails in PostgreSQL transaction', async () => {
      const db = getDatabaseClient();
      const repository = createAuthRepository(db);
      const sessionService = createSessionService();
      const tokenService = createSecurityTokenService({ database: db });

      const authService = createAuthService({
        repository,
        sessionService,
        tokenService,
      });

      const suffix = Date.now().toString(36);
      const org = await db.organization.create({
        data: {
          name: `Rollback Org ${suffix}`,
          normalizedName: `rollback-org-${suffix}`,
        },
      });

      const user = await db.user.create({
        data: {
          organizationId: org.id,
          email: `rollback-${suffix}@example.com`,
          normalizedEmail: `rollback-${suffix}@example.com`,
          role: 'RECRUITER',
          status: 'INVITED',
          passwordHash: null,
        },
      });

      const { token, record } = await tokenService.createToken({
        userId: user.id,
        organizationId: org.id,
        type: 'ACTIVATION',
      });

      // Manually change user status to ACTIVE before activation transaction runs,
      // causing user update (which requires status = INVITED) to match 0 rows.
      await db.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', passwordHash: 'pre-existing-hash' },
      });

      // Activation must throw InvalidTokenError
      await expect(authService.activate(token, 'ShouldRollback123!')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );

      // Verify rollback: token was NOT consumed because transaction aborted
      const tokenRecord = await db.userSecurityToken.findUniqueOrThrow({
        where: { id: record.id },
      });
      expect(tokenRecord.consumedAt).toBeNull();
    });
  },
);
