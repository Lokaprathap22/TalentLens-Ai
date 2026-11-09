import {
  DUMMY_PASSWORD_HASH,
  hashPassword as defaultHashPassword,
  verifyPassword as defaultVerifyPassword,
} from './password.service.js';
import type { AuthenticatedSession, AuthenticatedUserDto } from './auth.dto.js';
import { createAuthRepository, type AuthRepository } from './auth.repository.js';
import { createSessionService, type SessionService } from './session.service.js';
import {
  createSecurityTokenService,
  hashSecurityToken,
  isSecurityToken,
  InvalidTokenError,
  type SecurityTokenService,
} from './token.service.js';

export { InvalidTokenError } from './token.service.js';

export interface EmailDeliveryServiceWithAuth {
  sendPasswordReset(data: {
    to: string;
    userName?: string | undefined;
    organizationName: string;
    recipientRole?: 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | undefined;
    resetUrl: string;
    expiresAt: Date;
    organizationId?: string | undefined;
  }): Promise<{ delivered: boolean; error?: string }>;
  sendAccountActivation?(data: {
    to: string;
    userName?: string | undefined;
    organizationName: string;
    recipientRole?: 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | undefined;
    activationUrl: string;
    expiresAt: Date;
    organizationId?: string | undefined;
  }): Promise<{ delivered: boolean; error?: string }>;
}

export interface AuthServiceDependencies {
  repository?: AuthRepository;
  sessionService?: Pick<
    SessionService,
    'createSession' | 'revokeUserSessions' | 'revokeOtherUserSessions'
  >;
  tokenService?: Pick<SecurityTokenService, 'findValidToken' | 'consumeToken' | 'createToken'>;
  verifyPassword?: typeof defaultVerifyPassword;
  hashPassword?: typeof defaultHashPassword;
  emailDeliveryService?: EmailDeliveryServiceWithAuth;
  applicationOrigin?: string;
}

export class AuthenticationError extends Error {
  constructor(message = 'Invalid credentials') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class CurrentPasswordIncorrectError extends Error {
  constructor(message = 'Current password is incorrect') {
    super(message);
    this.name = 'CurrentPasswordIncorrectError';
  }
}

function normalizeOrganization(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function createAuthService(dependencies: AuthServiceDependencies = {}) {
  const repository = dependencies.repository ?? createAuthRepository();
  const sessionService = dependencies.sessionService ?? createSessionService();
  const tokenService = dependencies.tokenService ?? createSecurityTokenService();
  const verify = dependencies.verifyPassword ?? defaultVerifyPassword;
  const hash = dependencies.hashPassword ?? defaultHashPassword;
  const emailService = dependencies.emailDeliveryService;
  const appOrigin = dependencies.applicationOrigin ?? 'http://localhost:5173';

  return {
    async login(
      organization: string,
      email: string,
      password: string,
    ): Promise<AuthenticatedSession> {
      const user = await repository.findUserByOrganizationAndEmail(
        normalizeOrganization(organization),
        normalizeEmail(email),
      );
      const passwordValid = await verify(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

      if (!user || !passwordValid || user.status !== 'ACTIVE') {
        throw new AuthenticationError();
      }

      const session = await sessionService.createSession(user.id);
      return {
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          userId: user.id,
          organizationId: user.organizationId,
          organizationName: user.organizationName,
          name: user.name ?? null,
          email: user.email,
          role: user.role,
        },
      };
    },

    async activate(token: string, password: string): Promise<AuthenticatedSession> {
      if (!isSecurityToken(token)) {
        throw new InvalidTokenError('Invalid or expired account activation link');
      }

      const validToken = await tokenService.findValidToken(token, 'ACTIVATION');
      if (!validToken || validToken.user.status !== 'INVITED') {
        throw new InvalidTokenError('Invalid or expired account activation link');
      }

      const tokenHash = hashSecurityToken(token);
      const passwordHash = await hash(password);
      const now = new Date();

      const activatedUser = await repository.activateUserWithToken({
        tokenId: validToken.id,
        tokenHash,
        userId: validToken.userId,
        organizationId: validToken.organizationId,
        passwordHash,
        now,
      });

      // Invalidate any existing sessions for safety
      if (sessionService.revokeUserSessions) {
        await sessionService.revokeUserSessions(activatedUser.id);
      }

      // 12. Only after successful commit, create the authenticated session
      const session = await sessionService.createSession(activatedUser.id);

      return {
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          userId: activatedUser.id,
          organizationId: activatedUser.organizationId,
          organizationName: activatedUser.organizationName,
          name: activatedUser.name ?? null,
          email: activatedUser.email,
          role: activatedUser.role,
        },
      };
    },

    async changePassword(
      userId: string,
      currentPassword: string,
      newPassword: string,
      currentSessionToken?: string,
    ): Promise<void> {
      const user = await repository.findUserById(userId);
      if (!user || user.status !== 'ACTIVE') {
        throw new AuthenticationError('User account is inactive or not found');
      }

      const passwordValid = await verify(currentPassword, user.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!passwordValid) {
        throw new CurrentPasswordIncorrectError('Current password is incorrect');
      }

      const newPasswordHash = await hash(newPassword);
      await repository.updateUserPassword(userId, newPasswordHash);

      // Revoke other user sessions to protect the account while keeping the current session active
      if (currentSessionToken && sessionService.revokeOtherUserSessions) {
        await sessionService.revokeOtherUserSessions(userId, currentSessionToken);
      } else if (sessionService.revokeUserSessions) {
        await sessionService.revokeUserSessions(userId);
      }
    },

    async requestPasswordReset(organization: string, email: string): Promise<void> {
      // Anti-enumeration: wrapped in try-catch so caller receives identical success behavior
      try {
        const user = await repository.findUserByOrganizationAndEmail(
          normalizeOrganization(organization),
          normalizeEmail(email),
        );

        if (!user || user.status !== 'ACTIVE') {
          return;
        }

        const { token, record } = await tokenService.createToken({
          userId: user.id,
          organizationId: user.organizationId,
          type: 'PASSWORD_RESET',
        });

        if (emailService) {
          const resetUrl = `${appOrigin}/reset-password#token=${token}`;
          await emailService.sendPasswordReset({
            to: user.email,
            userName: user.name ?? undefined,
            organizationName: user.organizationName,
            recipientRole:
              user.role === 'CLIENT_HIRING_MANAGER' ? 'CLIENT_HIRING_MANAGER' : 'RECRUITER',
            resetUrl,
            expiresAt: record.expiresAt,
            organizationId: user.organizationId,
          });
        }
      } catch {
        // Suppress errors to prevent user/organization enumeration or timing side-channels
      }
    },

    async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
      if (!isSecurityToken(token)) {
        throw new InvalidTokenError('Invalid or expired password reset link');
      }

      const validToken = await tokenService.findValidToken(token, 'PASSWORD_RESET');
      if (!validToken || validToken.user.status !== 'ACTIVE') {
        throw new InvalidTokenError('Invalid or expired password reset link');
      }

      const tokenHash = hashSecurityToken(token);
      const passwordHash = await hash(newPassword);
      const now = new Date();

      await repository.resetPasswordWithToken({
        tokenId: validToken.id,
        tokenHash,
        userId: validToken.userId,
        organizationId: validToken.organizationId,
        passwordHash,
        now,
      });
    },

    async updateProfile(userId: string, name: string): Promise<AuthenticatedUserDto> {
      const updated = await repository.updateUserName(userId, name.trim());
      return {
        userId: updated.id,
        organizationId: updated.organizationId,
        organizationName: updated.organizationName,
        name: updated.name,
        email: updated.email,
        role: updated.role,
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
