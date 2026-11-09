export type ClientStatus = 'ACTIVE' | 'INACTIVE';

export type ClientFilterStatus = 'ALL' | 'ACTIVE' | 'INACTIVE';

export interface ClientRecord {
  id: string;
  name: string;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListClientsResponseDto {
  clients: ClientRecord[];
}

export interface ClientMutationResponseDto {
  client: ClientRecord;
}

export interface CreateClientInput {
  name: string;
}

export interface UpdateClientInput {
  name?: string | undefined;
  status?: ClientStatus | undefined;
}

export interface ClientSummaryCounts {
  total: number;
  active: number;
  inactive: number;
}

export type MembershipRole = 'CLIENT_HIRING_MANAGER';
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type UserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED';

export interface ClientMemberRecord {
  id: string;
  membershipId: string;
  userId: string;
  clientId: string;
  organizationId: string;
  name: string | null;
  email: string;
  role: MembershipRole;
  membershipStatus: MembershipStatus;
  userStatus: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListClientMembersResponseDto {
  members: ClientMemberRecord[];
}

export interface InviteClientMemberInput {
  email: string;
  name?: string | undefined;
}

export interface InviteClientMemberResponseDto {
  member: ClientMemberRecord;
}

export interface ClientDetailResponseDto {
  client: ClientRecord;
}
