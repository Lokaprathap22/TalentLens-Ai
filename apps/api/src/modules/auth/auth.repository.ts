import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

import type { UserRole } from './auth.dto.js';
import { InvalidTokenError } from './token.service.js';

export interface LoginUser {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface ActivateUserWithTokenParams {
  tokenId: string;
  tokenHash: string;
  userId: string;
  organizationId: string;
  passwordHash: string;
  now: Date;
}

export interface ResetPasswordWithTokenParams {
  tokenId: string;
  tokenHash: string;
  userId: string;
  organizationId: string;
  passwordHash: string;
  now: Date;
}

export interface AuthRepository {
  findUserByOrganizationAndEmail(
    organizationIdentifier: string,
    normalizedEmail: string,
  ): Promise<LoginUser | null>;
  findUserById(userId: string): Promise<LoginUser | null>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  activateUser(userId: string, passwordHash: string): Promise<LoginUser>;
  updateUserName(userId: string, name: string): Promise<LoginUser>;
  activateUserWithToken(params: ActivateUserWithTokenParams): Promise<LoginUser>;
  resetPasswordWithToken(params: ResetPasswordWithTokenParams): Promise<void>;
}

type DatabaseAuthClient = Pick<
  PrismaClient,
  'organization' | 'user' | 'userSecurityToken' | 'session' | '$transaction'
>;

export function createAuthRepository(
  database: DatabaseAuthClient = getDatabaseClient(),
): AuthRepository {
  return {
    async findUserByOrganizationAndEmail(
      organizationIdentifier,
      normalizedEmail,
    ): Promise<LoginUser | null> {
      const organization = await database.organization.findUnique({
        where: {
          normalizedName: organizationIdentifier,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!organization) {
        return null;
      }

      const user = await database.user.findFirst({
        where: {
          organizationId: organization.id,
          normalizedEmail,
        },
        select: {
          id: true,
          organizationId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          status: true,
        },
      });

      if (!user) {
        return null;
      }

      return {
        ...user,
        organizationName: organization.name,
      };
    },

    async findUserById(userId: string): Promise<LoginUser | null> {
      const user = await database.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          organizationId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          status: true,
          organization: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!user) {
        return null;
      }

      return {
        id: user.id,
        organizationId: user.organizationId,
        organizationName: user.organization.name,
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        status: user.status,
      };
    },

    async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
      await database.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
    },

    async activateUser(userId: string, passwordHash: string): Promise<LoginUser> {
      const updated = await database.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          organizationId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          status: true,
          organization: {
            select: {
              name: true,
            },
          },
        },
      });

      return {
        id: updated.id,
        organizationId: updated.organizationId,
        organizationName: updated.organization.name,
        name: updated.name,
        email: updated.email,
        passwordHash: updated.passwordHash,
        role: updated.role,
        status: updated.status,
      };
    },

    async updateUserName(userId: string, name: string): Promise<LoginUser> {
      const updated = await database.user.update({
        where: { id: userId },
        data: { name },
        select: {
          id: true,
          organizationId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          status: true,
          organization: {
            select: {
              name: true,
            },
          },
        },
      });

      return {
        id: updated.id,
        organizationId: updated.organizationId,
        organizationName: updated.organization.name,
        name: updated.name,
        email: updated.email,
        passwordHash: updated.passwordHash,
        role: updated.role,
        status: updated.status,
      };
    },

    async activateUserWithToken(params: ActivateUserWithTokenParams): Promise<LoginUser> {
      return await database.$transaction(async (tx) => {
        // 5 & 6. Atomically consume the activation token using a conditional update
        const tokenResult = await tx.userSecurityToken.updateMany({
          where: {
            id: params.tokenId,
            tokenHash: params.tokenHash,
            type: 'ACTIVATION',
            consumedAt: null,
            expiresAt: {
              gt: params.now,
            },
          },
          data: {
            consumedAt: params.now,
          },
        });

        if (tokenResult.count !== 1) {
          throw new InvalidTokenError('Invalid or expired account activation link');
        }

        // 7, 8 & 9. Update the user only if user ID & org match, status is INVITED, passwordHash is null
        const userResult = await tx.user.updateMany({
          where: {
            id: params.userId,
            organizationId: params.organizationId,
            status: 'INVITED',
            passwordHash: null,
          },
          data: {
            passwordHash: params.passwordHash,
            status: 'ACTIVE',
          },
        });

        if (userResult.count !== 1) {
          throw new InvalidTokenError('Invalid or expired account activation link');
        }

        const updatedUser = await tx.user.findUniqueOrThrow({
          where: { id: params.userId },
          select: {
            id: true,
            organizationId: true,
            name: true,
            email: true,
            passwordHash: true,
            role: true,
            status: true,
            organization: {
              select: {
                name: true,
              },
            },
          },
        });

        return {
          id: updatedUser.id,
          organizationId: updatedUser.organizationId,
          organizationName: updatedUser.organization.name,
          name: updatedUser.name,
          email: updatedUser.email,
          passwordHash: updatedUser.passwordHash,
          role: updatedUser.role,
          status: updatedUser.status,
        };
      });
    },

    async resetPasswordWithToken(params: ResetPasswordWithTokenParams): Promise<void> {
      await database.$transaction(async (tx) => {
        // 2 & 3. Atomically consume token only when PASSWORD_RESET, unconsumed, unexpired, matching user & org
        const tokenResult = await tx.userSecurityToken.updateMany({
          where: {
            id: params.tokenId,
            tokenHash: params.tokenHash,
            type: 'PASSWORD_RESET',
            consumedAt: null,
            expiresAt: {
              gt: params.now,
            },
            userId: params.userId,
            organizationId: params.organizationId,
          },
          data: {
            consumedAt: params.now,
          },
        });

        if (tokenResult.count !== 1) {
          throw new InvalidTokenError('Invalid or expired password reset link');
        }

        // 4 & 5. Update password only if user remains ACTIVE
        const userResult = await tx.user.updateMany({
          where: {
            id: params.userId,
            organizationId: params.organizationId,
            status: 'ACTIVE',
          },
          data: {
            passwordHash: params.passwordHash,
          },
        });

        if (userResult.count !== 1) {
          throw new InvalidTokenError('Invalid or expired password reset link');
        }

        // 6. Revoke user's existing sessions as part of the same transaction
        await tx.session.updateMany({
          where: {
            userId: params.userId,
            revokedAt: null,
          },
          data: {
            revokedAt: params.now,
          },
        });
      });
    },
  };
}
