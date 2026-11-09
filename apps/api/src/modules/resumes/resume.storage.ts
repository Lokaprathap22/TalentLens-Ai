import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { DocumentStorageService, StoredFileDescriptor } from './resume.types.js';
export type { DocumentStorageService, StoredFileDescriptor };

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

export interface S3StorageConfig {
  bucket: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean | undefined;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function getSigV4Key(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Buffer {
  const kDate = hmacSha256('AWS4' + key, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, 'aws4_request');
}

export class S3DocumentStorageService implements DocumentStorageService {
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;

  constructor(config: S3StorageConfig) {
    if (!config.bucket || config.bucket.trim().length === 0) {
      throw new Error('S3 bucket must be provided');
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 accessKeyId and secretAccessKey must be provided');
    }

    this.bucket = config.bucket.trim();
    this.region = config.region ?? 'ap-hyderabad-1';
    const customEndpoint = config.endpoint ? config.endpoint.replace(/\/+$/, '') : undefined;
    this.endpoint = customEndpoint ?? `https://s3.${this.region}.amazonaws.com`;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.forcePathStyle =
      config.forcePathStyle ??
      Boolean(
        customEndpoint &&
        (customEndpoint.includes('localhost') ||
          customEndpoint.includes('127.0.0.1') ||
          customEndpoint.includes(':')),
      );
  }

  public generateKey(extension: string): string {
    const cleanExt = extension.replace(/^\.+/, '').toLowerCase();
    const datePrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    return `${datePrefix}/${randomUUID()}.${cleanExt}`;
  }

  public validateKey(key: string): void {
    if (
      !key ||
      key.includes('\0') ||
      key.includes('..') ||
      key.startsWith('/') ||
      key.endsWith('/') ||
      key.includes('\\') ||
      path.isAbsolute(key)
    ) {
      throw new StoragePathTraversalError('Path traversal detected in S3 storage key');
    }

    const segments = key.split('/');
    if (segments.length === 0 || segments.some((s) => !s || s === '.' || s === '..')) {
      throw new StoragePathTraversalError('Path traversal detected in S3 storage key');
    }

    const safeSegmentRegex = /^[a-zA-Z0-9_.-]+$/;
    if (!segments.every((s) => safeSegmentRegex.test(s))) {
      throw new StoragePathTraversalError('Invalid storage key format: unsafe characters');
    }
  }

  private async s3Request(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    body?: Buffer,
  ): Promise<Response> {
    this.validateKey(key);

    const parsedEndpoint = new URL(this.endpoint);
    let requestUrl: string;
    let hostHeader: string;

    if (this.forcePathStyle) {
      requestUrl = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
      hostHeader = parsedEndpoint.host;
    } else {
      requestUrl = `${parsedEndpoint.protocol}//${this.bucket}.${parsedEndpoint.host}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
      hostHeader = `${this.bucket}.${parsedEndpoint.host}`;
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    if (method === 'PUT') {
      headers['content-type'] = 'application/octet-stream';
      const byteLength = body ? (Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)) : 0;
      headers['content-length'] = String(byteLength);
      headers['x-amz-server-side-encryption'] = 'AES256';
    }

    // SigV4 Canonical Request
    const canonicalUri = this.forcePathStyle
      ? `/${this.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
      : `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${headers[k]!.trim()}\n`)
      .join('');
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSigV4Key(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const fetchOptions: RequestInit = {
      method,
      headers,
    };
    if (body && method === 'PUT') {
      fetchOptions.body = new Uint8Array(body);
    }

    return await fetch(requestUrl, fetchOptions);
  }

  public async save(key: string, content: Buffer): Promise<StoredFileDescriptor> {
    const res = await this.s3Request('PUT', key, content);
    if (!res.ok) {
      throw new Error(`S3 PUT object failed: HTTP ${res.status}`);
    }
    return {
      storageKey: key,
      sizeBytes: content.length,
    };
  }

  public async saveFromPath(key: string, sourcePath: string): Promise<StoredFileDescriptor> {
    const content = await fs.readFile(sourcePath);
    const result = await this.save(key, content);
    await fs.unlink(sourcePath).catch(() => {});
    return result;
  }

  public async read(key: string): Promise<Buffer> {
    const res = await this.s3Request('GET', key);
    if (res.status === 404) {
      throw new StorageNotFoundError();
    }
    if (!res.ok) {
      throw new Error(`S3 GET object failed: HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  public async delete(key: string): Promise<void> {
    const res = await this.s3Request('DELETE', key);
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE object failed: HTTP ${res.status}`);
    }
  }

  public async exists(key: string): Promise<boolean> {
    const res = await this.s3Request('HEAD', key);
    if (res.status === 200) {
      return true;
    }
    if (res.status === 404) {
      return false;
    }
    throw new Error(`S3 HEAD object failed: HTTP ${res.status}`);
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
  const driver = process.env['STORAGE_DRIVER'] ?? 'local';
  const nodeEnv = process.env['NODE_ENV'];
  const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

  if (driver === 's3') {
    const bucket = process.env['S3_BUCKET'];
    const accessKeyId = process.env['S3_ACCESS_KEY_ID'] || process.env['AWS_ACCESS_KEY_ID'];
    const secretAccessKey =
      process.env['S3_SECRET_ACCESS_KEY'] || process.env['AWS_SECRET_ACCESS_KEY'];
    const region = process.env['S3_REGION'] || process.env['AWS_REGION'] || 'ap-hyderabad-1';
    const endpoint = process.env['S3_ENDPOINT'];
    const forcePathStyle = process.env['S3_FORCE_PATH_STYLE'] === 'true';

    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'S3 storage driver configured but missing required environment variables: S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must all be defined',
      );
    }

    return new S3DocumentStorageService({
      bucket,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
    });
  }

  if (nodeEnv === 'production') {
    throw new Error(
      'Production and staging deployments require STORAGE_DRIVER=s3 with shared private S3 object storage. Local filesystem storage is not permitted in production.',
    );
  }

  if (isProductionOrStaging && process.env['ALLOW_LOCAL_STORAGE_IN_PRODUCTION'] !== 'true') {
    throw new Error(
      'Production and staging deployments require STORAGE_DRIVER=s3 with shared private S3 object storage. Local filesystem storage is not permitted across distributed instances.',
    );
  }

  return new LocalDocumentStorageService({ storageRoot: resolveStorageRoot(storageRoot) });
}
