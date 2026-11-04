export type RequisitionStatus = 'DRAFT' | 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';

export interface RequisitionDto {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  jdText: string;
  status: RequisitionStatus;
  createdAt: string;
  updatedAt: string;
}
