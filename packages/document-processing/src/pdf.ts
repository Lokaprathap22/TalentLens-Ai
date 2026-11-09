import { inflateBounded } from './decompress.js';
import {
  DocumentProcessingTimeoutError,
  EncryptedDocumentError,
  InvalidDocumentFormatError,
  SecurityLimitExceededError,
} from './errors.js';
import { assertPdfGeometryWithinLimitsAsync, type ImageDimensionLimits } from './image-limits.js';
import type {
  DocumentParser,
  ExtractionQualityStatus,
  OcrProvider,
  PagePosition,
  ParserResult,
  ResumeFileType,
} from './types.js';

export interface PdfExtractorOptions {
  maxFileSizeBytes?: number;
  maxDecompressedStreamBytes?: number;
  maxTotalDecompressedBytes?: number;
  maxPages?: number;
  maxStreams?: number;
  maxCompressionRatio?: number;
  maxImageWidth?: number;
  maxImageHeight?: number;
  maxImagePixels?: number;
  maxAggregateImagePixels?: number;
  pdfRasterDpi?: number;
  maxRasterDpi?: number;
  maxInspectedDictionaries?: number;
  maxInspectedObjects?: number;
  timeoutMs?: number;
}

interface PdfDecompressionState {
  totalDecompressedBytes: number;
  streamCount: number;
  deadlineMs: number;
}

export class PdfTextExtractor implements DocumentParser {
  private readonly maxFileSizeBytes: number;
  private readonly maxDecompressedStreamBytes: number;
  private readonly maxTotalDecompressedBytes: number;
  private readonly maxPages: number;
  private readonly maxStreams: number;
  private readonly maxCompressionRatio: number;
  private readonly maxInspectedObjects: number;
  private readonly imageLimits: ImageDimensionLimits;
  private readonly timeoutMs: number;

  constructor(
    private readonly ocrProvider?: OcrProvider,
    options: PdfExtractorOptions = {},
  ) {
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 25 * 1024 * 1024; // 25 MB
    this.maxDecompressedStreamBytes = options.maxDecompressedStreamBytes ?? 10 * 1024 * 1024; // 10 MB per stream
    this.maxTotalDecompressedBytes = options.maxTotalDecompressedBytes ?? 25 * 1024 * 1024; // 25 MB aggregate
    this.maxPages = options.maxPages ?? 200;
    this.maxStreams = options.maxStreams ?? 2000;
    this.maxCompressionRatio = options.maxCompressionRatio ?? 100;
    this.maxInspectedObjects = options.maxInspectedObjects ?? 25_000;
    this.imageLimits = {
      maxImageWidth: options.maxImageWidth ?? 10_000,
      maxImageHeight: options.maxImageHeight ?? 10_000,
      maxImagePixels: options.maxImagePixels ?? 25_000_000,
      maxAggregatePixels: options.maxAggregateImagePixels ?? 75_000_000,
      maxRenderedPages: 10,
      maxInputPages: this.maxPages,
      pdfRasterDpi: options.pdfRasterDpi ?? 150,
      maxRasterDpi: options.maxRasterDpi ?? 600,
      ...(options.maxInspectedDictionaries !== undefined
        ? { maxInspectedDictionaries: options.maxInspectedDictionaries }
        : {}),
      maxInspectedObjects: this.maxInspectedObjects,
    };
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public supports(fileType: ResumeFileType): boolean {
    return fileType === 'PDF';
  }

  public async parse(buffer: Buffer): Promise<ParserResult> {
    // 1. Signature check: must begin with %PDF-
    if (!buffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
      throw new InvalidDocumentFormatError('Missing PDF file signature (%PDF)');
    }

    if (buffer.length > this.maxFileSizeBytes) {
      throw new SecurityLimitExceededError(
        `PDF size ${buffer.length} bytes exceeds ${this.maxFileSizeBytes} byte security limit`,
      );
    }

    const deadlineMs = Date.now() + this.timeoutMs;
    this.checkDeadline(deadlineMs);

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
      const pdfText = buffer.toString('binary');
      this.checkDeadline(deadlineMs);

      // 3. Bound image dimensions, /ObjStm streams, and rendered page sizes before decoding content streams or OCR
      const geometry = await assertPdfGeometryWithinLimitsAsync(buffer, {
        ...this.imageLimits,
        maxDecompressedStreamBytes: this.maxDecompressedStreamBytes,
        maxTotalDecompressedBytes: this.maxTotalDecompressedBytes,
        maxStreams: this.maxStreams,
        maxCompressionRatio: this.maxCompressionRatio,
        deadlineMs,
      });

      // 4. Reject excessive declared page counts early
      this.assertDeclaredPageCountWithinLimit(pdfText);

      // 5. Index indirect PDF objects linearly and merge bounded /ObjStm expanded objects
      const objectsMap = this.indexPdfObjects(pdfText, deadlineMs);
      for (const [objNum, body] of geometry.objectBodies.entries()) {
        if (!objectsMap.has(objNum)) {
          objectsMap.set(objNum, body);
        }
      }
      if (objectsMap.size > this.maxInspectedObjects) {
        throw new SecurityLimitExceededError(
          `PDF object count exceeds maximum inspected limit of ${this.maxInspectedObjects}`,
        );
      }

      const pagePositions: PagePosition[] = [];
      const extractedPages: string[] = [];

      // Check for PDF 1.5+ Object Streams
      const hasObjectStreams = geometry.hasObjectStreams || buffer.includes(Buffer.from('/ObjStm'));

      // Find all page objects in the PDF (preserving catalog/tree page order when available)
      const pageObjectIndices =
        geometry.orderedPageObjNums.length > 0
          ? geometry.orderedPageObjNums
          : this.findPageObjects(objectsMap);
      if (pageObjectIndices.length > this.maxPages) {
        throw new SecurityLimitExceededError(
          `PDF contains ${pageObjectIndices.length} pages, exceeding ${this.maxPages} page limit`,
        );
      }

      const decompressionState: PdfDecompressionState = {
        totalDecompressedBytes: geometry.decompressedBytes,
        streamCount: geometry.streamCount,
        deadlineMs,
      };
      const visitedStreamObjNums = new Set<number>(geometry.expandedObjStmIds);

      if (pageObjectIndices.length === 0) {
        // Fallback: extract any content streams in the entire document
        const streamTexts = await this.extractAllStreams(pdfText, decompressionState);
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
          this.checkDeadline(deadlineMs);
          const pageObjNum = pageObjectIndices[i]!;
          const pageText = await this.extractTextForPage(
            objectsMap,
            pageObjNum,
            decompressionState,
            visitedStreamObjNums,
          );
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

        // Verify any remaining FlateDecode streams (e.g., XObjects or unreferenced objects) cannot bypass decompression bounds
        await this.verifyUnvisitedFlateStreams(
          objectsMap,
          visitedStreamObjNums,
          decompressionState,
        );
      }

      const fullText = extractedPages.join('\n\n').trim();

      // Check if scanned (no text layer) or image-dominant with sparse text (< 100 characters)
      const hasImages =
        buffer.includes(Buffer.from('/Image')) || buffer.includes(Buffer.from('/DCTDecode'));
      const isScannedOrEmpty = fullText.length === 0 || (hasImages && fullText.length < 100);

      let warning: string | undefined;
      let qualityStatus: ExtractionQualityStatus = 'COMPLETE';
      let ocrUsed = false;
      let finalExtractedText = fullText;

      if (isScannedOrEmpty) {
        if (this.ocrProvider && this.ocrProvider.supports(buffer)) {
          try {
            this.checkDeadline(deadlineMs);
            const ocrResult = await this.ocrProvider.extractText(buffer);
            if (
              ocrResult &&
              ocrResult.text.trim().length > 0 &&
              (ocrResult.confidence === undefined || ocrResult.confidence >= 0.5)
            ) {
              finalExtractedText = ocrResult.text.trim();
              ocrUsed = true;
              qualityStatus = ocrResult.isPartial ? 'NEEDS_REVIEW' : 'COMPLETE';
              if (ocrResult.isPartial) {
                warning = `Document has ${ocrResult.totalPages ?? 'multiple'} pages, exceeding the OCR processing limit. Partial OCR extraction performed on first ${ocrResult.pages?.length ?? 10} pages. Recruiter review required.`;
              }
              pagePositions.length = 0;
              if (ocrResult.pages && ocrResult.pages.length > 0) {
                for (const p of ocrResult.pages) {
                  pagePositions.push({
                    pageNumber: p.pageNumber,
                    startOffset: p.startOffset,
                    endOffset: p.endOffset,
                    text: p.text,
                  });
                }
              } else {
                pagePositions.push({
                  pageNumber: 1,
                  startOffset: 0,
                  endOffset: finalExtractedText.length,
                  text: finalExtractedText,
                });
              }
            } else {
              qualityStatus = 'NEEDS_REVIEW';
              finalExtractedText = ocrResult?.text.trim() || fullText;
              warning = hasImages
                ? 'Document appears to be a scanned image or photograph. OCR yielded low-confidence or sparse text.'
                : 'Document contains low-confidence or unreadable text content.';
            }
          } catch (err: unknown) {
            if (
              err instanceof SecurityLimitExceededError ||
              err instanceof DocumentProcessingTimeoutError ||
              err instanceof InvalidDocumentFormatError
            ) {
              throw err;
            }
            qualityStatus = 'NEEDS_REVIEW';
            ocrUsed = false;
            finalExtractedText = fullText;
            warning = 'OCR extraction failed. Recruiter review required.';
          }
        } else {
          qualityStatus = 'NEEDS_REVIEW';
          if (hasImages) {
            warning = 'Document appears to be a scanned image or photograph. OCR is required.';
          } else if (hasObjectStreams) {
            warning = 'Document uses PDF 1.5+ object stream compression without extractable text.';
          } else {
            warning = 'Document contains no readable text content.';
          }
        }
      }

      const pageMapJson: Record<string, unknown> = {
        pageCount: Math.max(1, pagePositions.length),
        pages: pagePositions,
        ...(hasObjectStreams ? { objectStreams: true } : {}),
        ...(isScannedOrEmpty
          ? {
              scanned: hasImages,
              ocrUsed,
              warning,
            }
          : {}),
      };

      return {
        extractedText: finalExtractedText,
        pageMapJson,
        parser: ocrUsed ? 'talentlens-pdf-ocr-v1' : 'talentlens-pdf-v1',
        ocrUsed,
        qualityStatus,
        warning,
        objectStreamsDetected: hasObjectStreams,
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
        pageMapJson: { error: 'Failed to parse PDF document structure' },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'FAILED',
      };
    }
  }

  private checkDeadline(deadlineMs: number): void {
    if (Date.now() > deadlineMs) {
      throw new DocumentProcessingTimeoutError(
        `PDF parsing exceeded ${this.timeoutMs}ms timeout limit`,
      );
    }
  }

  private isEncrypted(buffer: Buffer): boolean {
    const text = buffer.toString('binary');
    return /\/Encrypt\b/i.test(text);
  }

  private assertDeclaredPageCountWithinLimit(pdfText: string): void {
    const pagesCountRegex = /\/Type\s*\/Pages\b(?:(?!endobj)[\s\S])*?\/Count\s+(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = pagesCountRegex.exec(pdfText)) !== null) {
      const count = parseInt(match[1]!, 10);
      if (!isNaN(count) && count > this.maxPages) {
        throw new SecurityLimitExceededError(
          `PDF declares ${count} pages, exceeding ${this.maxPages} page limit`,
        );
      }
    }
  }

  private indexPdfObjects(pdfText: string, deadlineMs: number): Map<number, string> {
    const objects = new Map<number, string>();
    const headerRegex = /(\d+)\s+\d+\s+obj\b/g;
    let match: RegExpExecArray | null;
    let scanned = 0;

    while ((match = headerRegex.exec(pdfText)) !== null) {
      scanned += 1;
      if (scanned % 200 === 0) {
        this.checkDeadline(deadlineMs);
      }
      if (scanned > this.maxInspectedObjects) {
        throw new SecurityLimitExceededError(
          `PDF object count exceeds maximum inspected limit of ${this.maxInspectedObjects}`,
        );
      }

      const objNum = parseInt(match[1]!, 10);
      const bodyStart = match.index + match[0].length;
      const endObjIdx = pdfText.indexOf('endobj', bodyStart);
      if (endObjIdx === -1) {
        continue;
      }

      if (!isNaN(objNum) && !objects.has(objNum)) {
        objects.set(objNum, pdfText.slice(bodyStart, endObjIdx));
      }
      headerRegex.lastIndex = endObjIdx + 'endobj'.length;
    }

    return objects;
  }

  private findPageObjects(objectsMap: Map<number, string>): number[] {
    const pages: number[] = [];
    for (const [objNum, body] of objectsMap.entries()) {
      if (/\/Type\s*\/Page\b(?!s)/i.test(body)) {
        pages.push(objNum);
      }
    }
    return pages;
  }

  private extractStreamSegmentsFromBody(
    body: string,
  ): { header: string; rawData: Buffer; isFlate: boolean; isImage: boolean } | null {
    const streamKwRegex = /\bstream(?:\r\n|\n|\r)/;
    const streamKwMatch = streamKwRegex.exec(body);
    if (!streamKwMatch) return null;

    const header = body.slice(0, streamKwMatch.index);
    const dataStart = streamKwMatch.index + streamKwMatch[0].length;

    const endStreamIdx = body.indexOf('endstream', dataStart);
    if (endStreamIdx === -1) return null;

    let dataEnd = endStreamIdx;
    if (dataEnd >= dataStart + 2 && body[dataEnd - 2] === '\r' && body[dataEnd - 1] === '\n') {
      dataEnd -= 2;
    } else if (
      dataEnd >= dataStart + 1 &&
      (body[dataEnd - 1] === '\n' || body[dataEnd - 1] === '\r')
    ) {
      dataEnd -= 1;
    }

    const rawData = Buffer.from(body.slice(dataStart, dataEnd), 'binary');
    const isFlate = /\/Filter\s*(?:\[[^\]]*)?\/FlateDecode\b/i.test(header);
    const isImage = /\/Subtype\s*\/Image\b/i.test(header);
    return { header, rawData, isFlate, isImage };
  }

  private hasOnlyFlateFilter(header: string): boolean {
    return (
      /\/Filter\s*(?:\[\s*)?\/FlateDecode\b/i.test(header) &&
      !/\/(?:ASCII85Decode|ASCIIHexDecode|LZWDecode|RunLengthDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/i.test(
        header,
      )
    );
  }

  private async inflatePdfStreamBounded(
    raw: Buffer,
    state: PdfDecompressionState,
    retainOutput: boolean,
    label: string,
    strictFlateErrors: boolean,
  ): Promise<Buffer | null> {
    this.checkDeadline(state.deadlineMs);

    state.streamCount += 1;
    if (state.streamCount > this.maxStreams) {
      throw new SecurityLimitExceededError(`PDF contains more than ${this.maxStreams} streams`);
    }

    const remainingTotal = this.maxTotalDecompressedBytes - state.totalDecompressedBytes;
    const budget = Math.min(this.maxDecompressedStreamBytes, remainingTotal);
    if (budget <= 0 && raw.length > 0) {
      throw new SecurityLimitExceededError(
        `Total PDF decompressed stream bytes exceed ${this.maxTotalDecompressedBytes} byte limit`,
      );
    }

    let result;
    try {
      result = await inflateBounded(raw, {
        mode: 'zlib',
        maxOutputBytes: budget,
        maxCompressionRatio: this.maxCompressionRatio,
        ratioMinOutputBytes: 512,
        deadlineMs: state.deadlineMs,
        retainOutput,
        entryLabel: label,
      });
    } catch (zlibErr: unknown) {
      if (
        zlibErr instanceof SecurityLimitExceededError ||
        zlibErr instanceof DocumentProcessingTimeoutError
      ) {
        throw zlibErr;
      }
      // Retry as raw DEFLATE only when standard zlib header failed
      try {
        result = await inflateBounded(raw, {
          mode: 'raw',
          maxOutputBytes: budget,
          maxCompressionRatio: this.maxCompressionRatio,
          ratioMinOutputBytes: 512,
          deadlineMs: state.deadlineMs,
          retainOutput,
          entryLabel: label,
        });
      } catch (rawErr: unknown) {
        if (
          rawErr instanceof SecurityLimitExceededError ||
          rawErr instanceof DocumentProcessingTimeoutError
        ) {
          throw rawErr;
        }
        if (strictFlateErrors) {
          throw new InvalidDocumentFormatError(`Malformed FlateDecode stream in PDF (${label})`);
        }
        return null;
      }
    }

    state.totalDecompressedBytes += result.bytesOut;
    if (state.totalDecompressedBytes > this.maxTotalDecompressedBytes) {
      throw new SecurityLimitExceededError(
        `Total PDF decompressed stream bytes exceed ${this.maxTotalDecompressedBytes} byte limit`,
      );
    }

    return result.buffer;
  }

  private async extractTextForPage(
    objectsMap: Map<number, string>,
    pageObjNum: number,
    state: PdfDecompressionState,
    visitedStreamObjNums: Set<number>,
  ): Promise<string> {
    const pageBody = objectsMap.get(pageObjNum);
    if (!pageBody) return '';

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
      visitedStreamObjNums.add(streamObjNum);
      const streamText = await this.extractStreamText(objectsMap, streamObjNum, state);
      if (streamText) pageTexts.push(streamText);
    }

    return pageTexts.join('\n').trim();
  }

  private async extractStreamText(
    objectsMap: Map<number, string>,
    streamObjNum: number,
    state: PdfDecompressionState,
  ): Promise<string> {
    const objBody = objectsMap.get(streamObjNum);
    if (!objBody) return '';

    const seg = this.extractStreamSegmentsFromBody(objBody);
    if (!seg) return '';

    let decompressed: Buffer = seg.rawData;
    if (seg.isFlate) {
      const strict = !seg.isImage && this.hasOnlyFlateFilter(seg.header);
      const inflated = await this.inflatePdfStreamBounded(
        seg.rawData,
        state,
        true,
        `object ${streamObjNum}`,
        strict,
      );
      if (!inflated) return '';
      decompressed = inflated;
    }

    return this.parsePdfContentStream(decompressed);
  }

  private async verifyUnvisitedFlateStreams(
    objectsMap: Map<number, string>,
    visitedStreamObjNums: Set<number>,
    state: PdfDecompressionState,
  ): Promise<void> {
    for (const [objNum, body] of objectsMap.entries()) {
      if (visitedStreamObjNums.has(objNum)) continue;
      const seg = this.extractStreamSegmentsFromBody(body);
      if (!seg || !seg.isFlate) continue;

      const strict = !seg.isImage && this.hasOnlyFlateFilter(seg.header);
      await this.inflatePdfStreamBounded(seg.rawData, state, false, `object ${objNum}`, strict);
    }
  }

  private async extractAllStreams(
    pdfText: string,
    state: PdfDecompressionState,
  ): Promise<string[]> {
    const results: string[] = [];
    const headerStreamRegex = /<<([\s\S]*?)>>\s*stream(?:\r\n|\n|\r)/gi;
    let match: RegExpExecArray | null;
    let streamIndex = 0;

    while ((match = headerStreamRegex.exec(pdfText)) !== null) {
      this.checkDeadline(state.deadlineMs);
      streamIndex += 1;

      const header = match[1]!;
      const dataStart = match.index + match[0].length;
      const endStreamIdx = pdfText.indexOf('endstream', dataStart);
      if (endStreamIdx === -1) break;

      let dataEnd = endStreamIdx;
      if (
        dataEnd >= dataStart + 2 &&
        pdfText[dataEnd - 2] === '\r' &&
        pdfText[dataEnd - 1] === '\n'
      ) {
        dataEnd -= 2;
      } else if (
        dataEnd >= dataStart + 1 &&
        (pdfText[dataEnd - 1] === '\n' || pdfText[dataEnd - 1] === '\r')
      ) {
        dataEnd -= 1;
      }

      headerStreamRegex.lastIndex = endStreamIdx + 'endstream'.length;

      const raw = Buffer.from(pdfText.slice(dataStart, dataEnd), 'binary');
      const isObjStm = /\/Type\s*\/ObjStm\b/i.test(header);
      if (isObjStm) continue;
      const isFlate = /\/Filter\s*(?:\[[^\]]*)?\/FlateDecode\b/i.test(header);
      const isImage = /\/Subtype\s*\/Image\b/i.test(header);

      let decompressed: Buffer = raw;
      if (isFlate) {
        const strict = !isImage && this.hasOnlyFlateFilter(header);
        const inflated = await this.inflatePdfStreamBounded(
          raw,
          state,
          !isImage,
          `stream ${streamIndex}`,
          strict,
        );
        if (!inflated) continue;
        decompressed = inflated;
      }

      if (!isImage) {
        const streamText = this.parsePdfContentStream(decompressed);
        if (streamText.trim()) results.push(streamText.trim());
      }
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
