import { Router, type Request } from 'express';
import { readSession } from './auth.js';
import {
  findDuplicate,
  insertBill,
  updateBill,
  reconcileReadiness,
  costComplete,
  sweepStuckProcessing,
  setBillFile,
  listBills,
  getBillById,
  getBillByIdAny,
  parseAmount,
  type Candidate,
} from './store.js';
import { putBillFile, getBillFile } from './storage.js';
import { dataScopeForOrg } from './organisations.js';
import { memberForSession } from './users.js';

// Persisted bills + duplicate detection. Mounted at /api/costs alongside the
// Vision extract router. Works with or without sign-in (the app runs in mock
// mode until Google OAuth is configured), so nothing here hard-requires a
// session — it just scopes data per org and stamps the uploader when known.

// Bills are scoped per ORGANISATION (separate Costs/Sales books per client
// entity). The client sends the selected org via an X-Org-Id header; the primary
// org (CY Business Management) and no-selection both map to the legacy shared
// scope so existing data stays put, while every other org gets its own isolated
// books. Users are still shared — everyone signed in can switch between orgs.
export function orgIdFor(req: Request): string {
  return dataScopeForOrg((req.header('X-Org-Id') || '').trim());
}

// Workflow statuses a client may set at creation time. Anything else (or
// omitted) falls back to 'new' (the inbox).
const ALLOWED_STATUSES = ['new', 'processing', 'review', 'ready', 'archived', 'merged'];

export const billsRouter = Router();

// GET /api/costs/bills — persisted bills for the caller's org, newest first.
// A Standard (employee) user sees only their own documents; admins and other
// roles see the whole org's. No role (mock/dev) → see all, so the demo works.
billsRouter.get('/bills', (req, res) => {
  const orgId = orgIdFor(req);
  sweepStuckProcessing(orgId); // self-heal any doc stuck in Processing
  let bills = listBills(orgId).map((b) => ({ ...b, hasFile: Boolean(b.storageKey) }));
  const me = memberForSession(req);
  if (me && me.role === 'Standard') {
    const own = new Set([me.email, me.name].map((v) => String(v || '').toLowerCase()).filter(Boolean));
    bills = bills.filter((b) => own.has(String(b.createdBy || '').toLowerCase()));
  }
  res.json({ bills });
});

// GET /api/costs/bills/:id/file — stream the original file (R2 or local disk).
// 404 when the bill has no stored file.
billsRouter.get('/bills/:id/file', async (req, res) => {
  // Prefer the caller's org, but fall back to a global by-id lookup so exported
  // CSV image links open even from a browser that isn't signed in (the bill id
  // is an unguessable capability token). Same model as Dext's receipt links.
  const bill = getBillById(orgIdFor(req), req.params.id) || getBillByIdAny(req.params.id);
  if (!bill || !bill.storageKey) return res.status(404).json({ error: 'no_file' });

  const obj = await getBillFile(bill.storageKey, bill.contentType);
  if (!obj) return res.status(502).json({ error: 'file_unavailable' });

  res.setHeader('Content-Type', bill.contentType || obj.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${bill.fileName || bill.id}"`);
  obj.body.on('error', () => res.destroy());
  obj.body.pipe(res);
});

// POST /api/costs/bills/:id/file — attach/replace the original file on an
// existing bill (e.g. one uploaded before file storage worked). Body:
// { fileBase64, mediaType }.
billsRouter.post('/bills/:id/file', async (req, res) => {
  const orgId = orgIdFor(req);
  const bill = getBillById(orgId, req.params.id);
  if (!bill) return res.status(404).json({ error: 'not_found' });

  const b = req.body ?? {};
  if (typeof b.fileBase64 !== 'string' || !b.fileBase64) {
    return res.status(400).json({ error: 'invalid_image' });
  }
  try {
    const bytes = Buffer.from(b.fileBase64, 'base64');
    const keyHash = bill.fileHash || bill.id;
    const stored = await putBillFile(orgId, keyHash, String(b.mediaType ?? ''), bytes);
    const updated = setBillFile(orgId, bill.id, stored.storageKey, stored.contentType);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, bill: { ...updated, hasFile: Boolean(updated.storageKey) } });
  } catch (err) {
    console.error('[bills] attach file failed', err);
    res.status(500).json({ error: 'store_failed' });
  }
});

// PATCH /api/costs/bills/:id — update editable fields (e.g. category) or the
// workflow status ('ready' moves it out of the inbox).
billsRouter.patch('/bills/:id', (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'taxRate', 'description', 'status', 'createdBy']) {
    if (typeof b[k] === 'string') patch[k] = b[k];
  }
  if (b.total != null) patch.total = parseAmount(b.total);
  if (b.tax != null) patch.tax = parseAmount(b.tax);

  const explicitStatus = typeof b.status === 'string';
  const orgId = orgIdFor(req);
  let updated = updateBill(orgId, req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  // A field edit (no explicit status) lets the system re-derive ready vs inbox
  // from completeness; an explicit status is a manual override, left untouched.
  if (!explicitStatus) updated = reconcileReadiness(orgId, req.params.id) || updated;
  res.json({ ok: true, bill: { ...updated, hasFile: Boolean(updated.storageKey) } });
});

// POST /api/costs/bills/:id/finalize — apply the fields Vision just read to a
// doc that was created up-front (in Processing), THEN run the fuzzy duplicate
// check now that supplier/invoice/total/date are known (the create-time check
// only had the file hash). Returns { bill, duplicate } — the client removes the
// row and offers "Add anyway" when a duplicate is reported.
billsRouter.post('/bills/:id/finalize', (req, res) => {
  const orgId = orgIdFor(req);
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'description']) {
    if (typeof b[k] === 'string') patch[k] = b[k];
  }
  if (b.total != null) patch.total = parseAmount(b.total);
  if (b.tax != null) patch.tax = parseAmount(b.tax);

  const updated = updateBill(orgId, req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'not_found' });

  // Fuzzy dedup against every OTHER doc (skip the file-hash tier — that already
  // ran at create). Exclude this row so it can't match itself.
  const dup = findDuplicate(
    orgId,
    { fileHash: '', supplier: updated.supplier, invoiceNumber: updated.invoiceNumber, total: updated.total, date: updated.date },
    updated.id
  );
  // Advance out of Processing now that Vision has read it: a complete document
  // lands straight in Ready, an incomplete one in the inbox (New). (Reconcile on
  // its own only toggles new↔ready, never leaves 'processing'.)
  let bill = updated;
  if (bill.status === 'processing') {
    bill = updateBill(orgId, req.params.id, { status: costComplete(bill) ? 'ready' : 'new' }) || bill;
  } else {
    bill = reconcileReadiness(orgId, req.params.id) || bill;
  }
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});

// POST /api/costs/bills — persist an uploaded bill after a duplicate check.
// Body: { fileHash, fileName, fileBase64?, mediaType?, supplier, invoiceNumber,
//         documentType, currency, total, tax, date, category, force }. On a
// detected duplicate returns 409 { error:'duplicate', duplicate } unless
// `force:true` overrides it. The original bytes go to R2 when configured.
billsRouter.post('/bills', async (req, res) => {
  const b = req.body ?? {};
  const orgId = orgIdFor(req);

  const candidate: Candidate = {
    fileHash: typeof b.fileHash === 'string' ? b.fileHash : '',
    supplier: String(b.supplier ?? ''),
    invoiceNumber: String(b.invoiceNumber ?? ''),
    total: parseAmount(b.total),
    date: String(b.date ?? ''),
  };

  const dup = findDuplicate(orgId, candidate);
  // Block duplicates by default, but let an explicit `force` ("Add anyway")
  // override any match — including a byte-identical file — so the user is never
  // stuck unable to add a receipt. `rejected` flags the exact-file case so the
  // client can label it, but it's still forceable.
  if (dup && b.force !== true) {
    return res.status(409).json({ error: 'duplicate', duplicate: dup, rejected: dup.type === 'exact_file' });
  }

  // Store the original bytes (R2 when configured, else local disk). Best-effort:
  // a storage failure must not lose the metadata/dedup record.
  let storageKey = '';
  let contentType = '';
  const mediaType = String(b.mediaType ?? '');
  if (typeof b.fileBase64 === 'string' && b.fileBase64) {
    try {
      const bytes = Buffer.from(b.fileBase64, 'base64');
      const stored = await putBillFile(orgId, candidate.fileHash, mediaType, bytes);
      storageKey = stored.storageKey;
      contentType = stored.contentType;
    } catch (err) {
      console.error('[bills] file store failed; storing metadata only', err);
      storageKey = '';
      contentType = '';
    }
  }

  const me = readSession(req);
  const bill = insertBill({
    orgId,
    fileHash: candidate.fileHash,
    fileName: String(b.fileName ?? ''),
    supplier: candidate.supplier,
    invoiceNumber: candidate.invoiceNumber,
    documentType: String(b.documentType ?? ''),
    currency: String(b.currency ?? ''),
    total: candidate.total,
    tax: parseAmount(b.tax),
    date: candidate.date,
    category: String(b.category ?? ''),
    taxRate: String(b.taxRate ?? ''),
    description: String(b.description ?? ''),
    // Attribute to the chosen "Document owner" from the drawer when provided,
    // else the signed-in uploader.
    createdBy: (typeof b.owner === 'string' && b.owner) ? b.owner : (me?.email ?? ''),
    storageKey,
    contentType,
    // Default to the inbox ('new'). The Add-Documents drawer opts into
    // 'processing' (Dext-style "reading" step) and auto-advances to the inbox a
    // moment later; other creators (Vault "Copy to Costs/Sales", Split) omit
    // status so their items land straight in the inbox, as their UI promises.
    status: ALLOWED_STATUSES.includes(String(b.status)) ? String(b.status) : 'new',
    kind: b.kind === 'sales' ? 'sales' : 'cost',
    ...(Array.isArray(b.mergedFrom) ? { mergedFrom: b.mergedFrom.map(String) } : {}),
  });

  // Echo the overridden match back so the client can note "added despite dup".
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});
