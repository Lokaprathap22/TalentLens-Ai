import { describe, expect, it, vi } from 'vitest';

import { AuthenticationError, createAuthService } from './auth.service.js';
import { createAuthRepository, type AuthRepository, type LoginUser } from './auth.repository.js';
import { DUMMY_PASSWORD_HASH } from './password.service.js';
import type { SessionService } from './session.service.js';

const activeRecruiter: LoginUser = {
  id: 'user-1',
  organizationId: 'org-1',
  organizationName: 'TalentLens',
  email: 'recruiter@example.com',
  passwordHash: 'stored-hash',
  role: 'RECRUITER',
  status: 'ACTIVE',
};

function createService(user: LoginUser | null) {
  const repository: AuthRepository = {
    findUserByOrganizationAndEmail: vi.fn(async () => user),
  };
  const sessionService: Pick<SessionService, 'createSession'> = {
    createSession: vi.fn(async () => ({
      token: 'A'.repeat(43),
      expiresAt: new Date('2026-11-04T07:33:39.684Z'),
    })),
  };
  const verifyPassword = vi.fn(
    async (password: string, hash: string) => password === 'password' && hash === 'stored-hash',
  );
  const service = createAuthService({
    repository,
    sessionService,
    verifyPassword,
  });

  return { repository, sessionService, service, verifyPassword };
}

describe('auth service', () => {
  it('scopes login by normalized organization and email', async () => {
    const { repository, sessionService, service, verifyPassword } = createService(activeRecruiter);

    await expect(
      service.login(' TalentLens ', 'Recruiter@Example.COM', 'password'),
    ).resolves.toMatchObject({
      user: {
        userId: 'user-1',
        organizationId: 'org-1',
        organizationName: 'TalentLens',
        email: 'recruiter@example.com',
        role: 'RECRUITER',
      },
    });
    expect(repository.findUserByOrganizationAndEmail).toHaveBeenCalledWith(
      'talentlens',
      'recruiter@example.com',
    );
    expect(sessionService.createSession).toHaveBeenCalledWith('user-1');
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith('password', 'stored-hash');
  });

  it('retrieves the organization display name in the auth repository', async () => {
    const findUniqueOrganization = vi.fn(async () => ({
      id: 'org-1',
      name: 'TalentLens Enterprise',
    }));
    const findFirstUser = vi.fn(async () => ({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'recruiter@example.com',
      passwordHash: 'stored-hash',
      role: 'RECRUITER' as const,
      status: 'ACTIVE' as const,
    }));
    const repository = createAuthRepository({
      organization: { findUnique: findUniqueOrganization },
      user: { findFirst: findFirstUser },
    } as never);

    const found = await repository.findUserByOrganizationAndEmail(
      'talentlens enterprise',
      'recruiter@example.com',
    );

    expect(findUniqueOrganization).toHaveBeenCalledWith({
      where: { normalizedName: 'talentlens enterprise' },
      select: { id: true, name: true },
    });
    expect(found).toEqual({
      id: 'user-1',
      organizationId: 'org-1',
      organizationName: 'TalentLens Enterprise',
      email: 'recruiter@example.com',
      passwordHash: 'stored-hash',
      role: 'RECRUITER',
      status: 'ACTIVE',
    });
  });

  it('supports client hiring manager identities without exposing credentials', async () => {
    const clientUser: LoginUser = {
      ...activeRecruiter,
      id: 'client-user-1',
      email: 'manager@example.com',
      role: 'CLIENT_HIRING_MANAGER',
    };
    const { service } = createService(clientUser);

    const result = await service.login('client-org', 'manager@example.com', 'password');
    expect(result.user.role).toBe('CLIENT_HIRING_MANAGER');
    expect(result).not.toHaveProperty('tokenHash');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('verifies an incorrect password against the stored hash once', async () => {
    const { service, verifyPassword } = createService(activeRecruiter);

    await expect(
      service.login('talentlens', 'recruiter@example.com', 'wrong'),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith('wrong', 'stored-hash');
  });

  it('uses the dummy hash once for an unknown user', async () => {
    const { service, verifyPassword } = createService(null);

    await expect(service.login('talentlens', 'recruiter@example.com', 'password')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith('password', DUMMY_PASSWORD_HASH);
  });

  it('uses the dummy hash once for an unknown organization', async () => {
    const { repository, service, verifyPassword } = createService(null);

    await expect(service.login('unknown-org', 'recruiter@example.com', 'password')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(repository.findUserByOrganizationAndEmail).toHaveBeenCalledWith(
      'unknown-org',
      'recruiter@example.com',
    );
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith('password', DUMMY_PASSWORD_HASH);
  });

  it('verifies inactive users before rejecting them', async () => {
    const inactiveUser = { ...activeRecruiter, status: 'SUSPENDED' as const };
    const { service, verifyPassword } = createService(inactiveUser);

    await expect(service.login('talentlens', 'recruiter@example.com', 'password')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith('password', 'stored-hash');
  });

  it('never authenticates from a dummy verification result', async () => {
    const { service, verifyPassword, sessionService } = createService(null);
    verifyPassword.mockResolvedValueOnce(true);

    await expect(
      service.login('talentlens', 'unknown@example.com', 'password'),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('uses one verification and the same public error for invalid credentials', async () => {
    const cases = [
      { user: null, password: 'password' },
      { user: { ...activeRecruiter, status: 'SUSPENDED' as const }, password: 'password' },
      { user: activeRecruiter, password: 'wrong' },
    ];

    for (const candidate of cases) {
      const { service, verifyPassword } = createService(candidate.user);
      const error = await service
        .login('talentlens', 'recruiter@example.com', candidate.password)
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as Error).message).toBe('Invalid credentials');
      expect(verifyPassword).toHaveBeenCalledTimes(1);
    }
  });
});
