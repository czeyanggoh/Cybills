import { Router, type Request } from 'express';
import { readSession } from './auth.js';
import { findDuplicate, insertBill, listBills, getBillById, parseAmount, type Candidate } from './store.js';
import { r2Enabled, putBill, getBill, extFor } from './storage.js';

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

// GET /api/costs/bills/:id/file — stream the original file from R2. 404 when the
// bill has no stored file (e.g. it was uploaded before R2 was configured).
billsRouter.get('/bills/:id/file', async (req, res) => {
  const bill = getBillById(orgIdFor(req), req.params.id);
  if (!bill || !bill.storageKey) return res.status(404).json({ error: 'no_file' });

  const obj = await getBill(bill.storageKey);
  if (!obj) return res.status(502).json({ error: 'file_unavailable' });

  res.setHeader('Content-Type', obj.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${bill.fileName || bill.id}"`);
  obj.body.on('error', () => res.destroy());
  obj.body.pipe(res);
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

  // Store the original bytes in R2 (best-effort — a storage failure must not
  // lose the metadata/dedup record, so we log and persist without a file).
  let storageKey = '';
  let contentType = '';
  const mediaType = String(b.mediaType ?? '');
  if (r2Enabled && typeof b.fileBase64 === 'string' && b.fileBase64) {
    try {
      const bytes = Buffer.from(b.fileBase64, 'base64');
      const ext = extFor(mediaType);
      storageKey = `bills/${orgId}/${candidate.fileHash}${ext ? `.${ext}` : ''}`;
      contentType = mediaType || 'application/octet-stream';
      await putBill(storageKey, bytes, contentType);
    } catch (err) {
      console.error('[bills] R2 upload failed; storing metadata only', err);
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
  });

  // Echo the overridden match back so the client can note "added despite dup".
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});
