import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

import type { UserRole } from './auth.dto.js';

export interface LoginUser {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface AuthRepository {
  findUserByOrganizationAndEmail(
    organizationIdentifier: string,
    normalizedEmail: string,
  ): Promise<LoginUser | null>;
}

type DatabaseAuthClient = Pick<PrismaClient, 'organization' | 'user'>;

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
  };
}
