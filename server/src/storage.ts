import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { mkdirSync, writeFileSync, createReadStream, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { env, r2Enabled } from './env.js';

// Cloudflare R2 object storage for the original uploaded bill files. R2 speaks
// the S3 API, so the AWS SDK works against its account-scoped endpoint. Stays a
// no-op until R2_* credentials are configured (see `r2Enabled`).

export { r2Enabled };

let client: S3Client | null = null;

// The client's configuration, exported so a test can check what actually goes
// over the wire rather than trusting the options are still set.
export function r2Config(): S3ClientConfig {
  return {
    region: 'auto',
    endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    ...(env.R2_ENDPOINT ? { forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // R2 speaks S3, but not every part of it. From v3.729 the AWS SDK sends a
    // CRC32 checksum header on every upload by default (and asks for one back
    // on every download), which R2 refuses — so a PutObject fails outright,
    // for a reason that has nothing to do with the credentials or the bucket.
    //
    // It matters more here than it looks: putBillFile catches that failure and
    // writes to local disk instead, so nothing appears broken — receipts still
    // open — while the bucket quietly holds none of them. And the WhatsApp
    // integration rests entirely on that bucket being shared with CYWorkspace,
    // which passes an object KEY rather than bytes.
    //
    // 'WHEN_REQUIRED' still sends a checksum where the API demands one; it
    // just stops adding them where they are optional. Correct against real S3
    // too, so this is not an R2-only workaround.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

function r2(): S3Client {
  if (!client) client = new S3Client(r2Config());
  return client;
}

// Storage-key prefix for an object that lives in the shared bucket but belongs
// to another system (CYWorkspace's WhatsApp attachments). CYBills reads those
// by key rather than copying the bytes — the two apps deliberately hold one
// bucket — and never deletes them.
export const SHARED_PREFIX = 'shared:';

// File extension for the S3 object key from a MIME type; '' when unknown.
export function extFor(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  };
  return map[mediaType] ?? '';
}

// How the bucket has been answering, kept so it can be SHOWN rather than only
// logged. The fallback to local disk below is right — a receipt must never be
// lost to a storage outage — and it is also exactly what let a misconfigured
// bucket go unnoticed for weeks: every upload "worked", every file landed on
// the VPS's own disk, and the only trace was a line in the server log. So each
// outcome is recorded here and read by the practice's storage status
// (storageCare.ts → GET /api/practice/storage), which says so on screen.
export type StorageHealth = {
  lastSuccessAt: string;
  lastFailureAt: string;
  lastFailureOp: string;
  lastFailureMessage: string;
  // Uploads that fell back to local disk since the process started.
  fallbacks: number;
};
const health: StorageHealth = { lastSuccessAt: '', lastFailureAt: '', lastFailureOp: '', lastFailureMessage: '', fallbacks: 0 };
export const storageHealth = (): StorageHealth => ({ ...health });
function noteSuccess(): void {
  health.lastSuccessAt = new Date().toISOString();
}
function noteFailure(op: string, err: unknown): void {
  health.lastFailureAt = new Date().toISOString();
  health.lastFailureOp = op;
  const e = err as { name?: string; message?: string };
  health.lastFailureMessage = [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
}

export async function putBill(key: string, body: Buffer, contentType: string): Promise<void> {
  try {
    await r2().send(
      new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType })
    );
    noteSuccess();
  } catch (err) {
    noteFailure('put', err);
    throw err;
  }
}

// The stored size of an object, or null when it isn't there (or can't be
// asked). What a copy is checked against before anything is pointed at it.
export async function objectSize(key: string): Promise<number | null> {
  try {
    const out = await r2().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    return typeof out.ContentLength === 'number' ? out.ContentLength : null;
  } catch {
    return null;
  }
}

// Every key under a prefix, for the backup's retention sweep.
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const out = await r2().send(
      new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function deleteKey(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

export async function getBill(
  key: string
): Promise<{ body: Readable; contentType: string } | null> {
  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    if (!out.Body) return null;
    noteSuccess();
    return { body: out.Body as Readable, contentType: out.ContentType ?? 'application/octet-stream' };
  } catch (err) {
    // A missing object is the caller's answer (null), not the bucket failing.
    if ((err as { name?: string })?.name !== 'NoSuchKey') noteFailure('get', err);
    console.error('[storage] R2 get failed', err);
    return null;
  }
}

// --- Local-disk fallback ----------------------------------------------------
// When R2 isn't configured, keep the original bytes on disk under the bills data
// dir (gitignored, survives `git reset --hard` on deploy) so uploaded receipts
// are still viewable. `storageKey` is prefixed (`r2:` / `local:`) so the file
// endpoint knows which backend to read.
const FILES_DIR = `${env.BILLS_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url))}/files`;

// Where a `local:` key's bytes are on disk, for moving them into the bucket.
export const localFilePath = (storageKey: string): string => `${FILES_DIR}/${storageKey.slice('local:'.length)}`;

function putBillLocal(
  orgId: string,
  fileHash: string,
  ext: string,
  bytes: Buffer,
  contentType: string
): { storageKey: string; contentType: string } {
  mkdirSync(FILES_DIR, { recursive: true });
  const name = `${orgId}_${fileHash}${ext ? `.${ext}` : ''}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  writeFileSync(`${FILES_DIR}/${name}`, bytes);
  return { storageKey: `local:${name}`, contentType };
}

// Store the uploaded bytes; returns the prefixed storageKey + resolved MIME type.
// Prefers R2 when configured, but falls back to local disk if R2 is disabled OR
// the R2 write fails (misconfigured creds/bucket) — so a receipt is never lost.
export async function putBillFile(
  orgId: string,
  fileHash: string,
  mediaType: string,
  bytes: Buffer
): Promise<{ storageKey: string; contentType: string }> {
  const ext = extFor(mediaType);
  const contentType = mediaType || 'application/octet-stream';
  if (r2Enabled) {
    try {
      const key = `bills/${orgId}/${fileHash}${ext ? `.${ext}` : ''}`;
      await putBill(key, bytes, contentType);
      return { storageKey: `r2:${key}`, contentType };
    } catch (err) {
      health.fallbacks += 1;
      console.error('[storage] R2 put failed; falling back to local disk', err);
    }
  }
  return putBillLocal(orgId, fileHash, ext, bytes, contentType);
}

// Permanently remove a stored file, routing on the storageKey prefix. Used only
// by a hard delete (the record is being removed for good), so the bytes are
// reclaimed rather than orphaned. Best-effort: a missing object/file is fine,
// and any backend error is logged but never fails the delete of the record.
export async function deleteBillFile(storageKey: string): Promise<void> {
  if (!storageKey) return;
  // `shared:` is an object ANOTHER system put in the bucket we share with it —
  // a WhatsApp attachment CYWorkspace stored and still holds its own record of.
  // Deleting a document here must not reach into their book and destroy the
  // file behind it, so the reference is dropped and the object is left alone.
  if (storageKey.startsWith(SHARED_PREFIX)) return;
  if (storageKey.startsWith('local:')) {
    const path = `${FILES_DIR}/${storageKey.slice('local:'.length)}`;
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.error('[storage] local delete failed', err);
    }
    return;
  }
  if (!r2Enabled) return;
  // `r2:`-prefixed, or a legacy bare key (only ever created under R2).
  const key = storageKey.startsWith('r2:') ? storageKey.slice('r2:'.length) : storageKey;
  try {
    await r2().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  } catch (err) {
    console.error('[storage] R2 delete failed', err);
  }
}

// Read a stored file back, routing on the storageKey prefix. `contentTypeHint`
// is the MIME persisted with the bill (used for local files).
export async function getBillFile(
  storageKey: string,
  contentTypeHint = ''
): Promise<{ body: Readable; contentType: string } | null> {
  // An object in the shared bucket that another system owns: read exactly like
  // one of ours, because it IS in our bucket — only the ownership differs.
  if (storageKey.startsWith(SHARED_PREFIX)) return getBill(storageKey.slice(SHARED_PREFIX.length));
  if (storageKey.startsWith('local:')) {
    const path = `${FILES_DIR}/${storageKey.slice('local:'.length)}`;
    if (!existsSync(path)) return null;
    return { body: createReadStream(path), contentType: contentTypeHint || 'application/octet-stream' };
  }
  // `r2:`-prefixed, or a legacy bare key (only ever created under R2).
  const key = storageKey.startsWith('r2:') ? storageKey.slice('r2:'.length) : storageKey;
  return getBill(key);
}
