import zlib from 'node:zlib';

import { InvalidDocumentFormatError, SecurityLimitExceededError } from './errors.js';
import type {
  DocumentParser,
  ExtractionQualityStatus,
  PagePosition,
  ParserResult,
  ResumeFileType,
} from './types.js';

export class PdfTextExtractor implements DocumentParser {
  public supports(fileType: ResumeFileType): boolean {
    return fileType === 'PDF';
  }

  public async parse(buffer: Buffer): Promise<ParserResult> {
    // 1. Signature check: must begin with %PDF-
    if (!buffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
      throw new InvalidDocumentFormatError('Missing PDF file signature (%PDF)');
    }

    // 2. Encryption check: reject encrypted documents safely with clear message
    if (this.isEncrypted(buffer)) {
      return {
        extractedText: '',
        pageMapJson: {
          encrypted: true,
          warning:
            'PDF document is password-protected or encrypted. Please upload an unencrypted document.',
        },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'FAILED',
        encrypted: true,
        warning: 'PDF document is password-protected or encrypted.',
      };
    }

    try {
      const pagePositions: PagePosition[] = [];
      const extractedPages: string[] = [];

      // Check for PDF 1.5+ Object Streams
      const hasObjectStreams = buffer.includes(Buffer.from('/ObjStm'));

      // Find all page objects in the PDF
      const pageObjectIndices = this.findPageObjects(buffer);

      if (pageObjectIndices.length === 0) {
        // Fallback: extract any content streams in the entire document
        const streamTexts = this.extractAllStreams(buffer);
        if (streamTexts.length > 0) {
          extractedPages.push(streamTexts.join('\n'));
          pagePositions.push({
            pageNumber: 1,
            startOffset: 0,
            endOffset: extractedPages[0]!.length,
            text: extractedPages[0]!,
          });
        }
      } else {
        let currentOffset = 0;
        for (let i = 0; i < pageObjectIndices.length; i += 1) {
          const pageObjNum = pageObjectIndices[i]!;
          const pageText = this.extractTextForPage(buffer, pageObjNum);
          extractedPages.push(pageText);

          const startOffset = currentOffset;
          const endOffset = currentOffset + pageText.length;
          pagePositions.push({
            pageNumber: i + 1,
            startOffset,
            endOffset,
            text: pageText,
          });

          // 2 newline separation between pages
          currentOffset = endOffset + 2;
        }
      }

      const fullText = extractedPages.join('\n\n').trim();

      // Check if scanned, object-stream-compressed without extracted text, or empty
      const isScannedOrEmpty = fullText.length === 0;
      const hasImages = buffer.includes(Buffer.from('/Image'));

      let warning: string | undefined;
      let qualityStatus: ExtractionQualityStatus = 'COMPLETE';

      if (isScannedOrEmpty) {
        qualityStatus = 'NEEDS_REVIEW';
        if (hasImages) {
          warning = 'Document appears to be a scanned image or photograph. OCR is required.';
        } else if (hasObjectStreams) {
          warning = 'Document uses PDF 1.5+ object stream compression without extractable text.';
        } else {
          warning = 'Document contains no readable text content.';
        }
      }

      const pageMapJson: Record<string, unknown> = {
        pageCount: Math.max(1, pagePositions.length),
        pages: pagePositions,
        ...(hasObjectStreams ? { objectStreams: true } : {}),
        ...(isScannedOrEmpty
          ? {
              scanned: hasImages,
              warning,
            }
          : {}),
      };

      return {
        extractedText: fullText,
        pageMapJson,
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus,
        warning,
        objectStreamsDetected: hasObjectStreams,
      };
    } catch (err: unknown) {
      if (err instanceof InvalidDocumentFormatError || err instanceof SecurityLimitExceededError) {
        throw err;
      }
      return {
        extractedText: '',
        pageMapJson: { error: 'Failed to parse PDF document structure' },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'FAILED',
      };
    }
  }

  private isEncrypted(buffer: Buffer): boolean {
    const text = buffer.toString('binary');
    // Match /Encrypt in dictionary trailer or root
    return /\/Encrypt\b/i.test(text);
  }

  private findPageObjects(buffer: Buffer): number[] {
    const pages: number[] = [];
    const text = buffer.toString('binary');
    // Match: N M obj << ... /Type /Page ... >> within a single object, excluding /Pages
    const pageRegex = /(\d+)\s+\d+\s+obj\b(?:(?!endobj)[\s\S])*?\/Type\s*\/Page\b(?!s)/gi;
    let match: RegExpExecArray | null;

    while ((match = pageRegex.exec(text)) !== null) {
      const objNum = parseInt(match[1]!, 10);
      if (!isNaN(objNum)) {
        pages.push(objNum);
      }
    }
    return pages;
  }

  private extractTextForPage(buffer: Buffer, pageObjNum: number): string {
    const text = buffer.toString('binary');

    // Find the page object definition
    const objRegex = new RegExp(`${pageObjNum}\\s+\\d+\\s+obj\\b([\\s\\S]*?)endobj`, 'i');
    const objMatch = objRegex.exec(text);
    if (!objMatch) return '';

    const pageBody = objMatch[1]!;

    // Extract Contents references: /Contents N 0 R or /Contents [N 0 R M 0 R]
    const contentsRefRegex = /\/Contents\s+(?:\[([\d\sR]+)\]|(\d+)\s+\d+\s+R)/i;
    const contentsMatch = contentsRefRegex.exec(pageBody);

    const streamObjNums: number[] = [];
    if (contentsMatch) {
      if (contentsMatch[2]) {
        streamObjNums.push(parseInt(contentsMatch[2], 10));
      } else if (contentsMatch[1]) {
        const refs = contentsMatch[1].match(/(\d+)\s+\d+\s+R/gi) ?? [];
        for (const ref of refs) {
          const m = /(\d+)\s+\d+\s+R/i.exec(ref);
          if (m && m[1]) streamObjNums.push(parseInt(m[1], 10));
        }
      }
    }

    const pageTexts: string[] = [];
    for (const streamObjNum of streamObjNums) {
      const streamText = this.extractStreamText(buffer, streamObjNum);
      if (streamText) pageTexts.push(streamText);
    }

    return pageTexts.join('\n').trim();
  }

  private extractStreamText(buffer: Buffer, streamObjNum: number): string {
    const text = buffer.toString('binary');
    const streamRegex = new RegExp(
      `${streamObjNum}\\s+\\d+\\s+obj\\b([\\s\\S]*?)stream\r?\n([\\s\\S]*?)\r?\nendstream`,
      'i',
    );
    const match = streamRegex.exec(text);
    if (!match) return '';

    const header = match[1]!;
    const streamRaw = Buffer.from(match[2]!, 'binary');

    let decompressed: Buffer = streamRaw;
    if (/\/Filter\s*\/FlateDecode/i.test(header)) {
      try {
        decompressed = zlib.inflateSync(streamRaw);
      } catch {
        try {
          decompressed = zlib.inflateRawSync(streamRaw);
        } catch {
          return '';
        }
      }
    }

    return this.parsePdfContentStream(decompressed);
  }

  private extractAllStreams(buffer: Buffer): string[] {
    const text = buffer.toString('binary');
    const streamRegex = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gi;
    const results: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = streamRegex.exec(text)) !== null) {
      const header = match[1]!;
      const raw = Buffer.from(match[2]!, 'binary');
      let decompressed = raw;

      if (/\/Filter\s*\/FlateDecode/i.test(header)) {
        try {
          decompressed = zlib.inflateSync(raw);
        } catch {
          try {
            decompressed = zlib.inflateRawSync(raw);
          } catch {
            continue;
          }
        }
      }

      const streamText = this.parsePdfContentStream(decompressed);
      if (streamText.trim()) results.push(streamText.trim());
    }

    return results;
  }

  private parsePdfContentStream(content: Buffer): string {
    const streamStr = content.toString('latin1');
    const lines: string[] = [];

    // Extract text from text blocks: BT ... ET
    const btRegex = /\bBT\b([\s\S]*?)\bET\b/gi;
    let btMatch: RegExpExecArray | null;

    while ((btMatch = btRegex.exec(streamStr)) !== null) {
      const block = btMatch[1]!;
      const blockLines: string[] = [];

      // Match string literals: (...) Tj, (...) '
      const tjRegex = /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g;
      let tjMatch: RegExpExecArray | null;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        blockLines.push(this.unescapePdfString(tjMatch[1]!));
      }

      // Match hex string literals: <...> Tj
      const hexTjRegex = /<([0-9A-Fa-f\s]+)>\s*(?:Tj|'|")/g;
      let hexMatch: RegExpExecArray | null;
      while ((hexMatch = hexTjRegex.exec(block)) !== null) {
        blockLines.push(this.decodePdfHexString(hexMatch[1]!));
      }

      // Match array text strings: [...] TJ
      const arrayTjRegex = /\[([\s\S]*?)\]\s*TJ/gi;
      let arrMatch: RegExpExecArray | null;
      while ((arrMatch = arrayTjRegex.exec(block)) !== null) {
        const elements = arrMatch[1]!;
        const partRegex = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g;
        let partMatch: RegExpExecArray | null;
        const words: string[] = [];
        while ((partMatch = partRegex.exec(elements)) !== null) {
          if (partMatch[1] !== undefined) {
            words.push(this.unescapePdfString(partMatch[1]));
          } else if (partMatch[2] !== undefined) {
            words.push(this.decodePdfHexString(partMatch[2]));
          }
        }
        if (words.length > 0) {
          blockLines.push(words.join(''));
        }
      }

      if (blockLines.length > 0) {
        lines.push(blockLines.join(' '));
      }
    }

    return lines.join('\n').trim();
  }

  private unescapePdfString(str: string): string {
    return str
      .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
        String.fromCharCode(parseInt(octal, 8)),
      )
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  private decodePdfHexString(hex: string): string {
    const clean = hex.replace(/\s+/g, '');
    let result = '';
    // Check for UTF-16BE BOM: FEFF
    if (clean.toUpperCase().startsWith('FEFF')) {
      for (let i = 4; i < clean.length; i += 4) {
        const charCode = parseInt(clean.substring(i, i + 4), 16);
        if (!isNaN(charCode)) result += String.fromCharCode(charCode);
      }
      return result;
    }
    for (let i = 0; i < clean.length; i += 2) {
      const byte = parseInt(clean.substring(i, i + 2), 16);
      if (!isNaN(byte)) result += String.fromCharCode(byte);
    }
    return result;
  }
}
