import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  detectFileTypeFromMagicBytes,
  FileTooLargeError,
  MultipartUploadError,
  parseMultipartUpload,
  TooManyFilesError,
} from './resume.multipart.js';

function createMockMultipartStream(
  files: Array<{ filename: string; content: Buffer }>,
  boundary = '----TestBoundary12345',
): IncomingMessage {
  const chunks: Buffer[] = [];

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const fullBody = Buffer.concat(chunks);

  const readable = Readable.from([fullBody]) as unknown as IncomingMessage;
  readable.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };

  return readable;
}

describe('Streaming Multipart Upload Parser', () => {
  it('detects PDF from magic bytes %PDF', () => {
    const pdfHeader = Buffer.from('%PDF-1.4 header info');
    expect(detectFileTypeFromMagicBytes(pdfHeader)).toBe('PDF');
  });

  it('detects DOCX from magic bytes PK\\x03\\x04', () => {
    const docxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(detectFileTypeFromMagicBytes(docxHeader)).toBe('DOCX');
  });

  it('returns null for unrecognized magic bytes', () => {
    const exeHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ executable
    expect(detectFileTypeFromMagicBytes(exeHeader)).toBeNull();
  });

  it('parses valid PDF and DOCX files, computes SHA-256, and sanitizes filenames', async () => {
    const pdfContent = Buffer.from('%PDF-1.4\nTest PDF Content Here');
    const docxContent = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]);

    const req = createMockMultipartStream([
      { filename: 'my_resume (1).pdf', content: pdfContent },
      { filename: '../../traversal/bad.docx', content: docxContent },
    ]);

    const parsed = await parseMultipartUpload(req);

    expect(parsed).toHaveLength(2);

    // File 1
    expect(parsed[0]!.fileType).toBe('PDF');
    expect(parsed[0]!.sanitizedFileName).toBe('my_resume (1).pdf');
    expect(parsed[0]!.sizeBytes).toBe(pdfContent.length);
    expect(parsed[0]!.sha256).toBe(createHash('sha256').update(pdfContent).digest('hex'));

    // File 2: traversal markers stripped
    expect(parsed[1]!.fileType).toBe('DOCX');
    expect(parsed[1]!.sanitizedFileName).toBe('_traversal_bad.docx');

    // Clean up
    for (const f of parsed) {
      await f.cleanup();
      const exists = await fs
        .access(f.tempPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  it('rejects upload when file exceeds maxFileSize limit', async () => {
    const largeContent = Buffer.alloc(1024 * 1024 * 2); // 2 MB
    largeContent.write('%PDF-1.4');

    const req = createMockMultipartStream([{ filename: 'large.pdf', content: largeContent }]);

    // Set maxFileSize to 1 MB
    await expect(parseMultipartUpload(req, { maxFileSize: 1024 * 1024 })).rejects.toThrow(
      FileTooLargeError,
    );
  });

  it('rejects upload when number of files exceeds maxFiles limit', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 content');
    const req = createMockMultipartStream([
      { filename: '1.pdf', content: pdfContent },
      { filename: '2.pdf', content: pdfContent },
      { filename: '3.pdf', content: pdfContent },
    ]);

    // Set maxFiles to 2
    await expect(parseMultipartUpload(req, { maxFiles: 2 })).rejects.toThrow(TooManyFilesError);
  });

  it('rejects non-multipart requests with MultipartUploadError', async () => {
    const req = Readable.from([Buffer.from('not multipart')]) as unknown as IncomingMessage;
    req.headers = { 'content-type': 'application/json' };

    await expect(parseMultipartUpload(req)).rejects.toThrow(MultipartUploadError);
  });

  it('preserves empty and unsupported-signature parts as rejected entries with clientFileId', async () => {
    const boundary = '----TestBoundaryReject';
    const chunks = [
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file:slot-empty"; filename="empty.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file:slot-bad"; filename="malware.exe"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const req = Readable.from([Buffer.concat(chunks)]) as unknown as IncomingMessage;
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };

    const parsed = await parseMultipartUpload(req);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      clientFileId: 'slot-empty',
      fileType: null,
      sizeBytes: 0,
      tempPath: '',
    });
    expect(parsed[0]?.rejectionReason).toContain('empty');

    expect(parsed[1]).toMatchObject({
      clientFileId: 'slot-bad',
      fileType: null,
      sizeBytes: 4,
      tempPath: '',
    });
    expect(parsed[1]?.rejectionReason).toContain('Unsupported');
  });
});
