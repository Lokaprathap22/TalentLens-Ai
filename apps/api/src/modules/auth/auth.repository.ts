import { getDatabaseClient, type PrismaClient } from '@talentlens/database';

export interface LoginUser {
  id: string;
  organizationId: string;
  email: string;
  passwordHash: string | null;
  role: 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | 'DELIVERY_HEAD';
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
        },
      });

      if (!organization) {
        return null;
      }

      return database.user.findFirst({
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
    },
  };
}
