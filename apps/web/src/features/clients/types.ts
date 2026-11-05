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
