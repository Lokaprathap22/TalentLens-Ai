import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export class PasswordHashingError extends Error {
  constructor() {
    super('Password hashing failed');
    this.name = 'PasswordHashingError';
  }
}

export async function hashPassword(password: string): Promise<string> {
  try {
    return await argon2.hash(password, ARGON2_OPTIONS);
  } catch {
    throw new PasswordHashingError();
  }
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(encodedHash, password);
  } catch {
    return false;
  }
}
