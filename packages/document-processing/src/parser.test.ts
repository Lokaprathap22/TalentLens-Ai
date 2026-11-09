import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPdfGeometryWithinLimits,
  assertPdfGeometryWithinLimitsAsync,
  DocumentProcessingTimeoutError,
  DocxTextExtractor,
  EncryptedDocumentError,
  InvalidDocumentFormatError,
  PdfTextExtractor,
  ResumeParsingService,
  SecurityLimitExceededError,
  TesseractOcrProvider,
} from './index.js';
import { inflateBounded } from './decompress.js';

function createMinimalPdf(
  text: string,
  options: { encrypt?: boolean; objectStream?: boolean } = {},
): Buffer {
  const parts: string[] = ['%PDF-1.4'];

  if (options.encrypt) {
    parts.push('1 0 obj << /Type /Encrypt /V 2 >> endobj');
  }

  if (options.objectStream) {
    parts.push(
      '2 0 obj << /Type /ObjStm /N 1 /First 4 >> stream\n6 0\n<< /Producer (TalentLens) >>\nendstream\nendobj',
    );
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

    it('invokes OCR provider when PDF has no text layer and OCR is supported', async () => {
      const scannedPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\ntrailer << >>\n%%EOF',
      );
      const mockOcr = {
        supports: vi.fn(() => true),
        extractText: vi.fn(async () => ({
          text: 'OCR Extracted Candidate Profile',
          confidence: 0.95,
          engine: 'mock-tesseract-v5',
        })),
      };

      const extractor = new PdfTextExtractor(mockOcr);
      const result = await extractor.parse(scannedPdf);

      expect(mockOcr.supports).toHaveBeenCalledWith(scannedPdf);
      expect(mockOcr.extractText).toHaveBeenCalledWith(scannedPdf);
      expect(result.ocrUsed).toBe(true);
      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toBe('OCR Extracted Candidate Profile');
      expect(result.parser).toBe('talentlens-pdf-ocr-v1');
    });

    it('honestly marks scanned PDF as NEEDS_REVIEW when OCR is not available', async () => {
      const scannedPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\ntrailer << >>\n%%EOF',
      );
      const extractor = new PdfTextExtractor(); // No OCR provider
      const result = await extractor.parse(scannedPdf);

      expect(result.ocrUsed).toBe(false);
      expect(result.qualityStatus).toBe('NEEDS_REVIEW');
      expect(result.warning).toBeDefined();
    });

    it('transitions to NEEDS_REVIEW when OCR yields low confidence (<0.5)', async () => {
      const scannedPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\ntrailer << >>\n%%EOF',
      );
      const lowConfidenceOcr = {
        supports: vi.fn(() => true),
        extractText: vi.fn(async () => ({
          text: 'Uncertain blurred characters',
          confidence: 0.35,
          engine: 'mock-tesseract-v5',
        })),
      };

      const extractor = new PdfTextExtractor(lowConfidenceOcr);
      const result = await extractor.parse(scannedPdf);

      expect(result.ocrUsed).toBe(false);
      expect(result.qualityStatus).toBe('NEEDS_REVIEW');
      expect(result.warning).toContain('low-confidence');
    });

    it('routes image-dominant PDF (<100 chars text + /Image) to OCR', async () => {
      const imagePdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Pages /Resources << /XObject << /Im1 << /Type /XObject /Subtype /Image >> >> >> >> endobj\n' +
          '2 0 obj << /Length 20 >> stream\nBT /F1 12 Tf (Cover) Tj ET\nendstream\nendobj\ntrailer << >>\n%%EOF',
      );
      const mockOcr = {
        supports: vi.fn(() => true),
        extractText: vi.fn(async () => ({
          text: 'Full OCR Extracted Text From High Resolution Document Scan',
          confidence: 0.92,
          engine: 'mock-tesseract-v5',
        })),
      };

      const extractor = new PdfTextExtractor(mockOcr);
      const result = await extractor.parse(imagePdf);

      expect(mockOcr.supports).toHaveBeenCalled();
      expect(result.ocrUsed).toBe(true);
      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toContain('Full OCR Extracted Text');
    });

    it('does not invoke OCR when standard PDF has adequate text layer', async () => {
      const longText =
        'Software Engineer with experience in TypeScript, React, PostgreSQL, Docker, AWS and systems design '.repeat(
          3,
        );
      const normalPdf = createMinimalPdf(longText);

      const mockOcr = {
        supports: vi.fn(() => true),
        extractText: vi.fn(async () => null),
      };

      const extractor = new PdfTextExtractor(mockOcr);
      const result = await extractor.parse(normalPdf);

      expect(mockOcr.extractText).not.toHaveBeenCalled();
      expect(result.ocrUsed).toBe(false);
      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toContain('Software Engineer');
    });
  });

  describe('TesseractOcrProvider', () => {
    const provider = new TesseractOcrProvider({
      maxFileSizeBytes: 1024 * 1024,
      timeoutMs: 5000,
    });

    it('supports PDF, PNG, JPEG, and TIFF signatures', () => {
      expect(provider.supports(Buffer.from('%PDF-1.7...'))).toBe(true);
      expect(provider.supports(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
        true,
      ); // PNG
      expect(provider.supports(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true); // JPEG
      expect(provider.supports(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe(true); // TIFF little-endian
      expect(provider.supports(Buffer.from('plain text'))).toBe(false);
    });

    it('parses TSV output correctly and calculates average word confidence', () => {
      const mockTsv = [
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
        '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
        '5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tJane',
        '5\t1\t1\t1\t1\t2\t65\t10\t50\t20\t85\tDoe',
        '5\t1\t1\t1\t2\t1\t10\t35\t100\t20\t90\tEngineer',
      ].join('\n');

      const parsed = provider.parseTsvOutput(mockTsv);

      expect(parsed.text).toBe('Jane Doe\nEngineer');
      expect(parsed.wordCount).toBe(3);
      // (0.95 + 0.85 + 0.90) / 3 = 0.90
      expect(parsed.confidence).toBeCloseTo(0.9, 2);
    });

    it('handles empty or header-only TSV gracefully', () => {
      const emptyTsv =
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
      const parsed = provider.parseTsvOutput(emptyTsv);

      expect(parsed.text).toBe('');
      expect(parsed.confidence).toBe(0);
      expect(parsed.wordCount).toBe(0);
    });

    it('enforces maximum file size limit with SecurityLimitExceededError', async () => {
      const oversizedBuffer = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB limit
      oversizedBuffer.write('%PDF-1.4');

      await expect(provider.extractText(oversizedBuffer)).rejects.toThrow(
        SecurityLimitExceededError,
      );
    });

    it('reports unavailable honestly without throwing unhandled crashes when binary is missing', async () => {
      const dummyProvider = new TesseractOcrProvider({
        tesseractPath: 'non-existent-tesseract-binary-xyz',
      });

      const isAvail = await dummyProvider.isAvailable();
      expect(isAvail).toBe(false);

      const dummyPdf = Buffer.from('%PDF-1.4\n...');
      const result = await dummyProvider.extractText(dummyPdf);
      expect(result).toBeNull();
    });

    it('flags partial OCR extractions exceeding page limit as NEEDS_REVIEW with provenance', async () => {
      const mockOcr = {
        supports: vi.fn(() => true),
        extractText: vi.fn(async () => ({
          text: 'Page 1 OCR text\n\nPage 2 OCR text',
          confidence: 0.92,
          engine: 'tesseract-5.x',
          totalPages: 15,
          isPartial: true,
          pages: [
            {
              pageNumber: 1,
              text: 'Page 1 OCR text',
              confidence: 0.95,
              startOffset: 0,
              endOffset: 15,
            },
            {
              pageNumber: 2,
              text: 'Page 2 OCR text',
              confidence: 0.89,
              startOffset: 17,
              endOffset: 32,
            },
          ],
        })),
      };

      const scannedPdf = Buffer.from('%PDF-1.4 /Image ...');
      const extractor = new PdfTextExtractor(mockOcr);
      const result = await extractor.parse(scannedPdf);

      expect(mockOcr.extractText).toHaveBeenCalled();
      expect(result.ocrUsed).toBe(true);
      expect(result.qualityStatus).toBe('NEEDS_REVIEW');
      expect(result.warning).toContain('exceeding the OCR processing limit');
      expect(result.pageMapJson['pages']).toHaveLength(2);
      expect(result.pageMapJson['pages']).toEqual([
        {
          pageNumber: 1,
          startOffset: 0,
          endOffset: 15,
          text: 'Page 1 OCR text',
        },
        {
          pageNumber: 2,
          startOffset: 17,
          endOffset: 32,
          text: 'Page 2 OCR text',
        },
      ]);
    });

    it('tracks exact page offsets across leading, middle, and trailing blank OCR pages', async () => {
      const makeTsv = (words: string[], conf = 94) => {
        const header =
          'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
        if (words.length === 0) return `${header}\n`;
        return [
          header,
          ...words.map(
            (word, idx) => `5\t1\t1\t1\t1\t${idx + 1}\t10\t10\t40\t20\t${conf}\t${word}`,
          ),
        ].join('\n');
      };

      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 24.02.0\n', stderr: '' };
          if (args.includes('--list-langs')) {
            return { stdout: 'List of available languages (1):\neng\n', stderr: '' };
          }
          if (file === 'pdfinfo') return { stdout: 'Pages:          5\n', stderr: '' };
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            for (let p = 1; p <= 5; p += 1) {
              await fs.promises.writeFile(`${prefix}-${p}.png`, Buffer.from('fake-png'));
            }
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            const imgPath = args[0]!;
            if (imgPath.endsWith('page-1.png')) return { stdout: makeTsv([]), stderr: '' };
            if (imgPath.endsWith('page-2.png'))
              return { stdout: makeTsv(['Alice', 'Smith']), stderr: '' };
            if (imgPath.endsWith('page-3.png')) return { stdout: makeTsv([]), stderr: '' };
            if (imgPath.endsWith('page-4.png'))
              return { stdout: makeTsv(['Staff', 'Engineer']), stderr: '' };
            if (imgPath.endsWith('page-5.png')) return { stdout: makeTsv([]), stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );

      const ocrProvider = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 5 >> endobj\n%%EOF');
      const extractor = new PdfTextExtractor(ocrProvider);
      const parsed = await extractor.parse(scannedPdf);

      expect(parsed.ocrUsed).toBe(true);
      expect(parsed.qualityStatus).toBe('COMPLETE');
      expect(parsed.extractedText).toBe('Alice Smith\n\nStaff Engineer');

      const pages = parsed.pageMapJson['pages'] as Array<{
        pageNumber: number;
        startOffset: number;
        endOffset: number;
        text: string;
      }>;
      expect(pages).toHaveLength(5);

      for (const page of pages) {
        expect(parsed.extractedText.slice(page.startOffset, page.endOffset)).toBe(page.text);
      }

      expect(pages).toEqual([
        { pageNumber: 1, startOffset: 0, endOffset: 0, text: '' },
        { pageNumber: 2, startOffset: 0, endOffset: 11, text: 'Alice Smith' },
        { pageNumber: 3, startOffset: 11, endOffset: 11, text: '' },
        { pageNumber: 4, startOffset: 13, endOffset: 27, text: 'Staff Engineer' },
        { pageNumber: 5, startOffset: 27, endOffset: 27, text: '' },
      ]);
    });

    it('enforces a cumulative timeoutMs budget across rasterization and page OCR and cleans up temp files', async () => {
      const recordedTimeouts: number[] = [];
      let createdTempDir: string | null = null;

      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
          opts: { timeout?: number },
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 24.02.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') {
            if (opts.timeout !== undefined) recordedTimeouts.push(opts.timeout);
            await new Promise((r) => setTimeout(r, 25));
            return { stdout: 'Pages: 3\n', stderr: '' };
          }
          if (file === 'pdftoppm') {
            if (opts.timeout !== undefined) recordedTimeouts.push(opts.timeout);
            const prefix = args[args.length - 1]!;
            createdTempDir = path.dirname(prefix);
            await fs.promises.writeFile(`${prefix}-1.png`, Buffer.from('fake-png'));
            await fs.promises.writeFile(`${prefix}-2.png`, Buffer.from('fake-png'));
            await new Promise((r) => setTimeout(r, 50));
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            if (opts.timeout !== undefined) recordedTimeouts.push(opts.timeout);
            await new Promise((r) => setTimeout(r, 95));
            return { stdout: '', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );

      const ocrProvider = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        timeoutMs: 140,
        execCommand,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 >> endobj\n%%EOF');
      await expect(ocrProvider.extractText(scannedPdf)).rejects.toThrow(
        /exceeded cumulative timeout budget/i,
      );

      expect(recordedTimeouts.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < recordedTimeouts.length; i += 1) {
        expect(recordedTimeouts[i]!).toBeLessThan(recordedTimeouts[i - 1]!);
      }
      expect(createdTempDir).not.toBeNull();
      expect(fs.existsSync(createdTempDir!)).toBe(false);
    });

    it('does not swallow non-ENOENT tesseract errors and marks PdfTextExtractor result as NEEDS_REVIEW', async () => {
      let tempDirObserved = '';
      const validPageTsv = [
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
        '5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t95\tHeaderOnly',
      ].join('\n');

      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 24.02.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') return { stdout: 'Pages: 2\n', stderr: '' };
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            tempDirObserved = path.dirname(prefix);
            await fs.promises.writeFile(`${prefix}-1.png`, Buffer.from('p1'));
            await fs.promises.writeFile(`${prefix}-2.png`, Buffer.from('p2'));
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            if (args[0]!.endsWith('page-1.png')) return { stdout: validPageTsv, stderr: '' };
            const crashErr = new Error('Error opening data file eng.traineddata') as Error & {
              code: number;
            };
            crashErr.code = 1;
            throw crashErr;
          }
          return { stdout: '', stderr: '' };
        },
      );

      const ocrProvider = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n%%EOF');
      await expect(ocrProvider.extractText(scannedPdf)).rejects.toThrow(
        /Tesseract OCR failed on page 2/i,
      );
      expect(tempDirObserved).toContain(os.tmpdir());
      expect(fs.existsSync(tempDirObserved)).toBe(false);

      const extractor = new PdfTextExtractor(ocrProvider);
      const parsed = await extractor.parse(scannedPdf);
      expect(parsed.ocrUsed).toBe(false);
      expect(parsed.qualityStatus).toBe('NEEDS_REVIEW');
      expect(parsed.warning).toBe('OCR extraction failed. Recruiter review required.');
      expect(parsed.extractedText).toBe('');
    });
  });

  describe('P1-01 Bounded Decompression, Geometry, and Archive Security Limits', () => {
    interface ZipEntrySpec {
      name: string;
      content: Buffer;
      compress?: boolean;
      declaredUncompressedSize?: number;
      declaredCompressedSize?: number;
      bitFlag?: number;
      useDataDescriptor?: boolean;
      includeDescriptorSig?: boolean;
    }

    function buildCompleteZip(
      entries: ZipEntrySpec[],
      options: {
        corruptCdSig?: boolean;
        corruptCdCount?: number;
        corruptEocdTotalEntries?: number;
        cdSizeOverride?: number;
        cdUncompressedSizeOverride?: { index: number; size: number };
      } = {},
    ): Buffer {
      const localParts: Buffer[] = [];
      const cdParts: Buffer[] = [];
      let localOffset = 0;

      entries.forEach((entry, idx) => {
        const useCompress = entry.compress ?? true;
        const compMethod = useCompress ? 8 : 0;
        const compressedData = useCompress ? zlib.deflateRawSync(entry.content) : entry.content;
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const actualUncomp = entry.content.length;
        const actualComp = compressedData.length;
        const declaredUncomp = entry.declaredUncompressedSize ?? actualUncomp;
        const declaredComp = entry.declaredCompressedSize ?? actualComp;
        const bitFlag = (entry.bitFlag ?? 0) | (entry.useDataDescriptor ? 0x0008 : 0);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(bitFlag, 6);
        localHeader.writeUInt16LE(compMethod, 8);
        localHeader.writeUInt32LE(0, 14);
        localHeader.writeUInt32LE(entry.useDataDescriptor ? 0 : declaredComp, 18);
        localHeader.writeUInt32LE(entry.useDataDescriptor ? 0 : declaredUncomp, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);

        const descriptorBuf = entry.useDataDescriptor
          ? (() => {
              if (entry.includeDescriptorSig !== false) {
                const b = Buffer.alloc(16);
                b.writeUInt32LE(0x08074b50, 0);
                b.writeUInt32LE(0, 4);
                b.writeUInt32LE(actualComp, 8);
                b.writeUInt32LE(actualUncomp, 12);
                return b;
              }
              const b = Buffer.alloc(12);
              b.writeUInt32LE(0, 0);
              b.writeUInt32LE(actualComp, 4);
              b.writeUInt32LE(actualUncomp, 8);
              return b;
            })()
          : Buffer.alloc(0);

        localParts.push(localHeader, nameBuf, compressedData, descriptorBuf);

        const cdHeader = Buffer.alloc(46);
        cdHeader.writeUInt32LE(options.corruptCdSig && idx === 0 ? 0xdeadbeef : 0x02014b50, 0);
        cdHeader.writeUInt16LE(20, 4);
        cdHeader.writeUInt16LE(20, 6);
        cdHeader.writeUInt16LE(bitFlag, 8);
        cdHeader.writeUInt16LE(compMethod, 10);
        cdHeader.writeUInt32LE(actualComp, 20);
        cdHeader.writeUInt32LE(
          options.cdUncompressedSizeOverride?.index === idx
            ? options.cdUncompressedSizeOverride.size
            : actualUncomp,
          24,
        );
        cdHeader.writeUInt16LE(nameBuf.length, 28);
        cdHeader.writeUInt32LE(localOffset, 42);

        cdParts.push(cdHeader, nameBuf);
        localOffset +=
          localHeader.length + nameBuf.length + compressedData.length + descriptorBuf.length;
      });

      const cdBuf = Buffer.concat(cdParts);
      const entryCount = options.corruptEocdTotalEntries ?? entries.length;
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(options.corruptCdCount ?? entries.length, 8);
      eocd.writeUInt16LE(entryCount, 10);
      eocd.writeUInt32LE(options.cdSizeOverride ?? cdBuf.length, 12);
      eocd.writeUInt32LE(localOffset, 16);

      return Buffer.concat([...localParts, cdBuf, eocd]);
    }

    function createMinimalPng(width: number, height: number): Buffer {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrLen = Buffer.alloc(4);
      ihdrLen.writeUInt32BE(13, 0);
      const ihdrType = Buffer.from('IHDR', 'ascii');
      const ihdrData = Buffer.alloc(13);
      ihdrData.writeUInt32BE(width, 0);
      ihdrData.writeUInt32BE(height, 4);
      ihdrData[8] = 8; // bit depth
      ihdrData[9] = 2; // RGB
      const crc = Buffer.alloc(4);
      return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
    }

    function createMinimalJpeg(width: number, height: number): Buffer {
      return Buffer.from([
        0xff,
        0xd8, // SOI
        0xff,
        0xc0, // SOF0
        0x00,
        0x0b, // segment length 11
        0x08, // precision
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0x01,
        0x01,
        0x11,
        0x00,
        0xff,
        0xd9, // EOI
      ]);
    }

    function buildFlatePdf(
      streams: string[],
      options: { declaredPageCount?: number; extraObjects?: string[]; pageCount?: number } = {},
    ): Buffer {
      const parts: string[] = ['%PDF-1.4'];
      const pageCount = options.pageCount ?? streams.length;
      const kids = Array.from({ length: pageCount }, (_, i) => `${100 + i} 0 R`).join(' ');
      parts.push(
        `1 0 obj << /Type /Pages /Kids [${kids}] /Count ${options.declaredPageCount ?? pageCount} >> endobj`,
      );
      if (options.extraObjects) {
        parts.push(...options.extraObjects);
      }

      const chunks: Buffer[] = [Buffer.from(parts.join('\n') + '\n', 'latin1')];
      for (let i = 0; i < streams.length; i += 1) {
        const pageNum = 100 + i;
        const streamNum = 200 + i;
        const deflated = zlib.deflateSync(Buffer.from(streams[i]!, 'utf8'));
        chunks.push(
          Buffer.from(
            `${pageNum} 0 obj << /Type /Page /Parent 1 0 R /Contents ${streamNum} 0 R >> endobj\n`,
            'latin1',
          ),
        );
        chunks.push(
          Buffer.from(
            `${streamNum} 0 obj << /Length ${deflated.length} /Filter /FlateDecode >> stream\n`,
            'latin1',
          ),
        );
        chunks.push(deflated);
        chunks.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
      }
      chunks.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF', 'latin1'));
      return Buffer.concat(chunks);
    }

    it('accepts a valid DOCX right at the allowed uncompressed boundary and rejects 1 byte over', async () => {
      const prefix = '<w:document><w:body><w:p><w:t>';
      const suffix = '</w:t></w:p></w:body></w:document>';
      const atLimitXml = Buffer.from(
        prefix + 'A'.repeat(2048 - prefix.length - suffix.length) + suffix,
        'utf8',
      );
      expect(atLimitXml.length).toBe(2048);

      const overLimitXml = Buffer.from(
        prefix + 'A'.repeat(2049 - prefix.length - suffix.length) + suffix,
        'utf8',
      );
      expect(overLimitXml.length).toBe(2049);

      const extractor = new DocxTextExtractor({
        maxUncompressedBytes: 2048,
        maxEntryUncompressedBytes: 2048,
        maxCompressionRatio: 1000,
      });

      const validZip = buildCompleteZip([{ name: 'word/document.xml', content: atLimitXml }]);
      const validResult = await extractor.parse(validZip);
      expect(validResult.qualityStatus).toBe('COMPLETE');
      expect(validResult.extractedText.length).toBeGreaterThan(1900);

      const overZip = buildCompleteZip([{ name: 'word/document.xml', content: overLimitXml }]);
      await expect(extractor.parse(overZip)).rejects.toThrow(SecurityLimitExceededError);
    });

    it('rejects DOCX with forged small declared header size when actual inflated output exceeds hard byte limit', async () => {
      // Compress 128 KB of patterned text (~1 KB compressed), but forge ZIP headers to claim 64 bytes uncompressed
      const payload = Buffer.from(
        `<w:document><w:body><w:p><w:t>${'ABC12345'.repeat(16_384)}</w:t></w:p></w:body></w:document>`,
        'utf8',
      );
      const forgedZip = buildCompleteZip([
        {
          name: 'word/document.xml',
          content: payload,
          declaredUncompressedSize: 64,
        },
      ]);

      const extractor = new DocxTextExtractor({
        maxUncompressedBytes: 32 * 1024,
        maxEntryUncompressedBytes: 32 * 1024,
        maxCompressionRatio: 10_000, // disable ratio gate to prove hard byte limit catches forged header
      });

      await expect(extractor.parse(forgedZip)).rejects.toThrow(SecurityLimitExceededError);
    });

    it('aborts high-compression-ratio DEFLATE bombs immediately without allocating full expansion', async () => {
      // 4 MB of zeros compresses to ~4 KB (1000:1), limit = 32 KB -> aborted mid-stream immediately
      const zeros = Buffer.alloc(4 * 1024 * 1024, 0x41);
      const compressedBomb = zlib.deflateRawSync(zeros);
      expect(compressedBomb.length).toBeLessThan(16 * 1024);

      const started = Date.now();
      await expect(
        inflateBounded(compressedBomb, {
          mode: 'raw',
          maxOutputBytes: 32 * 1024,
          maxCompressionRatio: 10_000,
          deadlineMs: Date.now() + 5_000,
          entryLabel: 'bomb-test',
        }),
      ).rejects.toThrow(/exceeds 32768 byte security limit/);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it('enforces aggregate DOCX document limits across many small entries below per-entry limit', async () => {
      // 6 entries x ~5.4 KB each = ~32 KB total > 20 KB aggregate, while each entry < 10 KB per-entry limit
      const chunkPayload = (label: string) => {
        const noise = Array.from({ length: 450 }, (_, i) => `${label}-${i}-${(i * 97) % 997}`).join(
          ' ',
        );
        return Buffer.from(noise, 'utf8');
      };
      const xmlEntry: ZipEntrySpec = {
        name: 'word/document.xml',
        content: Buffer.from('<w:p><w:t>Hello</w:t></w:p>'),
      };
      const entries: ZipEntrySpec[] = [xmlEntry];
      for (let i = 0; i < 6; i += 1) {
        entries.push({ name: `word/media/item-${i}.bin`, content: chunkPayload(`k${i}`) });
      }

      const extractor = new DocxTextExtractor({
        maxEntryUncompressedBytes: 10 * 1024,
        maxUncompressedBytes: 20 * 1024,
        maxCompressionRatio: 100,
      });

      const underAggregateZip = buildCompleteZip(entries.slice(0, 3)); // ~11 KB total -> passes
      await expect(extractor.parse(underAggregateZip)).resolves.toMatchObject({
        qualityStatus: 'COMPLETE',
      });

      const overAggregateZip = buildCompleteZip(entries);
      await expect(extractor.parse(overAggregateZip)).rejects.toThrow(SecurityLimitExceededError);
    });

    it('supports valid DOCX archives using bit-3 Data Descriptors and complete ZIP directories', async () => {
      const xml = Buffer.from(
        '<w:document><w:body><w:p><w:t>Senior Principal Engineer</w:t></w:p></w:body></w:document>',
        'utf8',
      );
      const docxWithDescriptor = buildCompleteZip([
        { name: '[Content_Types].xml', content: Buffer.from('<Types/>'), useDataDescriptor: true },
        { name: 'word/document.xml', content: xml, useDataDescriptor: true },
      ]);

      const extractor = new DocxTextExtractor();
      const result = await extractor.parse(docxWithDescriptor);
      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.extractedText).toBe('Senior Principal Engineer');
    });

    it('rejects excessive ZIP entry counts, encrypted entries, and path traversal entry names', async () => {
      const manyEntries: ZipEntrySpec[] = [
        { name: 'word/document.xml', content: Buffer.from('<w:p><w:t>Hi</w:t></w:p>') },
        { name: 'a.txt', content: Buffer.from('1'), compress: false },
        { name: 'b.txt', content: Buffer.from('2'), compress: false },
        { name: 'c.txt', content: Buffer.from('3'), compress: false },
      ];
      const strictCountExtractor = new DocxTextExtractor({ maxEntries: 3 });
      await expect(strictCountExtractor.parse(buildCompleteZip(manyEntries))).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const encryptedZip = buildCompleteZip([
        {
          name: 'word/document.xml',
          content: Buffer.from('<w:p><w:t>Secret</w:t></w:p>'),
          bitFlag: 0x0001,
        },
      ]);
      await expect(docxExtractor.parse(encryptedZip)).rejects.toThrow(EncryptedDocumentError);

      const traversalZip = buildCompleteZip([
        { name: '../evil.txt', content: Buffer.from('x'), compress: false },
        { name: 'word/document.xml', content: Buffer.from('<w:p><w:t>Hi</w:t></w:p>') },
      ]);
      await expect(docxExtractor.parse(traversalZip)).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('rejects malformed ZIP central directories, EOCD mismatches, and corrupt DEFLATE streams', async () => {
      const baseEntries: ZipEntrySpec[] = [
        { name: 'word/document.xml', content: Buffer.from('<w:p><w:t>Valid</w:t></w:p>') },
      ];

      await expect(
        docxExtractor.parse(buildCompleteZip(baseEntries, { corruptCdSig: true })),
      ).rejects.toThrow(InvalidDocumentFormatError);

      await expect(
        docxExtractor.parse(buildCompleteZip(baseEntries, { corruptEocdTotalEntries: 99 })),
      ).rejects.toThrow(InvalidDocumentFormatError);

      await expect(
        docxExtractor.parse(
          buildCompleteZip(baseEntries, {
            cdUncompressedSizeOverride: { index: 0, size: 99999 },
          }),
        ),
      ).rejects.toThrow(InvalidDocumentFormatError);

      // Corrupt deflate bytes
      const nameBuf = Buffer.from('word/document.xml', 'utf8');
      const garbageComp = Buffer.from([0xff, 0x00, 0xaa, 0x55, 0x11, 0x22, 0x33]);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(garbageComp.length, 18);
      header.writeUInt32LE(20, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      await expect(
        docxExtractor.parse(Buffer.concat([header, nameBuf, garbageComp])),
      ).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('rejects PDF with excessively large FlateDecode stream and passes PDF at exact boundary', async () => {
      const exactText = 'X'.repeat(1800);
      const overText = 'Y'.repeat(2400);
      const prefix = 'BT /F1 12 Tf (';
      const suffix = ') Tj ET';

      const boundaryPdf = buildFlatePdf([`${prefix}${exactText}${suffix}`]);
      const overPdf = buildFlatePdf([`${prefix}${overText}${suffix}`]);

      const boundedExtractor = new PdfTextExtractor(undefined, {
        maxDecompressedStreamBytes: 2048,
        maxTotalDecompressedBytes: 4096,
        maxCompressionRatio: 1000,
      });

      const okRes = await boundedExtractor.parse(boundaryPdf);
      expect(okRes.qualityStatus).toBe('COMPLETE');
      expect(okRes.extractedText).toContain(exactText);

      await expect(boundedExtractor.parse(overPdf)).rejects.toThrow(SecurityLimitExceededError);

      // Also catch aggregate stream bomb spread across unvisited PDF streams
      const multiStreamPdf = buildFlatePdf([`${prefix}${'A'.repeat(1500)}${suffix}`], {
        extraObjects: [
          (() => {
            const p1 = zlib.deflateSync(
              Buffer.from(Array.from({ length: 300 }, (_, i) => `k${i}`).join(' '), 'utf8'),
            );
            return `300 0 obj << /Length ${p1.length} /Filter /FlateDecode >> stream\n${p1.toString('binary')}\nendstream endobj`;
          })(),
          (() => {
            const p2 = zlib.deflateSync(
              Buffer.from(Array.from({ length: 300 }, (_, i) => `m${i}`).join(' '), 'utf8'),
            );
            return `301 0 obj << /Length ${p2.length} /Filter /FlateDecode >> stream\n${p2.toString('binary')}\nendstream endobj`;
          })(),
        ],
      });
      await expect(boundedExtractor.parse(multiStreamPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
    });

    it('rejects malformed FlateDecode streams in PDF and excessive PDF page counts', async () => {
      const badFlatePdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Pages /Kids [2 0 R] /Count 1 >> endobj\n' +
          '2 0 obj << /Type /Page /Parent 1 0 R /Contents 3 0 R >> endobj\n' +
          '3 0 obj << /Length 8 /Filter /FlateDecode >> stream\n' +
          '\xff\xfe\xfd\xfc\x01\x02\x03\x04' +
          '\nendstream endobj\n%%EOF',
        'binary',
      );
      await expect(pdfExtractor.parse(badFlatePdf)).rejects.toThrow(InvalidDocumentFormatError);

      const declaredOverLimit = buildFlatePdf(['BT (P1) Tj ET'], { declaredPageCount: 250 });
      await expect(pdfExtractor.parse(declaredOverLimit)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const pageBoundExtractor = new PdfTextExtractor(undefined, { maxPages: 2 });
      const threePagePdf = buildFlatePdf(['BT (A) Tj ET', 'BT (B) Tj ET', 'BT (C) Tj ET']);
      await expect(pageBoundExtractor.parse(threePagePdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
    });

    it('rejects oversized image dimensions and pixel counts in PDF geometry and OCR inputs', async () => {
      // 1. Embedded PDF image with nested /DecodeParms dictionary (ensuring nested <<>> cannot hide Width/Height)
      const hugeImgPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /XObject /Subtype /Image /Width 25000 /Height 25000 /DecodeParms << /K -1 >> >> endobj\n%%EOF',
        'latin1',
      );
      await expect(pdfExtractor.parse(hugeImgPdf)).rejects.toThrow(SecurityLimitExceededError);

      // 2. Oversized /MediaBox geometry (e.g., 10000 x 10000 pts -> >20k px at 150 DPI)
      const hugeMediaBoxPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 10000 10000] >> endobj\n%%EOF',
        'latin1',
      );
      await expect(pdfExtractor.parse(hugeMediaBoxPdf)).rejects.toThrow(SecurityLimitExceededError);

      // 3. Direct PNG & JPEG headers to TesseractOcrProvider fail closed even if binary not checked yet
      const ocrLimitsProvider = new TesseractOcrProvider({ timeoutMs: 5000 });
      const hugePng = createMinimalPng(12_000, 12_000);
      await expect(ocrLimitsProvider.extractText(hugePng)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const hugeJpeg = createMinimalJpeg(6000, 6000); // 36M pixels > 25M default
      await expect(ocrLimitsProvider.extractText(hugeJpeg)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      // 4. pdfinfo oversized Page size cleanup check
      let observedTempDir = '';
      const mockExecHugePdfInfo = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 24.02.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') {
            observedTempDir = path.dirname(args[0]!);
            return { stdout: 'Pages: 1\nPage size: 9000 x 9000 pts\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );
      const boundedOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: mockExecHugePdfInfo,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF');
      await expect(boundedOcr.extractText(scannedPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(observedTempDir).toContain(os.tmpdir());
      expect(fs.existsSync(observedTempDir)).toBe(false);
    });

    it('enforces DOCX & PDF processing timeouts with DocumentProcessingTimeoutError', async () => {
      const slowDocx = buildCompleteZip([
        {
          name: 'word/document.xml',
          content: Buffer.from(
            `<w:document><w:body>${'<w:p><w:t>Hello</w:t></w:p>'.repeat(500)}</w:body></w:document>`,
          ),
        },
      ]);
      const expiredDocxExtractor = new DocxTextExtractor({ timeoutMs: -1 });
      await expect(expiredDocxExtractor.parse(slowDocx)).rejects.toThrow(
        DocumentProcessingTimeoutError,
      );

      const samplePdf = createMinimalPdf('Valid text');
      const expiredPdfExtractor = new PdfTextExtractor(undefined, { timeoutMs: -1 });
      await expect(expiredPdfExtractor.parse(samplePdf)).rejects.toThrow(
        DocumentProcessingTimeoutError,
      );
    });

    it('cleans up temporary OCR files when rasterized page PNG exceeds dimension limit', async () => {
      let tempDirObserved = '';
      const oversizedPngHeader = createMinimalPng(15_000, 15_000);

      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 24.02.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') return { stdout: 'Pages: 1\n', stderr: '' };
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            tempDirObserved = path.dirname(prefix);
            await fs.promises.writeFile(`${prefix}-1.png`, oversizedPngHeader);
            return { stdout: '', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );

      const ocrProvider = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n%%EOF');
      await expect(ocrProvider.extractText(scannedPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(tempDirObserved).toContain(os.tmpdir());
      expect(fs.existsSync(tempDirObserved)).toBe(false);
    });
  });

  describe('R-01 PDF Geometry Validation and Aggregate OCR Limits', () => {
    function createTinyPng(width: number, height: number): Buffer {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrLen = Buffer.alloc(4);
      ihdrLen.writeUInt32BE(13, 0);
      const ihdrType = Buffer.from('IHDR', 'ascii');
      const ihdrData = Buffer.alloc(13);
      ihdrData.writeUInt32BE(width, 0);
      ihdrData.writeUInt32BE(height, 4);
      ihdrData[8] = 8;
      ihdrData[9] = 2;
      const crc = Buffer.alloc(4);
      return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
    }

    function createSpyExec(pdfinfoPageSize = '612 x 792 pts') {
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          calls.push({ file, args });
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') {
            return { stdout: `Pages: 1\nPage size: ${pdfinfoPageSize}\n`, stderr: '' };
          }
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            await fs.promises.writeFile(`${prefix}-1.png`, createTinyPng(100, 100));
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            return {
              stdout:
                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
                '5\t1\t1\t1\t1\t1\t0\t0\t50\t20\t95\tCroppedText\n',
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      );
      return { calls, execCommand };
    }

    it('fails closed when inspected PDF dictionary limit or object limit is exceeded', async () => {
      const manyDictObjects = Array.from(
        { length: 25 },
        (_, i) => `${i + 1} 0 obj << /Index ${i} >> endobj`,
      ).join('\n');
      const manyDictsPdf = Buffer.from(`%PDF-1.4\n${manyDictObjects}\n%%EOF`, 'latin1');

      const dictLimitedExtractor = new PdfTextExtractor(undefined, {
        maxInspectedDictionaries: 10,
      });
      await expect(dictLimitedExtractor.parse(manyDictsPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const objLimitedExtractor = new PdfTextExtractor(undefined, {
        maxInspectedObjects: 10,
      });
      await expect(objLimitedExtractor.parse(manyDictsPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const ocrLimited = new TesseractOcrProvider({ maxInspectedDictionaries: 10 });
      await expect(ocrLimited.extractText(manyDictsPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
    });

    it('resolves indirect /MediaBox and indirect box element refs before invoking pdftoppm', async () => {
      const indirectMediaBoxPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox 10 0 R >> endobj\n' +
          '10 0 obj [0 0 10000 10000] endobj\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      await expect(ocr.extractText(indirectMediaBoxPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);

      const indirectElemPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 11 0 R 12 0 R] >> endobj\n' +
          '11 0 obj 12000 endobj\n' +
          '12 0 obj 12000 endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(indirectElemPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);
    });

    it('resolves indirect /Width and /Height on embedded /Image XObjects', async () => {
      const indirectImagePdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Pages /Kids [2 0 R] /Count 1 >> endobj\n' +
          '2 0 obj << /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> >> endobj\n' +
          '5 0 obj << /Type /XObject /Subtype /Image /Width 6 0 R /Height 7 0 R >> endobj\n' +
          '6 0 obj 15000 endobj\n' +
          '7 0 obj 15000 endobj\n%%EOF',
        'latin1',
      );
      const pdfOnly = new PdfTextExtractor();
      await expect(pdfOnly.parse(indirectImagePdf)).rejects.toThrow(SecurityLimitExceededError);
    });

    it('enforces inherited /MediaBox from intermediate /Pages nodes when leaf /Page omits /MediaBox', async () => {
      const inheritedHugePdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 9000 9000] >> endobj\n' +
          '3 0 obj << /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 >> endobj\n' +
          '4 0 obj << /Type /Page /Parent 3 0 R >> endobj\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      await expect(ocr.extractText(inheritedHugePdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);
    });

    it('intersects /CropBox with inherited /MediaBox, invokes pdftoppm with -cropbox, and rejects empty intersections', async () => {
      const croppedPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 20000 20000] >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /CropBox [0 0 612 792] >> endobj\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      const res = await ocr.extractText(croppedPdf);
      expect(res?.text).toBe('CroppedText');
      const pdftoppmCall = calls.find((c) => c.file === 'pdftoppm' && !c.args.includes('-v'));
      expect(pdftoppmCall).toBeDefined();
      expect(pdftoppmCall?.args).toContain('-cropbox');

      const emptyIntersectionPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Page /MediaBox [0 0 612 792] /CropBox [700 0 1200 792] >> endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(emptyIntersectionPdf)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
    });

    it('accounts for direct and inherited /Rotate 90/270 dimension swap and rejects invalid rotations', async () => {
      // 720 pts = 1500 px at 150 DPI; 360 pts = 750 px at 150 DPI.
      // With /Rotate 90 inherited from /Pages, rendered dimensions swap to width=750, height=1500.
      const rotatedPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /Rotate 90 >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 720 360] >> endobj\n%%EOF',
        'latin1',
      );

      const asymmetricOk = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImageWidth: 800,
        maxImageHeight: 1600,
        execCommand: createSpyExec('360 x 720 pts').execCommand,
      });
      await expect(asymmetricOk.extractText(rotatedPdf)).resolves.toMatchObject({
        text: 'CroppedText',
      });

      const { calls, execCommand } = createSpyExec();
      const asymmetricTooTall = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImageWidth: 1600,
        maxImageHeight: 1000,
        execCommand,
      });
      await expect(asymmetricTooTall.extractText(rotatedPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);

      const badRotatePdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 612 792] /Rotate 45 >> endobj\n%%EOF',
        'latin1',
      );
      await expect(asymmetricOk.extractText(badRotatePdf)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
    });

    it('enforces /UserUnit scaling and rejects invalid /UserUnit values before rasterization', async () => {
      const scaledBombPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Page /MediaBox [0 0 612 792] /UserUnit 75 >> endobj\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });
      await expect(ocr.extractText(scaledBombPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);

      const badUserUnitPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 612 792] /UserUnit 0 >> endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(badUserUnitPdf)).rejects.toThrow(InvalidDocumentFormatError);
    });

    it('rejects degenerate boxes, unresolvable/circular indirect refs, and invalid or excessive DPI', async () => {
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: createSpyExec().execCommand,
      });

      const zeroAreaPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [100 100 100 792] >> endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(zeroAreaPdf)).rejects.toThrow(InvalidDocumentFormatError);

      const unresolvableRefPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox 999 0 R >> endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(unresolvableRefPdf)).rejects.toThrow(InvalidDocumentFormatError);

      const circularRefPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Page /MediaBox 10 0 R >> endobj\n' +
          '10 0 obj 11 0 R endobj\n' +
          '11 0 obj 10 0 R endobj\n%%EOF',
        'latin1',
      );
      await expect(ocr.extractText(circularRefPdf)).rejects.toThrow(InvalidDocumentFormatError);

      const normalPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 612 792] >> endobj\n%%EOF',
        'latin1',
      );
      const excessiveDpiOcr = new TesseractOcrProvider({ pdfRasterDpi: 1200, maxRasterDpi: 600 });
      await expect(excessiveDpiOcr.extractText(normalPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );

      const invalidDpiOcr = new TesseractOcrProvider({ pdfRasterDpi: 0 });
      await expect(invalidDpiOcr.extractText(normalPdf)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
    });

    it('does not let literal string "(stream\\n)" corrupt object parsing or hide oversized later pages', async () => {
      const spoofedPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R /Producer (Tool stream\nGenerator) >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 12000 12000] >> endobj\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand,
      });

      await expect(ocr.extractText(spoofedPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);
    });

    it('rejects multi-page aggregate pixel bomb where every single page is below per-page limits BEFORE pdftoppm', async () => {
      // Each page: 960 x 960 pts at 150 DPI = 2000 x 2000 px = 4,000,000 px (< 5M per-page limit).
      // 5 pages = 20,000,000 aggregate px (> 15M aggregate limit).
      const kids = ['10 0 R', '11 0 R', '12 0 R', '13 0 R', '14 0 R'];
      const pageObjs = [10, 11, 12, 13, 14]
        .map((n) => `${n} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 960 960] >> endobj`)
        .join('\n');
      const aggregateBombPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          `2 0 obj << /Type /Pages /Kids [${kids.join(' ')}] /Count 5 >> endobj\n` +
          `${pageObjs}\n%%EOF`,
        'latin1',
      );

      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImagePixels: 5_000_000,
        maxAggregatePixels: 15_000_000,
        execCommand,
      });

      await expect(ocr.extractText(aggregateBombPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);
    });

    it('validates per-page geometry past maxPages while allowing legitimate multi-page PDFs within aggregate OCR budget', async () => {
      // Build a 12-page PDF: pages 1..11 normal Letter (612x792 -> ~2.1M px each; first 10 sum ~21M < 75M),
      // page 12 oversized (9000x9000).
      const buildMultiPagePdf = (oversizeLastPage: boolean) => {
        const objs: string[] = [
          '%PDF-1.4',
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
          `2 0 obj << /Type /Pages /Kids [${Array.from({ length: 12 }, (_, i) => `${10 + i} 0 R`).join(' ')}] /Count 12 >> endobj`,
        ];
        for (let i = 0; i < 12; i += 1) {
          const box = oversizeLastPage && i === 11 ? '[0 0 9000 9000]' : '[0 0 612 792]';
          objs.push(`${10 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox ${box} >> endobj`);
        }
        objs.push('%%EOF');
        return Buffer.from(objs.join('\n'), 'latin1');
      };

      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxPages: 10,
        maxInputPages: 200,
        execCommand,
      });

      await expect(ocr.extractText(buildMultiPagePdf(true))).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);

      await expect(ocr.extractText(buildMultiPagePdf(false))).resolves.toMatchObject({
        text: 'CroppedText',
      });
    });

    it('enforces post-pdftoppm aggregate pixel, total raster byte, and output file count caps and cleans up temp files', async () => {
      let tempDirObserved = '';
      const makeExecWithOutputs = (files: Array<{ name: string; content: Buffer }>) =>
        vi.fn(async (file: string, args: readonly string[]) => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') return { stdout: 'Pages: 3\n', stderr: '' };
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            tempDirObserved = path.dirname(prefix);
            for (const f of files) {
              await fs.promises.writeFile(path.join(tempDirObserved, f.name), f.content);
            }
            return { stdout: '', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 >> endobj\n%%EOF');

      // Case A: 3 PNGs each 1000x1000 = 1M px (< 2M per-page), aggregate 3M px (> 2.5M aggregate)
      const providerAggPixels = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImagePixels: 2_000_000,
        maxAggregatePixels: 2_500_000,
        execCommand: makeExecWithOutputs([
          { name: 'page-1.png', content: createTinyPng(1000, 1000) },
          { name: 'page-2.png', content: createTinyPng(1000, 1000) },
          { name: 'page-3.png', content: createTinyPng(1000, 1000) },
        ]),
      });
      await expect(providerAggPixels.extractText(scannedPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(fs.existsSync(tempDirObserved)).toBe(false);

      // Case B: total raster bytes > maxTotalRasterBytes
      const providerRasterBytes = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxTotalRasterBytes: 120,
        execCommand: makeExecWithOutputs([
          { name: 'page-1.png', content: Buffer.concat([createTinyPng(10, 10), Buffer.alloc(60)]) },
          { name: 'page-2.png', content: Buffer.concat([createTinyPng(10, 10), Buffer.alloc(60)]) },
        ]),
      });
      await expect(providerRasterBytes.extractText(scannedPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(fs.existsSync(tempDirObserved)).toBe(false);
    });

    it('caps individual Tesseract page timeout using pageTimeoutMs within cumulative timeoutMs budget', async () => {
      const tesseractTimeouts: number[] = [];
      let tempDirObserved = '';

      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
          opts: { timeout?: number },
        ): Promise<{ stdout: string; stderr: string }> => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') return { stdout: 'Pages: 1\n', stderr: '' };
          if (file === 'pdftoppm') {
            const prefix = args[args.length - 1]!;
            tempDirObserved = path.dirname(prefix);
            await fs.promises.writeFile(`${prefix}-1.png`, createTinyPng(100, 100));
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            if (opts.timeout !== undefined) tesseractTimeouts.push(opts.timeout);
            const timeoutErr = Object.assign(new Error('ETIMEDOUT'), {
              killed: true,
              signal: 'SIGTERM',
              code: 'ETIMEDOUT',
            });
            throw timeoutErr;
          }
          return { stdout: '', stderr: '' };
        },
      );

      const provider = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        timeoutMs: 10_000,
        pageTimeoutMs: 750,
        execCommand,
      });

      const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n%%EOF');
      await expect(provider.extractText(scannedPdf)).rejects.toThrow(
        DocumentProcessingTimeoutError,
      );
      expect(tesseractTimeouts[0]).toBeLessThanOrEqual(750);
      expect(fs.existsSync(tempDirObserved)).toBe(false);
    });

    it('rejects PDFs exceeding maxInputPages before rasterization', async () => {
      const sixPagePdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R] /Count 6 >> endobj\n' +
          [10, 11, 12, 13, 14, 15]
            .map((n) => `${n} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj`)
            .join('\n') +
          '\n%%EOF',
        'latin1',
      );
      const { calls, execCommand } = createSpyExec();
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxInputPages: 4,
        execCommand,
      });
      await expect(ocr.extractText(sixPagePdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(calls.some((c) => c.file === 'pdftoppm')).toBe(false);
    });

    it('rejects pdftoppm generating more page PNGs than maxPages and resolves indirect /Rotate and /Count refs', async () => {
      let tempDirObserved = '';
      const execOverPageOutputs = vi.fn(async (file: string, args: readonly string[]) => {
        if (args.includes('--version')) return { stdout: 'tesseract 5.3.0\n', stderr: '' };
        if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
        if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
        if (file === 'pdfinfo') return { stdout: 'Pages: 2\n', stderr: '' };
        if (file === 'pdftoppm') {
          const prefix = args[args.length - 1]!;
          tempDirObserved = path.dirname(prefix);
          await fs.promises.writeFile(`${prefix}-1.png`, createTinyPng(100, 100));
          await fs.promises.writeFile(`${prefix}-2.png`, createTinyPng(100, 100));
          await fs.promises.writeFile(`${prefix}-3.png`, createTinyPng(100, 100));
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const ocrMax2 = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxPages: 2,
        execCommand: execOverPageOutputs,
      });
      const twoPagePdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
          '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 20 0 R >> endobj\n' +
          '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 21 0 R >> endobj\n' +
          '4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n' +
          '20 0 obj 2 endobj\n' +
          '21 0 obj 270 endobj\n%%EOF',
        'latin1',
      );
      await expect(ocrMax2.extractText(twoPagePdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(fs.existsSync(tempDirObserved)).toBe(false);
    });
  });

  describe('P1-PDF-OBJSTM Bounded Object-Stream Preflight & Geometry Enforcement', () => {
    function createSmallPng(width: number, height: number): Buffer {
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrLen = Buffer.alloc(4);
      ihdrLen.writeUInt32BE(13, 0);
      const ihdrType = Buffer.from('IHDR', 'ascii');
      const ihdrData = Buffer.alloc(13);
      ihdrData.writeUInt32BE(width, 0);
      ihdrData.writeUInt32BE(height, 4);
      ihdrData[8] = 8;
      ihdrData[9] = 2;
      const crc = Buffer.alloc(4);
      return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
    }

    function createOcrSpy(pagesCount = 1, pageSizes?: string[], pageRots?: number[]) {
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      let pdftoppmCalls = 0;
      const execCommand = vi.fn(
        async (
          file: string,
          args: readonly string[],
        ): Promise<{ stdout: string; stderr: string }> => {
          calls.push({ file, args });
          if (args.includes('--version')) return { stdout: 'tesseract 5.5.2\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') {
            if (args.includes('-box') && pageSizes && pageSizes.length > 0) {
              const lines = [`Pages: ${pagesCount}`];
              pageSizes.forEach((sz, idx) => {
                lines.push(`Page ${idx + 1} size: ${sz}`);
                lines.push(`Page ${idx + 1} rot: ${pageRots?.[idx] ?? 0}`);
              });
              lines.push('PDF version: 1.5');
              return { stdout: lines.join('\n') + '\n', stderr: '' };
            }
            const firstSize = pageSizes?.[0] ?? '612 x 792 pts';
            const firstRot = pageRots?.[0] ?? 0;
            return {
              stdout: `Pages: ${pagesCount}\nPage size: ${firstSize}\nPage rot: ${firstRot}\n`,
              stderr: '',
            };
          }
          if (file === 'pdftoppm') {
            pdftoppmCalls += 1;
            const prefix = args[args.length - 1]!;
            for (let p = 1; p <= pagesCount; p += 1) {
              await fs.promises.writeFile(`${prefix}-${p}.png`, createSmallPng(120, 160));
            }
            return { stdout: '', stderr: '' };
          }
          if (file === 'tesseract') {
            return {
              stdout:
                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
                '5\t1\t1\t1\t1\t1\t0\t0\t50\t20\t95\tObjStmOcrText\n',
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      );
      return { calls, getPdftoppmCalls: () => pdftoppmCalls, execCommand };
    }

    function buildObjStmPdf(options: {
      compressedObjects: Array<{ objNum: number; body: string }>;
      uncompressedObjects?: Array<{ objNum: number; body: string; streamBytes?: Buffer }>;
      objStmId?: number;
      rootObjNum?: number;
      filterOverride?: string;
      corruptStreamPayload?: Buffer;
      includeXRef?: boolean;
      extraHeaderPadding?: string;
    }): Buffer {
      const objStmId = options.objStmId ?? 50;
      const rootObjNum = options.rootObjNum ?? 1;
      const parts: Buffer[] = [Buffer.from('%PDF-1.5\n', 'latin1')];
      const offsets = new Map<number, { type: number; f2: number; f3: number }>();

      let cursor = parts[0]!.length;

      // Uncompressed indirect objects (if any)
      for (const u of options.uncompressedObjects ?? []) {
        offsets.set(u.objNum, { type: 1, f2: cursor, f3: 0 });
        if (u.streamBytes) {
          const head = Buffer.from(`${u.objNum} 0 obj ${u.body} stream\n`, 'latin1');
          const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
          parts.push(head, u.streamBytes, tail);
          cursor += head.length + u.streamBytes.length + tail.length;
        } else {
          const buf = Buffer.from(`${u.objNum} 0 obj ${u.body} endobj\n`, 'latin1');
          parts.push(buf);
          cursor += buf.length;
        }
      }

      // Build /ObjStm payload
      let relOffset = 0;
      const headerPairs: string[] = [];
      const bodyChunks: string[] = [];
      for (let i = 0; i < options.compressedObjects.length; i += 1) {
        const co = options.compressedObjects[i]!;
        headerPairs.push(`${co.objNum} ${relOffset}`);
        const chunk = co.body + ' ';
        bodyChunks.push(chunk);
        relOffset += chunk.length;
      }
      const headerStr = headerPairs.join(' ') + (options.extraHeaderPadding ?? '\n');
      const rawObjStm = Buffer.from(headerStr + bodyChunks.join(''), 'latin1');
      const payload =
        options.corruptStreamPayload ??
        (options.filterOverride === 'none' ? rawObjStm : zlib.deflateSync(rawObjStm));
      const filterClause =
        options.filterOverride === 'none'
          ? ''
          : `/Filter ${options.filterOverride ?? '/FlateDecode'} `;

      offsets.set(objStmId, { type: 1, f2: cursor, f3: 0 });
      const stmHead = Buffer.from(
        `${objStmId} 0 obj << /Type /ObjStm /N ${options.compressedObjects.length} /First ${headerStr.length} ${filterClause}/Length ${payload.length} >> stream\n`,
        'latin1',
      );
      const stmTail = Buffer.from('\nendstream\nendobj\n', 'latin1');
      parts.push(stmHead, payload, stmTail);
      cursor += stmHead.length + payload.length + stmTail.length;

      options.compressedObjects.forEach((co, idx) => {
        offsets.set(co.objNum, { type: 2, f2: objStmId, f3: idx });
      });

      if (options.includeXRef !== false) {
        const xrefObjNum = Math.max(objStmId, ...Array.from(offsets.keys())) + 1;
        offsets.set(xrefObjNum, { type: 1, f2: cursor, f3: 0 });
        const maxId = xrefObjNum + 1;
        const rows: Buffer[] = [];
        for (let id = 0; id < maxId; id += 1) {
          const row = Buffer.alloc(6);
          if (id === 0) {
            row[0] = 0;
            row.writeUInt32BE(0, 1);
            row[5] = 255;
          } else {
            const e = offsets.get(id) ?? { type: 0, f2: 0, f3: 0 };
            row[0] = e.type;
            row.writeUInt32BE(e.f2, 1);
            row[5] = e.f3;
          }
          rows.push(row);
        }
        const xrefStream = Buffer.concat(rows);
        const xrefHead = Buffer.from(
          `${xrefObjNum} 0 obj << /Type /XRef /Size ${maxId} /W [1 4 1] /Root ${rootObjNum} 0 R /Length ${xrefStream.length} >> stream\n`,
          'latin1',
        );
        const xrefTail = Buffer.from(`\nendstream\nendobj\nstartxref\n${cursor}\n%%EOF`, 'latin1');
        parts.push(xrefHead, xrefStream, xrefTail);
      } else {
        parts.push(Buffer.from(`trailer << /Root ${rootObjNum} 0 R >>\n%%EOF`, 'latin1'));
      }

      return Buffer.concat(parts);
    }

    it('A: allows valid PDF with compressed /ObjStm catalog and page tree through preflight and OCR', async () => {
      const contentBytes = zlib.deflateSync(
        Buffer.from('BT /F1 12 Tf (Valid ObjStm Resume) Tj ET', 'utf8'),
      );
      const validObjStmPdf = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          {
            objNum: 3,
            body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
          },
        ],
        uncompressedObjects: [
          {
            objNum: 4,
            body: `<< /Length ${contentBytes.length} /Filter /FlateDecode >>`,
            streamBytes: contentBytes,
          },
        ],
      });

      const pdfExtractor = new PdfTextExtractor();
      const parsed = await pdfExtractor.parse(validObjStmPdf);
      expect(parsed.qualityStatus).toBe('COMPLETE');
      expect(parsed.extractedText).toContain('Valid ObjStm Resume');
      expect(parsed.objectStreamsDetected).toBe(true);

      // Scanned compressed /ObjStm PDF passes OCR preflight and calls pdftoppm with -cropbox
      const scannedObjStmPdf = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ],
      });
      const spy = createOcrSpy(1);
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: spy.execCommand,
      });
      const ocrResult = await ocr.extractText(scannedObjStmPdf);
      expect(ocrResult?.text).toBe('ObjStmOcrText');
      expect(spy.getPdftoppmCalls()).toBe(1);
    });

    it('B & F: rejects multi-page /ObjStm PDF with normal page 1 and oversized page 2 or aggregate bomb BEFORE pdftoppm', async () => {
      // Page 1 normal Letter, Page 2 hidden inside Flate /ObjStm with 10000x10000 pts
      const laterPageOversized = buildObjStmPdf({
        uncompressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ],
        compressedObjects: [
          { objNum: 4, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] >>' },
        ],
      });

      const spy1 = createOcrSpy(2);
      const ocr1 = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: spy1.execCommand,
      });
      await expect(ocr1.extractText(laterPageOversized)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spy1.getPdftoppmCalls()).toBe(0);

      // Multi-page aggregate pixel bomb completely inside compressed /ObjStm
      const aggObjStmBomb = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 960] >>' },
          { objNum: 4, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 960] >>' },
          { objNum: 5, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 960] >>' },
        ],
      });
      const spy2 = createOcrSpy(3);
      const ocr2 = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImagePixels: 5_000_000,
        maxAggregatePixels: 10_000_000, // 3 * (2000*2000) = 12M > 10M
        execCommand: spy2.execCommand,
      });
      await expect(ocr2.extractText(aggObjStmBomb)).rejects.toThrow(SecurityLimitExceededError);
      expect(spy2.getPdftoppmCalls()).toBe(0);
    });

    it('C & F: fails closed on unresolved page-tree refs, missing /Parent, inconsistent /Count, unsupported filters, or corrupt /ObjStm BEFORE pdftoppm', async () => {
      const spy = createOcrSpy(1);
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: spy.execCommand,
      });

      // 1. Missing kid ref despite /Type /ObjStm present (former bypass vector)
      const unresolvedKidWithObjStm = buildObjStmPdf({
        uncompressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [999 0 R] /Count 1 >>' },
        ],
        compressedObjects: [{ objNum: 6, body: '<< /Producer (Dummy) >>' }],
      });
      await expect(ocr.extractText(unresolvedKidWithObjStm)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
      expect(spy.getPdftoppmCalls()).toBe(0);

      // Even synchronous helper must fail closed when /ObjStm is present
      expect(() =>
        assertPdfGeometryWithinLimits(unresolvedKidWithObjStm.toString('latin1'), {
          maxImageWidth: 10_000,
          maxImageHeight: 10_000,
          maxImagePixels: 25_000_000,
        }),
      ).toThrow(InvalidDocumentFormatError);

      // 2. Orphan /Page with missing /Parent node
      const missingParent = buildObjStmPdf({
        compressedObjects: [{ objNum: 3, body: '<< /Type /Page /Parent 888 0 R >>' }],
        includeXRef: false,
      });
      await expect(ocr.extractText(missingParent)).rejects.toThrow(InvalidDocumentFormatError);
      expect(spy.getPdftoppmCalls()).toBe(0);

      // 3. /Pages declaring mismatched /Count vs resolved /Kids count inside /ObjStm
      const inconsistentCount = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 1 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
          { objNum: 4, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ],
      });
      await expect(ocr.extractText(inconsistentCount)).rejects.toThrow(InvalidDocumentFormatError);
      expect(spy.getPdftoppmCalls()).toBe(0);

      // 4. Unsupported filter (/LZWDecode) on /ObjStm fails closed
      const unsupportedFilter = buildObjStmPdf({
        compressedObjects: [{ objNum: 3, body: '<< /Type /Page /MediaBox [0 0 612 792] >>' }],
        filterOverride: '/LZWDecode',
        corruptStreamPayload: Buffer.from('RAW_LZW_BYTES'),
      });
      await expect(ocr.extractText(unsupportedFilter)).rejects.toThrow(InvalidDocumentFormatError);
      expect(spy.getPdftoppmCalls()).toBe(0);

      // 5. Corrupt FlateDecode /ObjStm fails closed
      const corruptFlate = buildObjStmPdf({
        compressedObjects: [{ objNum: 3, body: '<< /Type /Page >>' }],
        corruptStreamPayload: Buffer.from([0x78, 0x9c, 0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]),
      });
      await expect(ocr.extractText(corruptFlate)).rejects.toThrow(InvalidDocumentFormatError);
      expect(spy.getPdftoppmCalls()).toBe(0);
    });

    it('D & F: accurately resolves inherited /MediaBox, /CropBox, /Rotate, /UserUnit, and indirect box refs stored inside /ObjStm', async () => {
      // Valid: Huge inherited /MediaBox on /Pages inside /ObjStm cropped via leaf /CropBox + /Rotate 90
      const croppedInheritedObjStm = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          {
            objNum: 2,
            body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 20000 20000] /Rotate 90 >>',
          },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /CropBox [0 0 720 360] >>' },
        ],
      });
      const spyValid = createOcrSpy(1, ['720 x 360 pts'], [90]);
      const asymmetricValidOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImageWidth: 800,
        maxImageHeight: 1600,
        execCommand: spyValid.execCommand,
      });
      await expect(asymmetricValidOcr.extractText(croppedInheritedObjStm)).resolves.toMatchObject({
        text: 'ObjStmOcrText',
      });
      expect(spyValid.getPdftoppmCalls()).toBe(1);

      // Rotated dimensions swap (750w x 1500h px) -> reject when maxImageHeight = 1000 BEFORE pdftoppm
      const spyRotFail = createOcrSpy(1);
      const rotFailOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxImageWidth: 1600,
        maxImageHeight: 1000,
        execCommand: spyRotFail.execCommand,
      });
      await expect(rotFailOcr.extractText(croppedInheritedObjStm)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spyRotFail.getPdftoppmCalls()).toBe(0);

      // Unsafe: leaf /Page omits boxes, inheriting oversized /MediaBox [0 0 9000 9000] from intermediate /Pages inside /ObjStm
      const inheritedBombObjStm = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox 10 0 R >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
          { objNum: 10, body: '[0 0 9000 9000]' },
        ],
      });
      const spyBomb = createOcrSpy(1);
      const bombOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: spyBomb.execCommand,
      });
      await expect(bombOcr.extractText(inheritedBombObjStm)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spyBomb.getPdftoppmCalls()).toBe(0);

      // /UserUnit 75 bomb stored inside /ObjStm rejected BEFORE pdftoppm
      const userUnitObjStmBomb = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          {
            objNum: 3,
            body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /UserUnit 75 >>',
          },
        ],
      });
      await expect(bombOcr.extractText(userUnitObjStmBomb)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spyBomb.getPdftoppmCalls()).toBe(0);
    });

    it('E & F: enforces inspection dict/object limits and decompression bomb budgets inside /ObjStm BEFORE pdftoppm', async () => {
      // 20 extra dictionaries inside /ObjStm exceeds maxInspectedDictionaries = 10
      const manyObjStmDicts = [
        { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ...Array.from({ length: 20 }, (_, i) => ({
          objNum: 10 + i,
          body: `<< /Index ${i} >>`,
        })),
      ];
      const dictBombObjStm = buildObjStmPdf({ compressedObjects: manyObjStmDicts });

      const spy = createOcrSpy(1);
      const dictLimitedOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxInspectedDictionaries: 10,
        execCommand: spy.execCommand,
      });
      await expect(dictLimitedOcr.extractText(dictBombObjStm)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spy.getPdftoppmCalls()).toBe(0);

      const objLimitedOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxInspectedObjects: 10,
        execCommand: spy.execCommand,
      });
      await expect(objLimitedOcr.extractText(dictBombObjStm)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spy.getPdftoppmCalls()).toBe(0);

      // /ObjStm Flate decompression bomb (excessive compression ratio > maxCompressionRatio)
      const paddedBody = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Pad (${'A'.repeat(25_000)}) >>`;
      const ratioBombPdf = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { objNum: 3, body: paddedBody },
        ],
      });
      const ratioLimitedOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        maxCompressionRatio: 20,
        execCommand: spy.execCommand,
      });
      await expect(ratioLimitedOcr.extractText(ratioBombPdf)).rejects.toThrow(
        SecurityLimitExceededError,
      );
      expect(spy.getPdftoppmCalls()).toBe(0);
    });

    it('G: rejects shadowed duplicate object definitions across top-level and /ObjStm and fails closed on pdfinfo error/mismatch', async () => {
      // Uncompressed benign 3 0 obj + compressed malicious 3 0 obj inside /ObjStm
      const shadowedPdf = buildObjStmPdf({
        uncompressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ],
        compressedObjects: [
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 12000 12000] >>' },
        ],
      });
      const spy = createOcrSpy(1);
      const ocr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: spy.execCommand,
      });
      await expect(ocr.extractText(shadowedPdf)).rejects.toThrow(SecurityLimitExceededError);
      expect(spy.getPdftoppmCalls()).toBe(0);

      // Also verify async validator explicitly validates complex legitimate /ObjStm tree
      const cleanValid = buildObjStmPdf({
        compressedObjects: [
          { objNum: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { objNum: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>' },
          { objNum: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
          { objNum: 4, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
        ],
      });
      const summary = await assertPdfGeometryWithinLimitsAsync(cleanValid, {
        maxImageWidth: 10_000,
        maxImageHeight: 10_000,
        maxImagePixels: 25_000_000,
      });
      expect(summary.hasObjectStreams).toBe(true);
      expect(summary.resolvedLeafPageCount).toBe(2);
      expect(summary.expandedObjectCount).toBe(4);

      // Fail closed on pdfinfo execution failure (non-ENOENT) BEFORE pdftoppm
      let pdfinfoErrPdftoppmCalls = 0;
      const pdfinfoFailOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: async (file, args) => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.5.2\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') throw new Error("Syntax Error: Couldn't read page catalog");
          if (file === 'pdftoppm') pdfinfoErrPdftoppmCalls += 1;
          return { stdout: '', stderr: '' };
        },
      });
      await expect(pdfinfoFailOcr.extractText(cleanValid)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
      expect(pdfinfoErrPdftoppmCalls).toBe(0);

      // Fail closed when pdfinfo page count mismatches /ObjStm page tree BEFORE pdftoppm
      const mismatchSpy = createOcrSpy(1);
      const mismatchOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: mismatchSpy.execCommand,
      });
      await expect(mismatchOcr.extractText(cleanValid)).rejects.toThrow(InvalidDocumentFormatError);
      expect(mismatchSpy.getPdftoppmCalls()).toBe(0);

      // Fail closed when pdfinfo -f 1 -l 2 -box omits page 2 entry
      let incompletePdftoppmCalls = 0;
      const incompleteBoxOcr = new TesseractOcrProvider({
        tesseractPath: 'tesseract',
        pdftoppmPath: 'pdftoppm',
        pdfinfoPath: 'pdfinfo',
        execCommand: async (file, args) => {
          if (args.includes('--version')) return { stdout: 'tesseract 5.5.2\n', stderr: '' };
          if (args.includes('-v')) return { stdout: 'pdftoppm version 25.12.0\n', stderr: '' };
          if (args.includes('--list-langs')) return { stdout: 'eng\n', stderr: '' };
          if (file === 'pdfinfo') {
            if (args.includes('-box')) {
              return {
                stdout: 'Pages: 2\nPage 1 size: 612 x 792 pts\nPDF version: 1.5\n',
                stderr: '',
              };
            }
            return { stdout: 'Pages: 2\nPage size: 612 x 792 pts\nPDF version: 1.5\n', stderr: '' };
          }
          if (file === 'pdftoppm') incompletePdftoppmCalls += 1;
          return { stdout: '', stderr: '' };
        },
      });
      await expect(incompleteBoxOcr.extractText(cleanValid)).rejects.toThrow(
        InvalidDocumentFormatError,
      );
      expect(incompletePdftoppmCalls).toBe(0);
    });
  });
});
