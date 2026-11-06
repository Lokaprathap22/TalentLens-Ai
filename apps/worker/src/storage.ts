import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';
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

export class WorkerStorageService {
  private readonly storageRoot: string;
  private readonly driver: 'local' | 's3';
  private readonly bucket?: string | undefined;
  private readonly region?: string | undefined;
  private readonly endpoint?: string | undefined;
  private readonly accessKeyId?: string | undefined;
  private readonly secretAccessKey?: string | undefined;
  private readonly forcePathStyle?: boolean | undefined;

  constructor(storageRoot?: string) {
    this.storageRoot = resolveStorageRoot(storageRoot);
    this.driver = (process.env['STORAGE_DRIVER'] ?? 'local') as 'local' | 's3';

    if (this.driver === 's3') {
      this.bucket = process.env['S3_BUCKET'];
      this.accessKeyId = process.env['S3_ACCESS_KEY_ID'] || process.env['AWS_ACCESS_KEY_ID'];
      this.secretAccessKey =
        process.env['S3_SECRET_ACCESS_KEY'] || process.env['AWS_SECRET_ACCESS_KEY'];
      this.region = process.env['S3_REGION'] || process.env['AWS_REGION'] || 'us-east-1';
      this.endpoint = process.env['S3_ENDPOINT'];
      this.forcePathStyle =
        process.env['S3_FORCE_PATH_STYLE'] === 'true' ||
        Boolean(
          this.endpoint &&
          (this.endpoint.includes('localhost') || this.endpoint.includes('127.0.0.1')),
        );

      const nodeEnv = process.env['NODE_ENV'];
      const isProductionOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

      if (!this.bucket || !this.accessKeyId || !this.secretAccessKey) {
        if (isProductionOrStaging) {
          throw new Error(
            'Worker requires S3 credentials (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) in production/staging',
          );
        }
      }
    }
  }

  public getRoot(): string {
    return this.storageRoot;
  }

  public async read(key: string): Promise<Buffer> {
    if (
      !key ||
      key.includes('\0') ||
      key.includes('..') ||
      path.isAbsolute(key) ||
      key.startsWith('/') ||
      key.endsWith('/') ||
      key.includes('\\')
    ) {
      throw new Error('Path traversal detected');
    }

    if (this.driver === 's3' && this.bucket && this.accessKeyId && this.secretAccessKey) {
      return this.readFromS3(key);
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

  private async readFromS3(key: string): Promise<Buffer> {
    const endpoint = this.endpoint
      ? this.endpoint.replace(/\/+$/, '')
      : `https://s3.${this.region}.amazonaws.com`;
    const parsedEndpoint = new URL(endpoint);

    let requestUrl: string;
    let hostHeader: string;

    if (this.forcePathStyle) {
      requestUrl = `${endpoint}/${this.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
      hostHeader = parsedEndpoint.host;
    } else {
      requestUrl = `${parsedEndpoint.protocol}//${this.bucket}.${parsedEndpoint.host}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
      hostHeader = `${this.bucket}.${parsedEndpoint.host}`;
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    const canonicalUri = this.forcePathStyle
      ? `/${this.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
      : `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${headers[k]!.trim()}\n`)
      .join('');
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      'GET',
      canonicalUri,
      '',
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

    const signingKey = getSigV4Key(this.secretAccessKey!, dateStamp, this.region!, 's3');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(requestUrl, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`S3 read failed with HTTP ${res.status}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}
