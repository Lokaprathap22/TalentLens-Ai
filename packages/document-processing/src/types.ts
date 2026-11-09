export type ResumeFileType = 'PDF' | 'DOCX';

export type ExtractionQualityStatus = 'COMPLETE' | 'NEEDS_REVIEW' | 'FAILED';

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
  warning?: string | undefined;
  encrypted?: boolean | undefined;
  objectStreamsDetected?: boolean | undefined;
}

export interface DocumentParser {
  supports(fileType: ResumeFileType): boolean;
  parse(buffer: Buffer): Promise<ParserResult>;
}

export interface OcrPage {
  pageNumber: number;
  text: string;
  confidence: number;
  startOffset: number;
  endOffset: number;
}

export interface OcrResult {
  text: string;
  confidence?: number;
  engine: string;
  pages?: OcrPage[];
  totalPages?: number;
  isPartial?: boolean;
}

export interface OcrProvider {
  supports(buffer: Buffer): boolean;
  extractText(buffer: Buffer): Promise<OcrResult | null>;
}
