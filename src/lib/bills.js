// Client helpers for the persisted-bills API (upload + duplicate detection).
import { nameForEmail } from '@/lib/userStore';
import { useState, useEffect } from 'react';
import { getActiveOrganisationId, ORGANISATION_EVENT, getExtractionTaxRates, getExtractionProjects, getExtractionCategories } from '@/lib/organisations';
import { supplierNamesFromDocs } from '@/lib/supplierList';
import { isGstRegistered } from '@/lib/businessProfile';
import { fetchReviewInstructions } from '@/lib/reviewInstructions';
import { requestedProvider } from '@/lib/readerProvider';

// Every bill request carries the selected organisation so the server serves that
// org's own Costs/Sales books (separate per client entity). Omitted when no org
// is selected — the server then falls back to the primary org's data.
function orgHeaders() {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
}

// Fires after a successful upload so open lists (e.g. the Costs inbox) refetch.
export const BILLS_CHANGED_EVENT = 'cybills:bills-changed';
export function notifyBillsChanged() {
  window.dispatchEvent(new Event(BILLS_CHANGED_EVENT));
}

// SHA-256 hex of a File via Web Crypto (available in secure contexts — HTTPS in
// prod, localhost in dev). This is the exact-file duplicate key.
export async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Bare base64 (no data-URL prefix) for the Vision extract endpoint.
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const VISION_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];

// Run a receipt image or PDF invoice through the extract endpoint, read by the
// engine this client entity picked (Business settings → Extraction → Document
// reader): Claude or OpenAI.
// `accounts` is the Xero chart of accounts (code/name/description) so the model
// classifies each expense into the account it should post to, using the
// descriptions. Returns the extracted fields object, or null if extraction is
// unavailable/failed (best-effort — the file is still stored + dedup-checked).
export async function fetchExtract(imageBase64, mediaType, accounts) {
  // The active org's Review instructions (business context + GST/coding rules)
  // ride along so the model classifies with that context. Best-effort.
  const instructions = await fetchReviewInstructions(getActiveOrganisationId());
  // Tax codes the org wrote a "when to use" rule for (Lists → Tax rates), so the
  // model can reach codes the arithmetic fallback deliberately won't. A company
  // that isn't GST-registered sends none — every document codes to No Tax.
  const taxRates = isGstRegistered()
    ? await getExtractionTaxRates().then((rows) => rows.filter((t) => t.rules)).catch(() => [])
    : [];
  // Projects the org wrote a "when to use" rule for (Lists → Projects), so a
  // document can be allocated by what it says rather than only by who uploaded
  // it. None written → the field isn't offered to the model at all.
  const projects = await getExtractionProjects().catch(() => []);
  // A bridge entity has no chart of accounts, so it classifies into the plain
  // names its people claim against instead. Empty for a linked entity, whose
  // `accounts` are the list — the server prefers accounts whenever it has them.
  const categories = await getExtractionCategories().catch(() => []);
  const res = await fetch('/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({
      imageBase64,
      mediaType,
      accounts,
      categories,
      instructions,
      taxRates,
      projects,
      // '' = no org preference; the server applies its own default.
      provider: requestedProvider(),
    }),
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data ?? null;
}

// Re-check every stored document in ONE book against every other in it, and
// record the verdicts. Costs, Sales and Supplier statements are separate books —
// a bill you received is never a duplicate of an invoice you issued — so the
// count comes back matching the list the scan was launched from.
// Returns { flagged, changed }.
export async function scanDuplicates(kind = 'cost') {
  const res = await fetch(`/api/costs/bills/scan-duplicates?kind=${encodeURIComponent(kind)}`, { method: 'POST', headers: orgHeaders() });
  if (!res.ok) return { flagged: 0, changed: 0 };
  return res.json();
}

// The reviewer's "these are different documents" — clears the flag for good.
export function markNotDuplicate(id) {
  return updateBill(id, { duplicateDismissed: true });
}

// Forget that a document was published to Xero: clears the stored invoice id,
// tenant and date, and brings it back out of Archive so it can be published
// again. Local only — it does NOT delete or void the bill in Xero. Use it when
// the bill was removed at the Xero end.
export async function clearXeroPublish(id) {
  const res = await fetch(`/api/costs/bills/${id}/unpublish`, { method: 'POST', headers: orgHeaders() });
  if (!res.ok) throw new Error('unpublish_failed');
  return res.json();
}

export async function fetchBills() {
  const res = await fetch('/api/costs/bills', { headers: orgHeaders() });
  if (!res.ok) return [];
  const { bills } = await res.json();
  return Array.isArray(bills) ? bills : [];
}

// Persist a bill. Returns { ok, bill } on success, or { duplicate, rejected }
// when the server flags a duplicate (HTTP 409). `rejected:true` means a
// byte-identical file already exists and cannot be added even with force.
// Throws on error.
export async function addBill(payload, { force = false } = {}) {
  const res = await fetch('/api/costs/bills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ ...payload, force }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { duplicate: body.duplicate ?? null, rejected: Boolean(body.rejected) };
  }
  if (!res.ok) throw new Error('add_failed');
  return res.json();
}

// Apply the Vision-read fields to a doc created up-front (in Processing), then
// run the fuzzy duplicate check. Returns { ok, bill, duplicate }.
// `checkDuplicates:false` (Business settings → Extraction → Duplicate detection
// "Off") skips recording a duplicate verdict on the document.
export async function finalizeBill(id, fields, { checkDuplicates = true } = {}) {
  const res = await fetch(`/api/costs/bills/${id}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ ...fields, checkDuplicates }),
  });
  if (!res.ok) return { ok: false, duplicate: null };
  return res.json();
}

// Read the itemised table off a document — its own pass, not a field on the
// general read (see server/src/extract.ts). Returns { lines, grandTotal,
// linesTotal, reconciled, note } so the caller can say whether the rows can be
// trusted, or null when the read failed.
export async function fetchExtractLines(imageBase64, mediaType, accounts) {
  const instructions = await fetchReviewInstructions(getActiveOrganisationId());
  // The org's projects (its first Xero tracking category), so each LINE can be
  // allocated to the outlet or site it names — an invoice billing three outlets
  // on one page is exactly what a per-line breakdown is for.
  const projects = await getExtractionProjects().catch(() => []);
  const categories = await getExtractionCategories().catch(() => []);
  const res = await fetch('/api/costs/extract-lines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({
      imageBase64,
      mediaType,
      accounts,
      categories,
      instructions,
      projects,
      provider: requestedProvider(),
    }),
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data ?? null;
}

// Will this document's line items reach Xero as themselves? Mirrors the rule
// the publish path enforces server-side (`perLineItems` in server/src/xero.ts,
// which is the authority): the rows must add up to the document's total, and
// their tax must add up to its tax — or carry no tax at all, in which case a
// single stated GST figure is apportioned across them. This is here so the
// publish dialog can say which of the two will happen BEFORE anyone presses the
// button; a bill quietly losing its breakdown is the surprise worth avoiding.
export function lineItemsPostable(lineItems, total, tax) {
  const rows = Array.isArray(lineItems) ? lineItems : [];
  const c = (v) => Math.round((Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0) * 100);
  const linesTotal = rows.reduce((t, r) => t + (c(r.total) || c(r.net) + c(r.tax)), 0);
  const billTotal = c(total);
  const billTax = c(tax);
  const rowTax = rows.reduce((t, r) => t + c(r.tax), 0);
  const out = {
    rows: rows.length,
    linesTotal: linesTotal / 100,
    linesTax: rowTax / 100,
    outBy: (billTotal - linesTotal) / 100,
    hasProjects: rows.some((r) => String(r.project || '').trim() || String(r.project2 || '').trim()),
    postable: false,
    reason: '',
  };
  if (!rows.length) return { ...out, reason: 'no-rows' };
  if (linesTotal !== billTotal) return { ...out, reason: 'total' };
  // Rows carrying SOME tax that isn't the document's is a disagreement, not a
  // gap to fill — only "the document states one GST figure" is recoverable.
  if (rowTax !== billTax && (rowTax !== 0 || billTax === 0)) return { ...out, reason: 'tax' };
  return { ...out, postable: true };
}

// Turn the reader's line items into the editable rows a bill stores: amounts as
// fixed-2 strings, and a category on every row (the document's own when the
// reader didn't code that line). Used by the manual "Extract line items" button
// and by the supplier rule that pulls them automatically.
export function lineItemRows(rows, fallbackCategory = '') {
  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  return (Array.isArray(rows) ? rows : []).map((li) => {
    const total = li?.amount != null ? Number(li.amount) : num(li?.net) + num(li?.tax);
    const tax = li?.tax != null ? Number(li.tax) : 0;
    const net = li?.net != null ? Number(li.net) : total - tax;
    return {
      description: li?.description || '',
      category: li?.category || fallbackCategory || 'Uncategorised',
      // `project` IS read per line — from what the row names, or the section
      // heading above it — because one invoice often bills several sites in
      // blocks, and putting every row on the document's single project throws
      // that away. Blank means the row named nothing, and the line then follows
      // the document's own project.
      project: li?.project || '',
      // `project2` is the org's SECOND tracking category, and is only ever set
      // by hand: the publish path tags a bill with it, but nothing reads it.
      project2: li?.project2 || '',
      net: net.toFixed(2),
      tax: tax.toFixed(2),
      total: total.toFixed(2),
    };
  });
}

// '' when the document records nobody — it was stored with no signed-in user,
// so there is no owner to name. It used to read "You", which is not a person:
// every viewer saw it as themselves.
const ownerName = (who) => (who ? nameForEmail(who) || who : '');

// Shape a persisted bill into the row/doc form the Costs list + detail expect.
export function billToDoc(b) {
  return {
    id: b.id,
    persisted: true,
    kind: b.kind || 'cost',
    itemId: b.id,
    // The document's public number, as ASSIGNED by the server. Falls back to the
    // derived one only for a record written before numbers were stored (the
    // server backfills those on load, so this is a first-render safety net).
    displayId: b.displayId || displayItemId(b.id),
    unread: !b.status || b.status === 'new',
    status: ['ready', 'expenseclaim', 'archived', 'review', 'deleted', 'processing', 'merged'].includes(b.status)
      ? b.status
      : 'new',
    mergedFrom: Array.isArray(b.mergedFrom) ? b.mergedFrom : [],
    // The owner if one was set, else whoever uploaded it — resolved to the one
    // display name that person is known by. The old fallback to the email's
    // local-part is gone: it is what listed "czeyang.goh" beside "Cze Yang Goh"
    // as if they were two people. An address the directory can't place is shown
    // whole, which at least reads as one person.
    user: ownerName(b.owner || b.createdBy),
    ownerEmail: b.owner || '',
    createdByEmail: b.createdBy || '',
    fileName: b.fileName || '',
    createdAt: b.createdAt || '',
    date: b.date || '—',
    supplier: b.supplier || 'Unknown supplier',
    type: b.documentType || 'Document',
    category: b.category || 'Uncategorised',
    categoryReason: b.categoryReason || '',
    projectReason: b.projectReason || '',
    taxRateReason: b.taxRateReason || '',
    currency: b.currency || 'SGD',
    total: b.total != null ? String(b.total) : '—',
    tax: b.tax != null ? String(b.tax) : '0.00',
    invoiceNumber: b.invoiceNumber || '',
    taxRate: b.taxRate || '',
    description: b.description || '',
    paymentMethod: b.paymentMethod || '',
    paid: Boolean(b.paid),
    customer: b.customer || '',
    project: b.project || '',
    cardLast4: b.cardLast4 || '',
    note: b.note || '',
    // The message this document arrived in, when it came by email. Null for an
    // upload, which is what the Email tab reads to know it has nothing to show.
    email: b.email || null,
    dueDate: b.dueDate || '',
    lineItems: Array.isArray(b.lineItems) ? b.lineItems : [],
    hasFile: Boolean(b.hasFile),
    contentType: b.contentType || '',
    // Xero provenance (set once published through the cyworkspace relay).
    // Duplicate detection, as recorded on the document by the server.
    duplicateOfId: b.duplicateOfId || '',
    duplicateType: b.duplicateType || '',
    duplicateDismissed: Boolean(b.duplicateDismissed),
    xeroInvoiceId: b.xeroInvoiceId || '',
    xeroTenantName: b.xeroTenantName || '',
    xeroPostedAt: b.xeroPostedAt || '',
  };
}

// The number a document's creation second DERIVES: YYMMDDHHMMSS in Singapore
// time (e.g. 260820130500 = 20 Aug 2026 13:05:00), decoded from the ms the
// internal id embeds.
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

// The address of a cost document: the path carries the NUMBER the page itself
// shows (/costs/260822123051), not the internal storage key, so a URL copied out
// of the address bar is the number you can search the list for.
//
// Pass the document where you have it — its assigned number is the one that is
// unique. A bare id still works (a claim line item holds only that) and derives
// the number, which the server also resolves.
export function costPath(docOrId) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  return `/costs/${doc ? doc.displayId || displayItemId(doc.id) : displayItemId(docOrId)}`;
}

// Does a document answer to this URL key? Links now carry the item id, but the
// internal id still resolves it — older bookmarks hold one, and an expense
// claim's line item stores one as its `itemId`.
export function isItemKey(docOrId, key) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const a = String((doc ? doc.id : docOrId) ?? '');
  const b = String(key ?? '');
  if (!b) return false;
  // The assigned number first; the derived one still answers, so a link made
  // before a document was renumbered opens the same page it always did.
  if (doc?.displayId && doc.displayId === b) return true;
  return a === b || displayItemId(a) === b;
}

// URL that streams a persisted bill's original file from the server.
export function billFileUrl(id) {
  return `/api/costs/bills/${id}/file`;
}

// Share links for an EXPORT's document links — an exported CSV or a claim PDF
// is read outside CYBills, by an accountant or an approver with no sign-in
// here, so a plain file URL would just bounce them to the login page. The
// server signs one short-lived link per document, and only for documents this
// caller can already open in an entity that allows sharing (Business settings
// -> Exports -> Image sharing). Returns { id: url }; ids it won't share are
// simply absent, so the export writes no link for them.
export async function fetchShareLinks(ids) {
  const wanted = [...new Set((ids || []).map((v) => String(v ?? '')).filter(Boolean))];
  if (!wanted.length) return {};
  try {
    const res = await fetch('/api/costs/share-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...orgHeaders() },
      body: JSON.stringify({ ids: wanted }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    return data?.links && typeof data.links === 'object' ? data.links : {};
  } catch {
    return {};
  }
}

// The suppliers this entity's own documents name, for the pickers. Kept here
// rather than in each page because two of them ask (the document's Supplier
// field and the Suppliers list) and a bridge entity has no Xero contacts to
// fall back on. Never throws: an unreachable server yields no options, and the
// field stays free text.
export function useDocumentSuppliers() {
  const [names, setNames] = useState([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetchBills()
        .then((bills) => {
          if (live) setNames(supplierNamesFromDocs(bills.filter((b) => b.kind !== 'sales')));
        })
        .catch(() => {});
    load();
    window.addEventListener(BILLS_CHANGED_EVENT, load);
    window.addEventListener(ORGANISATION_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(BILLS_CHANGED_EVENT, load);
      window.removeEventListener(ORGANISATION_EVENT, load);
    };
  }, []);
  return names;
}

// Whether a bill has a stored file (+ its type), resolved globally by id — works
// even when the bill sits outside the active org's book (e.g. a claim item).
export async function fetchBillFileMeta(id) {
  try {
    const res = await fetch(`/api/costs/bills/${id}/file-meta`, { headers: orgHeaders() });
    if (!res.ok) return { hasFile: false };
    return await res.json();
  } catch {
    return { hasFile: false };
  }
}

// One bill by id, with a global fallback so claim line items resolve regardless
// of which org's book the document lives in. Returns null when truly absent.
export async function fetchBillById(id) {
  try {
    const res = await fetch(`/api/costs/bills/${id}`, { headers: orgHeaders() });
    if (!res.ok) return null;
    const { bill } = await res.json();
    return bill ?? null;
  } catch {
    return null;
  }
}

// Attach/replace the original file on an existing bill. Returns the updated
// bill; throws on failure.
export async function uploadBillFile(id, fileBase64, mediaType) {
  const res = await fetch(`/api/costs/bills/${id}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ fileBase64, mediaType }),
  });
  if (!res.ok) throw new Error('attach_failed');
  return res.json();
}

// Update an existing bill's editable fields / workflow status. Returns the
// updated bill; throws on failure.
export async function updateBill(id, patch) {
  const res = await fetch(`/api/costs/bills/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('update_failed');
  return res.json();
}

// Permanently delete a bill: removes the record AND reclaims its stored file
// from Cloudflare R2 (or local disk). Destructive — callers confirm first. This
// is distinct from a soft delete/archive (updateBill with a status change),
// which keeps the row and its file so it can be restored.
export async function deleteBill(id) {
  const res = await fetch(`/api/costs/bills/${id}`, {
    method: 'DELETE',
    headers: orgHeaders(),
  });
  if (!res.ok) throw new Error('delete_failed');
  return res.json();
}

// Human summary of a duplicate match, e.g. for a warning banner.
export function describeDuplicate(dup) {
  if (!dup) return '';
  const { type, bill } = dup;
  const who = bill.createdBy ? ` by ${bill.createdBy.split('@')[0]}` : '';
  const when = bill.createdAt ? new Date(bill.createdAt).toLocaleDateString() : '';
  const label =
    type === 'exact_file'
      ? 'This exact file was already uploaded'
      : type === 'same_invoice'
        ? `Invoice ${bill.invoiceNumber || ''} from ${bill.supplier} was already added`.trim()
        : `A ${bill.currency} ${bill.total} ${bill.supplier} document from ${bill.date} was already added`;
  return `${label}${when ? ` on ${when}` : ''}${who}.`;
}

// Why a document was flagged, in the reviewer's terms — one wording, shared by
// the document page's banner and the side-by-side review.
export const DUPLICATE_REASON = {
  exact_file: 'The identical file has already been submitted.',
  same_invoice: 'The same supplier and document reference, for the same amount, is already on file.',
  likely_duplicate: 'The same supplier, amount and date is already on file.',
};
