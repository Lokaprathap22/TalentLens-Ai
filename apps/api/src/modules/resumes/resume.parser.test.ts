import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  DocxTextExtractor,
  InvalidDocumentFormatError,
  PdfTextExtractor,
  ResumeParsingService,
  SecurityLimitExceededError,
} from './resume.parser.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMinimalPdfWithText(text: string): Buffer {
  const streamContent = `BT\n/F1 12 Tf\n(${text}) Tj\nET`;
  const streamDeflated = zlib.deflateSync(Buffer.from(streamContent, 'utf8'));

  const pdf =
    [
      '%PDF-1.4',
      '1 0 obj',
      '<< /Type /Catalog /Pages 2 0 R >>',
      'endobj',
      '2 0 obj',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      'endobj',
      '3 0 obj',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      'endobj',
      '4 0 obj',
      `<< /Length ${streamDeflated.length} /Filter /FlateDecode >>`,
      'stream',
    ].join('\n') + '\n';

  const footer = [
    '\nendstream',
    'endobj',
    'xref',
    '0 5',
    'trailer',
    '<< /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');

  return Buffer.concat([Buffer.from(pdf, 'latin1'), streamDeflated, Buffer.from(footer, 'latin1')]);
}

function createMinimalScannedPdf(): Buffer {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> >>',
    'endobj',
    '4 0 obj',
    '<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /BitsPerComponent 8 >>',
    'stream',
    'RAW_IMAGE_BYTES_WITHOUT_TEXT',
    'endstream',
    'endobj',
    'trailer',
    '<< /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');

  return Buffer.from(pdf, 'latin1');
}

function createDocxBuffer(documentXmlText: string, compression = 8): Buffer {
  const nameBuf = Buffer.from('word/document.xml', 'utf8');
  const dataBuf = Buffer.from(documentXmlText, 'utf8');
  const compData = compression === 8 ? zlib.deflateRawSync(dataBuf) : dataBuf;

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(compression, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compData.length, 18);
  header.writeUInt32LE(dataBuf.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, nameBuf, compData]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Resume Parsing — PDF and DOCX Extractors', () => {
  const pdfExtractor = new PdfTextExtractor();
  const docxExtractor = new DocxTextExtractor();
  const parsingService = new ResumeParsingService(pdfExtractor, docxExtractor);

  describe('PDF Text Extractor', () => {
    it('rejects files without %PDF header signature', async () => {
      const invalid = Buffer.from('NOT A PDF FILE');
      await expect(pdfExtractor.parse(invalid)).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('extracts text and page positions from a valid text PDF', async () => {
      const pdfBuffer = createMinimalPdfWithText('Jane Doe - Staff Software Engineer');
      const result = await pdfExtractor.parse(pdfBuffer);

      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toContain('Jane Doe - Staff Software Engineer');
      expect(result.parser).toBe('talentlens-pdf-v1');
      expect(result.ocrUsed).toBe(false);

      const pages = result.pageMapJson['pages'] as Array<{ pageNumber: number; text: string }>;
      expect(pages).toHaveLength(1);
      expect(pages[0]!.pageNumber).toBe(1);
      expect(pages[0]!.text).toContain('Jane Doe');
    });

    it('marks scanned/image-only PDFs as NEEDS_REVIEW without inventing text', async () => {
      const scannedPdf = createMinimalScannedPdf();
      const result = await pdfExtractor.parse(scannedPdf);

      expect(result.qualityStatus).toBe('NEEDS_REVIEW');
      expect(result.extractedText).toBe('');
      expect(result.pageMapJson['scanned']).toBe(true);
      expect(String(result.pageMapJson['warning'])).toContain('OCR is required');
    });

    it('fails closed on unterminated PDF dictionary and degrades cleanly when valid PDF has unreadable text', async () => {
      const truncatedPdf = Buffer.from('%PDF-1.4\n1 0 obj << truncated');
      await expect(pdfExtractor.parse(truncatedPdf)).rejects.toThrow(InvalidDocumentFormatError);

      const unreadableContentPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Length 8 >> stream\nGARBAGE!\nendstream\nendobj\n%%EOF',
      );
      const result = await pdfExtractor.parse(unreadableContentPdf);

      expect(result.qualityStatus).toBe('NEEDS_REVIEW'); // no extractable text found
      expect(result.extractedText).toBe('');
    });
  });

  describe('DOCX Text Extractor', () => {
    it('rejects files without ZIP signature (PK\\x03\\x04)', async () => {
      const invalid = Buffer.from('NOT A DOCX FILE');
      await expect(docxExtractor.parse(invalid)).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('extracts paragraphs and character positions from a valid DOCX document', async () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '  <w:body>',
        '    <w:p><w:r><w:t>Alex Smith</w:t></w:r></w:p>',
        '    <w:p><w:r><w:t>Full Stack Developer &amp; Cloud Architect</w:t></w:r></w:p>',
        '  </w:body>',
        '</w:document>',
      ].join('\n');

      const docxBuffer = createDocxBuffer(xml);
      const result = await docxExtractor.parse(docxBuffer);

      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.parser).toBe('talentlens-docx-v1');
      expect(result.extractedText).toContain('Alex Smith');
      expect(result.extractedText).toContain('Full Stack Developer & Cloud Architect'); // unescaped &amp;

      const paragraphs = result.pageMapJson['paragraphs'] as Array<{ index: number; text: string }>;
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]!.text).toBe('Alex Smith');
      expect(paragraphs[1]!.text).toBe('Full Stack Developer & Cloud Architect');
    });

    it('rejects archives missing word/document.xml', async () => {
      const nameBuf = Buffer.from('some_other_file.txt', 'utf8');
      const dataBuf = Buffer.from('hello', 'utf8');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt32LE(dataBuf.length, 18);
      header.writeUInt32LE(dataBuf.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      const badZip = Buffer.concat([header, nameBuf, dataBuf]);

      await expect(docxExtractor.parse(badZip)).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('guards against ZIP bombs by rejecting excessive compression ratios', async () => {
      // Craft a header claiming 10 bytes compressed expands to 10,000 bytes (ratio > 50)
      const nameBuf = Buffer.from('word/document.xml', 'utf8');
      const fakeComp = Buffer.alloc(10);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(8, 8); // deflate
      header.writeUInt32LE(fakeComp.length, 18); // 10 bytes
      header.writeUInt32LE(10000, 22); // claims 10,000 bytes (ratio 1000x)
      header.writeUInt16LE(nameBuf.length, 26);

      const bomb = Buffer.concat([header, nameBuf, fakeComp]);
      await expect(docxExtractor.parse(bomb)).rejects.toThrow(SecurityLimitExceededError);
    });
  });

  describe('Unified Parsing Service', () => {
    it('delegates to the correct extractor based on file type', async () => {
      const pdf = createMinimalPdfWithText('PDF Content');
      const pdfRes = await parsingService.parse(pdf, 'PDF');
      expect(pdfRes.parser).toBe('talentlens-pdf-v1');

      const xml = '<w:p><w:t>DOCX Content</w:t></w:p>';
      const docx = createDocxBuffer(xml);
      const docxRes = await parsingService.parse(docx, 'DOCX');
      expect(docxRes.parser).toBe('talentlens-docx-v1');
    });
  });
});
