import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LocalDocumentStorageService,
  S3DocumentStorageService,
  StorageNotFoundError,
  StoragePathTraversalError,
  createDocumentStorageService,
} from './resume.storage.js';

describe('Document Storage Service — Path Safety and Atomic Writes', () => {
  let tempStorageRoot: string;
  let storage: LocalDocumentStorageService;

  beforeAll(async () => {
    tempStorageRoot = path.join(os.tmpdir(), `talentlens-storage-test-${randomUUID()}`);
    await fs.mkdir(tempStorageRoot, { recursive: true });
    storage = new LocalDocumentStorageService({ storageRoot: tempStorageRoot });
  });

  afterAll(async () => {
    await fs.rm(tempStorageRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('generates date-partitioned random storage keys', () => {
    const key = storage.generateKey('pdf');
    expect(key).toMatch(/^\d{4}-\d{2}\/[0-9a-f-]+\.pdf$/i);
  });

  it('saves and reads a document buffer atomically', async () => {
    const key = '2026-11/test-document.pdf';
    const content = Buffer.from('PDF Content Data');

    const stored = await storage.save(key, content);
    expect(stored.storageKey).toBe(key);
    expect(stored.sizeBytes).toBe(content.length);

    const exists = await storage.exists(key);
    expect(exists).toBe(true);

    const readBack = await storage.read(key);
    expect(readBack.toString('utf8')).toBe('PDF Content Data');
  });

  it('saves from a temporary file path atomically', async () => {
    const srcTemp = path.join(os.tmpdir(), `test-src-${randomUUID()}.tmp`);
    await fs.writeFile(srcTemp, 'Content from temporary upload');

    const key = '2026-11/moved-document.docx';
    const stored = await storage.saveFromPath(key, srcTemp);
    expect(stored.sizeBytes).toBe(Buffer.from('Content from temporary upload').length);

    const readBack = await storage.read(key);
    expect(readBack.toString('utf8')).toBe('Content from temporary upload');

    // Source temp file should no longer exist (moved)
    const srcExists = await fs
      .access(srcTemp)
      .then(() => true)
      .catch(() => false);
    expect(srcExists).toBe(false);
  });

  it('rejects path traversal attempts with ../', async () => {
    const maliciousKey = '../../outside-root.txt';
    const content = Buffer.from('malicious payload');

    await expect(storage.save(maliciousKey, content)).rejects.toThrow(StoragePathTraversalError);
    await expect(storage.read(maliciousKey)).rejects.toThrow(StoragePathTraversalError);
  });

  it('rejects absolute paths as keys', async () => {
    const absoluteKey = path.resolve(os.tmpdir(), 'some-arbitrary-file.txt');
    await expect(storage.save(absoluteKey, Buffer.from('bad'))).rejects.toThrow(
      StoragePathTraversalError,
    );
  });

  it('rejects null byte injections in storage keys', async () => {
    const nullByteKey = 'legit.pdf\0../../etc/passwd';
    await expect(storage.save(nullByteKey, Buffer.from('bad'))).rejects.toThrow(
      StoragePathTraversalError,
    );
  });

  it('throws StorageNotFoundError for missing documents', async () => {
    await expect(storage.read('2026-11/non-existent-file.pdf')).rejects.toThrow(
      StorageNotFoundError,
    );
  });

  it('deletes documents cleanly and idempotently', async () => {
    const key = '2026-11/to-delete.pdf';
    await storage.save(key, Buffer.from('temporary'));
    expect(await storage.exists(key)).toBe(true);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);

    // Second delete is a safe no-op
    await expect(storage.delete(key)).resolves.not.toThrow();
  });

  it('resolves relative storage paths consistently against the repository root', async () => {
    const { resolveStorageRoot } = await import('./resume.storage.js');
    const resolved = resolveStorageRoot('./storage/resumes');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toMatch(/[\\/]storage[\\/]resumes$/);
  });
});

describe('S3DocumentStorageService — Private S3 Adapter and SigV4 Controls', () => {
  let mockS3Server: http.Server;
  let mockS3Port: number;
  const s3Store = new Map<string, Buffer>();

  beforeAll(async () => {
    mockS3Server = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method;

      // Extract storage key from path style URL: /test-bucket/{key}
      const match = /^\/test-bucket\/(.+)$/.exec(url);
      if (!match) {
        res.statusCode = 404;
        res.end('Bucket not found');
        return;
      }

      const key = decodeURIComponent(match[1]!);

      if (method === 'PUT') {
        const auth = req.headers['authorization'];
        if (!auth || !auth.startsWith('AWS4-HMAC-SHA256')) {
          res.statusCode = 403;
          res.end('AccessDenied: Invalid signature');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          s3Store.set(key, Buffer.concat(chunks));
          res.statusCode = 200;
          res.end();
        });
      } else if (method === 'GET') {
        if (!s3Store.has(key)) {
          res.statusCode = 404;
          res.end('NoSuchKey');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(s3Store.get(key));
      } else if (method === 'HEAD') {
        if (!s3Store.has(key)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.end();
      } else if (method === 'DELETE') {
        s3Store.delete(key);
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 405;
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockS3Server.listen(0, '127.0.0.1', () => {
        const addr = mockS3Server.address() as { port: number };
        mockS3Port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockS3Server.close(() => resolve());
    });
  });

  it('generates opaque date-partitioned storage keys', () => {
    const s3 = new S3DocumentStorageService({
      bucket: 'test-bucket',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secretTestKey123',
    });

    const key = s3.generateKey('pdf');
    expect(key).toMatch(/^\d{4}-\d{2}\/[0-9a-f-]+\.pdf$/i);
  });

  it('uploads, exists, reads, and deletes objects in private S3 bucket', async () => {
    const s3 = new S3DocumentStorageService({
      bucket: 'test-bucket',
      endpoint: `http://127.0.0.1:${mockS3Port}`,
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secretTestKey123',
      forcePathStyle: true,
    });

    const key = '2026-11/cand-resume-1.pdf';
    const content = Buffer.from('%PDF-1.4 candidate credentials');

    const saved = await s3.save(key, content);
    expect(saved.storageKey).toBe(key);
    expect(saved.sizeBytes).toBe(content.length);

    const exists = await s3.exists(key);
    expect(exists).toBe(true);

    const readData = await s3.read(key);
    expect(readData.toString('utf8')).toBe('%PDF-1.4 candidate credentials');

    await s3.delete(key);
    const existsAfter = await s3.exists(key);
    expect(existsAfter).toBe(false);

    await expect(s3.read(key)).rejects.toThrow(StorageNotFoundError);
  });

  it('rejects path traversal attempts with ../ in S3 storage keys', async () => {
    const s3 = new S3DocumentStorageService({
      bucket: 'test-bucket',
      endpoint: `http://127.0.0.1:${mockS3Port}`,
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secretTestKey123',
    });

    await expect(s3.save('../../etc/passwd', Buffer.from('bad'))).rejects.toThrow(
      StoragePathTraversalError,
    );
    await expect(s3.read('../../etc/passwd')).rejects.toThrow(StoragePathTraversalError);
    await expect(s3.delete('/absolute/path.pdf')).rejects.toThrow(StoragePathTraversalError);
  });

  it('fails closed when STORAGE_DRIVER=s3 is set but required credentials are missing', () => {
    const originalEnv = { ...process.env };
    try {
      process.env['STORAGE_DRIVER'] = 's3';
      delete process.env['S3_BUCKET'];
      delete process.env['S3_ACCESS_KEY_ID'];
      delete process.env['S3_SECRET_ACCESS_KEY'];

      expect(() => createDocumentStorageService()).toThrow(
        /S3 storage driver configured but missing required environment variables/,
      );
    } finally {
      process.env = originalEnv;
    }
  });

  it('fails closed in production/staging when STORAGE_DRIVER=local is configured', () => {
    const originalEnv = { ...process.env };
    try {
      process.env['NODE_ENV'] = 'production';
      process.env['STORAGE_DRIVER'] = 'local';
      delete process.env['ALLOW_LOCAL_STORAGE_IN_PRODUCTION'];

      expect(() => createDocumentStorageService()).toThrow(
        /Production and staging deployments require STORAGE_DRIVER=s3/,
      );
    } finally {
      process.env = originalEnv;
    }
  });
});
