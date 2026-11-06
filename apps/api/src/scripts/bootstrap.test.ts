import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@talentlens/database';
import { bootstrapInitialTenant, generateSecureOneTimePassword } from './bootstrap.js';
import { verifyPassword } from '../modules/auth/password.service.js';

describe('Bootstrap Initial Tenant Script — Unit Tests', () => {
  it('generates a cryptographically strong URL-safe temporary password', () => {
    const password = generateSecureOneTimePassword();
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

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

  it('provisions organization and active recruiter with argon2id hashed password', async () => {
    interface CreatedUser {
      role: string;
      status: string;
      normalizedEmail: string;
      passwordHash: string;
      email: string;
    }
    let createdUserRecord: CreatedUser | null = null;

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
        };
        return cb(tx);
      }),
    } as unknown as PrismaClient;

    const result = await bootstrapInitialTenant(mockDb, {
      organizationName: 'TalentTech Solutions',
      recruiterEmail: 'head.recruiter@talenttech.com',
    });

    expect(result.organizationId).toBe('new-org-123');
    expect(result.organizationName).toBe('TalentTech Solutions');
    expect(result.userId).toBe('new-user-456');
    expect(result.recruiterEmail).toBe('head.recruiter@talenttech.com');
    expect(result.temporaryPassword).toBeDefined();

    expect(createdUserRecord).not.toBeNull();
    expect(createdUserRecord!.role).toBe('RECRUITER');
    expect(createdUserRecord!.status).toBe('ACTIVE');
    expect(createdUserRecord!.normalizedEmail).toBe('head.recruiter@talenttech.com');

    // Verify argon2id hash
    const isValid = await verifyPassword(result.temporaryPassword, createdUserRecord!.passwordHash);
    expect(isValid).toBe(true);
  });
});
