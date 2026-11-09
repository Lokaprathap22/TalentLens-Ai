import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@talentlens/database';
import { bootstrapInitialTenant } from './bootstrap.js';
import { hashSecurityToken } from '../modules/auth/token.service.js';

describe('Bootstrap Initial Tenant Script — Unit Tests', () => {
  it('rejects invalid or too short organization names', async () => {
    const mockDb = {} as PrismaClient;
    await expect(
      bootstrapInitialTenant(mockDb, {
        organizationName: ' ',
        recruiterEmail: 'recruiter@example.com',
      }),
    ).rejects.toThrow(/Organization name must contain at least 2 characters/);
  });

  it('rejects invalid email formats', async () => {
    const mockDb = {} as PrismaClient;
    await expect(
      bootstrapInitialTenant(mockDb, {
        organizationName: 'Valid Org',
        recruiterEmail: 'not-an-email',
      }),
    ).rejects.toThrow(/Valid recruiter email address is required/);
  });

  it('rejects bootstrap when organization normalized name already exists', async () => {
    const mockDb = {
      organization: {
        findUnique: vi.fn(async () => ({ id: 'existing-org-id', name: 'Existing Org' })),
      },
    } as unknown as PrismaClient;

    await expect(
      bootstrapInitialTenant(mockDb, {
        organizationName: 'Existing Org',
        recruiterEmail: 'recruiter@example.com',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('provisions organization and invited recruiter with an activation token', async () => {
    interface CreatedUser {
      role: string;
      status: string;
      normalizedEmail: string;
      passwordHash: string | null;
      email: string;
    }
    interface CreatedToken {
      organizationId: string;
      userId: string;
      tokenHash: string;
      type: string;
      expiresAt: Date;
    }
    let createdUserRecord: CreatedUser | null = null;
    let createdTokenRecord: CreatedToken | null = null;

    const mockDb = {
      organization: {
        findUnique: vi.fn(async () => null),
      },
      $transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = {
          organization: {
            create: vi.fn(async ({ data }: { data: { name: string; normalizedName: string } }) => ({
              id: 'new-org-123',
              name: data.name,
              normalizedName: data.normalizedName,
            })),
          },
          user: {
            create: vi.fn(async ({ data }: { data: CreatedUser }) => {
              createdUserRecord = data;
              return {
                id: 'new-user-456',
                email: data.email,
                role: data.role,
                status: data.status,
              };
            }),
          },
          userSecurityToken: {
            create: vi.fn(async ({ data }: { data: CreatedToken }) => {
              createdTokenRecord = data;
              return {
                id: 'token-uuid-1',
                ...data,
              };
            }),
          },
        };
        return cb(tx);
      }),
    } as unknown as PrismaClient;

    const result = await bootstrapInitialTenant(mockDb, {
      organizationName: 'TalentTech Solutions',
      recruiterEmail: 'head.recruiter@talenttech.com',
      applicationOrigin: 'https://talentlens.example.com',
    });

    expect(result.organizationId).toBe('new-org-123');
    expect(result.organizationName).toBe('TalentTech Solutions');
    expect(result.userId).toBe('new-user-456');
    expect(result.recruiterEmail).toBe('head.recruiter@talenttech.com');
    expect(result.activationToken).toBeDefined();
    expect(result.activationUrl).toBe(
      `https://talentlens.example.com/activate#token=${result.activationToken}`,
    );

    expect(createdUserRecord).not.toBeNull();
    expect(createdUserRecord!.role).toBe('RECRUITER');
    expect(createdUserRecord!.status).toBe('INVITED');
    expect(createdUserRecord!.passwordHash).toBeNull();
    expect(createdUserRecord!.normalizedEmail).toBe('head.recruiter@talenttech.com');

    expect(createdTokenRecord).not.toBeNull();
    expect(createdTokenRecord!.type).toBe('ACTIVATION');
    expect(createdTokenRecord!.tokenHash).toBe(hashSecurityToken(result.activationToken));
    expect(createdTokenRecord!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
