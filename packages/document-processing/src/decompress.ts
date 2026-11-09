import zlib from 'node:zlib';

import {
  DocumentProcessingTimeoutError,
  InvalidDocumentFormatError,
  SecurityLimitExceededError,
} from './errors.js';

export interface BoundedInflateOptions {
  mode: 'raw' | 'zlib';
  maxOutputBytes: number;
  maxCompressionRatio?: number | undefined;
  ratioMinOutputBytes?: number | undefined;
  hasUnknownCompressedLength?: boolean | undefined;
  deadlineMs: number;
  retainOutput?: boolean | undefined;
  entryLabel?: string | undefined;
}

export interface BoundedInflateResult {
  buffer: Buffer;
  bytesOut: number;
  compressedBytesConsumed: number;
}

/**
 * Decompresses raw DEFLATE or zlib-wrapped DEFLATE streams incrementally using small
 * fixed-size buffers, aborting immediately before accumulating bytes past hard limits.
 */
export function inflateBounded(
  compressed: Buffer,
  options: BoundedInflateOptions,
): Promise<BoundedInflateResult> {
  const {
    mode,
    maxOutputBytes,
    maxCompressionRatio,
    ratioMinOutputBytes = 512,
    hasUnknownCompressedLength = false,
    deadlineMs,
    retainOutput = true,
    entryLabel = 'stream',
  } = options;

  if (Date.now() > deadlineMs) {
    return Promise.reject(
      new DocumentProcessingTimeoutError(`Timed out while preparing to decompress ${entryLabel}`),
    );
  }

  if (maxOutputBytes < 0) {
    return Promise.reject(
      new SecurityLimitExceededError(
        `Decompressed output for ${entryLabel} exceeds configured byte budget`,
      ),
    );
  }

  return new Promise<BoundedInflateResult>((resolve, reject) => {
    const stream =
      mode === 'raw'
        ? zlib.createInflateRaw({ chunkSize: 8192 })
        : zlib.createInflate({ chunkSize: 8192 });

    const chunks: Buffer[] = [];
    let bytesOut = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (!stream.destroyed) {
        stream.destroy();
      }
      reject(err);
    };

    const checkBudget = (incomingLen: number): Error | null => {
      if (Date.now() > deadlineMs) {
        return new DocumentProcessingTimeoutError(
          `Document processing exceeded timeout limit while decompressing ${entryLabel}`,
        );
      }

      const nextTotal = bytesOut + incomingLen;
      if (nextTotal > maxOutputBytes) {
        return new SecurityLimitExceededError(
          `Decompressed output for ${entryLabel} exceeds ${maxOutputBytes} byte security limit`,
        );
      }

      if (maxCompressionRatio !== undefined && nextTotal > ratioMinOutputBytes) {
        const denominator = hasUnknownCompressedLength
          ? Math.max(stream.bytesWritten || compressed.length, 1)
          : Math.max(compressed.length, 1);
        if (nextTotal / denominator > maxCompressionRatio) {
          return new SecurityLimitExceededError(
            `Decompression ratio for ${entryLabel} exceeds ${maxCompressionRatio}:1 security threshold`,
          );
        }
      }

      return null;
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;

      const limitError = checkBudget(chunk.length);
      if (limitError) {
        fail(limitError);
        return;
      }

      bytesOut += chunk.length;
      if (retainOutput) {
        chunks.push(chunk);
      }
    });

    stream.once('error', (err: Error) => {
      if (settled) return;
      if (
        err instanceof SecurityLimitExceededError ||
        err instanceof DocumentProcessingTimeoutError ||
        err instanceof InvalidDocumentFormatError
      ) {
        fail(err);
        return;
      }
      fail(new InvalidDocumentFormatError(`Failed to decompress ${entryLabel}: ${err.message}`));
    });

    stream.once('end', () => {
      if (settled) return;
      const finalError = checkBudget(0);
      if (finalError) {
        fail(finalError);
        return;
      }

      const consumed = stream.bytesWritten || compressed.length;
      if (maxCompressionRatio !== undefined && bytesOut > ratioMinOutputBytes && consumed > 0) {
        if (bytesOut / consumed > maxCompressionRatio) {
          fail(
            new SecurityLimitExceededError(
              `Decompression ratio for ${entryLabel} exceeds ${maxCompressionRatio}:1 security threshold`,
            ),
          );
          return;
        }
      }

      settled = true;
      resolve({
        buffer: retainOutput ? Buffer.concat(chunks, bytesOut) : Buffer.alloc(0),
        bytesOut,
        compressedBytesConsumed: consumed,
      });
    });

    // Feed compressed input in bounded slices so huge inputs or bombs cannot queue unboundedly
    const inputSliceSize = 8192;
    let offset = 0;

    const pump = () => {
      while (offset < compressed.length && !settled && !stream.destroyed) {
        if (Date.now() > deadlineMs) {
          fail(
            new DocumentProcessingTimeoutError(
              `Document processing exceeded timeout limit while reading ${entryLabel}`,
            ),
          );
          return;
        }
        const nextEnd = Math.min(offset + inputSliceSize, compressed.length);
        const slice = compressed.subarray(offset, nextEnd);
        offset = nextEnd;
        const canContinue = stream.write(slice);
        if (!canContinue) {
          stream.once('drain', pump);
          return;
        }
      }

      if (offset >= compressed.length && !settled && !stream.destroyed) {
        stream.end();
      }
    };

    pump();
  });
}
