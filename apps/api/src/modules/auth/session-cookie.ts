import { SESSION_TTL_MS } from './session.service.js';

export const PRODUCTION_SESSION_COOKIE = '__Host-talentlens_session';
export const DEVELOPMENT_SESSION_COOKIE = 'talentlens_session';

export interface SessionCookieOptions {
  secure: boolean;
}

export function getSessionCookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE;
}

function cookieAttributes(options: SessionCookieOptions): string {
  return `HttpOnly; Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

export function setSessionCookie(token: string, options: SessionCookieOptions): string {
  const name = getSessionCookieName(options.secure);
  return `${name}=${token}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieAttributes(options)}`;
}

export function clearSessionCookie(options: SessionCookieOptions): string {
  const name = getSessionCookieName(options.secure);
  return `${name}=; Max-Age=0; ${cookieAttributes(options)}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    if (key === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }

  return null;
}
