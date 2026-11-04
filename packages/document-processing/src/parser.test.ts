import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  DocxTextExtractor,
  InvalidDocumentFormatError,
  PdfTextExtractor,
  ResumeParsingService,
  SecurityLimitExceededError,
} from './index.js';

function createMinimalPdf(
  text: string,
  options: { encrypt?: boolean; objectStream?: boolean } = {},
): Buffer {
  const parts: string[] = ['%PDF-1.4'];

  if (options.encrypt) {
    parts.push('1 0 obj << /Type /Encrypt /V 2 >> endobj');
  }

  if (options.objectStream) {
    parts.push('2 0 obj << /Type /ObjStm /N 1 /First 4 >> stream\n3 0\nendstream\nendobj');
  }

  const streamContent = `BT\n/F1 12 Tf\n(${text}) Tj\nET`;
  const streamDeflated = zlib.deflateSync(Buffer.from(streamContent, 'utf8'));

  parts.push(
    '3 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj',
    '4 0 obj << /Type /Page /Parent 3 0 R /Contents 5 0 R >> endobj',
    `5 0 obj << /Length ${streamDeflated.length} /Filter /FlateDecode >> stream\n`,
  );

  const prefix = Buffer.from(parts.join('\n'), 'latin1');
  const suffix = Buffer.from('\nendstream\nendobj\ntrailer << /Root 3 0 R >>\n%%EOF', 'latin1');

  return Buffer.concat([prefix, streamDeflated, suffix]);
}

function createMinimalDocx(xmlBody: string): Buffer {
  const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${xmlBody}</w:body>
</w:document>`;

  const deflatedXml = zlib.deflateRawSync(Buffer.from(xmlContent, 'utf8'));
  const filename = Buffer.from('word/document.xml', 'utf8');

  // ZIP local file header (30 bytes)
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // Local file header signature
  header.writeUInt16LE(20, 4); // Version needed
  header.writeUInt16LE(0, 6); // General purpose bit flag
  header.writeUInt16LE(8, 8); // Compression method: Deflate
  header.writeUInt16LE(0, 10); // Time
  header.writeUInt16LE(0, 12); // Date
  header.writeUInt32LE(0, 14); // CRC32 (ignored for test)
  header.writeUInt32LE(deflatedXml.length, 18); // Compressed size
  header.writeUInt32LE(Buffer.byteLength(xmlContent), 22); // Uncompressed size
  header.writeUInt16LE(filename.length, 26); // Filename length
  header.writeUInt16LE(0, 28); // Extra field length

  return Buffer.concat([header, filename, deflatedXml]);
}

describe('Document Processing Package', () => {
  const pdfExtractor = new PdfTextExtractor();
  const docxExtractor = new DocxTextExtractor();
  const service = new ResumeParsingService(pdfExtractor, docxExtractor);

  describe('PDF Text Extractor', () => {
    it('rejects files without %PDF signature', async () => {
      await expect(pdfExtractor.parse(Buffer.from('not a pdf document'))).rejects.toThrow(
        InvalidDocumentFormatError,
      );
    });

    it('extracts text and computes page positions for standard PDFs', async () => {
      const pdf = createMinimalPdf('Jane Doe - Senior Architect');
      const result = await pdfExtractor.parse(pdf);

      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toContain('Jane Doe - Senior Architect');
      expect(result.pageMapJson['pageCount']).toBe(1);
    });

    it('detects encrypted PDFs and flags them as FAILED without throwing unhandled exceptions', async () => {
      const pdf = createMinimalPdf('Classified', { encrypt: true });
      const result = await pdfExtractor.parse(pdf);

      expect(result.qualityStatus).toBe('FAILED');
      expect(result.encrypted).toBe(true);
      expect(result.warning).toContain('password-protected or encrypted');
    });

    it('detects PDF 1.5+ object streams and reports them in metadata', async () => {
      const pdf = createMinimalPdf('Text inside PDF with object streams', { objectStream: true });
      const result = await pdfExtractor.parse(pdf);

      expect(result.objectStreamsDetected).toBe(true);
      expect(result.pageMapJson['objectStreams']).toBe(true);
    });

    it('marks image-only/scanned PDFs as NEEDS_REVIEW', async () => {
      const scannedPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /XObject /Subtype /Image >> endobj\n%%EOF',
      );
      const result = await pdfExtractor.parse(scannedPdf);

      expect(result.qualityStatus).toBe('NEEDS_REVIEW');
      expect(result.pageMapJson['scanned']).toBe(true);
    });
  });

  describe('DOCX Text Extractor', () => {
    it('rejects files without ZIP local header signature', async () => {
      await expect(docxExtractor.parse(Buffer.from('corrupt non-zip'))).rejects.toThrow(
        InvalidDocumentFormatError,
      );
    });

    it('extracts paragraphs, tabs, line breaks, and Unicode numeric entities', async () => {
      const xml = `
        <w:p>
          <w:r><w:t>John Doe</w:t></w:r>
          <w:tab/>
          <w:r><w:t>Staff Engineer &#8211; Tech Lead</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:t>First line</w:t></w:r>
          <w:br/>
          <w:r><w:t>Second line with accented e: caf&#233;</w:t></w:r>
        </w:p>
      `;

      const docx = createMinimalDocx(xml);
      const result = await docxExtractor.parse(docx);

      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toContain('John Doe\tStaff Engineer – Tech Lead');
      expect(result.extractedText).toContain('First line\nSecond line with accented e: café');
      expect(result.pageMapJson['paragraphCount']).toBe(2);
    });

    it('guards against excessive compression ratio (ZIP bomb defense)', async () => {
      const largeXml = '<w:p><w:t>A</w:t></w:p>'.repeat(5000);
      const deflated = zlib.deflateRawSync(Buffer.from(largeXml));
      const filename = Buffer.from('word/document.xml');

      // Craft fake header claiming 1000:1 ratio
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(deflated.length, 18);
      header.writeUInt32LE(deflated.length * 100, 22); // Exceeds 50:1 limit
      header.writeUInt16LE(filename.length, 26);

      const fakeZipBomb = Buffer.concat([header, filename, deflated]);
      await expect(docxExtractor.parse(fakeZipBomb)).rejects.toThrow(SecurityLimitExceededError);
    });
  });

  describe('Unified Parsing Service', () => {
    it('delegates to the correct parser based on file type', async () => {
      const pdf = createMinimalPdf('Alice Smith');
      const result = await service.parse(pdf, 'PDF');
      expect(result.extractedText).toContain('Alice Smith');
    });
  });
});
