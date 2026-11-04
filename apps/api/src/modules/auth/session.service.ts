import { createHash, randomBytes } from 'node:crypto';

import type { AuthenticatedUserDto, UserRole } from './auth.dto.js';
import { createSessionRepository, type SessionRepository } from './session.repository.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthenticatedPrincipal {
  userId: string;
  organizationId: string;
  organizationName?: string;
  email?: string;
  role: UserRole;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface SessionServiceDependencies {
  repository?: SessionRepository;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export class SessionCreationError extends Error {
  constructor() {
    super('Unable to create session');
    this.name = 'SessionCreationError';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isSessionToken(rawToken: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(rawToken);
}

export function createSessionService(dependencies: SessionServiceDependencies = {}) {
  const repository = dependencies.repository ?? createSessionRepository();
  const now = dependencies.now ?? Date.now;
  const createRandomBytes = dependencies.randomBytes ?? randomBytes;

  return {
    async createSession(userId: string): Promise<CreatedSession> {
      const token = Buffer.from(createRandomBytes(32)).toString('base64url');
      const expiresAt = new Date(now() + SESSION_TTL_MS);
      const created = await repository.createForActiveUser({
        userId,
        tokenHash: hashToken(token),
        expiresAt,
      });

      if (!created) {
        throw new SessionCreationError();
      }

      return { token, expiresAt };
    },

    async validateSession(
      rawToken: string | null | undefined,
    ): Promise<AuthenticatedUserDto | null> {
      if (!rawToken || !isSessionToken(rawToken)) {
        return null;
      }

      const session = await repository.findByTokenHash(hashToken(rawToken));
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= now() ||
        session.user.status !== 'ACTIVE'
      ) {
        return null;
      }

      return {
        userId: session.user.id,
        organizationId: session.user.organizationId,
        organizationName: session.user.organization.name,
        email: session.user.email,
        role: session.user.role,
      };
    },

    async revokeSession(rawToken: string | null | undefined): Promise<void> {
      if (!rawToken || !isSessionToken(rawToken)) {
        return;
      }

      await repository.revokeByTokenHash(hashToken(rawToken), new Date(now()));
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
