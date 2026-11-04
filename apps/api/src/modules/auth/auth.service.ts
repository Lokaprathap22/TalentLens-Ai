import { DUMMY_PASSWORD_HASH, verifyPassword } from './password.service.js';
import type { AuthenticatedSession } from './auth.dto.js';
import { createAuthRepository, type AuthRepository } from './auth.repository.js';
import { createSessionService, type SessionService } from './session.service.js';

export interface AuthServiceDependencies {
  repository?: AuthRepository;
  sessionService?: Pick<SessionService, 'createSession'>;
  verifyPassword?: typeof verifyPassword;
}

export class AuthenticationError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'AuthenticationError';
  }
}

function normalizeOrganization(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function createAuthService(dependencies: AuthServiceDependencies = {}): {
  login(organization: string, email: string, password: string): Promise<AuthenticatedSession>;
} {
  const repository = dependencies.repository ?? createAuthRepository();
  const sessionService = dependencies.sessionService ?? createSessionService();
  const verify = dependencies.verifyPassword ?? verifyPassword;

  return {
    async login(organization, email, password): Promise<AuthenticatedSession> {
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
          email: user.email,
          role: user.role,
        },
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
