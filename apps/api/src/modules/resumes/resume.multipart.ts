import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

import { sanitizeFileName } from './resume.schemas.js';
import type { ResumeFileType } from './resume.types.js';

export class MultipartUploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'MultipartUploadError';
  }
}

export class FileTooLargeError extends MultipartUploadError {
  constructor(maxSizeMb = 15) {
    super(`File exceeds maximum allowed size of ${maxSizeMb} MB`, 413);
    this.name = 'FileTooLargeError';
  }
}

export class TooManyFilesError extends MultipartUploadError {
  constructor(maxFiles = 100) {
    super(`Exceeded maximum upload limit of ${maxFiles} files per batch`, 400);
    this.name = 'TooManyFilesError';
  }
}

export interface ParsedUploadedFile {
  tempPath: string;
  originalFileName: string;
  sanitizedFileName: string;
  fileType: ResumeFileType | null;
  rejectionReason?: string | undefined;
  sizeBytes: number;
  sha256: string;
  clientFileId?: string | undefined;
  cleanup: () => Promise<void>;
}

export interface MultipartOptions {
  maxFileSize?: number; // default 15MB
  maxFiles?: number; // default 500 total
  maxBodySize?: number; // default 50MB per multipart request (matching Nginx client_max_body_size 50M)
  maxTotalBytes?: number; // default 1GB cumulative batch limit
  tempDir?: string;
}

export function detectFileTypeFromMagicBytes(header: Buffer): ResumeFileType | null {
  if (header.length >= 4) {
    // PDF: %PDF
    if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
      return 'PDF';
    }
    // DOCX / ZIP: PK\x03\x04
    if (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
      return 'DOCX';
    }
  }
  return null;
}

export async function parseMultipartUpload(
  req: IncomingMessage,
  options: MultipartOptions = {},
): Promise<ParsedUploadedFile[]> {
  const maxFileSize = options.maxFileSize ?? 15 * 1024 * 1024; // 15MB
  const maxFiles = options.maxFiles ?? 500;
  const maxBodySize = options.maxBodySize ?? 50 * 1024 * 1024; // 50MB
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024; // 1GB
  const tempDir = options.tempDir ?? os.tmpdir();

  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    throw new MultipartUploadError('Content-Type must be multipart/form-data');
  }

  const boundaryMatch = /boundary=([^\s;]+)/i.exec(contentType);
  if (!boundaryMatch) {
    throw new MultipartUploadError('Missing multipart boundary');
  }

  // Remove optional quotes from boundary string
  let boundaryStr = boundaryMatch[1]!;
  if (boundaryStr.startsWith('"') && boundaryStr.endsWith('"')) {
    boundaryStr = boundaryStr.slice(1, -1);
  }

  const boundary = Buffer.from(`--${boundaryStr}`);
  const boundaryEnd = Buffer.from(`--${boundaryStr}--`);
  const headerEndDelimiter = Buffer.from('\r\n\r\n');

  const files: ParsedUploadedFile[] = [];
  const tempPathsToClean: string[] = [];

  const cleanupAll = async () => {
    for (const p of tempPathsToClean) {
      await fs.unlink(p).catch(() => {});
    }
  };

  try {
    let buffer = Buffer.alloc(0);
    let currentFileStream: ReturnType<typeof createWriteStream> | null = null;
    let currentTempPath: string | null = null;
    let currentHash = createHash('sha256');
    let currentBytes = 0;
    let currentHeaderBuffer = Buffer.alloc(0);
    let currentOriginalName = '';
    let currentClientFileId: string | undefined = undefined;
    let currentFileType: ResumeFileType | null = null;
    let insideFileBody = false;
    let totalStreamedBytes = 0;
    let totalFilesBytes = 0;

    const finishCurrentFile = async () => {
      if (currentFileStream && currentTempPath) {
        await new Promise<void>((resolve, reject) => {
          currentFileStream!.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        if (currentBytes === 0) {
          // Discard temp file for empty uploads, but preserve slot entry so service records rejection & clientFileId
          await fs.unlink(currentTempPath).catch(() => {});
          files.push({
            tempPath: '',
            originalFileName: currentOriginalName,
            sanitizedFileName: sanitizeFileName(currentOriginalName),
            fileType: null,
            rejectionReason: 'Uploaded file is empty (0 bytes)',
            sizeBytes: 0,
            sha256: currentHash.digest('hex'),
            clientFileId: currentClientFileId,
            cleanup: async () => {},
          });
        } else if (!currentFileType) {
          // Unlink untrusted bytes immediately, but preserve slot entry so service records rejection & clientFileId
          await fs.unlink(currentTempPath).catch(() => {});
          files.push({
            tempPath: '',
            originalFileName: currentOriginalName,
            sanitizedFileName: sanitizeFileName(currentOriginalName),
            fileType: null,
            rejectionReason: 'Unsupported or corrupted file signature (expected PDF or DOCX)',
            sizeBytes: currentBytes,
            sha256: currentHash.digest('hex'),
            clientFileId: currentClientFileId,
            cleanup: async () => {},
          });
        } else {
          const filePath = currentTempPath;
          files.push({
            tempPath: filePath,
            originalFileName: currentOriginalName,
            sanitizedFileName: sanitizeFileName(currentOriginalName),
            fileType: currentFileType,
            sizeBytes: currentBytes,
            sha256: currentHash.digest('hex'),
            clientFileId: currentClientFileId,
            cleanup: async () => {
              await fs.unlink(filePath).catch(() => {});
            },
          });
        }
      }

      currentFileStream = null;
      currentTempPath = null;
      currentBytes = 0;
      currentHeaderBuffer = Buffer.alloc(0);
      currentOriginalName = '';
      currentClientFileId = undefined;
      currentFileType = null;
      insideFileBody = false;
    };

    for await (const chunk of req as AsyncIterable<Buffer>) {
      totalStreamedBytes += chunk.length;
      if (totalStreamedBytes > maxBodySize) {
        throw new FileTooLargeError(Math.round(maxBodySize / (1024 * 1024)));
      }
      buffer = Buffer.concat([buffer, chunk]);

      let processMore = true;
      while (processMore) {
        if (!insideFileBody) {
          // Looking for boundary
          const bIndex = buffer.indexOf(boundary);
          if (bIndex === -1) {
            // Check if buffer is getting unreasonably large without finding a boundary
            if (buffer.length > 64 * 1024) {
              buffer = buffer.subarray(buffer.length - 1024);
            }
            break;
          }

          // Check if it's the end boundary
          if (buffer.indexOf(boundaryEnd) === bIndex) {
            processMore = false;
            break;
          }

          // Advance past boundary and \r\n
          const startAfterBoundary = bIndex + boundary.length;
          if (buffer.length < startAfterBoundary + 2) {
            break; // wait for \r\n
          }

          const headerEndIndex = buffer.indexOf(headerEndDelimiter, startAfterBoundary);
          if (headerEndIndex === -1) {
            break; // wait for complete headers
          }

          const headersRaw = buffer.subarray(startAfterBoundary, headerEndIndex).toString('utf8');
          buffer = buffer.subarray(headerEndIndex + headerEndDelimiter.length);

          // Parse Content-Disposition
          const dispMatch =
            /Content-Disposition:[^\r\n]*\bfilename=(?:"([^"]+)"|([^\s;\r\n]+))/i.exec(headersRaw);

          if (dispMatch) {
            const rawFileName = dispMatch[1] ?? dispMatch[2] ?? 'resume';

            if (files.length >= maxFiles) {
              throw new TooManyFilesError(maxFiles);
            }

            const nameMatch = /Content-Disposition:[^\r\n]*\bname="([^"]+)"/i.exec(headersRaw);
            let clientFileId: string | undefined;
            if (nameMatch && nameMatch[1]?.startsWith('file:')) {
              clientFileId = nameMatch[1].slice(5);
            }
            const clientFileIdHeader = /X-Client-File-Id:\s*([^\r\n]+)/i.exec(headersRaw);
            if (clientFileIdHeader?.[1]) {
              clientFileId = clientFileIdHeader[1].trim();
            }

            currentOriginalName = rawFileName;
            currentClientFileId = clientFileId;
            currentTempPath = path.join(tempDir, `talentlens-upload-${randomUUID()}.tmp`);
            tempPathsToClean.push(currentTempPath);
            currentFileStream = createWriteStream(currentTempPath);
            currentHash = createHash('sha256');
            currentBytes = 0;
            currentHeaderBuffer = Buffer.alloc(0);
            currentFileType = null;
            insideFileBody = true;
          }
        } else {
          // Inside file body: look for the next boundary
          const nextBoundaryIndex = buffer.indexOf(boundary);

          let chunkToWrite: Buffer;
          if (nextBoundaryIndex !== -1) {
            // Next boundary found: data ends right before CRLF + boundary
            let dataEnd = nextBoundaryIndex;
            if (dataEnd >= 2 && buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) {
              dataEnd -= 2;
            }
            chunkToWrite = buffer.subarray(0, dataEnd);
            buffer = buffer.subarray(nextBoundaryIndex);
          } else {
            // Keep boundary buffer margin so we don't accidentally write a split boundary
            const safeLength = buffer.length - (boundary.length + 4);
            if (safeLength <= 0) {
              break;
            }
            chunkToWrite = buffer.subarray(0, safeLength);
            buffer = buffer.subarray(safeLength);
          }

          if (chunkToWrite.length > 0) {
            currentBytes += chunkToWrite.length;
            totalFilesBytes += chunkToWrite.length;
            if (currentBytes > maxFileSize) {
              throw new FileTooLargeError(Math.round(maxFileSize / (1024 * 1024)));
            }
            if (totalFilesBytes > maxTotalBytes) {
              throw new MultipartUploadError('Total batch upload size exceeds 1 GB limit', 413);
            }

            currentHash.update(chunkToWrite);

            // Sniff magic bytes on the first chunk
            if (currentHeaderBuffer.length < 16) {
              currentHeaderBuffer = Buffer.concat([
                currentHeaderBuffer,
                chunkToWrite.subarray(0, 16 - currentHeaderBuffer.length),
              ]);
              currentFileType = detectFileTypeFromMagicBytes(currentHeaderBuffer);
            }

            await new Promise<void>((resolve) => {
              if (!currentFileStream!.write(chunkToWrite)) {
                currentFileStream!.once('drain', resolve);
              } else {
                resolve();
              }
            });
          }

          if (nextBoundaryIndex !== -1) {
            // Finished current file part
            await finishCurrentFile();
          }
        }
      }
    }

    if (insideFileBody) {
      await finishCurrentFile();
    }

    return files;
  } catch (err) {
    await cleanupAll();
    throw err;
  }
}
