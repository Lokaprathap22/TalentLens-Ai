import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DocumentProcessingTimeoutError,
  InvalidDocumentFormatError,
  OcrRuntimeUnavailableError,
  SecurityLimitExceededError,
} from './errors.js';
import {
  assertPdfGeometryWithinLimitsAsync,
  assertPixelDimensionsWithinLimits,
  assertRasterImageBufferWithinLimits,
  type ImageDimensionLimits,
  type PdfGeometryValidationResult,
} from './image-limits.js';
import type { OcrPage, OcrProvider, OcrResult } from './types.js';

const execFileAsync = promisify(execFile);

export type OcrExecCommand = (
  file: string,
  args: readonly string[],
  options: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TesseractOcrProviderOptions {
  tesseractPath?: string;
  pdftoppmPath?: string;
  pdfinfoPath?: string;
  maxFileSizeBytes?: number;
  maxPages?: number;
  maxInputPages?: number;
  maxImageWidth?: number;
  maxImageHeight?: number;
  maxImagePixels?: number;
  maxAggregatePixels?: number;
  maxTotalRasterBytes?: number;
  pdfRasterDpi?: number;
  maxRasterDpi?: number;
  maxInspectedDictionaries?: number;
  maxInspectedObjects?: number;
  maxDecompressedStreamBytes?: number;
  maxTotalDecompressedBytes?: number;
  maxStreams?: number;
  maxCompressionRatio?: number;
  timeoutMs?: number;
  pageTimeoutMs?: number;
  language?: string;
  execCommand?: OcrExecCommand;
}

export class TesseractOcrProvider implements OcrProvider {
  private readonly tesseractPath: string;
  private readonly pdftoppmPath: string;
  private readonly pdfinfoPath: string;
  private readonly maxFileSizeBytes: number;
  private readonly maxPages: number;
  private readonly maxInputPages: number;
  private readonly maxAggregatePixels: number;
  private readonly maxTotalRasterBytes: number;
  private readonly pdfRasterDpi: number;
  private readonly maxDecompressedStreamBytes: number;
  private readonly maxTotalDecompressedBytes: number;
  private readonly maxStreams: number;
  private readonly maxCompressionRatio: number;
  private readonly imageLimits: ImageDimensionLimits;
  private readonly timeoutMs: number;
  private readonly pageTimeoutMs: number;
  private readonly language: string;
  private readonly execCommand: OcrExecCommand;
  private cachedAvailability: boolean | null = null;

  constructor(options: TesseractOcrProviderOptions = {}) {
    this.tesseractPath = options.tesseractPath ?? process.env['TESSERACT_PATH'] ?? 'tesseract';
    this.pdftoppmPath = options.pdftoppmPath ?? process.env['PDFTOPPM_PATH'] ?? 'pdftoppm';
    this.pdfinfoPath = options.pdfinfoPath ?? process.env['PDFINFO_PATH'] ?? 'pdfinfo';
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 15 * 1024 * 1024; // 15 MB limit
    this.maxPages = options.maxPages ?? 10; // Up to 10 pages rasterized for OCR
    this.maxInputPages = options.maxInputPages ?? 200;
    this.maxAggregatePixels = options.maxAggregatePixels ?? 75_000_000;
    this.maxTotalRasterBytes = options.maxTotalRasterBytes ?? 50 * 1024 * 1024; // 50 MB raster budget
    this.pdfRasterDpi = options.pdfRasterDpi ?? 150;
    this.maxDecompressedStreamBytes = options.maxDecompressedStreamBytes ?? 10 * 1024 * 1024;
    this.maxTotalDecompressedBytes = options.maxTotalDecompressedBytes ?? 25 * 1024 * 1024;
    this.maxStreams = options.maxStreams ?? 2000;
    this.maxCompressionRatio = options.maxCompressionRatio ?? 100;
    this.imageLimits = {
      maxImageWidth: options.maxImageWidth ?? 10_000,
      maxImageHeight: options.maxImageHeight ?? 10_000,
      maxImagePixels: options.maxImagePixels ?? 25_000_000,
      maxAggregatePixels: this.maxAggregatePixels,
      maxRenderedPages: this.maxPages,
      maxInputPages: this.maxInputPages,
      pdfRasterDpi: this.pdfRasterDpi,
      maxRasterDpi: options.maxRasterDpi ?? 600,
      ...(options.maxInspectedDictionaries !== undefined
        ? { maxInspectedDictionaries: options.maxInspectedDictionaries }
        : {}),
      ...(options.maxInspectedObjects !== undefined
        ? { maxInspectedObjects: options.maxInspectedObjects }
        : {}),
    };
    this.timeoutMs = options.timeoutMs ?? 30_000; // 30 second timeout per document
    this.pageTimeoutMs = options.pageTimeoutMs ?? 15_000; // 15 second cap per page
    this.language = options.language ?? 'eng';
    this.execCommand =
      options.execCommand ?? ((file, args, opts) => execFileAsync(file, [...args], opts));
  }

  public supports(buffer: Buffer): boolean {
    if (!buffer || buffer.length === 0) return false;
    // PDF signature
    if (buffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
      return true;
    }
    // PNG signature
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer.subarray(1, 4).toString('ascii') === 'PNG'
    ) {
      return true;
    }
    // JPEG signature
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return true;
    }
    // TIFF signatures
    if (
      buffer.length >= 4 &&
      ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
    ) {
      return true;
    }
    return false;
  }

  /**
   * Probes whether the required system binaries (tesseract and pdftoppm) and language data are installed and executable.
   */
  public async isAvailable(): Promise<boolean> {
    if (this.cachedAvailability !== null) {
      return this.cachedAvailability;
    }

    try {
      await this.execCommand(this.tesseractPath, ['--version'], { timeout: 3000 });
      await this.execCommand(this.pdftoppmPath, ['-v'], { timeout: 3000 });
      const { stdout: langsStdout } = await this.execCommand(this.tesseractPath, ['--list-langs'], {
        timeout: 3000,
      });
      const langs = langsStdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!langs.includes(this.language)) {
        this.cachedAvailability = false;
        return false;
      }
      this.cachedAvailability = true;
      return true;
    } catch {
      this.cachedAvailability = false;
      return false;
    }
  }

  public async extractText(buffer: Buffer): Promise<OcrResult | null> {
    if (buffer.length > this.maxFileSizeBytes) {
      throw new SecurityLimitExceededError(
        `Document of size ${buffer.length} bytes exceeds maximum OCR processing limit of ${this.maxFileSizeBytes} bytes`,
      );
    }

    const validationDeadlineMs = Date.now() + this.timeoutMs;
    const isPdf = buffer.subarray(0, 5).toString('ascii').startsWith('%PDF');
    let pdfGeometry: PdfGeometryValidationResult | null = null;
    if (isPdf) {
      pdfGeometry = await assertPdfGeometryWithinLimitsAsync(buffer, {
        ...this.imageLimits,
        maxDecompressedStreamBytes: this.maxDecompressedStreamBytes,
        maxTotalDecompressedBytes: this.maxTotalDecompressedBytes,
        maxStreams: this.maxStreams,
        maxCompressionRatio: this.maxCompressionRatio,
        deadlineMs: validationDeadlineMs,
      });
    } else if (this.supports(buffer)) {
      assertRasterImageBufferWithinLimits(buffer, this.imageLimits, 'OCR input image');
    }

    const available = await this.isAvailable();
    if (!available) {
      // In development or environments without tesseract, report honest unavailable status
      return null;
    }

    const tempDir = path.join(os.tmpdir(), `talentlens-ocr-${randomUUID()}`);
    const deadlineMs = Date.now() + this.timeoutMs;

    try {
      await fs.promises.mkdir(tempDir, { recursive: true });

      if (isPdf) {
        return await this.processPdf(buffer, tempDir, deadlineMs, pdfGeometry);
      } else {
        return await this.processImage(buffer, tempDir, deadlineMs);
      }
    } finally {
      // Guaranteed cleanup of all temporary rasterized files
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  private getRemainingTimeoutMs(deadlineMs: number, capMs?: number): number {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      throw new DocumentProcessingTimeoutError(
        `OCR processing exceeded cumulative timeout budget of ${this.timeoutMs}ms`,
      );
    }
    return capMs !== undefined ? Math.min(capMs, remaining) : remaining;
  }

  private isSubprocessTimeoutError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const record = err as {
      killed?: boolean;
      signal?: string | null;
      code?: string | number | null;
      message?: string;
    };
    return (
      Boolean(record.killed) ||
      record.signal === 'SIGTERM' ||
      record.code === 'ETIMEDOUT' ||
      (typeof record.message === 'string' && record.message.includes('ETIMEDOUT'))
    );
  }

  private validatePdfinfoGeometryOutput(
    stdout: string,
    expectedTotalPages: number,
    requireAllPages = false,
  ): void {
    interface PopplerBox {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    }
    interface PopplerPageMetrics {
      sizeW?: number;
      sizeH?: number;
      mediaBox?: PopplerBox;
      cropBox?: PopplerBox;
      rot: number;
    }

    const dpi = this.pdfRasterDpi;
    const pages = new Map<number, PopplerPageMetrics>();
    const getOrCreatePage = (pageNum: number): PopplerPageMetrics => {
      let entry = pages.get(pageNum);
      if (!entry) {
        entry = { rot: 0 };
        pages.set(pageNum, entry);
      }
      return entry;
    };

    const numberedSizeRegex = /^Page\s+(\d+)\s+size:\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/gm;
    let match: RegExpExecArray | null;
    while ((match = numberedSizeRegex.exec(stdout)) !== null) {
      const pageNum = parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(pageNum) || pageNum <= 0) continue;
      const entry = getOrCreatePage(pageNum);
      entry.sizeW = parseFloat(match[2]!);
      entry.sizeH = parseFloat(match[3]!);
    }

    const numberedRotRegex = /^Page\s+(\d+)\s+rot:\s*(-?\d+)/gm;
    while ((match = numberedRotRegex.exec(stdout)) !== null) {
      const pageNum = parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(pageNum) || pageNum <= 0) continue;
      const rawRot = parseInt(match[2]!, 10);
      if (Number.isSafeInteger(rawRot)) {
        const entry = getOrCreatePage(pageNum);
        entry.rot = ((rawRot % 360) + 360) % 360;
      }
    }

    const boxRegex =
      /^Page\s+(\d+)\s+(MediaBox|CropBox):\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)/gm;
    while ((match = boxRegex.exec(stdout)) !== null) {
      const pageNum = parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(pageNum) || pageNum <= 0) continue;
      const x1 = parseFloat(match[3]!);
      const y1 = parseFloat(match[4]!);
      const x2 = parseFloat(match[5]!);
      const y2 = parseFloat(match[6]!);
      const box: PopplerBox = {
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
      };
      const entry = getOrCreatePage(pageNum);
      if (match[2] === 'MediaBox') entry.mediaBox = box;
      else entry.cropBox = box;
    }

    let pdfinfoAggregatePixels = 0n;

    if (pages.size > 0) {
      if (pages.size < expectedTotalPages) {
        throw new InvalidDocumentFormatError(
          `Incomplete pdfinfo page geometry inspection: expected ${expectedTotalPages} pages, inspected ${pages.size}`,
        );
      }
      const sortedPageNums = [...pages.keys()].sort((a, b) => a - b);
      for (const pageNum of sortedPageNums) {
        const m = pages.get(pageNum)!;
        let widthPts = m.sizeW;
        let heightPts = m.sizeH;

        if (m.mediaBox && m.cropBox) {
          const minX = Math.max(m.mediaBox.minX, m.cropBox.minX);
          const maxX = Math.min(m.mediaBox.maxX, m.cropBox.maxX);
          const minY = Math.max(m.mediaBox.minY, m.cropBox.minY);
          const maxY = Math.min(m.mediaBox.maxY, m.cropBox.maxY);
          if (maxX <= minX || maxY <= minY) {
            throw new InvalidDocumentFormatError(
              `PDF page ${pageNum} has empty CropBox/MediaBox intersection`,
            );
          }
          widthPts = maxX - minX;
          heightPts = maxY - minY;
        } else if (m.cropBox) {
          widthPts = m.cropBox.maxX - m.cropBox.minX;
          heightPts = m.cropBox.maxY - m.cropBox.minY;
        } else if (m.mediaBox) {
          widthPts = m.mediaBox.maxX - m.mediaBox.minX;
          heightPts = m.mediaBox.maxY - m.mediaBox.minY;
        }

        if (widthPts === undefined || heightPts === undefined) continue;

        let renderedWidth = Math.ceil((widthPts * dpi) / 72);
        let renderedHeight = Math.ceil((heightPts * dpi) / 72);
        if (m.rot === 90 || m.rot === 270) {
          [renderedWidth, renderedHeight] = [renderedHeight, renderedWidth];
        }

        assertPixelDimensionsWithinLimits(
          renderedWidth,
          renderedHeight,
          this.imageLimits,
          `PDF page ${pageNum} dimensions`,
        );

        if (pageNum <= this.maxPages) {
          pdfinfoAggregatePixels += BigInt(renderedWidth) * BigInt(renderedHeight);
          if (pdfinfoAggregatePixels > BigInt(this.maxAggregatePixels)) {
            throw new SecurityLimitExceededError(
              `PDF aggregate rendered pixel count (${pdfinfoAggregatePixels.toString()}) exceeds maximum allowed ${this.maxAggregatePixels} pixels`,
            );
          }
        }
      }
      return;
    }

    // Fallback for single-page unnumbered "Page size: W x H" + optional "Page rot: R" output
    const unnumberedRotMatch = /^Page\s+rot:\s*(-?\d+)/m.exec(stdout);
    const unnumberedRawRot = unnumberedRotMatch?.[1] ? parseInt(unnumberedRotMatch[1], 10) : 0;
    const unnumberedRot = Number.isSafeInteger(unnumberedRawRot)
      ? ((unnumberedRawRot % 360) + 360) % 360
      : 0;

    const unnumberedSizeRegex = /^Page\s+size:\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/gm;
    let sizeCount = 0;
    while ((match = unnumberedSizeRegex.exec(stdout)) !== null) {
      if (match[1] && match[2]) {
        sizeCount += 1;
        let renderedWidth = Math.ceil((parseFloat(match[1]) * dpi) / 72);
        let renderedHeight = Math.ceil((parseFloat(match[2]) * dpi) / 72);
        if (unnumberedRot === 90 || unnumberedRot === 270) {
          [renderedWidth, renderedHeight] = [renderedHeight, renderedWidth];
        }
        assertPixelDimensionsWithinLimits(
          renderedWidth,
          renderedHeight,
          this.imageLimits,
          'PDF page dimensions',
        );
        if (sizeCount <= this.maxPages) {
          pdfinfoAggregatePixels += BigInt(renderedWidth) * BigInt(renderedHeight);
        }
      }
    }

    if (requireAllPages && sizeCount === 0) {
      throw new InvalidDocumentFormatError(
        `Incomplete pdfinfo page geometry inspection: expected ${expectedTotalPages} pages, inspected 0`,
      );
    }

    if (sizeCount > 0 && pdfinfoAggregatePixels > BigInt(this.maxAggregatePixels)) {
      throw new SecurityLimitExceededError(
        `PDF aggregate rendered pixel count (${pdfinfoAggregatePixels.toString()}) exceeds maximum allowed ${this.maxAggregatePixels} pixels`,
      );
    }
  }

  private async runPdfinfoChecked(args: readonly string[], deadlineMs: number): Promise<string> {
    const pdfinfoTimeoutMs = this.getRemainingTimeoutMs(deadlineMs, 5000);
    try {
      const { stdout } = await this.execCommand(this.pdfinfoPath, args, {
        timeout: pdfinfoTimeoutMs,
      });
      return stdout;
    } catch (err: unknown) {
      if (
        err instanceof SecurityLimitExceededError ||
        err instanceof DocumentProcessingTimeoutError ||
        err instanceof InvalidDocumentFormatError ||
        err instanceof OcrRuntimeUnavailableError
      ) {
        throw err;
      }
      if (this.isSubprocessTimeoutError(err)) {
        throw new DocumentProcessingTimeoutError(
          `OCR processing exceeded cumulative timeout budget of ${this.timeoutMs}ms during pdfinfo inspection`,
        );
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (errCode === 'ENOENT' || errMsg.includes('ENOENT')) {
        throw new OcrRuntimeUnavailableError(
          `pdfinfo utility is not installed at ${this.pdfinfoPath}. Install poppler-utils.`,
        );
      }
      throw new InvalidDocumentFormatError(
        `Failed to inspect PDF geometry with pdfinfo: ${errMsg}`,
      );
    }
  }

  private async inspectPdfWithPoppler(
    inputPdfPath: string,
    pdfGeometry: PdfGeometryValidationResult | null,
    deadlineMs: number,
  ): Promise<number> {
    const baseStdout = await this.runPdfinfoChecked([inputPdfPath], deadlineMs);

    const pagesMatch = /^Pages:\s*(\d+)/m.exec(baseStdout);
    if (!pagesMatch?.[1]) {
      throw new InvalidDocumentFormatError('pdfinfo did not report a valid PDF page count');
    }
    const totalPages = parseInt(pagesMatch[1], 10);
    if (!Number.isSafeInteger(totalPages) || totalPages <= 0) {
      throw new InvalidDocumentFormatError(
        `pdfinfo reported invalid PDF page count: ${pagesMatch[1]}`,
      );
    }

    // Validate immediately on step 1 output (before any multi-page -box command)
    this.validatePdfinfoGeometryOutput(baseStdout, totalPages);

    if (totalPages > this.maxInputPages) {
      throw new SecurityLimitExceededError(
        `PDF contains ${totalPages} pages, exceeding maximum OCR input limit of ${this.maxInputPages} pages`,
      );
    }

    if (pdfGeometry) {
      if (pdfGeometry.totalPages > 0 && totalPages > pdfGeometry.totalPages) {
        throw new InvalidDocumentFormatError(
          `Inconsistent PDF page count: structural inspection found ${pdfGeometry.totalPages} page(s) while pdfinfo reported ${totalPages}`,
        );
      }
      if (
        pdfGeometry.hasObjectStreams &&
        pdfGeometry.resolvedLeafPageCount > 0 &&
        totalPages !== pdfGeometry.resolvedLeafPageCount
      ) {
        throw new InvalidDocumentFormatError(
          `Inconsistent PDF /ObjStm page count: structural inspection found ${pdfGeometry.resolvedLeafPageCount} page(s) while pdfinfo reported ${totalPages}`,
        );
      }
    }

    // Run per-page -box inspection across all 1..totalPages whenever multi-page or real Poppler output lacks -box
    const isRealPopplerWithoutBox =
      !/^Page(?:\s+1)?\s+CropBox:/m.test(baseStdout) &&
      (/PDF version:|Custom Metadata:/i.test(baseStdout) || totalPages > 1);

    if (isRealPopplerWithoutBox) {
      const boxStdout = await this.runPdfinfoChecked(
        ['-f', '1', '-l', String(totalPages), '-box', inputPdfPath],
        deadlineMs,
      );
      const hasRealPopplerMeta = /PDF version:|Custom Metadata:/i.test(boxStdout);
      this.validatePdfinfoGeometryOutput(boxStdout, totalPages, hasRealPopplerMeta);
    }

    return totalPages;
  }

  private async processPdf(
    buffer: Buffer,
    tempDir: string,
    deadlineMs: number,
    pdfGeometry: PdfGeometryValidationResult | null,
  ): Promise<OcrResult> {
    const inputPdfPath = path.join(tempDir, 'input.pdf');
    await fs.promises.writeFile(inputPdfPath, buffer);

    const totalPages = await this.inspectPdfWithPoppler(inputPdfPath, pdfGeometry, deadlineMs);
    if (totalPages > this.maxInputPages) {
      throw new SecurityLimitExceededError(
        `PDF contains ${totalPages} pages, exceeding maximum OCR input limit of ${this.maxInputPages} pages`,
      );
    }
    const isPartial = totalPages > this.maxPages;

    const pagePrefix = path.join(tempDir, 'page');

    // 1. Rasterize PDF pages using pdftoppm within remaining cumulative timeout budget
    // Use -cropbox to match intersected CropBox/MediaBox geometry validation.
    const rasterizeTimeoutMs = this.getRemainingTimeoutMs(deadlineMs);
    try {
      await this.execCommand(
        this.pdftoppmPath,
        [
          '-png',
          '-cropbox',
          '-r',
          String(this.pdfRasterDpi),
          '-f',
          '1',
          '-l',
          String(this.maxPages),
          inputPdfPath,
          pagePrefix,
        ],
        { timeout: rasterizeTimeoutMs },
      );
    } catch (err: unknown) {
      if (this.isSubprocessTimeoutError(err)) {
        throw new DocumentProcessingTimeoutError(
          `OCR processing exceeded cumulative timeout budget of ${this.timeoutMs}ms during PDF rasterization`,
        );
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('ENOENT')) {
        throw new OcrRuntimeUnavailableError(
          `pdftoppm utility is not installed at ${this.pdftoppmPath}. Install poppler-utils.`,
        );
      }
      throw new InvalidDocumentFormatError(`Failed to rasterize PDF for OCR: ${errMsg}`);
    }

    // 2. Discover generated page images and enforce per-page, aggregate pixel, and raster byte budgets before OCR
    const files = await fs.promises.readdir(tempDir);
    const pageImageFiles = files
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pageImageFiles.length > this.maxPages) {
      throw new SecurityLimitExceededError(
        `Rasterized page count (${pageImageFiles.length}) exceeds maximum OCR page limit of ${this.maxPages}`,
      );
    }

    let totalRasterBytes = 0;
    let aggregateRenderedPixels = 0n;

    for (const imageFile of pageImageFiles) {
      const imagePath = path.join(tempDir, imageFile);
      const stat = await fs.promises.stat(imagePath);
      totalRasterBytes += stat.size;
      if (totalRasterBytes > this.maxTotalRasterBytes) {
        throw new SecurityLimitExceededError(
          `Aggregate rasterized PNG bytes (${totalRasterBytes}) exceed maximum allowed ${this.maxTotalRasterBytes} bytes`,
        );
      }

      const fh = await fs.promises.open(imagePath, 'r');
      try {
        const headerBuf = Buffer.alloc(64);
        const { bytesRead } = await fh.read(headerBuf, 0, 64, 0);
        const dims = assertRasterImageBufferWithinLimits(
          headerBuf.subarray(0, bytesRead),
          this.imageLimits,
          `Rasterized PDF page ${imageFile}`,
        );
        if (dims) {
          aggregateRenderedPixels += BigInt(dims.width) * BigInt(dims.height);
          if (aggregateRenderedPixels > BigInt(this.maxAggregatePixels)) {
            throw new SecurityLimitExceededError(
              `Aggregate rasterized PDF pixel count (${aggregateRenderedPixels.toString()}) exceeds maximum allowed ${this.maxAggregatePixels} pixels`,
            );
          }
        }
      } finally {
        await fh.close();
      }
    }

    if (pageImageFiles.length === 0) {
      return {
        text: '',
        confidence: 0,
        engine: 'tesseract-5.x',
        pages: [],
        totalPages,
        isPartial,
      };
    }

    // 3. Run Tesseract on each page image and extract text + word confidence + page offsets
    const pages: OcrPage[] = [];
    const pageTexts: string[] = [];
    let currentOffset = 0;
    let totalConfidenceSum = 0;
    let totalWordCount = 0;

    for (let i = 0; i < pageImageFiles.length; i++) {
      const pageTimeoutMs = this.getRemainingTimeoutMs(deadlineMs, this.pageTimeoutMs);
      const imageFile = pageImageFiles[i]!;
      const imagePath = path.join(tempDir, imageFile);
      const pageNumber = i + 1;
      const { text, confidence, wordCount } = await this.runTesseractOnImage(
        imagePath,
        pageTimeoutMs,
        pageNumber,
      );
      const trimmedText = text.trim();
      const roundedConfidence = Number(confidence.toFixed(2));

      if (trimmedText.length > 0) {
        const startOffset = pageTexts.length > 0 ? currentOffset + 2 : currentOffset;
        const endOffset = startOffset + trimmedText.length;

        pages.push({
          pageNumber,
          text: trimmedText,
          confidence: roundedConfidence,
          startOffset,
          endOffset,
        });

        pageTexts.push(trimmedText);
        currentOffset = endOffset;
      } else {
        pages.push({
          pageNumber,
          text: '',
          confidence: roundedConfidence,
          startOffset: currentOffset,
          endOffset: currentOffset,
        });
      }

      totalConfidenceSum += confidence * wordCount;
      totalWordCount += wordCount;
    }

    const meanConfidence =
      totalWordCount > 0 ? Math.min(1, Math.max(0, totalConfidenceSum / totalWordCount)) : 0;

    return {
      text: pageTexts.join('\n\n').trim(),
      confidence: Number(meanConfidence.toFixed(2)),
      engine: 'tesseract-5.x',
      pages,
      totalPages,
      isPartial,
    };
  }

  private async processImage(
    buffer: Buffer,
    tempDir: string,
    deadlineMs: number,
  ): Promise<OcrResult> {
    const inputImagePath = path.join(tempDir, 'input-image.png');
    await fs.promises.writeFile(inputImagePath, buffer);

    const imageTimeoutMs = this.getRemainingTimeoutMs(deadlineMs);
    const { text, confidence } = await this.runTesseractOnImage(inputImagePath, imageTimeoutMs, 1);
    const trimmed = text.trim();
    const conf = Number(confidence.toFixed(2));

    return {
      text: trimmed,
      confidence: conf,
      engine: 'tesseract-5.x',
      pages: [
        {
          pageNumber: 1,
          text: trimmed,
          confidence: conf,
          startOffset: 0,
          endOffset: trimmed.length,
        },
      ],
      totalPages: 1,
      isPartial: false,
    };
  }

  private async runTesseractOnImage(
    imagePath: string,
    timeoutMs: number,
    pageNumber?: number,
  ): Promise<{ text: string; confidence: number; wordCount: number }> {
    try {
      const { stdout } = await this.execCommand(
        this.tesseractPath,
        [imagePath, 'stdout', '-l', this.language, '--oem', '1', '--psm', '3', 'tsv'],
        { timeout: timeoutMs },
      );

      return this.parseTsvOutput(stdout);
    } catch (err: unknown) {
      const pageLabel = pageNumber !== undefined ? ` on page ${pageNumber}` : '';
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (errCode === 'ENOENT' || errMsg.includes('ENOENT')) {
        throw new OcrRuntimeUnavailableError(
          `Tesseract OCR binary is not installed at ${this.tesseractPath}. Install tesseract-ocr.`,
        );
      }
      if (this.isSubprocessTimeoutError(err)) {
        throw new DocumentProcessingTimeoutError(
          `Tesseract OCR timed out${pageLabel} within cumulative timeout budget (${this.timeoutMs}ms): ${errMsg}`,
        );
      }
      throw new Error(`Tesseract OCR failed${pageLabel}: ${errMsg}`);
    }
  }

  /**
   * Parses standard Tesseract TSV output:
   * Header: level \t page_num \t block_num \t par_num \t line_num \t word_num \t left \t top \t width \t height \t conf \t text
   */
  public parseTsvOutput(tsv: string): { text: string; confidence: number; wordCount: number } {
    if (!tsv || !tsv.trim()) {
      return { text: '', confidence: 0, wordCount: 0 };
    }

    const lines = tsv.split(/\r?\n/);
    if (lines.length < 2) {
      return { text: '', confidence: 0, wordCount: 0 };
    }

    const extractedWords: string[] = [];
    let sumConf = 0;
    let wordCount = 0;

    // Line by line parsing
    let currentLineWords: string[] = [];
    let currentLineNum = -1;
    const documentLines: string[] = [];

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]?.trim();
      if (!line) continue;

      const cols = line.split('\t');
      // TSV must have 12 columns: level(0), ..., line_num(4), ..., conf(10), text(11)
      if (cols.length < 12) continue;

      const level = cols[0];
      const lineNum = parseInt(cols[4] ?? '-1', 10);
      const confStr = cols[10];
      const wordText = cols[11]?.trim();

      // level 5 represents word-level elements
      if (level === '5' && wordText && wordText.length > 0) {
        const confNum = parseFloat(confStr ?? '0');
        if (!isNaN(confNum) && confNum >= 0) {
          sumConf += confNum / 100; // Normalize 0-100 to 0.0-1.0
          wordCount += 1;
        }

        if (lineNum !== currentLineNum && currentLineWords.length > 0) {
          documentLines.push(currentLineWords.join(' '));
          currentLineWords = [];
        }
        currentLineNum = lineNum;
        currentLineWords.push(wordText);
        extractedWords.push(wordText);
      }
    }

    if (currentLineWords.length > 0) {
      documentLines.push(currentLineWords.join(' '));
    }

    const fullText = documentLines.join('\n');
    const meanConfidence = wordCount > 0 ? sumConf / wordCount : 0;

    return {
      text: fullText,
      confidence: meanConfidence,
      wordCount,
    };
  }
}
