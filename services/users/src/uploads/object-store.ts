import { Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * The object-store boundary (feature 016, roadmap 4.9 — research R2/R6).
 *
 * ⚠️ THIS IS THE ONLY FILE IN THE REPOSITORY THAT IMPORTS `@aws-sdk/client-s3`, and
 * `tests/uploads/single-ingest-path.spec.ts` fails the build if that stops being true. The
 * concentration is not tidiness — it IS the SEC-1 fix. "One validated path" is only checkable if
 * validation and storage are the same component; the moment a second file can write to the bucket,
 * the single-path guarantee is a convention again, which is precisely the defect being closed.
 *
 * The same client serves MinIO (dev, `beton-test`) and a managed private bucket in production —
 * `endpoint` + `forcePathStyle` is the whole difference (spec Q1 rejected a two-backend abstraction
 * because a security boundary asserted twice is proven once).
 *
 * ── No presigner, deliberately ───────────────────────────────────────────────────────────────────
 * There is no `getSignedUrl` here and there must not be. Reads are brokered so authorization is
 * evaluated at request time (FR-010); a signed URL grants access to whoever holds it for the length
 * of its window, which is the SEC-10 leaked-link case with extra steps.
 *
 * ── No bucket policy is ever set from code ───────────────────────────────────────────────────────
 * Privacy is asserted at provisioning (compose's one-shot `minio-init` runs `mc anonymous set none`).
 * Nothing here can widen it, because nothing here can set a policy at all.
 */

/** Injection token. Consumers depend on the INTERFACE so Track A can substitute the fake. */
export const OBJECT_STORE = 'OBJECT_STORE';

export interface ObjectStore {
  /** Store `body` at `key`. Overwrites — keys are uuid-based, so a collision is a bug, not a case. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The stored bytes, or `null` when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove `key`. Removing something absent is a no-op — this is called on a failure path. */
  delete(key: string): Promise<void>;
}

/** Config read from the environment, already validated refuse-to-start by `loadUsersConfig`. */
export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function objectStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig {
  return {
    endpoint: env.S3_ENDPOINT as string,
    region: env.S3_REGION as string,
    bucket: env.S3_BUCKET as string,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    // Any value other than a literal "false" means path style — MinIO needs it, and defaulting the
    // OTHER way would make a typo silently produce virtual-host URLs that fail at runtime.
    forcePathStyle: (env.S3_FORCE_PATH_STYLE as string) !== 'false',
  };
}

/** Errors from the store carry a CLASS, never a key, a filename or a response body (FR-020). */
export class ObjectStoreError extends Error {
  constructor(operation: 'put' | 'get' | 'delete', cause: unknown) {
    super(`object store ${operation} failed: ${cause instanceof Error ? cause.name : 'unknown'}`);
    this.name = 'ObjectStoreError';
  }
}

@Injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject('OBJECT_STORE_CONFIG') private readonly cfg: ObjectStoreConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          // The VERIFIED type. Stored on the object too so an operator inspecting the bucket sees
          // what the product decided, not what a client claimed. The served header comes from the
          // database row regardless — this is legibility, not a source of truth.
          ContentType: contentType,
        }),
      );
    } catch (err) {
      throw new ObjectStoreError('put', err);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new ObjectStoreError('get', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw new ObjectStoreError('delete', err);
    }
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || code === 404;
}
