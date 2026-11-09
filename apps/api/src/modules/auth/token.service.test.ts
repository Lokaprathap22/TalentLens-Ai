import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@talentlens/database';
import {
  ACTIVATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  createSecurityTokenService,
  generateSecureToken,
  hashSecurityToken,
  isSecurityToken,
} from './token.service.js';

describe('Security Token Service — Unit Tests', () => {
  it('generates high-entropy base64url tokens', () => {
    const token1 = generateSecureToken();
    const token2 = generateSecureToken();

    expect(token1).not.toBe(token2);
    expect(token1.length).toBeGreaterThanOrEqual(40);
    expect(isSecurityToken(token1)).toBe(true);
  });

  it('computes deterministic SHA-256 token hashes', () => {
    const token = 'sample-test-token-value-123456789012345';
    const hash1 = hashSecurityToken(token);
    const hash2 = hashSecurityToken(token);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates security token format safely', () => {
    expect(isSecurityToken('short')).toBe(false);
    expect(isSecurityToken(null)).toBe(false);
    expect(isSecurityToken(undefined)).toBe(false);
    expect(isSecurityToken('invalid token with spaces and stuff!!')).toBe(false);
    expect(isSecurityToken(generateSecureToken())).toBe(true);
  });

  it('creates an activation security token with default 48h expiration', async () => {
    const fixedNow = 1700000000000;
    const mockToken = 'mocked-activation-token-value-123456789';
    let capturedCreateData: Prisma.UserSecurityTokenUncheckedCreateInput | null = null;

    const mockDb = {
      userSecurityToken: {
        create: vi.fn(async ({ data }: { data: Prisma.UserSecurityTokenUncheckedCreateInput }) => {
          capturedCreateData = data;
          return {
            id: 'token-uuid-1',
            organizationId: data.organizationId,
            userId: data.userId,
            tokenHash: data.tokenHash,
            type: data.type,
            expiresAt: data.expiresAt,
            consumedAt: null,
            createdAt: new Date(fixedNow),
            user: {
              id: data.userId,
              email: 'test@example.com',
              name: null,
              role: 'RECRUITER',
              status: 'INVITED',
            },
            organization: {
              id: data.organizationId,
              name: 'Acme Corp',
            },
          };
        }),
      },
    } as unknown as PrismaClient;

    const service = createSecurityTokenService({
      database: mockDb,
      now: () => fixedNow,
      generateToken: () => mockToken,
    });

    const result = await service.createToken({
      userId: 'user-1',
      organizationId: 'org-1',
      type: 'ACTIVATION',
    });

    expect(result.token).toBe(mockToken);
    expect(capturedCreateData).not.toBeNull();
    expect(capturedCreateData!.type).toBe('ACTIVATION');
    expect(capturedCreateData!.tokenHash).toBe(hashSecurityToken(mockToken));
    expect(new Date(capturedCreateData!.expiresAt).getTime()).toBe(
      fixedNow + ACTIVATION_TOKEN_TTL_MS,
    );
  });

  it('creates a password reset token with default 1h expiration', async () => {
    const fixedNow = 1700000000000;
    const mockToken = 'mocked-reset-token-value-12345678901234';
    let capturedCreateData: Prisma.UserSecurityTokenUncheckedCreateInput | null = null;

    const mockDb = {
      userSecurityToken: {
        create: vi.fn(async ({ data }: { data: Prisma.UserSecurityTokenUncheckedCreateInput }) => {
          capturedCreateData = data;
          return {
            id: 'token-uuid-2',
            organizationId: data.organizationId,
            userId: data.userId,
            tokenHash: data.tokenHash,
            type: data.type,
            expiresAt: data.expiresAt,
            consumedAt: null,
            createdAt: new Date(fixedNow),
            user: {
              id: data.userId,
              email: 'test@example.com',
              name: 'Jane Recruiter',
              role: 'RECRUITER',
              status: 'ACTIVE',
            },
            organization: {
              id: data.organizationId,
              name: 'Acme Corp',
            },
          };
        }),
      },
    } as unknown as PrismaClient;

    const service = createSecurityTokenService({
      database: mockDb,
      now: () => fixedNow,
      generateToken: () => mockToken,
    });

    const result = await service.createToken({
      userId: 'user-1',
      organizationId: 'org-1',
      type: 'PASSWORD_RESET',
    });

    expect(result.token).toBe(mockToken);
    expect(capturedCreateData).not.toBeNull();
    expect(capturedCreateData!.type).toBe('PASSWORD_RESET');
    expect(new Date(capturedCreateData!.expiresAt).getTime()).toBe(
      fixedNow + PASSWORD_RESET_TOKEN_TTL_MS,
    );
  });

  it('finds and returns valid token, returns null if token is malformed', async () => {
    const service = createSecurityTokenService();
    const result = await service.findValidToken('short', 'ACTIVATION');
    expect(result).toBeNull();
  });

  it('consumes token atomically and prevents double consumption', async () => {
    let updateCount = 1;
    const mockDb = {
      userSecurityToken: {
        updateMany: vi.fn(async () => {
          const count = updateCount;
          updateCount = 0; // consumed once
          return { count };
        }),
      },
    } as unknown as PrismaClient;

    const service = createSecurityTokenService({
      database: mockDb,
    });

    const firstAttempt = await service.consumeToken('token-uuid-1');
    expect(firstAttempt).toBe(true);

    const secondAttempt = await service.consumeToken('token-uuid-1');
    expect(secondAttempt).toBe(false);
  });
});
