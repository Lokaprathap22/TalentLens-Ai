import { DocxTextExtractor } from './docx.js';
import { InvalidDocumentFormatError } from './errors.js';
import { PdfTextExtractor } from './pdf.js';
import type { DocumentParser, ParserResult, ResumeFileType } from './types.js';

export class ResumeParsingService {
  private readonly pdfExtractor: PdfTextExtractor;
  private readonly docxExtractor: DocxTextExtractor;

  constructor(
    pdfExtractor: PdfTextExtractor = new PdfTextExtractor(),
    docxExtractor: DocxTextExtractor = new DocxTextExtractor(),
  ) {
    this.pdfExtractor = pdfExtractor;
    this.docxExtractor = docxExtractor;
  }

  public getParser(fileType: ResumeFileType): DocumentParser {
    if (fileType === 'PDF') return this.pdfExtractor;
    if (fileType === 'DOCX') return this.docxExtractor;
    throw new InvalidDocumentFormatError(`Unsupported resume file type: ${String(fileType)}`);
  }

  public async parse(buffer: Buffer, fileType: ResumeFileType): Promise<ParserResult> {
    return this.getParser(fileType).parse(buffer);
  }
}

export function createResumeParsingService(): ResumeParsingService {
  return new ResumeParsingService();
}
