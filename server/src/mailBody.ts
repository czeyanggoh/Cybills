// A mail's HTML part, kept so the message can be shown as it was sent.
//
// The mirror holds a mail's TEXT part, and most paperwork that is an email —
// an order confirmation, a booking, a receipt — is laid out in the other one:
// the plain part of the same message is a flattened copy, its table a run of
// lines and its links written out in angle brackets. Shown from that, a
// confirmation that reads at a glance in a mail client reads as a wall here.
//
// In file storage rather than on the mirrored row, for the reason the row's
// own `html` is capped and dropped: that store is one JSON file, and a
// marketing email runs to hundreds of kilobytes. A leaf, like mailThread.ts.
import { createHash } from 'node:crypto';
import { getBillFile, putBillFile } from './storage.js';

// A mail larger than this is a newsletter with its images inlined; what is
// kept of it is the plain text.
const MAX_BYTES = 2 * 1024 * 1024;

/** Store the HTML part; answers with its storage key, '' where there is none. */
export async function storeMailBody(scope: string, html: string): Promise<string> {
  const text = String(html ?? '');
  if (!text.trim()) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BYTES) return '';
  // Hashed with a prefix of its own: storage is content-addressed, and a mail
  // body must never share a key with a document's file, which is deleted with
  // its document.
  const hash = createHash('sha256').update('mail-body\n').update(bytes).digest('hex');
  try {
    return (await putBillFile(scope, hash, 'text/html', bytes)).storageKey;
  } catch {
    return '';
  }
}

/**
 * The HTML of a mirrored message, '' where none was kept.
 *
 * A row mirrored before bodies were stored may still hold its markup itself —
 * it is kept there while a link waits to be fetched — so that is the fallback.
 */
export async function readMailBody(m: { bodyKey?: string; html?: string } | null): Promise<string> {
  if (!m) return '';
  if (m.bodyKey) {
    const file = await getBillFile(m.bodyKey, 'text/html');
    if (file) {
      const chunks: Buffer[] = [];
      for await (const c of file.body) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString('utf8');
    }
  }
  return String(m.html || '');
}
