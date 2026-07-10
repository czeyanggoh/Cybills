import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
