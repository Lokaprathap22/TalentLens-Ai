export type UserRole = 'RECRUITER' | 'CLIENT_HIRING_MANAGER' | 'DELIVERY_HEAD';

export interface AuthenticatedUserDto {
  userId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedSession {
  user: AuthenticatedUserDto;
  token: string;
  expiresAt: Date;
}
