import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

import type { UserRole } from './auth.dto.js';

export interface SessionCreation {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';
  organization: {
    name: string;
  };
}

export interface SessionRecord {
  expiresAt: Date;
  revokedAt: Date | null;
  user: SessionUser;
}

export interface SessionRepository {
  createForActiveUser(session: SessionCreation): Promise<boolean>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeByTokenHash(tokenHash: string, revokedAt: Date): Promise<void>;
}

type DatabaseSessionRepositoryClient = Pick<PrismaClient, 'user' | 'session'>;

export function createSessionRepository(
  database: DatabaseSessionRepositoryClient = getDatabaseClient(),
): SessionRepository {
  return {
    async createForActiveUser(session): Promise<boolean> {
      const activeUser = await database.user.findFirst({
        where: {
          id: session.userId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
        },
      });

      if (!activeUser) {
        return false;
      }

      await database.session.create({
        data: {
          userId: session.userId,
          tokenHash: session.tokenHash,
          expiresAt: session.expiresAt,
        },
      });

      return true;
    },

    async findByTokenHash(tokenHash): Promise<SessionRecord | null> {
      return database.session.findUnique({
        where: {
          tokenHash,
        },
        select: {
          expiresAt: true,
          revokedAt: true,
          user: {
            select: {
              id: true,
              organizationId: true,
              email: true,
              role: true,
              status: true,
              organization: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });
    },

    async revokeByTokenHash(tokenHash, revokedAt): Promise<void> {
      await database.session.updateMany({
        where: {
          tokenHash,
          revokedAt: null,
        },
        data: {
          revokedAt,
        },
      });
    },
  };
}
