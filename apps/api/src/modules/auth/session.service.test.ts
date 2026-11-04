import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUserDto } from './auth.dto.js';
import { SESSION_TTL_MS, createSessionService } from './session.service.js';
import {
  createSessionRepository,
  type SessionCreation,
  type SessionRecord,
  type SessionRepository,
} from './session.repository.js';

const user = {
  id: 'user-1',
  organizationId: 'organization-1',
  email: 'recruiter@example.com',
  role: 'RECRUITER' as const,
  status: 'ACTIVE' as const,
  organization: {
    name: 'TalentLens',
  },
};

function createFakeRepository() {
  const sessions = new Map<string, SessionRecord>();
  const repository: SessionRepository = {
    createForActiveUser: vi.fn(async (session: SessionCreation) => {
      sessions.set(session.tokenHash, {
        expiresAt: session.expiresAt,
        revokedAt: null,
        user: {
          ...user,
          organization: { ...user.organization },
        },
      });
      return true;
    }),
    findByTokenHash: vi.fn(async (tokenHash: string) => sessions.get(tokenHash) ?? null),
    revokeByTokenHash: vi.fn(async (tokenHash: string, revokedAt: Date) => {
      const session = sessions.get(tokenHash);
      if (session) {
        session.revokedAt = revokedAt;
      }
    }),
  };

  return { repository, sessions };
}

describe('session service', () => {
  it('returns a random base64url token and stores only its hash', async () => {
    const { repository } = createFakeRepository();
    const now = 1_700_000_000_000;
    const service = createSessionService({
      repository,
      now: () => now,
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    });

    const created = await service.createSession(user.id);
    const createCall = vi.mocked(repository.createForActiveUser).mock.calls[0]?.[0];

    expect(createCall).toBeDefined();
    expect(created.token).toHaveLength(43);
    expect(created.token).not.toBe(createCall?.tokenHash);
    expect(createCall?.tokenHash).not.toContain(created.token);
    expect(created.expiresAt.getTime()).toBe(now + SESSION_TTL_MS);
  });

  it('allows multiple sessions and restores the complete authenticated user DTO without credentials', async () => {
    const { repository } = createFakeRepository();
    const service = createSessionService({
      repository,
      now: () => 1_700_000_000_000,
      randomBytes: vi
        .fn()
        .mockReturnValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index))
        .mockReturnValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    });

    const first = await service.createSession(user.id);
    const second = await service.createSession(user.id);
    const principal = await service.validateSession(first.token);

    const expected: AuthenticatedUserDto = {
      userId: user.id,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      email: user.email,
      role: user.role,
    };
    expect(first.token).not.toBe(second.token);
    expect(principal).toEqual(expected);
    expect(principal && 'passwordHash' in principal).toBe(false);
    expect(principal && 'tokenHash' in principal).toBe(false);
  });

  it('selects user email and organization display name in the session repository', async () => {
    const expiresAt = new Date('2026-11-04T07:33:39.684Z');
    const findUniqueSession = vi.fn(async () => ({
      expiresAt,
      revokedAt: null,
      user: {
        id: 'user-1',
        organizationId: 'organization-1',
        email: 'recruiter@example.com',
        role: 'RECRUITER' as const,
        status: 'ACTIVE' as const,
        organization: {
          name: 'TalentLens',
        },
      },
    }));
    const repository = createSessionRepository({
      user: { findFirst: vi.fn() },
      session: {
        create: vi.fn(),
        findUnique: findUniqueSession,
        updateMany: vi.fn(),
      },
    } as never);

    const record = await repository.findByTokenHash('token-hash-1');

    expect(findUniqueSession).toHaveBeenCalledWith({
      where: { tokenHash: 'token-hash-1' },
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
    expect(record?.user.email).toBe('recruiter@example.com');
    expect(record?.user.organization.name).toBe('TalentLens');
  });

  it('rejects unknown, malformed, expired, revoked, and inactive sessions', async () => {
    const { repository, sessions } = createFakeRepository();
    const now = 1_700_000_000_000;
    const service = createSessionService({
      repository,
      now: () => now,
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    });

    const created = await service.createSession(user.id);
    const record = [...sessions.values()][0];
    expect(record).toBeDefined();
    if (!record) {
      throw new Error('Expected the fake repository to contain a session');
    }
    expect(await service.validateSession('invalid')).toBeNull();
    expect(await service.validateSession('')).toBeNull();

    record.expiresAt = new Date(now);
    expect(await service.validateSession(created.token)).toBeNull();

    record.expiresAt = new Date(now + SESSION_TTL_MS);
    record.revokedAt = new Date(now);
    expect(await service.validateSession(created.token)).toBeNull();

    record.revokedAt = null;
    record.user.status = 'SUSPENDED';
    expect(await service.validateSession(created.token)).toBeNull();
  });

  it('revokes only the matching session and is idempotent', async () => {
    const { repository } = createFakeRepository();
    const now = 1_700_000_000_000;
    const service = createSessionService({
      repository,
      now: () => now,
      randomBytes: vi
        .fn()
        .mockReturnValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index))
        .mockReturnValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    });

    const first = await service.createSession(user.id);
    const second = await service.createSession(user.id);

    await service.revokeSession(first.token);
    await service.revokeSession(first.token);
    expect(await service.validateSession(first.token)).toBeNull();
    expect(await service.validateSession(second.token)).not.toBeNull();
    expect(repository.revokeByTokenHash).toHaveBeenCalledTimes(2);
  });
});
