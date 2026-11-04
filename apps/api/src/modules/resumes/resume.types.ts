export type ResumeFileType = 'PDF' | 'DOCX';

export type ResumeParseStatus = 'PENDING' | 'PROCESSING' | 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';

export type ExtractionQualityStatus = 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED';

export interface AcceptedUploadItem {
  resumeDocumentId: string;
  candidateId: string;
  candidateCode: string;
  fileName: string;
  fileType: ResumeFileType;
  sizeBytes: number;
  sha256: string;
  status: 'ACCEPTED';
}

export interface DuplicateUploadItem {
  fileName: string;
  sha256: string;
  resumeDocumentId: string;
  status: 'DUPLICATE';
  message: string;
}

export interface RejectedUploadItem {
  fileName: string;
  reason: string;
  status: 'REJECTED';
}

export interface ResumeBatchUploadResult {
  batchId: string | null;
  totalFiles: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  accepted: AcceptedUploadItem[];
  duplicates: DuplicateUploadItem[];
  rejected: RejectedUploadItem[];
}

export interface ResumeDocumentDto {
  id: string;
  candidateId: string;
  candidateCode: string;
  fileName: string;
  fileType: ResumeFileType;
  sizeBytes: number;
  sha256: string;
  parseStatus: ResumeParseStatus;
  uploadedAt: string;
  updatedAt: string;
}

export interface DocumentExtractionDto {
  id: string;
  resumeDocumentId: string;
  version: number;
  extractedText: string;
  pageMap: Record<string, unknown>;
  parser: string;
  ocrUsed: boolean;
  qualityStatus: ExtractionQualityStatus;
  createdAt: string;
}

export interface PagePosition {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface ParagraphPosition {
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface ParserResult {
  extractedText: string;
  pageMapJson: Record<string, unknown>;
  parser: string;
  ocrUsed: boolean;
  qualityStatus: ExtractionQualityStatus;
}

export interface DocumentParser {
  supports(fileType: ResumeFileType): boolean;
  parse(buffer: Buffer): Promise<ParserResult>;
}

export interface StoredFileDescriptor {
  storageKey: string;
  sizeBytes: number;
}

export interface DocumentStorageService {
  save(key: string, content: Buffer): Promise<StoredFileDescriptor>;
  saveFromPath(key: string, sourcePath: string): Promise<StoredFileDescriptor>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
