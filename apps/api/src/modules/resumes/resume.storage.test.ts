import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LocalDocumentStorageService,
  StorageNotFoundError,
  StoragePathTraversalError,
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
