import zlib from 'node:zlib';

import { InvalidDocumentFormatError, SecurityLimitExceededError } from './errors.js';
import type {
  DocumentParser,
  ExtractionQualityStatus,
  ParagraphPosition,
  ParserResult,
  ResumeFileType,
} from './types.js';

export interface DocxExtractorOptions {
  maxUncompressedBytes?: number;
  maxEntries?: number;
  maxCompressionRatio?: number;
}

export class DocxTextExtractor implements DocumentParser {
  private readonly maxUncompressedBytes: number;
  private readonly maxEntries: number;
  private readonly maxCompressionRatio: number;

  constructor(options: DocxExtractorOptions = {}) {
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? 25 * 1024 * 1024; // 25 MB
    this.maxEntries = options.maxEntries ?? 500;
    this.maxCompressionRatio = options.maxCompressionRatio ?? 50; // Max 50:1 ratio
  }

  public supports(fileType: ResumeFileType): boolean {
    return fileType === 'DOCX';
  }

  public async parse(buffer: Buffer): Promise<ParserResult> {
    // 1. Signature check: ZIP local file header starts with PK\x03\x04
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new InvalidDocumentFormatError('Missing DOCX/ZIP signature (PK\\x03\\x04)');
    }

    try {
      const documentXml = this.extractWordDocumentXml(buffer);
      const paragraphs = this.parseWordDocumentXml(documentXml);

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
      if (err instanceof InvalidDocumentFormatError || err instanceof SecurityLimitExceededError) {
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

  private extractWordDocumentXml(buffer: Buffer): string {
    let offset = 0;
    let totalUncompressedBytes = 0;
    let entryCount = 0;
    let documentXmlContent: string | null = null;

    while (offset < buffer.length - 30) {
      const sig = buffer.readUInt32LE(offset);
      // Check for central directory header (0x02014b50) or end of central directory (0x06054b50)
      if (sig === 0x02014b50 || sig === 0x06054b50) {
        break;
      }
      if (sig !== 0x04034b50) {
        break;
      }

      entryCount += 1;
      if (entryCount > this.maxEntries) {
        throw new SecurityLimitExceededError(
          `Archive contains more than ${this.maxEntries} entries`,
        );
      }

      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const uncompressedSize = buffer.readUInt32LE(offset + 22);
      const nameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);

      // Ratio check to protect against zip bombs
      if (compressedSize > 0 && uncompressedSize / compressedSize > this.maxCompressionRatio) {
        throw new SecurityLimitExceededError('ZIP compression ratio exceeds safety threshold');
      }

      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > this.maxUncompressedBytes) {
        throw new SecurityLimitExceededError(
          `Uncompressed archive size exceeds ${Math.round(this.maxUncompressedBytes / (1024 * 1024))} MB limit`,
        );
      }

      const nameStart = offset + 30;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated entry name in DOCX archive');
      }

      const fileName = buffer.toString('utf8', nameStart, nameEnd);
      const dataStart = nameEnd + extraLength;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated entry data in DOCX archive');
      }

      if (fileName === 'word/document.xml' || fileName === 'word\\document.xml') {
        const rawData = buffer.subarray(dataStart, dataEnd);
        let decompressed: Buffer;

        if (compressionMethod === 0) {
          decompressed = rawData;
        } else if (compressionMethod === 8) {
          try {
            decompressed = zlib.inflateRawSync(rawData);
          } catch {
            throw new InvalidDocumentFormatError('Failed to decompress word/document.xml');
          }
        } else {
          throw new InvalidDocumentFormatError(
            `Unsupported compression method (${compressionMethod}) in DOCX archive`,
          );
        }

        documentXmlContent = decompressed.toString('utf8');
      }

      offset = dataEnd;
    }

    if (!documentXmlContent) {
      throw new InvalidDocumentFormatError('DOCX archive missing required word/document.xml entry');
    }

    return documentXmlContent;
  }

  private parseWordDocumentXml(xml: string): string[] {
    const paragraphs: string[] = [];

    // Match each paragraph <w:p ...>...</w:p>
    const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
    let pMatch: RegExpExecArray | null;

    while ((pMatch = pRegex.exec(xml)) !== null) {
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
