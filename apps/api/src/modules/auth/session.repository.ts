import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

export interface SessionCreation {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface SessionUser {
  id: string;
  organizationId: string;
  role: 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | 'DELIVERY_HEAD';
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';
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
              role: true,
              status: true,
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
