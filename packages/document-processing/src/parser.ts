import { DocxTextExtractor } from './docx.js';
import { InvalidDocumentFormatError } from './errors.js';
import { TesseractOcrProvider } from './ocr.js';
import { PdfTextExtractor } from './pdf.js';
import type { DocumentParser, OcrProvider, ParserResult, ResumeFileType } from './types.js';

export class ResumeParsingService {
  private readonly pdfExtractor: PdfTextExtractor;
  private readonly docxExtractor: DocxTextExtractor;

  constructor(
    pdfExtractor: PdfTextExtractor = new PdfTextExtractor(new TesseractOcrProvider()),
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

export function createResumeParsingService(options?: {
  ocrProvider?: OcrProvider | undefined;
}): ResumeParsingService {
  const ocrProvider = options?.ocrProvider ?? new TesseractOcrProvider();
  return new ResumeParsingService(new PdfTextExtractor(ocrProvider));
}
