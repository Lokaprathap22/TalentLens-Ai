import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { DocumentStorageService, StoredFileDescriptor } from './resume.types.js';

export class StoragePathTraversalError extends Error {
  constructor(message = 'Invalid storage path: traversal detected') {
    super(message);
    this.name = 'StoragePathTraversalError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(message = 'Stored file not found') {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}

export interface LocalStorageConfig {
  storageRoot: string;
}

export class LocalDocumentStorageService implements DocumentStorageService {
  private readonly storageRoot: string;

  constructor(config: LocalStorageConfig) {
    this.storageRoot = path.resolve(config.storageRoot);
  }

  public getRoot(): string {
    return this.storageRoot;
  }

  public generateKey(extension: string): string {
    const cleanExt = extension.replace(/^\.+/, '').toLowerCase();
    const datePrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    return `${datePrefix}/${randomUUID()}.${cleanExt}`;
  }

  private resolvePath(key: string): string {
    // Disallow null bytes or absolute paths
    if (key.includes('\0') || path.isAbsolute(key)) {
      throw new StoragePathTraversalError();
    }

    const resolved = path.resolve(this.storageRoot, key);

    // Verify target path is strictly inside storage root
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;

    if (!resolved.startsWith(rootWithSep)) {
      throw new StoragePathTraversalError();
    }

    return resolved;
  }

  public async save(key: string, content: Buffer): Promise<StoredFileDescriptor> {
    const targetPath = this.resolvePath(key);
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });

    // Write to a temporary file first for atomic finalization
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, targetPath);

    return {
      storageKey: key,
      sizeBytes: content.length,
    };
  }

  public async saveFromPath(key: string, sourcePath: string): Promise<StoredFileDescriptor> {
    const targetPath = this.resolvePath(key);
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });

    // Atomically move sourcePath to targetPath (or copy if cross-device)
    try {
      await fs.rename(sourcePath, targetPath);
    } catch {
      await fs.copyFile(sourcePath, targetPath);
      await fs.unlink(sourcePath).catch(() => {});
    }

    const stat = await fs.stat(targetPath);
    return {
      storageKey: key,
      sizeBytes: stat.size,
    };
  }

  public async read(key: string): Promise<Buffer> {
    const targetPath = this.resolvePath(key);
    try {
      return await fs.readFile(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageNotFoundError();
      }
      throw err;
    }
  }

  public async delete(key: string): Promise<void> {
    const targetPath = this.resolvePath(key);
    try {
      await fs.unlink(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  public async exists(key: string): Promise<boolean> {
    const targetPath = this.resolvePath(key);
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

function findRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
}

export function resolveStorageRoot(customRoot?: string): string {
  const root = customRoot ?? process.env['RESUME_STORAGE_ROOT'] ?? './storage/resumes';
  if (path.isAbsolute(root)) {
    return path.normalize(root);
  }
  return path.resolve(findRepositoryRoot(), root);
}

export function createDocumentStorageService(storageRoot?: string): DocumentStorageService {
  return new LocalDocumentStorageService({ storageRoot: resolveStorageRoot(storageRoot) });
}
