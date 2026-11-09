import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationError,
  CurrentPasswordIncorrectError,
  InvalidTokenError,
  createAuthService,
} from './auth.service.js';
import { createAuthRepository, type AuthRepository, type LoginUser } from './auth.repository.js';
import { DUMMY_PASSWORD_HASH } from './password.service.js';
import type { SessionService } from './session.service.js';
import type { SecurityTokenRecord, SecurityTokenService } from './token.service.js';

const activeRecruiter: LoginUser = {
  id: 'user-1',
  organizationId: 'org-1',
  organizationName: 'TalentLens',
  name: 'Alex Recruiter',
  email: 'recruiter@example.com',
  passwordHash: 'stored-hash',
  role: 'RECRUITER',
  status: 'ACTIVE',
};

function createService(user: LoginUser | null) {
  const repository: AuthRepository = {
    findUserByOrganizationAndEmail: vi.fn(async () => user),
    findUserById: vi.fn(async (id: string) => (user?.id === id ? user : null)),
    updateUserPassword: vi.fn(async () => {}),
    activateUser: vi.fn(async () => ({
      ...activeRecruiter,
      passwordHash: 'new-hash',
      status: 'ACTIVE' as const,
    })),
    updateUserName: vi.fn(async (_id: string, name: string) => ({
      ...activeRecruiter,
      name,
    })),
    activateUserWithToken: vi.fn(async () => ({
      ...activeRecruiter,
      passwordHash: 'new-hash',
      status: 'ACTIVE' as const,
    })),
    resetPasswordWithToken: vi.fn(async () => {}),
  };
  const sessionService: Pick<
    SessionService,
    'createSession' | 'revokeUserSessions' | 'revokeOtherUserSessions'
  > = {
    createSession: vi.fn(async () => ({
      token: 'A'.repeat(43),
      expiresAt: new Date('2026-11-04T07:33:39.684Z'),
    })),
    revokeUserSessions: vi.fn(async () => {}),
    revokeOtherUserSessions: vi.fn(async () => {}),
  };
  const verifyPassword = vi.fn(
    async (password: string, hash: string) => password === 'password' && hash === 'stored-hash',
  );
  const hashPassword = vi.fn(async (password: string) => `hashed-${password}`);

  const mockTokenRecord: SecurityTokenRecord = {
    id: 'tok-1',
    organizationId: 'org-1',
    userId: 'user-1',
    tokenHash: 'token-hash',
    type: 'ACTIVATION',
    expiresAt: new Date(Date.now() + 100000),
    consumedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-1',
      email: 'recruiter@example.com',
      name: 'Alex Recruiter',
      role: 'RECRUITER',
      status: 'INVITED',
    },
    organization: {
      id: 'org-1',
      name: 'TalentLens',
    },
  };

  const tokenService: Pick<
    SecurityTokenService,
    'findValidToken' | 'consumeToken' | 'createToken'
  > = {
    findValidToken: vi.fn(async (token: string, type: string) =>
      token.startsWith('valid-') && type === mockTokenRecord.type ? mockTokenRecord : null,
    ),
    consumeToken: vi.fn(async () => true),
    createToken: vi.fn(async () => ({
      token: 'generated-token-xyz-123456789012345',
      record: mockTokenRecord,
    })),
  };

  const emailDeliveryService = {
    sendPasswordReset: vi.fn(async () => ({ delivered: true })),
    sendAccountActivation: vi.fn(async () => ({ delivered: true })),
  };

  const service = createAuthService({
    repository,
    sessionService,
    tokenService,
    verifyPassword,
    hashPassword,
    emailDeliveryService,
    applicationOrigin: 'https://talentlens-ai.duckdns.org',
  });

  return {
    repository,
    sessionService,
    tokenService,
    service,
    verifyPassword,
    hashPassword,
    emailDeliveryService,
  };
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
        name: 'Alex Recruiter',
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
      name: null,
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
      name: null,
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

  it('activates account with valid token, updates status to ACTIVE, and creates session', async () => {
    const { service, repository, tokenService, sessionService, hashPassword } =
      createService(activeRecruiter);
    const validToken = 'valid-activation-token-123456789012345678';

    const result = await service.activate(validToken, 'new-secure-password');

    expect(tokenService.findValidToken).toHaveBeenCalledWith(validToken, 'ACTIVATION');
    expect(hashPassword).toHaveBeenCalledWith('new-secure-password');
    expect(repository.activateUserWithToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 'tok-1',
        userId: 'user-1',
        organizationId: 'org-1',
        passwordHash: 'hashed-new-secure-password',
      }),
    );
    expect(sessionService.revokeUserSessions).toHaveBeenCalledWith('user-1');
    expect(sessionService.createSession).toHaveBeenCalledWith('user-1');
    expect(result.user.email).toBe('recruiter@example.com');
  });

  it('rejects activation when token format is invalid', async () => {
    const { service } = createService(activeRecruiter);

    await expect(service.activate('short', 'password')).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects activation when token is invalid or expired', async () => {
    const { service, tokenService } = createService(activeRecruiter);
    vi.mocked(tokenService.findValidToken).mockResolvedValueOnce(null);

    await expect(
      service.activate('valid-but-expired-token-123456789012', 'password'),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects activation if account status is SUSPENDED or DEACTIVATED', async () => {
    const { service, tokenService } = createService(activeRecruiter);
    const validToken = 'valid-activation-token-123456789012345678';

    // Suspended
    vi.mocked(tokenService.findValidToken).mockResolvedValueOnce({
      id: 'tok-1',
      organizationId: 'org-1',
      userId: 'user-1',
      tokenHash: 'token-hash',
      type: 'ACTIVATION',
      expiresAt: new Date(Date.now() + 100000),
      consumedAt: null,
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'recruiter@example.com',
        name: 'Alex Recruiter',
        role: 'RECRUITER',
        status: 'SUSPENDED',
      },
      organization: { id: 'org-1', name: 'TalentLens' },
    });

    await expect(service.activate(validToken, 'new-secure-password')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );

    // Deactivated
    vi.mocked(tokenService.findValidToken).mockResolvedValueOnce({
      id: 'tok-1',
      organizationId: 'org-1',
      userId: 'user-1',
      tokenHash: 'token-hash',
      type: 'ACTIVATION',
      expiresAt: new Date(Date.now() + 100000),
      consumedAt: null,
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'recruiter@example.com',
        name: 'Alex Recruiter',
        role: 'RECRUITER',
        status: 'DEACTIVATED',
      },
      organization: { id: 'org-1', name: 'TalentLens' },
    });

    await expect(service.activate(validToken, 'new-secure-password')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('simulates two simultaneous activation attempts with one token: exactly one succeeds and second is rejected', async () => {
    const { service, repository } = createService(activeRecruiter);
    const validToken = 'valid-activation-token-123456789012345678';

    let calls = 0;
    vi.mocked(repository.activateUserWithToken).mockImplementation(async () => {
      calls += 1;
      if (calls > 1) {
        throw new InvalidTokenError('Invalid or expired account activation link');
      }
      return {
        ...activeRecruiter,
        passwordHash: 'new-hash',
        status: 'ACTIVE',
      };
    });

    const [res1, res2] = await Promise.allSettled([
      service.activate(validToken, 'password-attempt-1'),
      service.activate(validToken, 'password-attempt-2'),
    ]);

    const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
    const failures = [res1, res2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTokenError);
  });

  it('failed account update rolls back token consumption and never creates a session', async () => {
    const { service, repository, sessionService } = createService(activeRecruiter);
    const validToken = 'valid-activation-token-123456789012345678';

    vi.mocked(repository.activateUserWithToken).mockRejectedValueOnce(
      new InvalidTokenError('Account update failed - rolled back'),
    );

    await expect(service.activate(validToken, 'password')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('changes password when current password matches, revoking other sessions', async () => {
    const { service, repository, sessionService, hashPassword } = createService(activeRecruiter);

    await service.changePassword('user-1', 'password', 'brand-new-pass', 'current-token-123');

    expect(repository.findUserById).toHaveBeenCalledWith('user-1');
    expect(hashPassword).toHaveBeenCalledWith('brand-new-pass');
    expect(repository.updateUserPassword).toHaveBeenCalledWith('user-1', 'hashed-brand-new-pass');
    expect(sessionService.revokeOtherUserSessions).toHaveBeenCalledWith(
      'user-1',
      'current-token-123',
    );
  });

  it('rejects change password when current password is wrong', async () => {
    const { service } = createService(activeRecruiter);

    await expect(
      service.changePassword('user-1', 'wrong-pass', 'brand-new-pass', 'tok'),
    ).rejects.toBeInstanceOf(CurrentPasswordIncorrectError);
  });

  it('requests password reset without user enumeration, sending email with URL fragment and user role', async () => {
    const { service, tokenService, emailDeliveryService } = createService(activeRecruiter);

    await service.requestPasswordReset('talentlens', 'recruiter@example.com');

    expect(tokenService.createToken).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      type: 'PASSWORD_RESET',
    });
    expect(emailDeliveryService.sendPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recruiter@example.com',
        recipientRole: 'RECRUITER',
        resetUrl: expect.stringContaining('/reset-password#token=generated-token-xyz'),
      }),
    );
  });

  it('requests password reset without leaking nonexistent accounts', async () => {
    const { service, tokenService, emailDeliveryService } = createService(null);

    await expect(
      service.requestPasswordReset('nonexistent-org', 'unknown@example.com'),
    ).resolves.toBeUndefined();

    expect(tokenService.createToken).not.toHaveBeenCalled();
    expect(emailDeliveryService.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('confirms password reset atomically with resetPasswordWithToken', async () => {
    const { service, repository, tokenService, hashPassword } = createService(activeRecruiter);
    const validResetToken = 'valid-reset-token-123456789012345678';
    vi.mocked(tokenService.findValidToken).mockResolvedValueOnce({
      id: 'reset-tok-1',
      organizationId: 'org-1',
      userId: 'user-1',
      tokenHash: 'tok-hash',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'recruiter@example.com',
        name: null,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
      organization: {
        id: 'org-1',
        name: 'TalentLens',
      },
    });

    await service.confirmPasswordReset(validResetToken, 'my-new-password');

    expect(hashPassword).toHaveBeenCalledWith('my-new-password');
    expect(repository.resetPasswordWithToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 'reset-tok-1',
        userId: 'user-1',
        organizationId: 'org-1',
        passwordHash: 'hashed-my-new-password',
      }),
    );
  });

  it('simulates two simultaneous reset attempts with one token: exactly one succeeds and second is rejected', async () => {
    const { service, repository, tokenService } = createService(activeRecruiter);
    const validResetToken = 'valid-reset-token-123456789012345678';
    vi.mocked(tokenService.findValidToken).mockResolvedValue({
      id: 'reset-tok-1',
      organizationId: 'org-1',
      userId: 'user-1',
      tokenHash: 'tok-hash',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'recruiter@example.com',
        name: null,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
      organization: {
        id: 'org-1',
        name: 'TalentLens',
      },
    });

    let calls = 0;
    vi.mocked(repository.resetPasswordWithToken).mockImplementation(async () => {
      calls += 1;
      if (calls > 1) {
        throw new InvalidTokenError('Invalid or expired password reset link');
      }
    });

    const [res1, res2] = await Promise.allSettled([
      service.confirmPasswordReset(validResetToken, 'password-attempt-1'),
      service.confirmPasswordReset(validResetToken, 'password-attempt-2'),
    ]);

    const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
    const failures = [res1, res2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects password reset when account is not active (SUSPENDED)', async () => {
    const { service, tokenService } = createService(activeRecruiter);
    const validResetToken = 'valid-reset-token-123456789012345678';
    vi.mocked(tokenService.findValidToken).mockResolvedValueOnce({
      id: 'reset-tok-1',
      organizationId: 'org-1',
      userId: 'user-1',
      tokenHash: 'tok-hash',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'recruiter@example.com',
        name: null,
        role: 'RECRUITER',
        status: 'SUSPENDED',
      },
      organization: {
        id: 'org-1',
        name: 'TalentLens',
      },
    });

    await expect(
      service.confirmPasswordReset(validResetToken, 'my-new-password'),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects password reset when token format is invalid', async () => {
    const { service } = createService(activeRecruiter);

    await expect(service.confirmPasswordReset('too-short', 'new-password')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('updates user display name in profile', async () => {
    const { service, repository } = createService(activeRecruiter);

    const updated = await service.updateProfile('user-1', 'Jane Recruiter');

    expect(repository.updateUserName).toHaveBeenCalledWith('user-1', 'Jane Recruiter');
    expect(updated.name).toBe('Jane Recruiter');
  });
});
