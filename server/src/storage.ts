import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdirSync, writeFileSync, createReadStream, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { env, r2Enabled } from './env.js';

// Cloudflare R2 object storage for the original uploaded bill files. R2 speaks
// the S3 API, so the AWS SDK works against its account-scoped endpoint. Stays a
// no-op until R2_* credentials are configured (see `r2Enabled`).

export { r2Enabled };

let client: S3Client | null = null;
function r2(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
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

export async function putBill(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2().send(
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType })
  );
}

export async function getBill(
  key: string
): Promise<{ body: Readable; contentType: string } | null> {
  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    if (!out.Body) return null;
    return { body: out.Body as Readable, contentType: out.ContentType ?? 'application/octet-stream' };
  } catch (err) {
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
