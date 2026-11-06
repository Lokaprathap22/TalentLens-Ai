import net from 'node:net';

export interface ScanResult {
  status: 'CLEAN' | 'INFECTED' | 'ERROR';
  threatName?: string | undefined;
  errorMessage?: string | undefined;
}

export interface ResumeScanner {
  scan(buffer: Buffer, fileName: string): Promise<ScanResult>;
}

export interface ClamAvScannerOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  chunkSize?: number;
  failClosed?: boolean;
}

export const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export class ClamAvScanner implements ResumeScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;
  public readonly failClosed: boolean;

  constructor(options: ClamAvScannerOptions) {
    this.host = options.host.trim();
    this.port = options.port ?? 3310;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.chunkSize = options.chunkSize ?? 64 * 1024; // 64KB chunk
    this.failClosed = options.failClosed ?? true;
  }

  public async scan(buffer: Buffer, _fileName: string): Promise<ScanResult> {
    return new Promise((resolve) => {
      let resolved = false;
      let socket: net.Socket | null = null;
      let timer: NodeJS.Timeout | null = null;
      let responseBuffer = '';

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      const safeResolve = (result: ScanResult) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(result);
        }
      };

      timer = setTimeout(() => {
        safeResolve({
          status: 'ERROR',
          errorMessage: `ClamAV scan timeout after ${this.timeoutMs}ms connecting to ${this.host}:${this.port}`,
        });
      }, this.timeoutMs);

      socket = net.createConnection({ host: this.host, port: this.port }, () => {
        if (!socket) return;
        // zINSTREAM uses null byte delimiter
        socket.write('zINSTREAM\0');

        // Stream buffer in chunks
        let offset = 0;
        const total = buffer.length;

        const writeNextChunk = () => {
          if (!socket || socket.destroyed) return;

          while (offset < total) {
            const end = Math.min(offset + this.chunkSize, total);
            const chunk = buffer.subarray(offset, end);
            offset = end;

            const lenPrefix = Buffer.alloc(4);
            lenPrefix.writeUInt32BE(chunk.length, 0);

            const canContinue = socket.write(lenPrefix) && socket.write(chunk);
            if (!canContinue) {
              socket.once('drain', writeNextChunk);
              return;
            }
          }

          // Terminate stream with 4 zero bytes
          socket.write(Buffer.alloc(4, 0));
        };

        writeNextChunk();
      });

      socket.on('data', (chunk) => {
        responseBuffer += chunk.toString('utf8');
        // ClamAV responses are null-byte or newline terminated:
        // "stream: OK\0" or "stream: Win.Test.EICAR_HDB-1 FOUND\0" or "stream: ... ERROR\0"
        if (responseBuffer.includes('\0') || responseBuffer.includes('\n')) {
          const trimmed = responseBuffer.replace(/[\0\r\n]+$/, '').trim();

          if (trimmed.includes('FOUND')) {
            const threatMatch = /stream:\s*(.+?)\s+FOUND/i.exec(trimmed);
            const threatName = threatMatch && threatMatch[1] ? threatMatch[1] : 'Malware detected';
            safeResolve({
              status: 'INFECTED',
              threatName,
            });
          } else if (trimmed.includes('OK')) {
            safeResolve({
              status: 'CLEAN',
            });
          } else if (trimmed.includes('ERROR')) {
            safeResolve({
              status: 'ERROR',
              errorMessage: `ClamAV daemon returned error: ${trimmed}`,
            });
          } else {
            safeResolve({
              status: 'ERROR',
              errorMessage: `Malformed ClamAV response: ${trimmed}`,
            });
          }
        }
      });

      socket.on('error', (err) => {
        safeResolve({
          status: 'ERROR',
          errorMessage: `ClamAV socket connection error: ${err.message}`,
        });
      });
    });
  }
}

export class MockResumeScanner implements ResumeScanner {
  public forceStatus?: ('CLEAN' | 'INFECTED' | 'ERROR') | undefined;
  public simulatedThreatName?: string | undefined;
  public errorMessage?: string | undefined;
  public scanCallCount = 0;

  constructor(options?: {
    forceStatus?: ('CLEAN' | 'INFECTED' | 'ERROR') | undefined;
    simulatedThreatName?: string | undefined;
    errorMessage?: string | undefined;
  }) {
    this.forceStatus = options?.forceStatus;
    this.simulatedThreatName = options?.simulatedThreatName;
    this.errorMessage = options?.errorMessage;
  }

  public async scan(buffer: Buffer, _fileName: string): Promise<ScanResult> {
    this.scanCallCount++;

    if (this.forceStatus) {
      if (this.forceStatus === 'INFECTED') {
        return {
          status: 'INFECTED',
          threatName: this.simulatedThreatName ?? 'Mock.Malware.Signature',
        };
      }
      if (this.forceStatus === 'ERROR') {
        return {
          status: 'ERROR',
          errorMessage: this.errorMessage ?? 'Mock scanner unavailable',
        };
      }
      return { status: 'CLEAN' };
    }

    // Default behavior: Detect standard EICAR test signature
    const content = buffer.toString('binary');
    if (content.includes(EICAR_SIGNATURE)) {
      return {
        status: 'INFECTED',
        threatName: 'Win.Test.EICAR_HDB-1',
      };
    }

    return { status: 'CLEAN' };
  }
}

export function createResumeScanner(): ResumeScanner {
  const driver = process.env['SCANNER_DRIVER'];
  const host = process.env['CLAMAV_HOST'];
  const port = process.env['CLAMAV_PORT'] ? parseInt(process.env['CLAMAV_PORT'], 10) : 3310;
  const nodeEnv = process.env['NODE_ENV'];
  const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

  if (driver === 'clamav' || host) {
    return new ClamAvScanner({
      host: host ?? 'localhost',
      port,
      failClosed: process.env['SCANNER_FAIL_CLOSED'] !== 'false',
    });
  }

  if (isProductionOrStaging) {
    // In production/staging, fail-closed scanner is required
    return new ClamAvScanner({
      host: host ?? 'localhost',
      port,
      failClosed: true,
    });
  }

  // Development/test mock scanner
  return new MockResumeScanner();
}
