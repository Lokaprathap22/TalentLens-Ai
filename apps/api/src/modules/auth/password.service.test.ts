import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.service.js';

describe('password service', () => {
  it('hashes passwords with Argon2id without returning plaintext', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('$m=19456,t=2,p=1$');
  });

  it('verifies correct and incorrect passwords', async () => {
    const hash = await hashPassword('correct password');

    await expect(verifyPassword('correct password', hash)).resolves.toBe(true);
    await expect(verifyPassword('incorrect password', hash)).resolves.toBe(false);
  });

  it('fails safely for malformed hashes without exposing credentials', async () => {
    const password = 'secret password';

    await expect(verifyPassword(password, 'not-an-argon2-hash')).resolves.toBe(false);
    await expect(verifyPassword(password, '$argon2id$malformed')).resolves.toBe(false);
  });
});
