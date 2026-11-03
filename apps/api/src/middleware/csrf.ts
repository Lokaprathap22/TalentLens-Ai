import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

const CSRF_PURPOSE = 'talentlens-auth-csrf-v1';

export function deriveCsrfToken(rawSessionToken: string): string {
  return createHmac('sha256', rawSessionToken).update(CSRF_PURPOSE, 'utf8').digest('base64url');
}

export function verifyCsrfToken(
  rawSessionToken: string,
  suppliedToken: string | undefined,
): boolean {
  if (!suppliedToken) {
    return false;
  }

  const expected = Buffer.from(deriveCsrfToken(rawSessionToken), 'utf8');
  const supplied = Buffer.from(suppliedToken, 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export const CSRF_HEADER = 'x-csrf-token';

export const requireCsrf: RequestHandler = (request, response, next) => {
  const rawSessionToken = response.locals.sessionToken;
  if (
    typeof rawSessionToken !== 'string' ||
    !verifyCsrfToken(rawSessionToken, request.get(CSRF_HEADER))
  ) {
    response.status(403).json({ error: 'request_not_allowed' });
    return;
  }

  next();
};
