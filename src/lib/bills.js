// Client helpers for the persisted-bills API (upload + duplicate detection).

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

export const VISION_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Run an image through the Claude Vision extract endpoint. Returns the extracted
// fields object, or null if extraction is unavailable/failed (caller treats
// extraction as best-effort — the file is still stored + dedup-checked).
export async function fetchExtract(imageBase64, mediaType) {
  const res = await fetch('/api/costs/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mediaType }),
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data ?? null;
}

export async function fetchBills() {
  const res = await fetch('/api/costs/bills');
  if (!res.ok) return [];
  const { bills } = await res.json();
  return Array.isArray(bills) ? bills : [];
}

// Persist a bill. Returns { ok, bill } on success, or { duplicate } when the
// server flags a duplicate (HTTP 409) and `force` was not set. Throws on error.
export async function addBill(payload, { force = false } = {}) {
  const res = await fetch('/api/costs/bills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, force }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { duplicate: body.duplicate ?? null };
  }
  if (!res.ok) throw new Error('add_failed');
  return res.json();
}

// Shape a persisted bill into the row/doc form the Costs list + detail expect.
export function billToDoc(b) {
  return {
    id: b.id,
    persisted: true,
    itemId: b.id,
    unread: !b.status || b.status === 'new',
    status: ['ready', 'expenseclaim', 'archived'].includes(b.status) ? b.status : 'new',
    user: b.createdBy ? b.createdBy.split('@')[0] : 'You',
    date: b.date || '—',
    supplier: b.supplier || 'Unknown supplier',
    type: b.documentType || 'Document',
    category: b.category || 'Uncategorised',
    currency: b.currency || 'SGD',
    total: b.total != null ? String(b.total) : '—',
    tax: b.tax != null ? String(b.tax) : '0.00',
    invoiceNumber: b.invoiceNumber || '',
    hasFile: Boolean(b.hasFile),
    contentType: b.contentType || '',
  };
}

// URL that streams a persisted bill's original file from the server.
export function billFileUrl(id) {
  return `/api/costs/bills/${id}/file`;
}

// Attach/replace the original file on an existing bill. Returns the updated
// bill; throws on failure.
export async function uploadBillFile(id, fileBase64, mediaType) {
  const res = await fetch(`/api/costs/bills/${id}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
