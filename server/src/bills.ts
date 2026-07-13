import { Router, type Request } from 'express';
import { readSession } from './auth.js';
import {
  findDuplicate,
  insertBill,
  updateBill,
  setBillFile,
  listBills,
  getBillById,
  parseAmount,
  type Candidate,
} from './store.js';
import { putBillFile, getBillFile } from './storage.js';

// Persisted bills + duplicate detection. Mounted at /api/costs alongside the
// Vision extract router. Works with or without sign-in (the app runs in mock
// mode until Google OAuth is configured), so nothing here hard-requires a
// session — it just scopes data per org and stamps the uploader when known.

// Single-tenant for now: scope by the signed-in user's email domain, else a
// shared default. Gives real separation once OAuth is on without a tenant model.
function orgIdFor(req: Request): string {
  const me = readSession(req);
  const domain = me?.email?.split('@')[1]?.toLowerCase();
  return domain || 'cybills';
}

export const billsRouter = Router();

// GET /api/costs/bills — persisted bills for the caller's org, newest first.
billsRouter.get('/bills', (req, res) => {
  const bills = listBills(orgIdFor(req)).map((b) => ({ ...b, hasFile: Boolean(b.storageKey) }));
  res.json({ bills });
});

// GET /api/costs/bills/:id/file — stream the original file (R2 or local disk).
// 404 when the bill has no stored file.
billsRouter.get('/bills/:id/file', async (req, res) => {
  const bill = getBillById(orgIdFor(req), req.params.id);
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
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'status']) {
    if (typeof b[k] === 'string') patch[k] = b[k];
  }
  if (b.total != null) patch.total = parseAmount(b.total);
  if (b.tax != null) patch.tax = parseAmount(b.tax);

  const updated = updateBill(orgIdFor(req), req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, bill: { ...updated, hasFile: Boolean(updated.storageKey) } });
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
  if (dup && b.force !== true) {
    return res.status(409).json({ error: 'duplicate', duplicate: dup });
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
    createdBy: me?.email ?? '',
    storageKey,
    contentType,
    status: 'new',
  });

  // Echo the overridden match back so the client can note "added despite dup".
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});
