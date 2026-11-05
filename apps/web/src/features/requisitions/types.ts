export type RequisitionStatus = 'DRAFT' | 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';

export type RequisitionFilterStatus = 'ALL' | 'DRAFT' | 'OPEN' | 'PAUSED' | 'CLOSED_OR_FILLED';

export interface RequisitionRecord {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  jdText: string;
  status: RequisitionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListRequisitionsResponseDto {
  requisitions: RequisitionRecord[];
}

export interface RequisitionResponseDto {
  requisition: RequisitionRecord;
}

export interface CreateRequisitionInput {
  clientId: string;
  title: string;
  jdText: string;
}

export interface UpdateRequisitionInput {
  clientId?: string | undefined;
  title?: string | undefined;
  jdText?: string | undefined;
}

export type TransitionTargetStatus = 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';

export interface TransitionStatusInput {
  status: TransitionTargetStatus;
}

export interface RequisitionSummaryCounts {
  total: number;
  draft: number;
  open: number;
  paused: number;
  closedOrFilled: number;
}
