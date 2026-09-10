// How a cost document is NAMED and ADDRESSED — its display number, and the
// path that opens it.
//
// Pure and dependency-free on purpose. These three used to live in `bills.js`,
// which pulls in React, the org store, the supplier list and half the app; and
// `exportFormat.js` imported one of them, which made the claim PDF's whole
// import graph browser-only. The SERVER now builds that PDF too (a signed link
// serves it to somebody with no login), and it can only load a module whose
// dependencies it can also load — the same arrangement as claimReference.js,
// mileage.js and the rest of the shared leaves.
//
// `bills.js` re-exports all three, so every existing caller is unchanged.

// The number a document's own second derives.
//
// This is no longer where a document's number comes from — two uploads in the
// same second derive the same twelve digits, and the number has to be unique
// because it addresses the document. The server assigns and stores one instead
// (`displayId`, see nextDisplayId in store.ts); use `doc.displayId`.
//
// This remains for the cases that have no record to read it from: a claim line
// item holding only an internal id, a sample/demo doc, and the moment before a
// backfill has run. Numeric ids pass through; anything unrecognised falls back
// to a stable hash.
export function displayItemId(id) {
  const s = String(id ?? '');
  if (/^\d+$/.test(s)) return s;
  const m = /^bill_([0-9a-z]+)_/.exec(s);
  if (m) {
    const ms = parseInt(m[1], 36);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms + 8 * 60 * 60 * 1000); // shift to SGT, then read UTC parts
      const p = (n) => String(n).padStart(2, '0');
      return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    }
  }
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(21000000000 + (h % 1000000000));
}

// The number to SHOW for a document: the one it was assigned, falling back to
// the one its second derives (a claim line item holding only an internal id, a
// sample doc). One expression so no screen has to remember the order.
export function itemNumber(docOrId) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  if (!doc) return displayItemId(docOrId);
  return doc.displayId || displayItemId(doc.id ?? doc.itemId);
}

function addressKeyFor(id) {
  const s = String(id ?? '');
  if (/^\d+$/.test(s)) return s;
  if (/^bill_/.test(s)) return s;
  return displayItemId(s);
}

// The address of a cost document: the path carries the NUMBER the page itself
// shows (/costs/260822123051), not the internal storage key, so a URL copied out
// of the address bar is the number you can search the list for.
//
// Pass the DOCUMENT wherever you have it — its assigned number is the one that
// is unique, and passing `doc.id` instead throws that away and derives an
// ambiguous one. A bare id still works (a claim line item holds only that).
export function costPath(docOrId) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const key = doc
    ? doc.displayId || addressKeyFor(doc.id ?? doc.itemId)
    : addressKeyFor(docOrId);
  return `/costs/${key}`;
}

// Where a claim's own supporting document is served from.
export const claimAttachmentUrl = (claimId, attachmentId) =>
  `/api/claims/${encodeURIComponent(claimId)}/attachments/${encodeURIComponent(attachmentId)}/file`;

// Where a cost document's original file is served from.
export const costFileUrl = (itemId) => `/api/costs/bills/${encodeURIComponent(itemId)}/file`;
