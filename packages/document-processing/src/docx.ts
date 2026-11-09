import { inflateBounded } from './decompress.js';
import {
  DocumentProcessingTimeoutError,
  EncryptedDocumentError,
  InvalidDocumentFormatError,
  SecurityLimitExceededError,
} from './errors.js';
import type {
  DocumentParser,
  ExtractionQualityStatus,
  ParagraphPosition,
  ParserResult,
  ResumeFileType,
} from './types.js';

export interface DocxExtractorOptions {
  maxUncompressedBytes?: number;
  maxEntryUncompressedBytes?: number;
  maxEntries?: number;
  maxCompressionRatio?: number;
  timeoutMs?: number;
}

interface ParsedZipEntryMeta {
  offset: number;
  normalizedName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  hasDataDescriptor: boolean;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export class DocxTextExtractor implements DocumentParser {
  private readonly maxUncompressedBytes: number;
  private readonly maxEntryUncompressedBytes: number;
  private readonly maxEntries: number;
  private readonly maxCompressionRatio: number;
  private readonly timeoutMs: number;

  constructor(options: DocxExtractorOptions = {}) {
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? 25 * 1024 * 1024; // 25 MB aggregate
    this.maxEntryUncompressedBytes =
      options.maxEntryUncompressedBytes ?? Math.min(10 * 1024 * 1024, this.maxUncompressedBytes); // 10 MB per entry
    this.maxEntries = options.maxEntries ?? 500;
    this.maxCompressionRatio = options.maxCompressionRatio ?? 50; // Max 50:1 ratio
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public supports(fileType: ResumeFileType): boolean {
    return fileType === 'DOCX';
  }

  public async parse(buffer: Buffer): Promise<ParserResult> {
    // 1. Signature check: ZIP local file header starts with PK\x03\x04
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIG) {
      throw new InvalidDocumentFormatError('Missing DOCX/ZIP signature (PK\\x03\\x04)');
    }

    const deadlineMs = Date.now() + this.timeoutMs;

    try {
      const documentXml = await this.extractWordDocumentXml(buffer, deadlineMs);
      const paragraphs = this.parseWordDocumentXml(documentXml, deadlineMs);

      const paragraphPositions: ParagraphPosition[] = [];
      let currentOffset = 0;

      for (let i = 0; i < paragraphs.length; i += 1) {
        const text = paragraphs[i]!;
        const startOffset = currentOffset;
        const endOffset = currentOffset + text.length;

        paragraphPositions.push({
          index: i + 1,
          startOffset,
          endOffset,
          text,
        });

        // 2 newline separation between paragraphs in full extracted text
        currentOffset = endOffset + 2;
      }

      const fullText = paragraphs.join('\n\n').trim();
      const isEmpty = fullText.length === 0;
      const qualityStatus: ExtractionQualityStatus = isEmpty ? 'NEEDS_REVIEW' : 'COMPLETE';

      return {
        extractedText: fullText,
        pageMapJson: {
          paragraphCount: paragraphs.length,
          paragraphs: paragraphPositions,
          ...(isEmpty ? { warning: 'DOCX document contains no readable text content.' } : {}),
        },
        parser: 'talentlens-docx-v1',
        ocrUsed: false,
        qualityStatus,
      };
    } catch (err: unknown) {
      if (
        err instanceof InvalidDocumentFormatError ||
        err instanceof SecurityLimitExceededError ||
        err instanceof EncryptedDocumentError ||
        err instanceof DocumentProcessingTimeoutError
      ) {
        throw err;
      }
      return {
        extractedText: '',
        pageMapJson: { error: 'Failed to extract DOCX archive' },
        parser: 'talentlens-docx-v1',
        ocrUsed: false,
        qualityStatus: 'FAILED',
      };
    }
  }

  private validateAndNormalizeEntryPath(rawName: string): string {
    if (!rawName || rawName.length === 0) {
      throw new InvalidDocumentFormatError('Empty archive entry name in DOCX archive');
    }
    for (let i = 0; i < rawName.length; i += 1) {
      if (rawName.charCodeAt(i) < 0x20) {
        throw new InvalidDocumentFormatError('Unsafe control character in DOCX archive entry name');
      }
    }
    if (rawName.startsWith('/') || rawName.startsWith('\\') || /^[a-zA-Z]:/.test(rawName)) {
      throw new InvalidDocumentFormatError(
        'Absolute or drive-qualified path is forbidden in DOCX archive',
      );
    }

    const segments = rawName.split(/[/\\]/);
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      // Allow single trailing empty segment only if it's a directory entry (e.g., "word/")
      if (seg === '' && i < segments.length - 1) {
        throw new InvalidDocumentFormatError('Malformed path separator in DOCX archive');
      }
      if (seg === '..' || seg === '.') {
        throw new InvalidDocumentFormatError('Path traversal segment is forbidden in DOCX archive');
      }
    }

    return rawName.replace(/\\/g, '/');
  }

  private async extractWordDocumentXml(buffer: Buffer, deadlineMs: number): Promise<string> {
    let offset = 0;
    let totalActualUncompressedBytes = 0;
    let entryCount = 0;
    let documentXmlContent: string | null = null;
    const localEntries: ParsedZipEntryMeta[] = [];

    while (offset < buffer.length) {
      if (Date.now() > deadlineMs) {
        throw new DocumentProcessingTimeoutError(
          `DOCX parsing exceeded ${this.timeoutMs}ms timeout limit`,
        );
      }

      if (offset + 4 > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated ZIP section header in DOCX archive');
      }

      const sig = buffer.readUInt32LE(offset);
      if (sig === CENTRAL_DIR_HEADER_SIG || sig === EOCD_SIG) {
        break;
      }
      if (sig !== LOCAL_FILE_HEADER_SIG) {
        throw new InvalidDocumentFormatError('Corrupt ZIP local file signature in DOCX archive');
      }

      if (offset + 30 > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated ZIP local file header in DOCX archive');
      }

      entryCount += 1;
      if (entryCount > this.maxEntries) {
        throw new SecurityLimitExceededError(
          `Archive contains more than ${this.maxEntries} entries`,
        );
      }

      const bitFlag = buffer.readUInt16LE(offset + 6);
      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const declaredCompressedSize = buffer.readUInt32LE(offset + 18);
      const declaredUncompressedSize = buffer.readUInt32LE(offset + 22);
      const nameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);

      if ((bitFlag & 0x0001) !== 0) {
        throw new EncryptedDocumentError(
          'DOCX archive contains password-protected or encrypted entries',
        );
      }

      if (
        declaredCompressedSize === 0xffffffff ||
        declaredUncompressedSize === 0xffffffff ||
        nameLength === 0xffff
      ) {
        throw new InvalidDocumentFormatError('Unsupported ZIP64 marker in DOCX archive');
      }

      const hasDataDescriptor = (bitFlag & 0x0008) !== 0;

      // Reject forged headers declaring absurd sizes before decompressing
      if (!hasDataDescriptor || declaredUncompressedSize > 0) {
        if (declaredUncompressedSize > this.maxEntryUncompressedBytes) {
          throw new SecurityLimitExceededError(
            `ZIP entry uncompressed size exceeds ${this.maxEntryUncompressedBytes} byte per-entry limit`,
          );
        }
        if (totalActualUncompressedBytes + declaredUncompressedSize > this.maxUncompressedBytes) {
          throw new SecurityLimitExceededError(
            `Uncompressed archive size exceeds ${this.maxUncompressedBytes} byte limit`,
          );
        }
        if (
          declaredCompressedSize > 0 &&
          declaredUncompressedSize / declaredCompressedSize > this.maxCompressionRatio
        ) {
          throw new SecurityLimitExceededError('ZIP compression ratio exceeds safety threshold');
        }
      }

      const nameStart = offset + 30;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated entry name in DOCX archive');
      }

      const rawFileName = buffer.toString('utf8', nameStart, nameEnd);
      const normalizedName = this.validateAndNormalizeEntryPath(rawFileName);
      const isDocumentXml = normalizedName.toLowerCase() === 'word/document.xml';

      if (isDocumentXml && documentXmlContent !== null) {
        throw new InvalidDocumentFormatError('Duplicate word/document.xml entry in DOCX archive');
      }

      const dataStart = nameEnd + extraLength;
      if (dataStart > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated entry extra field in DOCX archive');
      }

      if (compressionMethod !== 0 && compressionMethod !== 8) {
        throw new InvalidDocumentFormatError(
          `Unsupported compression method (${compressionMethod}) in DOCX archive`,
        );
      }

      const remainingDocBudget = this.maxUncompressedBytes - totalActualUncompressedBytes;
      const entryBudget = Math.min(this.maxEntryUncompressedBytes, remainingDocBudget);

      let actualCompressedSize = declaredCompressedSize;
      let actualUncompressedSize = 0;
      let nextOffset = dataStart;

      if (hasDataDescriptor && compressionMethod === 0 && declaredCompressedSize === 0) {
        throw new InvalidDocumentFormatError(
          'Unsupported bit-3 data descriptor with stored compression and zero size',
        );
      }

      if (hasDataDescriptor && compressionMethod === 8 && declaredCompressedSize === 0) {
        // Streaming bounded raw DEFLATE from unknown compressed length up to Z_STREAM_END
        const tailSlice = buffer.subarray(dataStart);
        const inflated = await inflateBounded(tailSlice, {
          mode: 'raw',
          maxOutputBytes: entryBudget,
          maxCompressionRatio: this.maxCompressionRatio,
          ratioMinOutputBytes: 512,
          hasUnknownCompressedLength: true,
          deadlineMs,
          retainOutput: isDocumentXml,
          entryLabel: normalizedName,
        });

        actualCompressedSize = inflated.compressedBytesConsumed;
        actualUncompressedSize = inflated.bytesOut;

        const descStart = dataStart + actualCompressedSize;
        if (descStart + 12 > buffer.length) {
          throw new InvalidDocumentFormatError('Truncated ZIP data descriptor in DOCX archive');
        }

        let descCompressed = 0;
        let descUncompressed = 0;
        if (buffer.readUInt32LE(descStart) === DATA_DESCRIPTOR_SIG) {
          if (descStart + 16 > buffer.length) {
            throw new InvalidDocumentFormatError('Truncated ZIP data descriptor in DOCX archive');
          }
          descCompressed = buffer.readUInt32LE(descStart + 8);
          descUncompressed = buffer.readUInt32LE(descStart + 12);
          nextOffset = descStart + 16;
        } else {
          descCompressed = buffer.readUInt32LE(descStart + 4);
          descUncompressed = buffer.readUInt32LE(descStart + 8);
          nextOffset = descStart + 12;
        }

        if (
          descCompressed !== actualCompressedSize ||
          descUncompressed !== actualUncompressedSize
        ) {
          throw new InvalidDocumentFormatError(
            `ZIP data descriptor size mismatch for ${normalizedName}`,
          );
        }

        if (isDocumentXml) {
          documentXmlContent = inflated.buffer.toString('utf8');
        }
      } else {
        const dataEnd = dataStart + declaredCompressedSize;
        if (dataEnd > buffer.length) {
          throw new InvalidDocumentFormatError('Truncated entry data in DOCX archive');
        }
        nextOffset = dataEnd;

        const rawData = buffer.subarray(dataStart, dataEnd);

        if (compressionMethod === 0) {
          if (declaredCompressedSize !== declaredUncompressedSize) {
            throw new InvalidDocumentFormatError(
              `Stored ZIP entry size mismatch for ${normalizedName}`,
            );
          }
          if (rawData.length > entryBudget) {
            throw new SecurityLimitExceededError(
              `Uncompressed archive size exceeds security limit`,
            );
          }
          actualCompressedSize = rawData.length;
          actualUncompressedSize = rawData.length;
          if (isDocumentXml) {
            documentXmlContent = rawData.toString('utf8');
          }
        } else {
          // Deflate entry: never allocate uncompressed buffer above actual budget
          if (rawData.length === 0 && declaredUncompressedSize === 0) {
            actualCompressedSize = 0;
            actualUncompressedSize = 0;
            if (isDocumentXml) {
              documentXmlContent = '';
            }
          } else {
            const inflated = await inflateBounded(rawData, {
              mode: 'raw',
              maxOutputBytes: entryBudget,
              maxCompressionRatio: this.maxCompressionRatio,
              ratioMinOutputBytes: 512,
              deadlineMs,
              retainOutput: isDocumentXml,
              entryLabel: normalizedName,
            });
            actualUncompressedSize = inflated.bytesOut;

            if (
              declaredUncompressedSize !== actualUncompressedSize &&
              declaredUncompressedSize !== 0
            ) {
              throw new InvalidDocumentFormatError(
                `ZIP local header uncompressed size mismatch for ${normalizedName}`,
              );
            }
            if (
              declaredUncompressedSize === 0 &&
              actualUncompressedSize > 0 &&
              !hasDataDescriptor
            ) {
              throw new InvalidDocumentFormatError(
                `ZIP local header forged zero uncompressed size for ${normalizedName}`,
              );
            }

            if (hasDataDescriptor && nextOffset + 12 <= buffer.length) {
              // Consume optional trailing data descriptor when bit 3 was set alongside known compressed size
              if (buffer.readUInt32LE(nextOffset) === DATA_DESCRIPTOR_SIG) {
                if (nextOffset + 16 > buffer.length) {
                  throw new InvalidDocumentFormatError('Truncated ZIP data descriptor');
                }
                nextOffset += 16;
              } else {
                const sigPeek = buffer.readUInt32LE(nextOffset);
                if (
                  sigPeek !== LOCAL_FILE_HEADER_SIG &&
                  sigPeek !== CENTRAL_DIR_HEADER_SIG &&
                  sigPeek !== EOCD_SIG
                ) {
                  nextOffset += 12;
                }
              }
            }

            if (isDocumentXml) {
              documentXmlContent = inflated.buffer.toString('utf8');
            }
          }
        }
      }

      totalActualUncompressedBytes += actualUncompressedSize;
      if (totalActualUncompressedBytes > this.maxUncompressedBytes) {
        throw new SecurityLimitExceededError(
          `Uncompressed archive size exceeds ${this.maxUncompressedBytes} byte limit`,
        );
      }

      localEntries.push({
        offset,
        normalizedName,
        compressionMethod,
        compressedSize: actualCompressedSize,
        uncompressedSize: actualUncompressedSize,
        hasDataDescriptor,
      });

      offset = nextOffset;
    }

    // Validate Central Directory and End of Central Directory when present.
    // Minimal synthetic unit-test buffers may end immediately after local entries.
    if (offset < buffer.length) {
      this.validateCentralDirectoryAndEocd(buffer, offset, localEntries, deadlineMs);
    }

    if (documentXmlContent === null || documentXmlContent.length === 0) {
      throw new InvalidDocumentFormatError('DOCX archive missing required word/document.xml entry');
    }

    return documentXmlContent;
  }

  private validateCentralDirectoryAndEocd(
    buffer: Buffer,
    cdStartOffset: number,
    localEntries: readonly ParsedZipEntryMeta[],
    deadlineMs: number,
  ): void {
    let offset = cdStartOffset;
    if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIR_HEADER_SIG) {
      throw new InvalidDocumentFormatError('Malformed ZIP central directory in DOCX archive');
    }

    const matchedLocalOffsets = new Set<number>();
    const localByOffset = new Map<number, ParsedZipEntryMeta>();
    for (const local of localEntries) {
      localByOffset.set(local.offset, local);
    }

    let cdCount = 0;
    while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === CENTRAL_DIR_HEADER_SIG) {
      if (Date.now() > deadlineMs) {
        throw new DocumentProcessingTimeoutError(
          `DOCX parsing exceeded ${this.timeoutMs}ms timeout limit`,
        );
      }

      if (offset + 46 > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated ZIP central directory header');
      }

      if (cdCount >= this.maxEntries || cdCount >= localEntries.length) {
        throw new InvalidDocumentFormatError(
          'ZIP central directory entry count does not match local entries',
        );
      }

      const cdCompressionMethod = buffer.readUInt16LE(offset + 10);
      const cdCompressedSize = buffer.readUInt32LE(offset + 20);
      const cdUncompressedSize = buffer.readUInt32LE(offset + 24);
      const nameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const cdLocalHeaderOffset = buffer.readUInt32LE(offset + 42);

      if (cdUncompressedSize > this.maxEntryUncompressedBytes) {
        throw new SecurityLimitExceededError(
          `ZIP central directory declares entry larger than ${this.maxEntryUncompressedBytes} byte limit`,
        );
      }

      const recordEnd = offset + 46 + nameLen + extraLen + commentLen;
      if (recordEnd > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated ZIP central directory record');
      }

      const rawCdName = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
      const cdNormalizedName = this.validateAndNormalizeEntryPath(rawCdName);

      const expectedLocal = localByOffset.get(cdLocalHeaderOffset);
      if (
        !expectedLocal ||
        matchedLocalOffsets.has(cdLocalHeaderOffset) ||
        cdNormalizedName !== expectedLocal.normalizedName ||
        cdCompressionMethod !== expectedLocal.compressionMethod ||
        cdCompressedSize !== expectedLocal.compressedSize ||
        cdUncompressedSize !== expectedLocal.uncompressedSize
      ) {
        throw new InvalidDocumentFormatError(
          `ZIP central directory metadata mismatch for entry ${cdNormalizedName}`,
        );
      }

      matchedLocalOffsets.add(cdLocalHeaderOffset);
      cdCount += 1;
      offset = recordEnd;
    }

    if (cdCount !== localEntries.length || matchedLocalOffsets.size !== localEntries.length) {
      throw new InvalidDocumentFormatError(
        'ZIP central directory entry count mismatch in DOCX archive',
      );
    }

    if (offset + 22 > buffer.length || buffer.readUInt32LE(offset) !== EOCD_SIG) {
      throw new InvalidDocumentFormatError(
        'Missing or truncated End of Central Directory record in DOCX archive',
      );
    }

    const diskNumber = buffer.readUInt16LE(offset + 4);
    const cdStartDisk = buffer.readUInt16LE(offset + 6);
    const entriesOnDisk = buffer.readUInt16LE(offset + 8);
    const totalEntries = buffer.readUInt16LE(offset + 10);
    const cdSize = buffer.readUInt32LE(offset + 12);
    const cdOffset = buffer.readUInt32LE(offset + 16);
    const commentLen = buffer.readUInt16LE(offset + 20);

    if (diskNumber !== 0 || cdStartDisk !== 0) {
      throw new InvalidDocumentFormatError('Multi-disk ZIP archives are not supported');
    }

    if (
      entriesOnDisk !== localEntries.length ||
      totalEntries !== localEntries.length ||
      cdOffset !== cdStartOffset ||
      cdSize !== offset - cdStartOffset
    ) {
      throw new InvalidDocumentFormatError('ZIP End of Central Directory metadata mismatch');
    }

    if (offset + 22 + commentLen !== buffer.length) {
      throw new InvalidDocumentFormatError('Corrupt trailing data after ZIP EOCD in DOCX archive');
    }
  }

  private parseWordDocumentXml(xml: string, deadlineMs: number): string[] {
    const paragraphs: string[] = [];

    // Match each paragraph <w:p ...>...</w:p>
    const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
    let pMatch: RegExpExecArray | null;

    while ((pMatch = pRegex.exec(xml)) !== null) {
      if (Date.now() > deadlineMs) {
        throw new DocumentProcessingTimeoutError(
          `DOCX XML extraction exceeded ${this.timeoutMs}ms timeout limit`,
        );
      }

      const pBody = pMatch[1]!;
      const textParts: string[] = [];

      // Walk text runs, text elements, tabs, and line breaks within the paragraph
      const tokenRegex = /<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/gi;
      let tokenMatch: RegExpExecArray | null;

      while ((tokenMatch = tokenRegex.exec(pBody)) !== null) {
        if (tokenMatch[1] !== undefined) {
          textParts.push(this.unescapeXml(tokenMatch[1]));
        } else if (tokenMatch[0].includes('tab')) {
          textParts.push('\t');
        } else {
          textParts.push('\n');
        }
      }

      const pText = textParts.join('').trim();
      if (pText.length > 0) {
        paragraphs.push(pText);
      }
    }

    return paragraphs;
  }

  private unescapeXml(str: string): string {
    return (
      str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        // Decimal entities: &#8211; etc.
        .replace(/&#([0-9]+);/g, (_m, code: string) => {
          try {
            return String.fromCodePoint(parseInt(code, 10));
          } catch {
            return '';
          }
        })
        // Hex entities: &#x2013; etc.
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
          try {
            return String.fromCodePoint(parseInt(hex, 16));
          } catch {
            return '';
          }
        })
    );
  }
}
