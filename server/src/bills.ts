import { Router, type Request } from 'express';
import { readSession } from './auth.js';
import {
  findDuplicate,
  insertBill,
  updateBill,
  reconcileReadiness,
  clearBillPosted,
  costComplete,
  sweepStuckProcessing,
  flagDuplicate,
  scanDuplicates,
  bookRevision,
  setBillFile,
  listBills,
  getBillById,
  getBillByIdAny,
  deleteBillHard,
  storageKeyInUse,
  parseAmount,
  type Candidate,
} from './store.js';
import { putBillFile, getBillFile, deleteBillFile } from './storage.js';
import { dataScopeForOrg } from './organisations.js';
import { workspaceId } from './workspace.js';
import { emailForPerson, orgScope, ownerForOrg } from './users.js';
import { runAutoClaims } from './autoClaims.js';
import { readSetting } from './settings.js';
import { decideTaxRate, taxContextFor } from './taxRules.js';

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
// NB: no owner-based filtering. An earlier "Standard users see only their own
// docs" filter hid a person's own upload the moment its (editable) owner field
// no longer matched their session — losing the document from every tab. The
// "employees can't do admin things" requirement is enforced by gating the admin
// pages (Users / Business settings), not by hiding receipts.
// The duplicate scan used to be a button the reviewer had to remember, so a
// document that became a duplicate AFTER it was uploaded — the second copy
// arrives later, or an edit makes two rows agree — sat there unflagged until
// somebody thought to check. It runs by itself now, on the listing, for every
// surface at once.
//
// It is skipped unless the book changed since the last scan: comparing every
// document with every other is cheap in memory but pointless to repeat over an
// unchanged list. Off is honoured — a workspace that set Duplicate items to Off
// asked for no duplicate checking, and this is duplicate checking.
const scannedAt = new Map<string, number>();
function autoScanDuplicates(ws: string, org: string, scope: string): void {
  const settings = readSetting<{ duplicateMode?: string }>(ws, 'cybills.extraction-settings.v1', org);
  if (String(settings?.duplicateMode ?? 'Automatic') === 'Off') return;
  if (scannedAt.get(scope) === bookRevision()) return;
  scanDuplicates(scope, 'cost');
  scanDuplicates(scope, 'sales');
  // Read AFTER the scan: flagging is itself a write, and the run that flags
  // nothing new is the one that settles.
  scannedAt.set(scope, bookRevision());
}

// One-time repair of the rows written before the owner had a field of its own.
// Back then the drawer's "Document owner" and the detail page's owner edit both
// wrote a DISPLAY NAME over createdBy, so the same person reached the User
// column two ways — "Cze Yang Goh" on the documents whose owner was set,
// "czeyang.goh" on the ones still carrying their email. Each such row gets the
// email that name resolves to, in both fields: the true uploader was already
// overwritten when the name was stored, so the owner is the best attribution
// left. A name that matches nobody (or two people) is left exactly as it is —
// a wrong name is worse than an unresolved one. Runs off the list endpoint and
// rewrites nothing once done.
function backfillOwners(ws: string, org: string, scope: string): void {
  for (const b of listBills(scope)) {
    if (b.owner || !b.createdBy || b.createdBy.includes('@')) continue;
    const email = emailForPerson(ws, org, b.createdBy);
    if (email) updateBill(scope, b.id, { owner: email, createdBy: email });
  }
}

// A tax code is arithmetic, not a reading — total, GST and the supplier's
// registration decide it. The browser has always done that sum on upload, so a
// document created any OTHER way (an emailed one, before the inbound path ran
// the same decision) reached the inbox with the cell simply blank, and nothing
// would ever fill it: re-reading is the only path that computes one, and paying
// for a model call to work out "no GST printed, therefore No Tax" is absurd.
//
// So it is computed here for the documents that never had the chance. Two
// guards make that safe:
//   - Only a document with NO taxRate FIELD AT ALL. Clearing the cell writes an
//     empty string, which is a decision; never having been asked is the absence
//     of one. Refilling a deliberate blank would be fighting the reviewer.
//   - Never a published document, whose figures are already in the ledger.
// Skipped entirely unless the book changed, and it costs nothing (not even the
// relay call for the rates) when there is nothing to fill.
//
// It fills the missing decision and nothing else. Where the decision would also
// have to REVISE money — a document with GST recorded that turns out not to be
// claimable Singapore input tax, where a read moves the amount into the cost —
// the document is left untouched instead. Supplying an answer nobody ever asked
// for is a repair; rewriting a figure somebody may already have checked, days
// later and without being asked, is not. Those go through Rerun processing,
// where the whole document is being decided again and the change is visible.
const taxFilledAt = new Map<string, number>();
async function backfillTaxRates(ws: string, org: string, scope: string): Promise<void> {
  if (taxFilledAt.get(scope) === bookRevision()) return;
  taxFilledAt.set(scope, bookRevision());
  const undecided = listBills(scope).filter(
    (b) => b.kind === 'cost' && !('taxRate' in b) && !b.xeroInvoiceId
  );
  if (!undecided.length) return;
  const ctx = await taxContextFor(ws, org);
  if (!ctx.visibleRates.length) return; // no rates to choose from — say nothing
  for (const b of undecided) {
    const outcome = await decideTaxRate(ctx, b);
    if (!outcome?.name) continue;
    if (!outcome.claimsTax && parseAmount(b.tax) > 0) continue; // would revise money — leave it
    updateBill(scope, b.id, { taxRate: outcome.name, taxRateReason: outcome.reason });
  }
}

billsRouter.get('/bills', (req, res) => {
  const orgId = orgIdFor(req);
  sweepStuckProcessing(orgId); // self-heal any doc stuck in Processing
  backfillOwners(workspaceId(req), orgScope(req), orgId);
  autoScanDuplicates(workspaceId(req), orgScope(req), orgId);
  // Fills in the background — it needs the org's rates over the relay, and the
  // list must not wait on a network call. The next fetch shows the result.
  void backfillTaxRates(workspaceId(req), orgScope(req), orgId).catch((err) =>
    console.error('[bills] tax-rate backfill failed', err)
  );
  // File any Auto Expense claim whose period has ended. Rides on the fetch every
  // list already makes rather than a background worker, so a period that ended
  // while nobody was looking is claimed the moment someone opens the app.
  try {
    runAutoClaims(workspaceId(req), orgId);
  } catch (err) {
    console.error('[autoClaims] sweep failed', err);
  }
  const bills = listBills(orgId).map((b) => ({ ...b, hasFile: Boolean(b.storageKey) }));
  res.json({ bills });
});

// Content-Disposition for a stored file. Node rejects any header value outside
// latin1 (ERR_INVALID_CHAR) and throws mid-response, which the browser sees as
// a dead connection — nginx turns that into a 502 on the preview iframe. Split
// PDF by page names its pages "scan — p1.pdf", and plenty of real uploads
// carry accented or CJK names, so the name is sent the way RFC 6266 says: an
// ASCII-only `filename` for old clients plus a UTF-8 `filename*` for the rest.
function contentDisposition(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

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

  const type = String(bill.contentType || obj.contentType || 'application/octet-stream');
  res.setHeader('Content-Type', /^[\x20-\x7e]+$/.test(type) ? type : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(bill.fileName || bill.id));
  obj.body.on('error', () => res.destroy());
  obj.body.pipe(res);
});

// GET /api/costs/bills/:id/file-meta — does this bill have a stored file, and
// what type? Resolved globally by id (same capability-token model as /file), so
// a claim item whose document lives in another org scope still resolves.
billsRouter.get('/bills/:id/file-meta', (req, res) => {
  const bill = getBillById(orgIdFor(req), req.params.id) || getBillByIdAny(req.params.id);
  if (!bill) return res.json({ hasFile: false });
  res.json({ hasFile: Boolean(bill.storageKey), contentType: bill.contentType || '', fileName: bill.fileName || '' });
});

// GET /api/costs/bills/:id — one bill by id, org-first then a global fallback,
// so opening a claim's line item resolves its document even if it sits in a
// different org's book (or the active org isn't the one it was created under).
billsRouter.get('/bills/:id', (req, res) => {
  const bill = getBillById(orgIdFor(req), req.params.id) || getBillByIdAny(req.params.id);
  if (!bill) return res.status(404).json({ error: 'not_found' });
  res.json({ bill: { ...bill, hasFile: Boolean(bill.storageKey) } });
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

// A "Document owner" from the client — an email, or the display name older
// callers send — as the one email that identifies that person. An address we
// can't place is kept as given (a real person outside this entity's directory);
// an unresolvable NAME is dropped rather than stored, since a bare name is
// exactly the ambiguity this field exists to remove. A practice colleague is
// never the answer: what a colleague adds to a client belongs to that client's
// general account, which is what `uploader` (their email, on create) decides.
function ownerEmail(req: Request, value: unknown, uploader = ''): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  // orgScope, not orgIdFor: people belong to an ENTITY, while a bill belongs to
  // that entity's data scope (which collapses to 'cybm' for the primary one).
  return ownerForOrg(workspaceId(req), orgScope(req), raw, uploader);
}

// PATCH /api/costs/bills/:id — update editable fields (e.g. category) or the
// workflow status ('ready' moves it out of the inbox).
billsRouter.patch('/bills/:id', (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'categoryReason', 'taxRate', 'taxRateReason', 'description', 'status', 'paymentMethod', 'customer', 'project', 'projectReason', 'cardLast4', 'note', 'dueDate']) {
    if (typeof b[k] === 'string') patch[k] = b[k];
  }
  // Reassigning the owner never rewrites createdBy: who uploaded a document is
  // a fact about the past, and overwriting it with a display name is what left
  // one person listed twice in the first place.
  if (typeof b.owner === 'string') patch.owner = ownerEmail(req, b.owner);
  if (typeof b.paid === 'boolean') patch.paid = b.paid;
  // "Not a duplicate" — the reviewer's verdict, which clears the flag and
  // survives every later re-check.
  if (b.duplicateDismissed === true) {
    patch.duplicateDismissed = true;
    patch.duplicateOfId = '';
    patch.duplicateType = '';
  }
  if (Array.isArray(b.lineItems)) {
    patch.lineItems = b.lineItems.map((li: any) => ({
      description: String(li?.description ?? ''),
      category: String(li?.category ?? ''),
      // The two Xero tracking categories, per line. A bill whose lines carry
      // their own project publishes as those lines rather than one summary one
      // — see the publish path in xero.ts.
      project: String(li?.project ?? ''),
      project2: String(li?.project2 ?? ''),
      net: String(li?.net ?? ''),
      tax: String(li?.tax ?? ''),
      total: String(li?.total ?? ''),
    }));
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
  // Editing what identifies a document can make it a duplicate — or clear one.
  if (['supplier', 'invoiceNumber', 'total', 'date'].some((k) => k in patch)) {
    updated = flagDuplicate(orgId, req.params.id) || updated;
  }
  res.json({ ok: true, bill: { ...updated, hasFile: Boolean(updated.storageKey) } });
});

// DELETE /api/costs/bills/:id — PERMANENT delete. Drops the record for good AND
// reclaims its stored file from R2 (or local disk). This is the destructive
// counterpart to the soft delete/archive (status change, file kept) — the client
// only calls it behind an explicit confirmation. File cleanup is best-effort and
// never blocks removing the record.
billsRouter.delete('/bills/:id', async (req, res) => {
  const orgId = orgIdFor(req);
  const removed = deleteBillHard(orgId, req.params.id);
  if (!removed) return res.status(404).json({ error: 'not_found' });
  // Only reclaim the stored file if no other bill still shares it (identical
  // uploads are stored once and share a key).
  const fileRemoved = Boolean(removed.storageKey) && !storageKeyInUse(removed.storageKey);
  if (fileRemoved) await deleteBillFile(removed.storageKey);
  res.json({ ok: true, id: removed.id, fileRemoved });
});

// POST /api/costs/bills/:id/unpublish — forget that this document was published
// to Xero: clears the stored invoice id / tenant / date and brings it back out
// of Archive so it can be published again. Local only — it does NOT delete or
// void anything in Xero. For when the bill was removed at the Xero end.
billsRouter.post('/bills/:id/unpublish', (req, res) => {
  const orgId = orgIdFor(req);
  const cleared = clearBillPosted(orgId, req.params.id);
  if (!cleared) return res.status(404).json({ error: 'not_found' });
  const bill = reconcileReadiness(orgId, req.params.id) || cleared;
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) } });
});

// POST /api/costs/bills/scan-duplicates — re-check every stored document
// against every other and record the verdicts. Catches a corpus that predates
// flagging, anything added with "Add anyway", and pairs whose fields were
// edited into matching after upload.
// `kind` picks the book to walk (default Costs) — Costs, Sales and Supplier
// statements are checked separately, so the count always matches the list the
// scan was launched from.
billsRouter.post('/bills/scan-duplicates', (req, res) => {
  const orgId = orgIdFor(req);
  res.json({ ok: true, ...scanDuplicates(orgId, String(req.query.kind ?? req.body?.kind ?? 'cost')) });
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
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'categoryReason', 'description', 'cardLast4', 'project', 'projectReason']) {
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
    { fileHash: '', supplier: updated.supplier, invoiceNumber: updated.invoiceNumber, total: updated.total, date: updated.date, kind: updated.kind },
    updated.id
  );
  // Record it on the document too. The drawer may let the upload through
  // ("Add anyway", or Review-manually mode), and a verdict that exists only in
  // that response is lost the moment the drawer closes.
  if (b.checkDuplicates !== false) flagDuplicate(orgId, updated.id);
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
    kind: b.kind,
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
    categoryReason: String(b.categoryReason ?? ''),
    projectReason: String(b.projectReason ?? ''),
    taxRate: String(b.taxRate ?? ''),
    taxRateReason: String(b.taxRateReason ?? ''),
    description: String(b.description ?? ''),
    // createdBy is who UPLOADED it and nothing else. The drawer's "Document
    // owner" is a separate field, resolved to an email so one person can't end
    // up stored two ways (a display name here, their address there).
    createdBy: me?.email ?? '',
    owner: ownerEmail(req, b.owner, me?.email ?? ''),
    storageKey,
    contentType,
    // Default to the inbox ('new'). The Add-Documents drawer opts into
    // 'processing' (Dext-style "reading" step) and auto-advances to the inbox a
    // moment later; other creators (Vault "Copy to Costs/Sales", Split) omit
    // status so their items land straight in the inbox, as their UI promises.
    status: ALLOWED_STATUSES.includes(String(b.status)) ? String(b.status) : 'new',
    kind: b.kind === 'sales' ? 'sales' : b.kind === 'supplier_statement' ? 'supplier_statement' : 'cost',
    ...(Array.isArray(b.mergedFrom) ? { mergedFrom: b.mergedFrom.map(String) } : {}),
  });

  // Echo the overridden match back so the client can note "added despite dup".
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});
