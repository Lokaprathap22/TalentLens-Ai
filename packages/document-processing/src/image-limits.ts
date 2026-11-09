import { inflateBounded } from './decompress.js';
import {
  DocumentProcessingTimeoutError,
  InvalidDocumentFormatError,
  SecurityLimitExceededError,
} from './errors.js';

export interface ImageDimensionLimits {
  maxImageWidth: number;
  maxImageHeight: number;
  maxImagePixels: number;
  maxAggregatePixels?: number;
  maxRenderedPages?: number;
  maxInputPages?: number;
  pdfRasterDpi?: number;
  maxRasterDpi?: number;
  maxInspectedDictionaries?: number;
  maxInspectedObjects?: number;
  maxDecompressedStreamBytes?: number;
  maxTotalDecompressedBytes?: number;
  maxStreams?: number;
  maxCompressionRatio?: number;
  deadlineMs?: number;
}

export interface PdfGeometryValidationResult {
  hasObjectStreams: boolean;
  totalPages: number;
  resolvedLeafPageCount: number;
  orderedPageObjNums: number[];
  expandedObjectCount: number;
  expandedObjStmIds: number[];
  objectBodies: Map<number, string>;
  decompressedBytes: number;
  streamCount: number;
}

export interface ParsedImageDimensions {
  format: 'PNG' | 'JPEG' | 'TIFF';
  width: number;
  height: number;
}

const DEFAULT_MAX_INSPECTED_DICTS = 20_000;
const DEFAULT_MAX_INSPECTED_OBJECTS = 25_000;
const DEFAULT_MAX_RASTER_DPI = 600;
const DEFAULT_MAX_DICT_DEPTH = 64;
const DEFAULT_MAX_REF_DEPTH = 16;
const DEFAULT_MAX_DECOMPRESSED_STREAM_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_DECOMPRESSED_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_STREAMS = 2000;
const DEFAULT_MAX_COMPRESSION_RATIO = 100;
const DEFAULT_INSPECTION_TIMEOUT_MS = 15_000;

interface PdfBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PdfParsedDict {
  entries: Map<string, string>;
  nestedDicts: PdfParsedDict[];
}

export function assertPixelDimensionsWithinLimits(
  width: number,
  height: number,
  limits: ImageDimensionLimits,
  sourceLabel: string,
): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new SecurityLimitExceededError(`Invalid dimensions reported for ${sourceLabel}`);
  }

  if (width > limits.maxImageWidth || height > limits.maxImageHeight) {
    throw new SecurityLimitExceededError(
      `${sourceLabel} dimensions (${width}x${height}) exceed maximum allowed ${limits.maxImageWidth}x${limits.maxImageHeight} pixels`,
    );
  }

  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxImagePixels) {
    throw new SecurityLimitExceededError(
      `${sourceLabel} pixel count (${pixels}) exceeds maximum allowed ${limits.maxImagePixels} pixels`,
    );
  }
}

/**
 * Inspects image headers (PNG IHDR, JPEG SOFn, TIFF IFD0) without decoding pixel buffers.
 * Returns null if the buffer does not start with a recognized raster image signature.
 */
export function inspectRasterImageDimensions(buffer: Buffer): ParsedImageDimensions | null {
  if (!buffer || buffer.length < 4) return null;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A + length(4) + "IHDR"(4) + width(4) + height(4)
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.length < 24 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
      throw new InvalidDocumentFormatError('Malformed PNG IHDR header');
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width === 0 || height === 0) {
      throw new InvalidDocumentFormatError('Invalid zero-dimension PNG image');
    }
    return { format: 'PNG', width, height };
  }

  // 2. JPEG: FF D8 ... scan SOFn markers (C0..CF excluding C4, C8, CC)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        break;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= buffer.length) break;
      const marker = buffer[offset]!;
      offset += 1;

      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        if (marker === 0xd9) break; // EOI
        continue;
      }
      if (marker === 0xda) {
        // SOS: compressed entropy stream follows
        break;
      }

      if (offset + 2 > buffer.length) {
        throw new InvalidDocumentFormatError('Truncated JPEG marker segment');
      }
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        throw new InvalidDocumentFormatError('Malformed JPEG segment length');
      }

      const isSofMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isSofMarker) {
        if (segmentLength < 7 || offset + 7 > buffer.length) {
          throw new InvalidDocumentFormatError('Truncated JPEG SOF frame header');
        }
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width === 0 || height === 0) {
          throw new InvalidDocumentFormatError('Invalid zero-dimension JPEG image');
        }
        return { format: 'JPEG', width, height };
      }

      offset += segmentLength;
    }

    throw new InvalidDocumentFormatError('JPEG image missing SOF frame dimensions');
  }

  // 3. TIFF: II*\0 (little-endian) or MM\0* (big-endian)
  const isLittle =
    buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
  const isBig =
    buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;

  if (isLittle || isBig) {
    if (buffer.length < 8) {
      throw new InvalidDocumentFormatError('Truncated TIFF header');
    }
    const readU16 = (pos: number) =>
      isLittle ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
    const readU32 = (pos: number) =>
      isLittle ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);

    const ifdOffset = readU32(4);
    if (ifdOffset < 8 || ifdOffset + 2 > buffer.length) {
      throw new InvalidDocumentFormatError('Malformed TIFF IFD offset');
    }

    const entryCount = readU16(ifdOffset);
    let width: number | undefined;
    let height: number | undefined;

    for (let i = 0; i < entryCount && i < 256; i += 1) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > buffer.length) {
        break;
      }
      const tag = readU16(entryOffset);
      const type = readU16(entryOffset + 2);
      const count = readU32(entryOffset + 4);
      if (count !== 1) continue;

      const val =
        type === 3 ? readU16(entryOffset + 8) : type === 4 ? readU32(entryOffset + 8) : undefined;

      if (val !== undefined) {
        if (tag === 256) width = val;
        else if (tag === 257) height = val;
      }

      if (width !== undefined && height !== undefined) {
        return { format: 'TIFF', width, height };
      }
    }

    throw new InvalidDocumentFormatError('TIFF image missing width/length tags');
  }

  return null;
}

export function assertRasterImageBufferWithinLimits(
  buffer: Buffer,
  limits: ImageDimensionLimits,
  sourceLabel = 'Image',
): ParsedImageDimensions | null {
  const dims = inspectRasterImageDimensions(buffer);
  if (dims) {
    assertPixelDimensionsWithinLimits(
      dims.width,
      dims.height,
      limits,
      `${dims.format} ${sourceLabel}`,
    );
  }
  return dims;
}

function findTopLevelStreamOrEndObj(
  text: string,
  bodyStart: number,
): { streamAt: number; streamDataStart: number; endObjAt: number } {
  let i = bodyStart;
  let dictDepth = 0;

  while (i < text.length) {
    i = skipPdfWhitespaceAndComments(text, i);
    if (i >= text.length) break;

    const ch = text[i]!;
    if (ch === '(') {
      i = skipPdfLiteralString(text, i);
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      dictDepth += 1;
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '>') {
      if (dictDepth > 0) dictDepth -= 1;
      i += 2;
      continue;
    }
    if (ch === '<') {
      i = skipPdfHexString(text, i);
      continue;
    }
    if (ch === '[') {
      i = skipPdfBracketArray(text, i);
      continue;
    }

    if (dictDepth === 0) {
      if (
        text.startsWith('stream', i) &&
        (i === bodyStart || isPdfWhitespace(text[i - 1]!) || isPdfDelimiter(text[i - 1]!))
      ) {
        const afterKw = i + 6;
        if (text.startsWith('\r\n', afterKw)) {
          return { streamAt: i, streamDataStart: afterKw + 2, endObjAt: -1 };
        }
        if (text[afterKw] === '\n' || text[afterKw] === '\r') {
          return { streamAt: i, streamDataStart: afterKw + 1, endObjAt: -1 };
        }
      }
      if (
        text.startsWith('endobj', i) &&
        (i === bodyStart || isPdfWhitespace(text[i - 1]!) || isPdfDelimiter(text[i - 1]!)) &&
        (i + 6 >= text.length || isPdfWhitespace(text[i + 6]!) || isPdfDelimiter(text[i + 6]!))
      ) {
        return { streamAt: -1, streamDataStart: -1, endObjAt: i };
      }
    }

    i += 1;
  }

  return { streamAt: -1, streamDataStart: -1, endObjAt: -1 };
}

interface RawStreamLocator {
  objNum: number;
  occurrenceIndex: number;
  streamDataStart: number;
  dataEnd: number;
}

function findMatchingEndstreamForDeclaredLength(
  pdfText: string,
  headerSlice: string,
  streamDataStart: number,
): { endStreamIdx: number; dataEnd: number } | null {
  const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)\b/.exec(headerSlice);
  if (!lenMatch?.[1]) return null;
  const declaredLen = parseInt(lenMatch[1], 10);
  if (!Number.isSafeInteger(declaredLen) || declaredLen < 0) return null;
  const afterData = streamDataStart + declaredLen;
  if (afterData > pdfText.length) return null;

  let probe = afterData;
  if (pdfText.startsWith('\r\n', probe)) {
    probe += 2;
  } else if (pdfText[probe] === '\r' || pdfText[probe] === '\n') {
    probe += 1;
  }
  while (probe < pdfText.length && (pdfText[probe] === ' ' || pdfText[probe] === '\t')) {
    probe += 1;
  }
  if (pdfText.startsWith('endstream', probe)) {
    return { endStreamIdx: probe, dataEnd: afterData };
  }
  return null;
}

function computeStreamDataEndBeforeEndstream(
  pdfText: string,
  streamDataStart: number,
  endStreamIdx: number,
): number {
  let dataEnd = endStreamIdx;
  if (
    dataEnd >= streamDataStart + 2 &&
    pdfText[dataEnd - 2] === '\r' &&
    pdfText[dataEnd - 1] === '\n'
  ) {
    dataEnd -= 2;
  } else if (
    dataEnd >= streamDataStart + 1 &&
    (pdfText[dataEnd - 1] === '\n' || pdfText[dataEnd - 1] === '\r')
  ) {
    dataEnd -= 1;
  }
  return Math.max(streamDataStart, dataEnd);
}

/**
 * Strips raw `stream...endstream` payloads inside PDF objects so binary/compressed stream bytes
 * cannot interfere with dictionary `<< ... >>` scanning or spoof subsequent object headers,
 * while recording byte offsets of each stream for bounded `/ObjStm` decompression.
 */
function stripPdfStreamPayloads(pdfText: string): {
  headerOnlyText: string;
  rawStreams: RawStreamLocator[];
} {
  const objHeaderRegex = /(\d+)\s+(\d+)\s+obj\b/g;
  const parts: string[] = [];
  const rawStreams: RawStreamLocator[] = [];
  const objOccurrenceCounts = new Map<number, number>();
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = objHeaderRegex.exec(pdfText)) !== null) {
    const objNum = parseInt(match[1]!, 10);
    const occurrenceIndex = objOccurrenceCounts.get(objNum) ?? 0;
    objOccurrenceCounts.set(objNum, occurrenceIndex + 1);

    const bodyStart = match.index + match[0].length;
    const {
      streamAt: foundStreamAt,
      streamDataStart,
      endObjAt: foundEndObjAt,
    } = findTopLevelStreamOrEndObj(pdfText, bodyStart);

    if (foundStreamAt !== -1) {
      const headerSlice = pdfText.slice(bodyStart, foundStreamAt);
      const exactMatch = findMatchingEndstreamForDeclaredLength(
        pdfText,
        headerSlice,
        streamDataStart,
      );

      let endStreamIdx = -1;
      let dataEnd = -1;
      if (exactMatch) {
        endStreamIdx = exactMatch.endStreamIdx;
        dataEnd = exactMatch.dataEnd;
      } else {
        const candidateEndStream = pdfText.indexOf('endstream', streamDataStart);
        if (candidateEndStream !== -1) {
          const between = pdfText.slice(streamDataStart, candidateEndStream);
          const spansNextObject = /(?:^|[\r\n])\s*(?:endobj|\d+\s+\d+\s+obj)\b/.test(between);
          if (!spansNextObject) {
            endStreamIdx = candidateEndStream;
            dataEnd = computeStreamDataEndBeforeEndstream(pdfText, streamDataStart, endStreamIdx);
          }
        }
      }

      if (endStreamIdx !== -1) {
        if (Number.isSafeInteger(objNum)) {
          rawStreams.push({
            objNum,
            occurrenceIndex,
            streamDataStart,
            dataEnd,
          });
        }
        parts.push(pdfText.slice(cursor, foundStreamAt + 6), '\nendstream');
        cursor = endStreamIdx + 'endstream'.length;
        const nextEndObj = pdfText.indexOf('endobj', cursor);
        objHeaderRegex.lastIndex = nextEndObj !== -1 ? nextEndObj + 'endobj'.length : cursor;
        continue;
      }

      parts.push(pdfText.slice(cursor, streamDataStart));
      cursor = streamDataStart;
      objHeaderRegex.lastIndex = streamDataStart;
      continue;
    }

    if (foundEndObjAt !== -1) {
      objHeaderRegex.lastIndex = foundEndObjAt + 'endobj'.length;
    }
  }

  parts.push(pdfText.slice(cursor));
  return { headerOnlyText: parts.join(''), rawStreams };
}

function isPdfWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0';
}

function isPdfDelimiter(ch: string): boolean {
  return (
    ch === '(' ||
    ch === ')' ||
    ch === '<' ||
    ch === '>' ||
    ch === '[' ||
    ch === ']' ||
    ch === '{' ||
    ch === '}' ||
    ch === '/' ||
    ch === '%'
  );
}

function skipPdfWhitespaceAndComments(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (isPdfWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function skipPdfLiteralString(text: string, start: number): number {
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function skipPdfHexString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '>') {
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function skipPdfBracketArray(text: string, start: number): number {
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    i = skipPdfWhitespaceAndComments(text, i);
    if (i >= text.length) break;
    const ch = text[i]!;
    if (ch === '(') {
      i = skipPdfLiteralString(text, i);
    } else if (ch === '<' && text[i + 1] !== '<') {
      i = skipPdfHexString(text, i);
    } else if (ch === '[') {
      depth += 1;
      i += 1;
    } else if (ch === ']') {
      depth -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (depth > 0) {
    throw new InvalidDocumentFormatError('Malformed or unterminated PDF array');
  }
  return i;
}

function readPdfNameToken(text: string, start: number): { token: string; nextIndex: number } {
  let i = start + 1;
  while (i < text.length && !isPdfWhitespace(text[i]!) && !isPdfDelimiter(text[i]!)) {
    i += 1;
  }
  const rawToken = text.slice(start, i);
  const decodedToken = rawToken.includes('#')
    ? rawToken.replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
    : rawToken;
  return { token: decodedToken, nextIndex: i };
}

function readPdfWordToken(text: string, start: number): { token: string; nextIndex: number } {
  let i = start;
  while (i < text.length && !isPdfWhitespace(text[i]!) && !isPdfDelimiter(text[i]!)) {
    i += 1;
  }
  return { token: text.slice(start, i), nextIndex: i };
}

function parsePdfDictionary(
  text: string,
  start: number,
  counter: { dicts: number; maxDicts: number },
  depth: number,
): { dict: PdfParsedDict; nextIndex: number } {
  counter.dicts += 1;
  if (counter.dicts > counter.maxDicts) {
    throw new SecurityLimitExceededError(
      `PDF dictionary count exceeds maximum inspected limit of ${counter.maxDicts}`,
    );
  }
  if (depth > DEFAULT_MAX_DICT_DEPTH) {
    throw new SecurityLimitExceededError(
      `PDF dictionary nesting depth exceeds maximum limit of ${DEFAULT_MAX_DICT_DEPTH}`,
    );
  }

  const entries = new Map<string, string>();
  const nestedDicts: PdfParsedDict[] = [];
  let i = start + 2;

  const readSingleValue = (): { raw: string; closedDict: boolean } => {
    i = skipPdfWhitespaceAndComments(text, i);
    if (i >= text.length) {
      throw new InvalidDocumentFormatError('Malformed or unterminated PDF dictionary');
    }
    if (text[i] === '>' && text[i + 1] === '>') {
      return { raw: '', closedDict: true };
    }

    const ch = text[i]!;
    if (ch === '<' && text[i + 1] === '<') {
      const subStart = i;
      const sub = parsePdfDictionary(text, i, counter, depth + 1);
      nestedDicts.push(sub.dict);
      i = sub.nextIndex;
      return { raw: text.slice(subStart, i), closedDict: false };
    }
    if (ch === '<') {
      const s = i;
      i = skipPdfHexString(text, i);
      return { raw: text.slice(s, i), closedDict: false };
    }
    if (ch === '(') {
      const s = i;
      i = skipPdfLiteralString(text, i);
      return { raw: text.slice(s, i), closedDict: false };
    }
    if (ch === '[') {
      const s = i;
      i = skipPdfBracketArray(text, i);
      return { raw: text.slice(s, i), closedDict: false };
    }
    if (ch === '/') {
      const nameTok = readPdfNameToken(text, i);
      i = nameTok.nextIndex;
      return { raw: nameTok.token, closedDict: false };
    }

    const word1 = readPdfWordToken(text, i);
    i = word1.nextIndex;
    if (/^\d+$/.test(word1.token)) {
      const savePos = i;
      const pos2 = skipPdfWhitespaceAndComments(text, i);
      if (pos2 < text.length && !isPdfDelimiter(text[pos2]!)) {
        const word2 = readPdfWordToken(text, pos2);
        if (/^\d+$/.test(word2.token)) {
          const pos3 = skipPdfWhitespaceAndComments(text, word2.nextIndex);
          if (pos3 < text.length && !isPdfDelimiter(text[pos3]!)) {
            const word3 = readPdfWordToken(text, pos3);
            if (word3.token === 'R') {
              i = word3.nextIndex;
              return { raw: `${word1.token} ${word2.token} R`, closedDict: false };
            }
          }
        }
      }
      i = savePos;
    }

    return { raw: word1.token, closedDict: false };
  };

  while (i < text.length) {
    i = skipPdfWhitespaceAndComments(text, i);
    if (i >= text.length) {
      throw new InvalidDocumentFormatError('Malformed or unterminated PDF dictionary');
    }
    if (text[i] === '>' && text[i + 1] === '>') {
      return { dict: { entries, nestedDicts }, nextIndex: i + 2 };
    }

    const ch = text[i]!;
    if (ch === '/') {
      const keyTok = readPdfNameToken(text, i);
      i = keyTok.nextIndex;
      const val = readSingleValue();
      if (val.closedDict) {
        entries.set(keyTok.token, '');
        return { dict: { entries, nestedDicts }, nextIndex: i + 2 };
      }
      entries.set(keyTok.token, val.raw);
      continue;
    }

    if (ch === '<' && text[i + 1] === '<') {
      const sub = parsePdfDictionary(text, i, counter, depth + 1);
      nestedDicts.push(sub.dict);
      i = sub.nextIndex;
      continue;
    }
    if (ch === '(') {
      i = skipPdfLiteralString(text, i);
      continue;
    }
    if (ch === '<') {
      i = skipPdfHexString(text, i);
      continue;
    }
    if (ch === '[') {
      i = skipPdfBracketArray(text, i);
      continue;
    }

    i += 1;
  }

  throw new InvalidDocumentFormatError('Malformed or unterminated PDF dictionary');
}

function collectDictionariesFromSegment(
  segment: string,
  counter: { dicts: number; maxDicts: number },
): PdfParsedDict[] {
  const dicts: PdfParsedDict[] = [];
  let i = 0;

  while (i < segment.length) {
    i = skipPdfWhitespaceAndComments(segment, i);
    if (i >= segment.length) break;

    const ch = segment[i]!;
    if (ch === '(') {
      i = skipPdfLiteralString(segment, i);
    } else if (ch === '<' && segment[i + 1] === '<') {
      const parsed = parsePdfDictionary(segment, i, counter, 1);
      dicts.push(parsed.dict);
      i = parsed.nextIndex;
    } else if (ch === '<') {
      i = skipPdfHexString(segment, i);
    } else if (ch === '[') {
      i = skipPdfBracketArray(segment, i);
    } else {
      i += 1;
    }
  }

  return dicts;
}

function flattenDictTree(root: PdfParsedDict): PdfParsedDict[] {
  const out: PdfParsedDict[] = [];
  const stack: PdfParsedDict[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    out.push(current);
    for (let idx = current.nestedDicts.length - 1; idx >= 0; idx -= 1) {
      stack.push(current.nestedDicts[idx]!);
    }
  }
  return out;
}

function parseIndirectRefNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^(\d+)\s+\d+\s+R$/.exec(trimmed);
  if (!m?.[1]) return null;
  const objNum = parseInt(m[1], 10);
  return Number.isSafeInteger(objNum) ? objNum : null;
}

function extractCleanObjectBody(rawBody: string): string {
  const { streamAt } = findTopLevelStreamOrEndObj(rawBody, 0);
  const headerSlice = streamAt !== -1 ? rawBody.slice(0, streamAt) : rawBody;
  return headerSlice.trim();
}

function resolveIndirectValue(
  rawValue: string,
  objectsMap: Map<number, string>,
  sourceLabel: string,
  fieldName: string,
  depth = 0,
  visited = new Set<number>(),
): string {
  if (depth > DEFAULT_MAX_REF_DEPTH) {
    throw new SecurityLimitExceededError(
      `PDF indirect reference depth exceeds limit for ${fieldName} on ${sourceLabel}`,
    );
  }

  const trimmed = rawValue.trim();
  const refObjNum = parseIndirectRefNumber(trimmed);
  if (refObjNum === null) {
    return trimmed;
  }

  if (visited.has(refObjNum)) {
    throw new InvalidDocumentFormatError(
      `Circular indirect PDF reference (object ${refObjNum}) for ${fieldName} on ${sourceLabel}`,
    );
  }

  const targetBody = objectsMap.get(refObjNum);
  if (targetBody === undefined) {
    throw new InvalidDocumentFormatError(
      `Unresolvable indirect reference ${refObjNum} 0 R for ${fieldName} on ${sourceLabel}`,
    );
  }

  visited.add(refObjNum);
  return resolveIndirectValue(
    extractCleanObjectBody(targetBody),
    objectsMap,
    sourceLabel,
    fieldName,
    depth + 1,
    visited,
  );
}

function parseFinitePdfNumber(
  rawValue: string,
  objectsMap: Map<number, string>,
  sourceLabel: string,
  fieldName: string,
): number {
  const resolved = resolveIndirectValue(rawValue, objectsMap, sourceLabel, fieldName);
  const clean = resolved.replace(/%[^\r\n]*/g, '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean)) {
    throw new InvalidDocumentFormatError(
      `Invalid numeric value "${clean}" for ${fieldName} on ${sourceLabel}`,
    );
  }
  const num = Number(clean);
  if (!Number.isFinite(num)) {
    throw new SecurityLimitExceededError(`Numeric overflow in ${fieldName} on ${sourceLabel}`);
  }
  return num;
}

function tokenizeArrayItems(arrayText: string): string[] {
  const trimmed = arrayText.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new InvalidDocumentFormatError(`Expected PDF array, got "${trimmed.slice(0, 40)}"`);
  }
  const inner = trimmed.slice(1, -1);
  const tokens: string[] = [];
  let i = 0;

  while (i < inner.length) {
    i = skipPdfWhitespaceAndComments(inner, i);
    if (i >= inner.length) break;

    const ch = inner[i]!;
    if (ch === '(') {
      const s = i;
      i = skipPdfLiteralString(inner, i);
      tokens.push(inner.slice(s, i));
    } else if (ch === '<' && inner[i + 1] === '<') {
      throw new InvalidDocumentFormatError('Unexpected dictionary inside PDF numeric/ref array');
    } else if (ch === '<') {
      const s = i;
      i = skipPdfHexString(inner, i);
      tokens.push(inner.slice(s, i));
    } else if (ch === '[') {
      const s = i;
      i = skipPdfBracketArray(inner, i);
      tokens.push(inner.slice(s, i));
    } else if (ch === '/') {
      const tok = readPdfNameToken(inner, i);
      tokens.push(tok.token);
      i = tok.nextIndex;
    } else {
      const w1 = readPdfWordToken(inner, i);
      i = w1.nextIndex;
      if (/^\d+$/.test(w1.token)) {
        const p2 = skipPdfWhitespaceAndComments(inner, i);
        if (p2 < inner.length && !isPdfDelimiter(inner[p2]!)) {
          const w2 = readPdfWordToken(inner, p2);
          if (/^\d+$/.test(w2.token)) {
            const p3 = skipPdfWhitespaceAndComments(inner, w2.nextIndex);
            if (p3 < inner.length && !isPdfDelimiter(inner[p3]!)) {
              const w3 = readPdfWordToken(inner, p3);
              if (w3.token === 'R') {
                i = w3.nextIndex;
                tokens.push(`${w1.token} ${w2.token} R`);
                continue;
              }
            }
          }
        }
      }
      if (w1.token.length > 0) {
        tokens.push(w1.token);
      } else {
        i += 1;
      }
    }
  }

  return tokens;
}

function parsePdfBox(
  rawValue: string,
  objectsMap: Map<number, string>,
  sourceLabel: string,
  fieldName: string,
): PdfBox {
  const resolvedArray = resolveIndirectValue(rawValue, objectsMap, sourceLabel, fieldName);
  const items = tokenizeArrayItems(resolvedArray);
  if (items.length !== 4) {
    throw new InvalidDocumentFormatError(
      `${fieldName} on ${sourceLabel} must have 4 numeric coordinates, found ${items.length}`,
    );
  }

  const x1 = parseFinitePdfNumber(items[0]!, objectsMap, sourceLabel, `${fieldName}[0]`);
  const y1 = parseFinitePdfNumber(items[1]!, objectsMap, sourceLabel, `${fieldName}[1]`);
  const x2 = parseFinitePdfNumber(items[2]!, objectsMap, sourceLabel, `${fieldName}[2]`);
  const y2 = parseFinitePdfNumber(items[3]!, objectsMap, sourceLabel, `${fieldName}[3]`);

  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  if (!Number.isFinite(maxX - minX) || !Number.isFinite(maxY - minY)) {
    throw new SecurityLimitExceededError(
      `PDF coordinate range overflow in ${fieldName} on ${sourceLabel}`,
    );
  }
  if (maxX - minX <= 0 || maxY - minY <= 0) {
    throw new InvalidDocumentFormatError(
      `Degenerate zero-area ${fieldName} dimensions on ${sourceLabel}`,
    );
  }

  return { minX, minY, maxX, maxY };
}

function intersectPdfBoxes(mediaBox: PdfBox, cropBox: PdfBox, sourceLabel: string): PdfBox {
  const minX = Math.max(mediaBox.minX, cropBox.minX);
  const maxX = Math.min(mediaBox.maxX, cropBox.maxX);
  const minY = Math.max(mediaBox.minY, cropBox.minY);
  const maxY = Math.min(mediaBox.maxY, cropBox.maxY);
  if (maxX <= minX || maxY <= minY) {
    throw new InvalidDocumentFormatError(`${sourceLabel} has empty CropBox/MediaBox intersection`);
  }
  return { minX, minY, maxX, maxY };
}

function parsePdfRotate(
  rawValue: string,
  objectsMap: Map<number, string>,
  sourceLabel: string,
): number {
  const num = parseFinitePdfNumber(rawValue, objectsMap, sourceLabel, '/Rotate');
  if (!Number.isSafeInteger(num) || num % 90 !== 0) {
    throw new InvalidDocumentFormatError(
      `Invalid PDF /Rotate value (${num}) on ${sourceLabel}; must be an integer multiple of 90`,
    );
  }
  return ((num % 360) + 360) % 360;
}

function computeRenderedPageDimensions(
  box: PdfBox,
  rotation: number,
  dpi: number,
  userUnit: number,
  sourceLabel: string,
): { width: number; height: number } {
  const widthPts = (box.maxX - box.minX) * userUnit;
  const heightPts = (box.maxY - box.minY) * userUnit;

  const rawWidth = Math.ceil((widthPts * dpi) / 72);
  const rawHeight = Math.ceil((heightPts * dpi) / 72);

  if (
    !Number.isFinite(rawWidth) ||
    !Number.isFinite(rawHeight) ||
    !Number.isSafeInteger(rawWidth) ||
    !Number.isSafeInteger(rawHeight) ||
    rawWidth <= 0 ||
    rawHeight <= 0
  ) {
    throw new SecurityLimitExceededError(
      `Rendered dimensions overflow safe bounds for ${sourceLabel}`,
    );
  }

  if (rotation === 90 || rotation === 270) {
    return { width: rawHeight, height: rawWidth };
  }
  return { width: rawWidth, height: rawHeight };
}

interface PdfRawObjStmCandidate {
  objNum: number;
  genNum: number;
  dict: PdfParsedDict;
  rawLocator: RawStreamLocator | null;
}

interface PreparedPdfState {
  pdfBuffer: Buffer;
  pdfText: string;
  headerOnlyText: string;
  limits: ImageDimensionLimits;
  dpi: number;
  maxDicts: number;
  maxObjects: number;
  counter: { dicts: number; maxDicts: number };
  objCount: number;
  objectsMap: Map<number, string>;
  objectBodyVariants: Map<number, string[]>;
  objectTopDicts: Map<number, PdfParsedDict>;
  objectDictVariants: Map<number, PdfParsedDict[]>;
  allDicts: Array<{ label: string; dict: PdfParsedDict }>;
  trailerDicts: PdfParsedDict[];
  rawStreamsByOccurrenceKey: Map<string, RawStreamLocator>;
}

function recordVariant<T>(map: Map<number, T[]>, key: number, val: T): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(val);
  } else {
    map.set(key, [val]);
  }
}

function resolvePdfDictType(
  dict: PdfParsedDict,
  objectsMap: Map<number, string>,
  label: string,
): string {
  const rawType = dict.entries.get('/Type');
  if (!rawType) return '';
  if (parseIndirectRefNumber(rawType) !== null) {
    return resolveIndirectValue(rawType, objectsMap, label, '/Type');
  }
  return rawType;
}

function resolveAllIndirectVariants(
  rawValue: string,
  objectBodyVariants: Map<number, string[]>,
  objectsMap: Map<number, string>,
  sourceLabel: string,
  fieldName: string,
): string[] {
  const refObjNum = parseIndirectRefNumber(rawValue);
  if (refObjNum === null) {
    return [rawValue.trim()];
  }
  const variants = objectBodyVariants.get(refObjNum);
  if (!variants || variants.length <= 1) {
    return [resolveIndirectValue(rawValue, objectsMap, sourceLabel, fieldName)];
  }
  const results: string[] = [];
  for (const variantBody of variants) {
    const clean = extractCleanObjectBody(variantBody);
    const resolved =
      parseIndirectRefNumber(clean) !== null
        ? resolveIndirectValue(clean, objectsMap, sourceLabel, fieldName, 1, new Set([refObjNum]))
        : clean;
    if (!results.includes(resolved)) {
      results.push(resolved);
    }
  }
  return results.length > 0
    ? results
    : [resolveIndirectValue(rawValue, objectsMap, sourceLabel, fieldName)];
}

function preparePdfInspectionState(
  input: Buffer | string,
  limits: ImageDimensionLimits,
): PreparedPdfState {
  const pdfBuffer = typeof input === 'string' ? Buffer.from(input, 'latin1') : input;
  const pdfText = typeof input === 'string' ? input : input.toString('latin1');

  const dpi = limits.pdfRasterDpi ?? 150;
  const maxDpi = limits.maxRasterDpi ?? DEFAULT_MAX_RASTER_DPI;
  if (!Number.isFinite(maxDpi) || maxDpi <= 0) {
    throw new InvalidDocumentFormatError(`Invalid maxRasterDpi configuration: ${String(maxDpi)}`);
  }
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi <= 0) {
    throw new InvalidDocumentFormatError(`Invalid PDF rasterization DPI: ${String(dpi)}`);
  }
  if (dpi > maxDpi) {
    throw new SecurityLimitExceededError(
      `PDF rasterization DPI (${dpi}) exceeds maximum allowed ${maxDpi}`,
    );
  }

  const maxDicts = limits.maxInspectedDictionaries ?? DEFAULT_MAX_INSPECTED_DICTS;
  const maxObjects = limits.maxInspectedObjects ?? DEFAULT_MAX_INSPECTED_OBJECTS;
  const { headerOnlyText, rawStreams } = stripPdfStreamPayloads(pdfText);
  const rawStreamsByOccurrenceKey = new Map<string, RawStreamLocator>();
  for (const rs of rawStreams) {
    rawStreamsByOccurrenceKey.set(`${rs.objNum}:${rs.occurrenceIndex}`, rs);
  }

  const counter = { dicts: 0, maxDicts };
  const objectsMap = new Map<number, string>();
  const objectBodyVariants = new Map<number, string[]>();
  const objectTopDicts = new Map<number, PdfParsedDict>();
  const objectDictVariants = new Map<number, PdfParsedDict[]>();
  const allDicts: Array<{ label: string; dict: PdfParsedDict }> = [];
  const occurrenceCounters = new Map<number, number>();

  const objHeaderRegex = /(\d+)\s+(\d+)\s+obj\b/g;
  let objMatch: RegExpExecArray | null;
  let objCount = 0;
  const nonObjRanges: Array<{ start: number; end: number }> = [];
  let prevEnd = 0;

  while ((objMatch = objHeaderRegex.exec(headerOnlyText)) !== null) {
    objCount += 1;
    if (objCount > maxObjects) {
      throw new SecurityLimitExceededError(
        `PDF object count exceeds maximum inspected limit of ${maxObjects}`,
      );
    }

    if (objMatch.index > prevEnd) {
      nonObjRanges.push({ start: prevEnd, end: objMatch.index });
    }

    const objNum = parseInt(objMatch[1]!, 10);
    const bodyStart = objMatch.index + objMatch[0].length;
    const endObjIdx = headerOnlyText.indexOf('endobj', bodyStart);
    const bodyEnd = endObjIdx !== -1 ? endObjIdx : headerOnlyText.length;
    const rawBody = headerOnlyText.slice(bodyStart, bodyEnd);
    const cleanBody = extractCleanObjectBody(rawBody);

    if (Number.isSafeInteger(objNum)) {
      const occ = occurrenceCounters.get(objNum) ?? 0;
      occurrenceCounters.set(objNum, occ + 1);
      objectsMap.set(objNum, cleanBody);
      recordVariant(objectBodyVariants, objNum, cleanBody);
    }

    const segDicts = collectDictionariesFromSegment(cleanBody, counter);
    if (segDicts.length > 0 && Number.isSafeInteger(objNum)) {
      objectTopDicts.set(objNum, segDicts[0]!);
      recordVariant(objectDictVariants, objNum, segDicts[0]!);
    }
    for (const rootDict of segDicts) {
      for (const flat of flattenDictTree(rootDict)) {
        allDicts.push({
          label: Number.isSafeInteger(objNum) ? `PDF object ${objNum}` : 'PDF dictionary',
          dict: flat,
        });
      }
    }

    prevEnd = endObjIdx !== -1 ? endObjIdx + 'endobj'.length : bodyEnd;
    objHeaderRegex.lastIndex = prevEnd;
  }

  if (prevEnd < headerOnlyText.length) {
    nonObjRanges.push({ start: prevEnd, end: headerOnlyText.length });
  }

  const trailerDicts: PdfParsedDict[] = [];
  for (const range of nonObjRanges) {
    const slice = headerOnlyText.slice(range.start, range.end);
    if (slice.includes('<<')) {
      const segDicts = collectDictionariesFromSegment(slice, counter);
      for (const rootDict of segDicts) {
        trailerDicts.push(rootDict);
        for (const flat of flattenDictTree(rootDict)) {
          allDicts.push({ label: 'PDF dictionary', dict: flat });
        }
      }
    }
  }

  return {
    pdfBuffer,
    pdfText,
    headerOnlyText,
    limits,
    dpi,
    maxDicts,
    maxObjects,
    counter,
    objCount,
    objectsMap,
    objectBodyVariants,
    objectTopDicts,
    objectDictVariants,
    allDicts,
    trailerDicts,
    rawStreamsByOccurrenceKey,
  };
}

function collectObjectStreamCandidates(state: PreparedPdfState): PdfRawObjStmCandidate[] {
  const candidates: PdfRawObjStmCandidate[] = [];
  const occurrenceCounters = new Map<number, number>();
  const objHeaderRegex = /(\d+)\s+(\d+)\s+obj\b/g;
  let objMatch: RegExpExecArray | null;

  while ((objMatch = objHeaderRegex.exec(state.headerOnlyText)) !== null) {
    const objNum = parseInt(objMatch[1]!, 10);
    const genNum = parseInt(objMatch[2]!, 10);
    const occ = occurrenceCounters.get(objNum) ?? 0;
    occurrenceCounters.set(objNum, occ + 1);

    const bodyStart = objMatch.index + objMatch[0].length;
    const endObjIdx = state.headerOnlyText.indexOf('endobj', bodyStart);
    const bodyEnd = endObjIdx !== -1 ? endObjIdx : state.headerOnlyText.length;
    const cleanBody = extractCleanObjectBody(state.headerOnlyText.slice(bodyStart, bodyEnd));
    const dict = collectDictionariesFromSegment(cleanBody, {
      dicts: 0,
      maxDicts: state.maxDicts + 1000,
    })[0];

    if (dict) {
      const dictType = resolvePdfDictType(
        dict,
        state.objectsMap,
        Number.isSafeInteger(objNum) ? `PDF object ${objNum}` : 'PDF /ObjStm',
      );
      if (dictType === '/ObjStm') {
        const rawLocator = state.rawStreamsByOccurrenceKey.get(`${objNum}:${occ}`) ?? null;
        candidates.push({ objNum, genNum, dict, rawLocator });
      }
    }

    objHeaderRegex.lastIndex = endObjIdx !== -1 ? endObjIdx + 'endobj'.length : bodyEnd;
  }

  for (const td of state.trailerDicts) {
    if (resolvePdfDictType(td, state.objectsMap, 'PDF trailer') === '/ObjStm') {
      throw new InvalidDocumentFormatError(
        'Malformed /ObjStm dictionary outside indirect stream object',
      );
    }
  }

  return candidates;
}

function checkObjStmDecodeParmsUnsupported(
  dict: PdfParsedDict,
  objectsMap: Map<number, string>,
  counter: { dicts: number; maxDicts: number },
  label: string,
): void {
  const rawDecodeParms = dict.entries.get('/DecodeParms');
  if (!rawDecodeParms) return;
  const resolved = resolveIndirectValue(rawDecodeParms, objectsMap, label, '/DecodeParms');
  const trimmed = resolved.trim();
  if (!trimmed || trimmed === 'null') return;
  const dpDicts = collectDictionariesFromSegment(trimmed, counter);
  for (const dp of dpDicts) {
    if (dp.entries.has('/Predictor')) {
      const pred = parseFinitePdfNumber(
        dp.entries.get('/Predictor')!,
        objectsMap,
        label,
        '/Predictor',
      );
      if (pred !== 1) {
        throw new InvalidDocumentFormatError(
          `Unsupported /DecodeParms /Predictor ${pred} on /ObjStm ${label}`,
        );
      }
    }
  }
}

function getAllowedObjStmFilter(
  dict: PdfParsedDict,
  objectsMap: Map<number, string>,
  label: string,
): 'none' | 'flate' {
  const rawFilter = dict.entries.get('/Filter');
  if (!rawFilter) return 'none';
  const resolved = resolveIndirectValue(rawFilter, objectsMap, label, '/Filter').trim();
  if (resolved === 'null') return 'none';
  if (resolved.startsWith('[')) {
    const items = tokenizeArrayItems(resolved);
    if (items.length === 0) return 'none';
    if (items.length === 1) {
      const resolvedItem = resolveIndirectValue(items[0]!, objectsMap, label, '/Filter[0]');
      if (resolvedItem === '/FlateDecode') return 'flate';
    }
    throw new InvalidDocumentFormatError(
      `Unsupported filter chain "${resolved}" on /ObjStm ${label}`,
    );
  }
  if (resolved === '/FlateDecode') return 'flate';
  throw new InvalidDocumentFormatError(
    `Unsupported stream filter "${resolved}" on /ObjStm ${label}`,
  );
}

function extractObjStmStreamBuffer(
  candidate: PdfRawObjStmCandidate,
  state: PreparedPdfState,
): Buffer {
  const label = `PDF /ObjStm object ${candidate.objNum}`;
  if (!candidate.rawLocator) {
    throw new InvalidDocumentFormatError(`Malformed ${label} missing valid stream payload`);
  }

  const { streamDataStart, dataEnd } = candidate.rawLocator;
  if (dataEnd < streamDataStart || dataEnd > state.pdfBuffer.length) {
    throw new InvalidDocumentFormatError(`Corrupt stream boundaries for ${label}`);
  }

  if (candidate.dict.entries.has('/Length')) {
    const declaredLen = parseFinitePdfNumber(
      candidate.dict.entries.get('/Length')!,
      state.objectsMap,
      label,
      '/Length',
    );
    if (!Number.isSafeInteger(declaredLen) || declaredLen < 0) {
      throw new InvalidDocumentFormatError(`Invalid /Length (${declaredLen}) on ${label}`);
    }
    if (streamDataStart + declaredLen > state.pdfBuffer.length) {
      throw new InvalidDocumentFormatError(
        `Truncated ${label}: declared /Length (${declaredLen}) exceeds file length`,
      );
    }
    // Check if endstream follows declaredLen closely
    let probe = streamDataStart + declaredLen;
    if (state.pdfText.startsWith('\r\n', probe)) {
      probe += 2;
    } else if (state.pdfText[probe] === '\r' || state.pdfText[probe] === '\n') {
      probe += 1;
    }
    while (
      probe < state.pdfText.length &&
      (state.pdfText[probe] === ' ' || state.pdfText[probe] === '\t')
    ) {
      probe += 1;
    }
    if (state.pdfText.startsWith('endstream', probe)) {
      return state.pdfBuffer.subarray(streamDataStart, streamDataStart + declaredLen);
    }
  }

  return state.pdfBuffer.subarray(streamDataStart, dataEnd);
}

async function expandPdfObjectStreamsAsync(
  state: PreparedPdfState,
  candidates: PdfRawObjStmCandidate[],
): Promise<{
  expandedObjectCount: number;
  expandedObjStmIds: number[];
  compressedObjectBodies: Map<number, string>;
  decompressedBytes: number;
  streamCount: number;
}> {
  const maxDecompressedStreamBytes =
    state.limits.maxDecompressedStreamBytes ?? DEFAULT_MAX_DECOMPRESSED_STREAM_BYTES;
  const maxTotalDecompressedBytes =
    state.limits.maxTotalDecompressedBytes ?? DEFAULT_MAX_TOTAL_DECOMPRESSED_BYTES;
  const maxStreams = state.limits.maxStreams ?? DEFAULT_MAX_STREAMS;
  const maxCompressionRatio = state.limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO;
  const deadlineMs = state.limits.deadlineMs ?? Date.now() + DEFAULT_INSPECTION_TIMEOUT_MS;

  const objStmIdSet = new Set(candidates.map((c) => c.objNum));
  const objStmDictById = new Map(candidates.map((c) => [c.objNum, c.dict]));

  // Validate /Extends chain references and cycle freedom before decompressing
  for (const cand of candidates) {
    const label = `PDF /ObjStm object ${cand.objNum}`;
    const seen = new Set<number>([cand.objNum]);
    let curDict: PdfParsedDict | undefined = cand.dict;
    while (curDict && curDict.entries.has('/Extends')) {
      const extObjNum = parseIndirectRefNumber(curDict.entries.get('/Extends'));
      if (extObjNum === null || !objStmIdSet.has(extObjNum)) {
        throw new InvalidDocumentFormatError(
          `Invalid or missing /Extends /ObjStm target from ${label}`,
        );
      }
      if (seen.has(extObjNum)) {
        throw new InvalidDocumentFormatError(
          `Circular /Extends reference in PDF /ObjStm chain at object ${extObjNum}`,
        );
      }
      seen.add(extObjNum);
      curDict = objStmDictById.get(extObjNum);
    }
  }

  let totalDecompressedBytes = 0;
  let streamCount = 0;
  let expandedObjectCount = 0;
  const expandedObjStmIds: number[] = [];
  const compressedObjectBodies = new Map<number, string>();

  for (const cand of candidates) {
    if (Date.now() > deadlineMs) {
      throw new DocumentProcessingTimeoutError(
        'PDF object stream inspection exceeded timeout limit',
      );
    }

    const label = `PDF /ObjStm object ${cand.objNum}`;
    if (!cand.dict.entries.has('/N') || !cand.dict.entries.has('/First')) {
      throw new InvalidDocumentFormatError(
        `Malformed ${label}: missing required /N or /First entry`,
      );
    }

    const n = parseFinitePdfNumber(cand.dict.entries.get('/N')!, state.objectsMap, label, '/N');
    const first = parseFinitePdfNumber(
      cand.dict.entries.get('/First')!,
      state.objectsMap,
      label,
      '/First',
    );
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidDocumentFormatError(`Invalid /N (${n}) on ${label}`);
    }
    if (!Number.isSafeInteger(first) || first < 0) {
      throw new InvalidDocumentFormatError(`Invalid /First (${first}) on ${label}`);
    }
    if (state.objCount + n > state.maxObjects) {
      throw new SecurityLimitExceededError(
        `PDF object count exceeds maximum inspected limit of ${state.maxObjects}`,
      );
    }

    checkObjStmDecodeParmsUnsupported(cand.dict, state.objectsMap, state.counter, label);
    const filterKind = getAllowedObjStmFilter(cand.dict, state.objectsMap, label);
    const rawStreamBytes = extractObjStmStreamBuffer(cand, state);

    streamCount += 1;
    if (streamCount > maxStreams) {
      throw new SecurityLimitExceededError(`PDF contains more than ${maxStreams} streams`);
    }

    const remainingTotal = maxTotalDecompressedBytes - totalDecompressedBytes;
    const budget = Math.min(maxDecompressedStreamBytes, remainingTotal);
    if (budget <= 0 && rawStreamBytes.length > 0) {
      throw new SecurityLimitExceededError(
        `Total PDF decompressed stream bytes exceed ${maxTotalDecompressedBytes} byte limit`,
      );
    }

    let decoded: Buffer;
    if (filterKind === 'flate') {
      let inflated;
      try {
        inflated = await inflateBounded(rawStreamBytes, {
          mode: 'zlib',
          maxOutputBytes: budget,
          maxCompressionRatio,
          ratioMinOutputBytes: 512,
          deadlineMs,
          retainOutput: true,
          entryLabel: label,
        });
      } catch (zlibErr: unknown) {
        if (
          zlibErr instanceof SecurityLimitExceededError ||
          zlibErr instanceof DocumentProcessingTimeoutError
        ) {
          throw zlibErr;
        }
        try {
          inflated = await inflateBounded(rawStreamBytes, {
            mode: 'raw',
            maxOutputBytes: budget,
            maxCompressionRatio,
            ratioMinOutputBytes: 512,
            deadlineMs,
            retainOutput: true,
            entryLabel: label,
          });
        } catch (rawErr: unknown) {
          if (
            rawErr instanceof SecurityLimitExceededError ||
            rawErr instanceof DocumentProcessingTimeoutError
          ) {
            throw rawErr;
          }
          throw new InvalidDocumentFormatError(`Malformed FlateDecode stream in ${label}`);
        }
      }
      totalDecompressedBytes += inflated.bytesOut;
      if (totalDecompressedBytes > maxTotalDecompressedBytes) {
        throw new SecurityLimitExceededError(
          `Total PDF decompressed stream bytes exceed ${maxTotalDecompressedBytes} byte limit`,
        );
      }
      decoded = inflated.buffer;
    } else {
      if (
        rawStreamBytes.length > budget ||
        totalDecompressedBytes + rawStreamBytes.length > maxTotalDecompressedBytes
      ) {
        throw new SecurityLimitExceededError(
          `Decompressed output for ${label} exceeds ${Math.min(budget, maxTotalDecompressedBytes)} byte security limit`,
        );
      }
      totalDecompressedBytes += rawStreamBytes.length;
      decoded = rawStreamBytes;
    }

    expandedObjStmIds.push(cand.objNum);

    if (first > decoded.length) {
      throw new InvalidDocumentFormatError(
        `Malformed ${label}: /First offset (${first}) exceeds stream length (${decoded.length})`,
      );
    }

    const headerRegion = decoded
      .subarray(0, first)
      .toString('latin1')
      .replace(/%[^\r\n]*/g, ' ')
      .trim();
    const headerTokens = headerRegion.length > 0 ? headerRegion.split(/\s+/) : [];
    if (headerTokens.length !== n * 2) {
      throw new InvalidDocumentFormatError(
        `Malformed ${label}: expected ${n * 2} header index tokens for /N ${n}, found ${headerTokens.length}`,
      );
    }

    const entries: Array<{ embeddedObjNum: number; absStart: number }> = [];
    let prevRelOffset = -1;
    for (let idx = 0; idx < n; idx += 1) {
      const objTok = headerTokens[idx * 2]!;
      const offTok = headerTokens[idx * 2 + 1]!;
      if (!/^\d+$/.test(objTok) || !/^\d+$/.test(offTok)) {
        throw new InvalidDocumentFormatError(
          `Malformed ${label}: non-integer header index token "${objTok} ${offTok}"`,
        );
      }
      const embeddedObjNum = parseInt(objTok, 10);
      const relOffset = parseInt(offTok, 10);
      if (!Number.isSafeInteger(embeddedObjNum) || embeddedObjNum <= 0) {
        throw new InvalidDocumentFormatError(
          `Malformed ${label}: invalid embedded object number ${objTok}`,
        );
      }
      if (
        !Number.isSafeInteger(relOffset) ||
        relOffset < 0 ||
        relOffset < prevRelOffset ||
        first + relOffset >= decoded.length
      ) {
        throw new InvalidDocumentFormatError(
          `Malformed ${label}: invalid embedded object offset ${offTok}`,
        );
      }
      prevRelOffset = relOffset;
      entries.push({ embeddedObjNum, absStart: first + relOffset });
    }

    for (let idx = 0; idx < entries.length; idx += 1) {
      state.objCount += 1;
      if (state.objCount > state.maxObjects) {
        throw new SecurityLimitExceededError(
          `PDF object count exceeds maximum inspected limit of ${state.maxObjects}`,
        );
      }
      if (state.objCount % 200 === 0 && Date.now() > deadlineMs) {
        throw new DocumentProcessingTimeoutError(
          'PDF object stream inspection exceeded timeout limit',
        );
      }

      const entry = entries[idx]!;
      const absEnd = idx + 1 < entries.length ? entries[idx + 1]!.absStart : decoded.length;
      const bodyText = decoded.subarray(entry.absStart, absEnd).toString('latin1').trim();
      if (!bodyText) {
        throw new InvalidDocumentFormatError(
          `Malformed ${label}: empty embedded object ${entry.embeddedObjNum}`,
        );
      }
      if (findTopLevelStreamOrEndObj(bodyText, 0).streamAt !== -1) {
        throw new InvalidDocumentFormatError(
          `Forbidden stream object ${entry.embeddedObjNum} inside ${label}`,
        );
      }

      const embeddedLabel = `PDF object ${entry.embeddedObjNum}`;
      state.objectsMap.set(entry.embeddedObjNum, bodyText);
      compressedObjectBodies.set(entry.embeddedObjNum, bodyText);
      recordVariant(state.objectBodyVariants, entry.embeddedObjNum, bodyText);

      const segDicts = collectDictionariesFromSegment(bodyText, state.counter);
      if (segDicts.length > 0) {
        const topDict = segDicts[0]!;
        if (resolvePdfDictType(topDict, state.objectsMap, embeddedLabel) === '/ObjStm') {
          throw new InvalidDocumentFormatError(
            `Forbidden nested /ObjStm object ${entry.embeddedObjNum} inside ${label}`,
          );
        }
        state.objectTopDicts.set(entry.embeddedObjNum, topDict);
        recordVariant(state.objectDictVariants, entry.embeddedObjNum, topDict);
      }
      for (const rootDict of segDicts) {
        for (const flat of flattenDictTree(rootDict)) {
          state.allDicts.push({ label: embeddedLabel, dict: flat });
        }
      }
      expandedObjectCount += 1;
    }
  }

  return {
    expandedObjectCount,
    expandedObjStmIds,
    compressedObjectBodies,
    decompressedBytes: totalDecompressedBytes,
    streamCount,
  };
}

function validatePreparedPdfGeometry(
  state: PreparedPdfState,
  expansionSummary: {
    hasObjectStreams: boolean;
    expandedObjectCount: number;
    expandedObjStmIds: number[];
    compressedObjectBodies: Map<number, string>;
    decompressedBytes: number;
    streamCount: number;
  },
): PdfGeometryValidationResult {
  const {
    limits,
    dpi,
    objectsMap,
    objectBodyVariants,
    objectTopDicts,
    objectDictVariants,
    allDicts,
    trailerDicts,
  } = state;

  // Helper returning every variant of an indirect PDF number/box/count when object numbers duplicate
  const parseBoxVariants = (rawValue: string, label: string, fieldName: string): PdfBox[] => {
    const resolvedList = resolveAllIndirectVariants(
      rawValue,
      objectBodyVariants,
      objectsMap,
      label,
      fieldName,
    );
    return resolvedList.map((resolved) => parsePdfBox(resolved, objectsMap, label, fieldName));
  };

  // 1. Validate every embedded /Image XObject (checking all indirect ref variants for /Width and /Height)
  for (const { label, dict } of allDicts) {
    const subtypeRaw = dict.entries.get('/Subtype');
    const subtypeVariants = subtypeRaw
      ? resolveAllIndirectVariants(subtypeRaw, objectBodyVariants, objectsMap, label, '/Subtype')
      : [''];
    if (subtypeVariants.some((s) => s === '/Image')) {
      const hasW = dict.entries.has('/Width');
      const hasH = dict.entries.has('/Height');
      const widths = hasW
        ? resolveAllIndirectVariants(
            dict.entries.get('/Width')!,
            objectBodyVariants,
            objectsMap,
            label,
            '/Width',
          ).map((v) => parseFinitePdfNumber(v, objectsMap, label, '/Width'))
        : [];
      const heights = hasH
        ? resolveAllIndirectVariants(
            dict.entries.get('/Height')!,
            objectBodyVariants,
            objectsMap,
            label,
            '/Height',
          ).map((v) => parseFinitePdfNumber(v, objectsMap, label, '/Height'))
        : [];
      for (const w of widths) {
        if (!Number.isSafeInteger(w) || w <= 0 || w > limits.maxImageWidth) {
          throw new SecurityLimitExceededError(
            `Embedded PDF image width (${w}) exceeds or violates maximum ${limits.maxImageWidth} pixels on ${label}`,
          );
        }
      }
      for (const h of heights) {
        if (!Number.isSafeInteger(h) || h <= 0 || h > limits.maxImageHeight) {
          throw new SecurityLimitExceededError(
            `Embedded PDF image height (${h}) exceeds or violates maximum ${limits.maxImageHeight} pixels on ${label}`,
          );
        }
      }
      for (const w of widths) {
        for (const h of heights) {
          assertPixelDimensionsWithinLimits(w, h, limits, `Embedded PDF image (${label})`);
        }
      }
    }
  }

  // 2. Locate root /Pages nodes from trailer -> Catalog, /XRef -> Catalog, or /Catalog objects
  const catalogPagesRefs: number[] = [];
  const checkRootCatalogRef = (rootRaw: string | undefined, sourceLabel: string) => {
    if (!rootRaw) return;
    const rootRef = parseIndirectRefNumber(rootRaw);
    if (rootRef === null) {
      throw new InvalidDocumentFormatError(
        `Invalid PDF /Root reference "${rootRaw}" in ${sourceLabel}`,
      );
    }
    const rootDict = objectTopDicts.get(rootRef);
    if (!rootDict) {
      throw new InvalidDocumentFormatError(
        `Missing referenced PDF /Root object ${rootRef} from ${sourceLabel}`,
      );
    }
    const rootType = resolvePdfDictType(rootDict, objectsMap, `PDF object ${rootRef}`);
    if (rootDict.entries.has('/Pages')) {
      const pagesRef = parseIndirectRefNumber(rootDict.entries.get('/Pages'));
      if (pagesRef === null) {
        throw new InvalidDocumentFormatError(
          `Invalid /Pages reference in PDF catalog object ${rootRef}`,
        );
      }
      if (!catalogPagesRefs.includes(pagesRef)) catalogPagesRefs.push(pagesRef);
    } else if (rootType === '/Catalog' && expansionSummary.hasObjectStreams) {
      throw new InvalidDocumentFormatError(
        `Malformed PDF catalog object ${rootRef} missing required /Pages reference`,
      );
    }
  };

  for (const td of trailerDicts) {
    checkRootCatalogRef(td.entries.get('/Root'), 'PDF trailer');
  }
  for (const [objNum, variants] of objectDictVariants.entries()) {
    for (const dict of variants) {
      const t = resolvePdfDictType(dict, objectsMap, `PDF object ${objNum}`);
      if (t === '/XRef') {
        checkRootCatalogRef(dict.entries.get('/Root'), `PDF /XRef object ${objNum}`);
      } else if (t === '/Catalog') {
        if (dict.entries.has('/Pages')) {
          const pagesRef = parseIndirectRefNumber(dict.entries.get('/Pages'));
          if (pagesRef === null) {
            throw new InvalidDocumentFormatError(
              `Invalid /Pages reference in PDF catalog object ${objNum}`,
            );
          }
          if (!catalogPagesRefs.includes(pagesRef)) catalogPagesRefs.push(pagesRef);
        } else if (expansionSummary.hasObjectStreams) {
          throw new InvalidDocumentFormatError(
            `Malformed PDF catalog object ${objNum} missing required /Pages reference`,
          );
        }
      }
    }
  }

  interface InheritedPageAttrs {
    mediaBox: PdfBox | undefined;
    cropBox: PdfBox | undefined;
    rotate: number | undefined;
  }

  interface ResolvedLeafPage {
    objNum: number | null;
    pageNumber: number;
    label: string;
    box: PdfBox | null;
    rotate: number;
    userUnit: number;
  }

  const resolvedLeafPages: ResolvedLeafPage[] = [];
  const orderedPageObjNums: number[] = [];
  const visitedTreeNodes = new Set<number>();
  const visitedPageObjects = new Set<number>();
  let maxDeclaredCount = 0;

  const parseOptionalUserUnit = (dict: PdfParsedDict, label: string): number => {
    if (!dict.entries.has('/UserUnit')) return 1;
    const variants = resolveAllIndirectVariants(
      dict.entries.get('/UserUnit')!,
      objectBodyVariants,
      objectsMap,
      label,
      '/UserUnit',
    );
    let maxU = 1;
    for (const raw of variants) {
      const u = parseFinitePdfNumber(raw, objectsMap, label, '/UserUnit');
      if (!Number.isFinite(u) || u <= 0) {
        throw new InvalidDocumentFormatError(
          `Invalid PDF /UserUnit value (${u}) on ${label}; must be positive`,
        );
      }
      if (u > maxU) maxU = u;
    }
    return maxU;
  };

  const parseRotateVariantsMax = (dict: PdfParsedDict, label: string): number[] => {
    if (!dict.entries.has('/Rotate')) return [];
    const variants = resolveAllIndirectVariants(
      dict.entries.get('/Rotate')!,
      objectBodyVariants,
      objectsMap,
      label,
      '/Rotate',
    );
    return variants.map((raw) => parsePdfRotate(raw, objectsMap, label));
  };

  const extractLocalAttrs = (dict: PdfParsedDict, label: string): Partial<InheritedPageAttrs> => {
    const attrs: Partial<InheritedPageAttrs> = {};
    if (dict.entries.has('/MediaBox')) {
      attrs.mediaBox = parseBoxVariants(dict.entries.get('/MediaBox')!, label, '/MediaBox')[0];
    }
    if (dict.entries.has('/CropBox')) {
      attrs.cropBox = parseBoxVariants(dict.entries.get('/CropBox')!, label, '/CropBox')[0];
    }
    if (dict.entries.has('/Rotate')) {
      attrs.rotate = parseRotateVariantsMax(dict, label)[0];
    }
    return attrs;
  };

  const resolveInheritedFromParents = (dict: PdfParsedDict, label: string): InheritedPageAttrs => {
    const chain: Array<{ dict: PdfParsedDict; label: string }> = [{ dict, label }];
    const seen = new Set<number>();
    let currentDict = dict;

    while (currentDict.entries.has('/Parent')) {
      const rawParent = currentDict.entries.get('/Parent');
      const parentObjNum = parseIndirectRefNumber(rawParent);
      if (parentObjNum === null) {
        throw new InvalidDocumentFormatError(
          `Invalid /Parent reference "${rawParent ?? ''}" on ${label}`,
        );
      }
      if (seen.has(parentObjNum)) {
        throw new InvalidDocumentFormatError(
          `Circular /Parent reference at object ${parentObjNum} in PDF page tree`,
        );
      }
      seen.add(parentObjNum);
      const parentDict = objectTopDicts.get(parentObjNum);
      if (!parentDict) {
        throw new InvalidDocumentFormatError(
          `Missing referenced PDF /Parent node object ${parentObjNum} on ${label}`,
        );
      }
      chain.push({ dict: parentDict, label: `PDF object ${parentObjNum}` });
      currentDict = parentDict;
    }

    let mediaBox: PdfBox | undefined;
    let cropBox: PdfBox | undefined;
    let rotate: number | undefined;
    for (let idx = chain.length - 1; idx >= 0; idx -= 1) {
      const local = extractLocalAttrs(chain[idx]!.dict, chain[idx]!.label);
      if (local.mediaBox !== undefined) mediaBox = local.mediaBox;
      if (local.cropBox !== undefined) cropBox = local.cropBox;
      if (local.rotate !== undefined) rotate = local.rotate;
    }
    return { mediaBox, cropBox, rotate };
  };

  // Helper verifying every variant of an object's attributes/inherited boxes satisfies per-page limits
  const assertDictAndIndirectVariantsWithinLimits = (
    dict: PdfParsedDict,
    inherited: InheritedPageAttrs,
    label: string,
  ): void => {
    const mediaVariants = dict.entries.has('/MediaBox')
      ? parseBoxVariants(dict.entries.get('/MediaBox')!, label, '/MediaBox')
      : inherited.mediaBox
        ? [inherited.mediaBox]
        : [];
    const cropVariants = dict.entries.has('/CropBox')
      ? parseBoxVariants(dict.entries.get('/CropBox')!, label, '/CropBox')
      : inherited.cropBox
        ? [inherited.cropBox]
        : [];
    const rotateVariants = dict.entries.has('/Rotate')
      ? parseRotateVariantsMax(dict, label)
      : [inherited.rotate ?? 0];
    const userUnit = parseOptionalUserUnit(dict, label);

    const effectiveBoxes: PdfBox[] = [];
    if (mediaVariants.length > 0 && cropVariants.length > 0) {
      for (const mb of mediaVariants) {
        for (const cb of cropVariants) {
          effectiveBoxes.push(intersectPdfBoxes(mb, cb, label));
        }
      }
    } else if (cropVariants.length > 0) {
      effectiveBoxes.push(...cropVariants);
    } else if (mediaVariants.length > 0) {
      effectiveBoxes.push(...mediaVariants);
    }

    for (const eff of effectiveBoxes) {
      for (const rot of rotateVariants) {
        const dims = computeRenderedPageDimensions(eff, rot, dpi, userUnit, label);
        assertPixelDimensionsWithinLimits(dims.width, dims.height, limits, `PDF page (${label})`);
      }
    }
  };

  // Pre-scan whether any /Page object references a parent /Pages node via /Parent
  const referencedParentObjIds = new Set<number>();
  for (const [objNum, variants] of objectDictVariants.entries()) {
    for (const dict of variants) {
      if (resolvePdfDictType(dict, objectsMap, `PDF object ${objNum}`) === '/Page') {
        const pRef = parseIndirectRefNumber(dict.entries.get('/Parent'));
        if (pRef !== null) referencedParentObjIds.add(pRef);
      }
    }
  }

  const walkTreeNode = (
    objNum: number,
    inherited: InheritedPageAttrs,
    ancestors: Set<number>,
  ): number => {
    if (ancestors.has(objNum)) {
      throw new InvalidDocumentFormatError(
        `Circular reference detected in PDF page tree at object ${objNum}`,
      );
    }
    if (visitedTreeNodes.has(objNum)) {
      throw new InvalidDocumentFormatError(
        `Duplicate page tree node reference to object ${objNum}`,
      );
    }
    const dict = objectTopDicts.get(objNum);
    if (!dict) {
      throw new InvalidDocumentFormatError(
        `Missing referenced PDF page tree node object ${objNum}`,
      );
    }

    visitedTreeNodes.add(objNum);
    const label = `PDF object ${objNum}`;

    if (dict.entries.has('/Parent')) {
      const parentObjNum = parseIndirectRefNumber(dict.entries.get('/Parent'));
      if (parentObjNum === null || !objectTopDicts.has(parentObjNum)) {
        throw new InvalidDocumentFormatError(
          `Missing or invalid referenced PDF /Parent node ${dict.entries.get('/Parent') ?? ''} on ${label}`,
        );
      }
    }

    let declaredCount: number | null = null;
    if (dict.entries.has('/Count')) {
      const countVariants = resolveAllIndirectVariants(
        dict.entries.get('/Count')!,
        objectBodyVariants,
        objectsMap,
        label,
        '/Count',
      );
      for (const rawC of countVariants) {
        const c = parseFinitePdfNumber(rawC, objectsMap, label, '/Count');
        if (!Number.isSafeInteger(c) || c < 0) {
          throw new InvalidDocumentFormatError(`Invalid /Count value (${c}) on ${label}`);
        }
        if (c > maxDeclaredCount) maxDeclaredCount = c;
        if (limits.maxInputPages !== undefined && c > limits.maxInputPages) {
          throw new SecurityLimitExceededError(
            `PDF declares ${c} pages, exceeding maximum input limit of ${limits.maxInputPages} pages`,
          );
        }
        if (declaredCount === null) declaredCount = c;
      }
    }

    const local = extractLocalAttrs(dict, label);
    const merged: InheritedPageAttrs = {
      mediaBox: local.mediaBox ?? inherited.mediaBox,
      cropBox: local.cropBox ?? inherited.cropBox,
      rotate: local.rotate ?? inherited.rotate,
    };

    if (dict.entries.has('/Kids')) {
      const resolvedKids = resolveIndirectValue(
        dict.entries.get('/Kids')!,
        objectsMap,
        label,
        '/Kids',
      );
      const kidTokens = tokenizeArrayItems(resolvedKids);
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(objNum);
      let subtreeLeaves = 0;
      for (const tok of kidTokens) {
        const kidObjNum = parseIndirectRefNumber(tok);
        if (kidObjNum === null) {
          throw new InvalidDocumentFormatError(`Invalid /Kids entry "${tok}" on ${label}`);
        }
        subtreeLeaves += walkTreeNode(kidObjNum, merged, nextAncestors);
      }
      if (declaredCount !== null && subtreeLeaves !== declaredCount) {
        throw new InvalidDocumentFormatError(
          `Inconsistent PDF /Count (${declaredCount}) on ${label}; resolved ${subtreeLeaves} page(s)`,
        );
      }
      return subtreeLeaves;
    }

    assertDictAndIndirectVariantsWithinLimits(dict, inherited, label);
    const nodeType = resolvePdfDictType(dict, objectsMap, label);
    const localUserUnit = parseOptionalUserUnit(dict, label);
    if (nodeType === '/Pages') {
      if (
        expansionSummary.hasObjectStreams &&
        declaredCount !== null &&
        declaredCount > 0 &&
        !referencedParentObjIds.has(objNum)
      ) {
        throw new InvalidDocumentFormatError(
          `Malformed /Pages node ${label} declaring /Count ${declaredCount} without /Kids in /ObjStm document`,
        );
      }
      // Synthetic /Pages node without /Kids (e.g., << /Type /Pages /Count 5 /MediaBox ... >>)
      const effectiveBox =
        merged.mediaBox && merged.cropBox
          ? intersectPdfBoxes(merged.mediaBox, merged.cropBox, label)
          : (merged.cropBox ?? merged.mediaBox ?? null);
      if (effectiveBox !== null && !referencedParentObjIds.has(objNum)) {
        const countRaw = declaredCount ?? 1;
        const syntheticCopies = Math.min(Math.max(1, countRaw), limits.maxInputPages ?? 200);
        for (let k = 0; k < syntheticCopies; k += 1) {
          resolvedLeafPages.push({
            objNum: null,
            pageNumber: resolvedLeafPages.length + 1,
            label,
            box: effectiveBox,
            rotate: merged.rotate ?? 0,
            userUnit: localUserUnit,
          });
        }
        return syntheticCopies;
      }
      return declaredCount ?? 0;
    }

    visitedPageObjects.add(objNum);
    orderedPageObjNums.push(objNum);
    const effectiveBox =
      merged.mediaBox && merged.cropBox
        ? intersectPdfBoxes(merged.mediaBox, merged.cropBox, label)
        : (merged.cropBox ?? merged.mediaBox ?? null);

    resolvedLeafPages.push({
      objNum,
      pageNumber: resolvedLeafPages.length + 1,
      label,
      box: effectiveBox,
      rotate: merged.rotate ?? 0,
      userUnit: localUserUnit,
    });
    return 1;
  };

  for (const rootPagesObjNum of catalogPagesRefs) {
    if (!visitedTreeNodes.has(rootPagesObjNum)) {
      walkTreeNode(
        rootPagesObjNum,
        { mediaBox: undefined, cropBox: undefined, rotate: undefined },
        new Set(),
      );
    }
  }

  // Handle rootless /Pages trees (e.g. no /Catalog) when catalog walk did not cover them
  for (const [objNum, dict] of objectTopDicts.entries()) {
    if (
      !visitedTreeNodes.has(objNum) &&
      resolvePdfDictType(dict, objectsMap, `PDF object ${objNum}`) === '/Pages' &&
      !dict.entries.has('/Parent')
    ) {
      walkTreeNode(
        objNum,
        { mediaBox: undefined, cropBox: undefined, rotate: undefined },
        new Set(),
      );
    }
  }

  // Handle any unvisited /Type /Page objects (orphan pages) + check all duplicate variants of every /Page
  for (const [objNum, variants] of objectDictVariants.entries()) {
    const label = `PDF object ${objNum}`;
    for (const dict of variants) {
      if (resolvePdfDictType(dict, objectsMap, label) === '/Page') {
        const attrs = resolveInheritedFromParents(dict, label);
        assertDictAndIndirectVariantsWithinLimits(dict, attrs, label);

        if (!visitedPageObjects.has(objNum)) {
          visitedPageObjects.add(objNum);
          orderedPageObjNums.push(objNum);
          const effectiveBox =
            attrs.mediaBox && attrs.cropBox
              ? intersectPdfBoxes(attrs.mediaBox, attrs.cropBox, label)
              : (attrs.cropBox ?? attrs.mediaBox ?? null);
          resolvedLeafPages.push({
            objNum,
            pageNumber: resolvedLeafPages.length + 1,
            label,
            box: effectiveBox,
            rotate: attrs.rotate ?? 0,
            userUnit: parseOptionalUserUnit(dict, label),
          });
        }
      }
    }
  }

  // Also check any unvisited /Type /Pages nodes and any duplicate leaf/root variants
  for (const [objNum, variants] of objectDictVariants.entries()) {
    const label = `PDF object ${objNum}`;
    for (const dict of variants) {
      if (resolvePdfDictType(dict, objectsMap, label) === '/Pages') {
        if (dict.entries.has('/Count')) {
          const c = parseFinitePdfNumber(dict.entries.get('/Count')!, objectsMap, label, '/Count');
          if (!Number.isSafeInteger(c) || c < 0) {
            throw new InvalidDocumentFormatError(`Invalid /Count value (${c}) on ${label}`);
          }
          if (c > maxDeclaredCount) maxDeclaredCount = c;
          if (limits.maxInputPages !== undefined && c > limits.maxInputPages) {
            throw new SecurityLimitExceededError(
              `PDF declares ${c} pages, exceeding maximum input limit of ${limits.maxInputPages} pages`,
            );
          }
        }
        if (!visitedTreeNodes.has(objNum) && !dict.entries.has('/Kids')) {
          assertDictAndIndirectVariantsWithinLimits(
            dict,
            { mediaBox: undefined, cropBox: undefined, rotate: undefined },
            label,
          );
        }
      }
    }
  }

  // Validate standalone dictionaries that specify boxes without being /Page or /Pages nodes
  for (const { label, dict } of allDicts) {
    const t = resolvePdfDictType(dict, objectsMap, label);
    if (
      t !== '/Page' &&
      t !== '/Pages' &&
      (dict.entries.has('/MediaBox') || dict.entries.has('/CropBox'))
    ) {
      assertDictAndIndirectVariantsWithinLimits(
        dict,
        { mediaBox: undefined, cropBox: undefined, rotate: undefined },
        label,
      );
    }
  }

  const totalInputPages = Math.max(resolvedLeafPages.length, maxDeclaredCount);
  if (limits.maxInputPages !== undefined && totalInputPages > limits.maxInputPages) {
    throw new SecurityLimitExceededError(
      `PDF contains ${totalInputPages} pages, exceeding maximum input limit of ${limits.maxInputPages} pages`,
    );
  }

  // 3. Enforce per-page rendered bounds on EVERY page and aggregate pixel budget across rendered pages
  const renderedLimit =
    limits.maxRenderedPages !== undefined
      ? Math.max(0, limits.maxRenderedPages)
      : resolvedLeafPages.length;
  let aggregatePixels = 0n;

  for (let i = 0; i < resolvedLeafPages.length; i += 1) {
    const page = resolvedLeafPages[i]!;
    if (!page.box) continue;
    const dims = computeRenderedPageDimensions(
      page.box,
      page.rotate,
      dpi,
      page.userUnit,
      `PDF page ${page.pageNumber}`,
    );
    assertPixelDimensionsWithinLimits(
      dims.width,
      dims.height,
      limits,
      `PDF rendered page ${page.pageNumber}`,
    );

    if (i < renderedLimit) {
      aggregatePixels += BigInt(dims.width) * BigInt(dims.height);
      if (
        limits.maxAggregatePixels !== undefined &&
        aggregatePixels > BigInt(limits.maxAggregatePixels)
      ) {
        throw new SecurityLimitExceededError(
          `PDF aggregate rendered pixel count (${aggregatePixels.toString()}) exceeds maximum allowed ${limits.maxAggregatePixels} pixels`,
        );
      }
    }
  }

  return {
    hasObjectStreams: expansionSummary.hasObjectStreams,
    totalPages: totalInputPages,
    resolvedLeafPageCount:
      visitedPageObjects.size > 0 ? visitedPageObjects.size : resolvedLeafPages.length,
    orderedPageObjNums,
    expandedObjectCount: expansionSummary.expandedObjectCount,
    expandedObjStmIds: expansionSummary.expandedObjStmIds,
    objectBodies: expansionSummary.compressedObjectBodies,
    decompressedBytes: expansionSummary.decompressedBytes,
    streamCount: expansionSummary.streamCount,
  };
}

/**
 * Validates PDF page tree geometry asynchronously, boundedly decompressing and inspecting
 * `/ObjStm` compressed object streams before invoking pdftoppm or Tesseract.
 */
export async function assertPdfGeometryWithinLimitsAsync(
  input: Buffer | string,
  limits: ImageDimensionLimits,
): Promise<PdfGeometryValidationResult> {
  const state = preparePdfInspectionState(input, limits);
  const candidates = collectObjectStreamCandidates(state);
  const hasObjectStreams = candidates.length > 0;
  const expanded = await expandPdfObjectStreamsAsync(state, candidates);

  return validatePreparedPdfGeometry(state, {
    hasObjectStreams,
    ...expanded,
  });
}

/**
 * Synchronous PDF geometry validation for documents without compressed `/ObjStm` streams.
 * Fails closed when `/ObjStm` streams are present so no page-tree node can be skipped.
 */
export function assertPdfGeometryWithinLimits(pdfText: string, limits: ImageDimensionLimits): void {
  const state = preparePdfInspectionState(pdfText, limits);
  const candidates = collectObjectStreamCandidates(state);
  if (candidates.length > 0) {
    throw new InvalidDocumentFormatError(
      'PDF contains object streams (/ObjStm); use async assertPdfGeometryWithinLimitsAsync for bounded inspection',
    );
  }

  validatePreparedPdfGeometry(state, {
    hasObjectStreams: false,
    expandedObjectCount: 0,
    expandedObjStmIds: [],
    compressedObjectBodies: new Map(),
    decompressedBytes: 0,
    streamCount: 0,
  });
}
