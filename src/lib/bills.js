// Client helpers for the persisted-bills API (upload + duplicate detection).
import { nameForEmail } from '@/lib/userStore';
import { getActiveOrganisationId } from '@/lib/organisations';
import { fetchReviewInstructions } from '@/lib/reviewInstructions';

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

// Run a receipt image or PDF invoice through the Claude extract endpoint.
// `accounts` is the Xero chart of accounts (code/name/description) so the model
// classifies each expense into the account it should post to, using the
// descriptions. Returns the extracted fields object, or null if extraction is
// unavailable/failed (best-effort — the file is still stored + dedup-checked).
export async function fetchExtract(imageBase64, mediaType, accounts) {
  // The active org's Review instructions (business context + GST/coding rules)
  // ride along so the model classifies with that context. Best-effort.
  const instructions = await fetchReviewInstructions(getActiveOrganisationId());
  const res = await fetch('/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ imageBase64, mediaType, accounts, instructions }),
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data ?? null;
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
export async function finalizeBill(id, fields) {
  const res = await fetch(`/api/costs/bills/${id}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(fields),
  });
  if (!res.ok) return { ok: false, duplicate: null };
  return res.json();
}

// Shape a persisted bill into the row/doc form the Costs list + detail expect.
export function billToDoc(b) {
  return {
    id: b.id,
    persisted: true,
    kind: b.kind || 'cost',
    itemId: b.id,
    unread: !b.status || b.status === 'new',
    status: ['ready', 'expenseclaim', 'archived', 'review', 'deleted', 'processing', 'merged'].includes(b.status)
      ? b.status
      : 'new',
    mergedFrom: Array.isArray(b.mergedFrom) ? b.mergedFrom : [],
    user: b.createdBy ? nameForEmail(b.createdBy) || b.createdBy.split('@')[0] : 'You',
    createdByEmail: b.createdBy || '',
    fileName: b.fileName || '',
    createdAt: b.createdAt || '',
    date: b.date || '—',
    supplier: b.supplier || 'Unknown supplier',
    type: b.documentType || 'Document',
    category: b.category || 'Uncategorised',
    categoryReason: b.categoryReason || '',
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
    lineItems: Array.isArray(b.lineItems) ? b.lineItems : [],
    hasFile: Boolean(b.hasFile),
    contentType: b.contentType || '',
    // Xero provenance (set once published through the cyworkspace relay).
    xeroInvoiceId: b.xeroInvoiceId || '',
    xeroTenantName: b.xeroTenantName || '',
    xeroPostedAt: b.xeroPostedAt || '',
  };
}

// A clean, Dext-style numeric item id for display. Seed docs already use
// numeric ids (returned as-is); persisted bills use an internal "bill_…" id, so
// we derive a stable 11-digit number from it (same id → same number) rather
// than surfacing the raw storage key in reports.
export function displayItemId(id) {
  const s = String(id ?? '');
  if (/^\d+$/.test(s)) return s;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(21000000000 + (h % 1000000000));
}

// URL that streams a persisted bill's original file from the server.
export function billFileUrl(id) {
  return `/api/costs/bills/${id}/file`;
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
