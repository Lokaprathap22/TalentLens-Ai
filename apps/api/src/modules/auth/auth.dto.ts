import type { AuthenticatedPrincipal } from './session.service.js';

export interface AuthenticatedUserDto {
  userId: string;
  organizationId: string;
  email: string;
  role: AuthenticatedPrincipal['role'];
}

export interface AuthenticatedSession {
  user: AuthenticatedUserDto;
  token: string;
  expiresAt: Date;
}
