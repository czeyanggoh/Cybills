// The document behind a LINK.
//
// Most bills that arrive at an entity's address carry the invoice as an
// attachment, and the attachment road files it. A growing number carry a LINK
// instead — Xero's own subscription invoice is the case that prompted this
// ("View your bill online: INV-7822201", and the PDF is behind a login) — and
// that mail filed nothing at all: no document, no trace, no reason, just a
// delivery that answered `created: 0`.
//
// CYBills holds no credentials for any of those portals and should not. n8n
// does, and already runs retrievals of exactly this kind, so "what is behind
// this link" is asked THERE and this module is the one road it is asked down.
// Synchronous by design: what comes back is filed and read in the same
// background pass an attachment gets, so a document that arrived by link is
// indistinguishable afterwards from one that arrived as a file.
//
// Every failure here is a NOTE rather than an exception. A mail that yields
// nothing is still mirrored in the Email tab carrying the reason, which is the
// whole point of that tab: "I sent that last week" needs an answer even —
// especially — when nothing was filed.
import { env } from './env.js';
import { sniffMediaType, type ReaderMedia } from './mediaType.js';

/** Whether a link can be followed at all. Unset, the road is simply not there. */
export const n8nEnabled = (): boolean => Boolean(String(env.N8N_FETCH_URL || '').trim());

export type FetchedDocument = { bytes: Buffer; fileName: string; mediaType: ReaderMedia };

export type LinkFetchResult = {
  documents: FetchedDocument[];
  /** What happened, in words a reviewer can act on. Always set. */
  note: string;
  /** Whether n8n was actually called — an unconfigured road is not a failure. */
  attempted: boolean;
};

// A file this big is not a receipt, and holding one in memory on the road
// nobody is watching is how a server falls over quietly.
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_LINKS = 25;

// The http(s) links in one message, in the order they were written, deduped.
//
// Both halves are read: the HTML is where a mail client puts the anchor a
// person actually clicked ("INV-7822201"), and the text part is where a
// forwarded plain-text copy leaves the bare URL. Nothing is judged here about
// WHICH link is the invoice — that is n8n's job, and it is the half that knows
// what a Xero billing URL looks like.
export function linksIn(text: string, html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    let url = String(raw || '')
      .replace(/&amp;/gi, '&')
      .trim();
    // Trailing punctuation belongs to the sentence, not to the URL: a link at
    // the end of a line arrives as "…/invoice/7822201." more often than not.
    url = url.replace(/[.,;:!?)\]}>'"]+$/, '');
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < MAX_LINKS) out.push(url);
  };
  const source = String(html || '');
  for (const m of source.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(m[0]);
  // A plain-text URL sitting inside the HTML part too (Outlook writes both).
  for (const m of source.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(m[0]);
  return out;
}

// n8n answers in more than one shape depending on how the workflow was wired —
// a Respond-to-Webhook node returns `[{ json: … }]`, a binary passthrough
// returns `{ data, mimeType, fileName }`, a hand-built response returns
// whatever the author typed. Rather than insist on one, every object in the
// reply is treated as a possible document and the ones carrying bytes are kept.
function itemsIn(data: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 4 || !data) return [];
  if (Array.isArray(data)) return data.flatMap((d) => itemsIn(d, depth + 1));
  if (typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const nested = ['documents', 'files', 'attachments', 'json', 'binary', 'data', 'result']
    .filter((k) => o[k] && typeof o[k] === 'object')
    .flatMap((k) => itemsIn(o[k], depth + 1));
  return [o, ...nested];
}

const BASE64_KEYS = ['contentBase64', 'fileBase64', 'pdfBase64', 'base64', 'content', 'data', 'file', 'pdf', 'body'];
const NAME_KEYS = ['fileName', 'filename', 'name', 'title'];

const pick = (o: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

// The bytes on one item, or null. A `data:` URI counts — it is what a browser
// step in a workflow hands back — and so does bare base64.
function bytesOf(o: Record<string, unknown>): Buffer | null {
  const raw = pick(o, BASE64_KEYS);
  if (!raw) return null;
  const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  // A cheap pre-filter before decoding: Buffer.from will happily turn a
  // sentence into three bytes of nonsense. Deliberately NOT a size floor —
  // what makes these bytes a document is `sniffMediaType` a line below, and a
  // threshold here would only ever refuse a real, small one.
  if (!/^[A-Za-z0-9+/\r\n=_-]{8,}$/.test(b64)) return null;
  const bytes = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length ? bytes : null;
}

// A name for the file. n8n usually gives one; where it does not, the link's own
// last path segment is better than "document", because it is what the portal
// called it — and a file name travels to the reader as the sender's own label.
function nameFor(given: string, link: string, mediaType: string): string {
  const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType.split('/')[1] || 'pdf';
  const fromLink = (() => {
    try {
      const seg = new URL(link).pathname.split('/').filter(Boolean).pop() || '';
      return /[a-z0-9]/i.test(seg) ? seg : '';
    } catch {
      return '';
    }
  })();
  const base = given || fromLink || 'linked-document';
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}

// Keep a document only where the BYTES say it is one. This is the load-bearing
// check on this road: a portal that wants a login answers 200 with an HTML
// sign-in page, and a workflow that hands it back verbatim — under
// `application/pdf`, named `invoice.pdf`, because that is what the author typed
// — would otherwise be filed as a cost document and given to the reader, which
// would dutifully read a login form. So the declared type and the file name are
// not consulted here at all; `sniffMediaType` is, and nothing else.
function documentFrom(o: Record<string, unknown>, link: string): FetchedDocument | null {
  const bytes = bytesOf(o);
  if (!bytes || bytes.length > MAX_BYTES) return null;
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) return null;
  return { bytes, fileName: nameFor(pick(o, NAME_KEYS), link, mediaType), mediaType };
}

/**
 * Ask n8n what is behind these links.
 *
 * The whole list goes over, in the order it was written, with the first also as
 * `url` — a mail carries an unsubscribe link and a help-centre link beside the
 * invoice, and which of them is the document is a question the workflow holding
 * the portal credentials is the one equipped to answer.
 */
export async function fetchDocumentsForLinks(
  links: string[],
  envelope: { from?: string; to?: string; subject?: string; date?: string; text?: string }
): Promise<LinkFetchResult> {
  const url = String(env.N8N_FETCH_URL || '').trim();
  if (!url) return { documents: [], note: 'no n8n webhook is configured (N8N_FETCH_URL)', attempted: false };
  if (!links.length) return { documents: [], note: 'the message carried no link to follow', attempted: false };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/pdf;q=0.9, */*;q=0.8',
  };
  const key = String(env.N8N_API_KEY || '').trim();
  if (key) headers['X-API-Key'] = key;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: links[0],
        links,
        from: envelope.from || '',
        to: envelope.to || '',
        subject: envelope.subject || '',
        date: envelope.date || '',
        text: envelope.text || '',
      }),
      signal: AbortSignal.timeout(Number(env.N8N_TIMEOUT_MS) || 120000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { documents: [], note: `n8n could not be reached (${why})`, attempted: true };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { documents: [], note: `n8n answered ${res.status}${detail ? ` — ${detail}` : ''}`, attempted: true };
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const documents: FetchedDocument[] = [];

  if (contentType.includes('json')) {
    const data = await res.json().catch(() => null);
    for (const item of itemsIn(data)) {
      const doc = documentFrom(item, links[0]);
      if (doc && !documents.some((d) => d.bytes.equals(doc.bytes))) documents.push(doc);
    }
    if (!documents.length) {
      // Say what it DID answer. A workflow that ran and found nothing usually
      // says so in a field, and quoting that back is the difference between
      // "n8n returned nothing" and a reviewer knowing the login had expired.
      const said = itemsIn(data)
        .map((o) => pick(o, ['error', 'message', 'note', 'reason']))
        .find(Boolean);
      return {
        documents,
        note: said ? `n8n returned no document — ${said.slice(0, 160)}` : 'n8n returned no document',
        attempted: true,
      };
    }
  } else {
    // The workflow streamed the file itself. Same rule: the bytes decide.
    const bytes = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const disposition = String(res.headers.get('content-disposition') || '');
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] || '';
    const doc = documentFrom({ base64: bytes.toString('base64'), fileName: named }, links[0]);
    if (!doc) {
      const label = contentType.split(';')[0] || 'an unrecognised type';
      return {
        documents,
        note: `n8n returned ${label} rather than a document — the link probably needs a login n8n could not complete`,
        attempted: true,
      };
    }
    documents.push(doc);
  }

  return {
    documents,
    note: `n8n returned ${documents.length} document${documents.length === 1 ? '' : 's'}`,
    attempted: true,
  };
}
