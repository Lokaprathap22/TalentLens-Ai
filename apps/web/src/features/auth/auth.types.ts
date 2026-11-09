import type {
  AuthenticatedUserDto,
  AuthenticatedUserResponseDto,
  CsrfTokenResponseDto,
  LoginRequestDto,
  UserRole,
} from '../../lib/api-client.js';

export type {
  AuthenticatedUserDto,
  AuthenticatedUserResponseDto,
  CsrfTokenResponseDto,
  LoginRequestDto,
  UserRole,
};

/**
 * Backend-authoritative authenticated user identity.
 * Note: The backend User model has no personal `name` column; `email` is the account identifier.
 */
export type AuthenticatedUser = AuthenticatedUserDto;

export type LoginInput = LoginRequestDto;

export type AuthInitializationStage = 'session' | 'csrf';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | {
      status: 'initialization-error';
      stage: AuthInitializationStage;
      message: string;
      user?: AuthenticatedUser | undefined;
    }
  | {
      status: 'authenticated';
      user: AuthenticatedUser;
    };

export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  RECRUITER: 'Recruiter',
  CLIENT_HIRING_MANAGER: 'Client Hiring Manager',
  DELIVERY_HEAD: 'Delivery Head',
};

export function formatUserRoleLabel(role: UserRole): string {
  return USER_ROLE_LABELS[role];
}

export function defaultLandingPathForRole(role: UserRole): string {
  switch (role) {
    case 'RECRUITER':
      return '/dashboard';
    case 'CLIENT_HIRING_MANAGER':
      return '/client-portal';
    case 'DELIVERY_HEAD':
      return '/delivery-overview';
  }
}

const RECRUITER_DISALLOWED_PREFIXES = ['/client-portal', '/delivery-overview', '/login'] as const;

/**
 * Validates that a candidate post-login redirect path is a safe internal application path
 * and is permitted for the authenticated user's role.
 */
export function isSafeInternalPath(path: unknown): path is string {
  if (typeof path !== 'string') {
    return false;
  }
  const trimmed = path.trim();
  if (
    !trimmed ||
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
  ) {
    return false;
  }

  const pathname = trimmed.split(/[?#]/)[0] ?? '';
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }

  return true;
}

export function isPathAllowedForRole(path: string, role: UserRole): boolean {
  if (!isSafeInternalPath(path)) {
    return false;
  }

  const pathname = path.trim().split(/[?#]/)[0] ?? '';
  if (pathname === '/' || pathname === '/login' || pathname.startsWith('/login/')) {
    return false;
  }

  switch (role) {
    case 'RECRUITER':
      return !RECRUITER_DISALLOWED_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      );
    case 'CLIENT_HIRING_MANAGER':
      return (
        pathname === '/dashboard' ||
        pathname.startsWith('/dashboard/') ||
        pathname === '/client-portal' ||
        pathname.startsWith('/client-portal/') ||
        pathname === '/interviews' ||
        pathname.startsWith('/interviews/')
      );
    case 'DELIVERY_HEAD':
      return pathname === '/delivery-overview' || pathname.startsWith('/delivery-overview/');
  }
}

export function resolveSafePostLoginRedirect(requestedPath: unknown, role: UserRole): string {
  if (isSafeInternalPath(requestedPath) && isPathAllowedForRole(requestedPath, role)) {
    return requestedPath.trim();
  }
  return defaultLandingPathForRole(role);
}
