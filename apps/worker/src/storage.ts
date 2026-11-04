import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
}

export function resolveStorageRoot(customRoot?: string): string {
  const root = customRoot ?? process.env['RESUME_STORAGE_ROOT'] ?? './storage/resumes';
  if (path.isAbsolute(root)) {
    return path.normalize(root);
  }
  return path.resolve(findRepositoryRoot(), root);
}

export class WorkerStorageService {
  private readonly storageRoot: string;

  constructor(storageRoot?: string) {
    this.storageRoot = resolveStorageRoot(storageRoot);
  }

  public getRoot(): string {
    return this.storageRoot;
  }

  public async read(key: string): Promise<Buffer> {
    if (key.includes('\0') || path.isAbsolute(key)) {
      throw new Error('Invalid storage key');
    }
    const resolved = path.resolve(this.storageRoot, key);
    const rootWithSep = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;

    if (!resolved.startsWith(rootWithSep)) {
      throw new Error('Path traversal detected');
    }

    return fs.readFile(resolved);
  }
}
