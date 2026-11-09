import { createHash, randomBytes } from 'node:crypto';
import { getDatabaseClient, type PrismaClient } from '@talentlens/database';
import type { UserRole } from './auth.dto.js';

export const ACTIVATION_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export type SecurityTokenType = 'ACTIVATION' | 'PASSWORD_RESET';

export interface SecurityTokenUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface SecurityTokenOrganization {
  id: string;
  name: string;
}

export interface SecurityTokenRecord {
  id: string;
  organizationId: string;
  userId: string;
  tokenHash: string;
  type: SecurityTokenType;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  user: SecurityTokenUser;
  organization: SecurityTokenOrganization;
}

export function generateSecureToken(size = 32): string {
  return randomBytes(size).toString('base64url');
}

export function hashSecurityToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isSecurityToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  return /^[A-Za-z0-9_-]{16,200}$/.test(token);
}

export interface SecurityTokenServiceDependencies {
  database?: PrismaClient | undefined;
  now?: (() => number) | undefined;
  generateToken?: (() => string) | undefined;
}

export class SecurityTokenError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'SecurityTokenError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class InvalidOrExpiredTokenError extends SecurityTokenError {
  constructor(message = 'Security token is invalid, expired, or has already been used') {
    super(message, 'INVALID_OR_EXPIRED_TOKEN', 400);
    this.name = 'InvalidOrExpiredTokenError';
  }
}

export class InvalidTokenError extends Error {
  constructor(message = 'Security token is invalid, expired, or has already been used') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

export function createSecurityTokenService(dependencies: SecurityTokenServiceDependencies = {}) {
  const getDb = () => dependencies.database ?? getDatabaseClient();
  const getNow = dependencies.now ?? Date.now;
  const generate = dependencies.generateToken ?? generateSecureToken;

  return {
    async createToken(params: {
      userId: string;
      organizationId: string;
      type: SecurityTokenType;
      expiresInMs?: number;
      tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
    }): Promise<{ token: string; record: SecurityTokenRecord }> {
      const client = params.tx ?? getDb();
      const rawToken = generate();
      const tokenHash = hashSecurityToken(rawToken);

      const ttlMs =
        params.expiresInMs ??
        (params.type === 'ACTIVATION' ? ACTIVATION_TOKEN_TTL_MS : PASSWORD_RESET_TOKEN_TTL_MS);

      const expiresAt = new Date(getNow() + ttlMs);

      const record = await client.userSecurityToken.create({
        data: {
          userId: params.userId,
          organizationId: params.organizationId,
          type: params.type,
          tokenHash,
          expiresAt,
        },
        select: {
          id: true,
          organizationId: true,
          userId: true,
          tokenHash: true,
          type: true,
          expiresAt: true,
          consumedAt: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              status: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return {
        token: rawToken,
        record: record as SecurityTokenRecord,
      };
    },

    async findValidToken(
      rawToken: string,
      type: SecurityTokenType,
    ): Promise<SecurityTokenRecord | null> {
      if (!isSecurityToken(rawToken)) {
        return null;
      }

      const tokenHash = hashSecurityToken(rawToken);
      const currentTime = new Date(getNow());

      const record = await getDb().userSecurityToken.findFirst({
        where: {
          tokenHash,
          type,
          consumedAt: null,
          expiresAt: {
            gt: currentTime,
          },
        },
        select: {
          id: true,
          organizationId: true,
          userId: true,
          tokenHash: true,
          type: true,
          expiresAt: true,
          consumedAt: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              status: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return record as SecurityTokenRecord | null;
    },

    async consumeToken(
      tokenId: string,
      tx?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    ): Promise<boolean> {
      const client = tx ?? getDb();
      const updated = await client.userSecurityToken.updateMany({
        where: {
          id: tokenId,
          consumedAt: null,
        },
        data: {
          consumedAt: new Date(getNow()),
        },
      });

      return updated.count > 0;
    },
  };
}

export type SecurityTokenService = ReturnType<typeof createSecurityTokenService>;
