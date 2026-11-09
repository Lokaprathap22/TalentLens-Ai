import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, MockResumeScanner, EICAR_SIGNATURE } from './resume.scanner.js';

class MockClamAvServer {
  private server: net.Server | null = null;
  public port = 0;
  public receivedData = Buffer.alloc(0);
  public mode: 'OK' | 'FOUND' | 'ERROR' | 'MALFORMED' | 'HANG' = 'OK';
  public customThreatName = 'Win.Test.EICAR_HDB-1';

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let isReceivingChunks = false;
        let command = '';

        socket.on('data', (chunk) => {
          if (!isReceivingChunks) {
            command += chunk.toString('utf8');
            if (command.includes('zINSTREAM\0')) {
              isReceivingChunks = true;
            }
          }

          if (this.mode === 'HANG') {
            // Do not reply to trigger timeout
            return;
          }

          // Check for termination marker: 4 zero bytes
          if (chunk.length >= 4 && chunk.readUInt32BE(chunk.length - 4) === 0) {
            if (this.mode === 'OK') {
              socket.write('stream: OK\0');
            } else if (this.mode === 'FOUND') {
              socket.write(`stream: ${this.customThreatName} FOUND\0`);
            } else if (this.mode === 'ERROR') {
              socket.write('stream: Scan failed ERROR\0');
            } else if (this.mode === 'MALFORMED') {
              socket.write('UNKNOWN RESPONSE WITHOUT PROTOCOL DELIMITER\0');
            }
            socket.end();
          }
        });
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(addr.port);
      });

      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

describe('ClamAvScanner — Antivirus Daemon Protocol Tests', () => {
  let server: MockClamAvServer;

  beforeEach(async () => {
    server = new MockClamAvServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('scans clean buffer and returns CLEAN status', async () => {
    server.mode = 'OK';
    const scanner = new ClamAvScanner({
      host: '127.0.0.1',
      port: server.port,
    });

    const cleanPdf = Buffer.from('%PDF-1.4 sample clean document content');
    const result = await scanner.scan(cleanPdf, 'clean-resume.pdf');

    expect(result.status).toBe('CLEAN');
    expect(result.threatName).toBeUndefined();
  });

  it('detects malware and returns INFECTED status with threat name', async () => {
    server.mode = 'FOUND';
    server.customThreatName = 'Trojan.Resume.Script-99';
    const scanner = new ClamAvScanner({
      host: '127.0.0.1',
      port: server.port,
    });

    const testBuffer = Buffer.from('%PDF-1.4 malicious resume content');
    const result = await scanner.scan(testBuffer, 'infected-resume.pdf');

    expect(result.status).toBe('INFECTED');
    expect(result.threatName).toBe('Trojan.Resume.Script-99');
  });

  it('handles ClamAV daemon error and returns ERROR status', async () => {
    server.mode = 'ERROR';
    const scanner = new ClamAvScanner({
      host: '127.0.0.1',
      port: server.port,
    });

    const testBuffer = Buffer.from('%PDF-1.4 test document');
    const result = await scanner.scan(testBuffer, 'error-test.pdf');

    expect(result.status).toBe('ERROR');
    expect(result.errorMessage).toContain('Scan failed ERROR');
  });

  it('handles socket connection timeout gracefully without hanging', async () => {
    server.mode = 'HANG';
    const scanner = new ClamAvScanner({
      host: '127.0.0.1',
      port: server.port,
      timeoutMs: 150, // Short timeout for unit test
    });

    const testBuffer = Buffer.from('%PDF-1.4 test document');
    const result = await scanner.scan(testBuffer, 'timeout-test.pdf');

    expect(result.status).toBe('ERROR');
    expect(result.errorMessage).toContain('timeout');
  });

  it('handles unreachable daemon socket connection error', async () => {
    const scanner = new ClamAvScanner({
      host: '127.0.0.1',
      port: 19998, // Closed port
      timeoutMs: 500,
    });

    const testBuffer = Buffer.from('%PDF-1.4 test document');
    const result = await scanner.scan(testBuffer, 'unreachable.pdf');

    expect(result.status).toBe('ERROR');
    expect(result.errorMessage).toBeDefined();
  });
});

describe('MockResumeScanner — Development and EICAR Detection Tests', () => {
  it('detects standard EICAR test string and reports INFECTED', async () => {
    const scanner = new MockResumeScanner();
    const eicarBuffer = Buffer.from(`%PDF-1.4\n${EICAR_SIGNATURE}\n%%EOF`);

    const result = await scanner.scan(eicarBuffer, 'eicar-sample.pdf');

    expect(result.status).toBe('INFECTED');
    expect(result.threatName).toBe('Win.Test.EICAR_HDB-1');
  });

  it('passes normal clean document buffer', async () => {
    const scanner = new MockResumeScanner();
    const cleanBuffer = Buffer.from('%PDF-1.4 Normal candidate resume text %%EOF');

    const result = await scanner.scan(cleanBuffer, 'john-doe.pdf');

    expect(result.status).toBe('CLEAN');
  });

  it('supports forced status for test suite fault injection', async () => {
    const scanner = new MockResumeScanner({
      forceStatus: 'ERROR',
      errorMessage: 'Simulated antivirus offline',
    });

    const result = await scanner.scan(Buffer.from('data'), 'test.pdf');
    expect(result.status).toBe('ERROR');
    expect(result.errorMessage).toBe('Simulated antivirus offline');
  });
});
