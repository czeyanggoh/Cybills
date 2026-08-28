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
  type Bill,
  type Candidate,
} from './store.js';
import { putBillFile, getBillFile, deleteBillFile } from './storage.js';
import { dataScopeForOrg, primaryOrgId } from './organisations.js';
import { workspaceId, WORKSPACE_ID } from './workspace.js';
import { canAccessOrg, emailForPerson, memberForSession, orgScope, ownerForOrg } from './users.js';
import { runAutoClaims } from './autoClaims.js';
import { readSetting } from './settings.js';
import { decideTaxRate, foldLineTaxIntoCost, isZeroTaxRate, taxContextFor } from './taxRules.js';
import { shareToken, verifyShareToken, SHARE_TTL_DAYS } from './shareLinks.js';

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
//   - Only a document nobody has decided. An EMPTY tax rate does not mean
//     somebody chose "none": a reader writes one whenever it has no code to
//     offer, which is exactly how the emailed documents got here. The person's
//     decision is recorded explicitly (`taxRateCleared`), and only that is
//     respected — inferring it from the empty string skipped every document
//     this was written to repair.
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
    (b) => b.kind === 'cost' && !b.taxRate && !b.taxRateCleared && !b.xeroInvoiceId
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

// A supplier's standing rule, applied to the documents that already carry that
// supplier's name.
//
// A rule fires when a document is READ. But rules get written AFTER documents
// arrive — you correct a receipt, then write the rule so the next one is right —
// and those already-here documents got nothing. The only ways to connect them
// were a re-read (a model call to apply an instruction already written down) or
// pressing a button per document, which is the "somebody has to remember" shape
// this app removes everywhere else: both duplicate scans run themselves, and
// Ready fills itself.
//
// It writes a field when the field is BLANK, or when the rule is the thing that
// last wrote it. That second half is what makes editing a rule work: change the
// category on a rule, refresh, and the documents the rule had filled follow it —
// while a value a PERSON typed stays, because editing a field takes it over from
// the rule (see the PATCH route). Provenance is recorded rather than guessed;
// inferring it from the value is what made the tax-rate backfill skip every
// document it existed to repair.
//
// Never a published document, and skipped unless the book changed.
// Keyed on the book AND the rules themselves. Editing a rule doesn't touch a
// single bill, so a book-only guard would skip the very sweep the edit was
// supposed to trigger — which is the whole point of being able to change a rule
// and refresh.
const rulesAppliedAt = new Map<string, string>();
function applySupplierRules(ws: string, org: string, scope: string): void {
  const rules = readSetting<Record<string, Record<string, string>>>(ws, 'cybills.supplier.rules.v1', org);
  if (!rules || !Object.keys(rules).length) return;
  const key = `${bookRevision()}|${JSON.stringify(rules)}`;
  if (rulesAppliedAt.get(scope) === key) return;
  rulesAppliedAt.set(scope, key);
  const byName = new Map(Object.entries(rules).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const blank = (v: unknown) => !String(v ?? '').trim();

  for (const b of listBills(scope)) {
    if (b.kind !== 'cost' || b.xeroInvoiceId) continue;
    const rule = byName.get(String(b.supplier ?? '').trim().toLowerCase());
    if (!rule) continue;
    const owned = new Set(Array.isArray(b.ruleFields) ? b.ruleFields : []);
    const patch: Record<string, unknown> = {};
    // Free to write when nothing is there, or when the rule put what is there.
    // 'Uncategorised' counts as nothing — a placeholder, not somebody's answer.
    const mine = (field: string, current: unknown) => blank(current) || owned.has(field);
    const cat = String(b.category ?? '').trim();
    if (rule.category && (!cat || cat.toLowerCase() === 'uncategorised' || owned.has('category'))) {
      patch.category = rule.category;
    }
    if (rule.customer && mine('customer', b.customer)) patch.customer = rule.customer;
    if (rule.project && mine('project', b.project)) patch.project = rule.project;
    if (rule.currency && mine('currency', b.currency)) patch.currency = rule.currency;
    if (rule.paymentMethod && mine('paymentMethod', b.paymentMethod)) patch.paymentMethod = rule.paymentMethod;
    if (rule.description && mine('description', b.description)) patch.description = rule.description;
    // A tax code only where nobody has DECIDED one — `taxRateCleared` is a
    // person choosing blank, and it outranks the rule the same way here.
    if (rule.taxRate && !b.taxRateCleared && mine('taxRate', b.taxRate)) patch.taxRate = rule.taxRate;

    // Nothing to do when every field already reads what the rule says.
    const changed = Object.entries(patch).filter(([k, v]) => String((b as Record<string, unknown>)[k] ?? '') !== String(v));
    if (!changed.length) continue;
    if (patch.category) {
      patch.categoryReason = `Standing rule: documents from ${b.supplier} are coded ${patch.category}.`;
    }
    patch.ruleFields = [...new Set([...owned, ...Object.keys(patch)])].filter((f) => f !== 'categoryReason');
    updateBill(scope, b.id, patch);
    reconcileReadiness(scope, b.id);
  }
}

// "No Tax" with a tax amount beside it is not a document anybody can act on, so
// the pairing is repaired wherever it already exists. A code carrying no tax and
// an amount of GST contradict each other: either the tax is claimable input tax,
// in which case the code says which, or it is not, in which case it belongs
// inside the cost. The TOTAL is untouched — only the split moves — which is what
// makes this a repair rather than a revision of somebody's figures.
//
// It happened because the capture-time decision only ran for a document that
// arrived WITHOUT a rate: a reader that answered "No Tax" itself kept whatever
// tax it had read. That hole is closed at the source too (AddDocumentsDrawer,
// and the write path below); this is for the documents already carrying it.
//
// A PUBLISHED document is left alone: its figures are in the ledger, and the
// two disagreeing is worse than one of them being odd.
const zeroTaxFixedAt = new Map<string, number>();
async function repairZeroTaxAmounts(scope: string): Promise<void> {
  if (zeroTaxFixedAt.get(scope) === bookRevision()) return;
  zeroTaxFixedAt.set(scope, bookRevision());
  // A document is wrong here if its own tax field carries GST, or if its LINES
  // do while it says there is none — the second is what a half-applied repair
  // leaves behind, and it locks the document out of Xero just as firmly.
  const lineTax = (b: { lineItems?: Array<{ tax?: unknown }> }) =>
    (b.lineItems ?? []).reduce((t, li) => t + parseAmount(li?.tax), 0);
  const wrong = listBills(scope).filter(
    (b) => b.kind !== 'sales' && !b.xeroInvoiceId && b.taxRate && (parseAmount(b.tax) > 0 || lineTax(b) > 0)
  );
  for (const b of wrong) {
    if (!(await isZeroTaxRate(b.taxRate))) continue;
    const patch: Record<string, unknown> = { tax: 0 };
    if (lineTax(b) > 0) {
      const folded = await foldLineTaxIntoCost(b.lineItems);
      if (folded) patch.lineItems = folded;
    }
    updateBill(scope, b.id, patch);
  }
}

billsRouter.get('/bills', (req, res) => {
  const orgId = orgIdFor(req);
  sweepStuckProcessing(orgId); // self-heal any doc stuck in Processing
  backfillOwners(workspaceId(req), orgScope(req), orgId);
  applySupplierRules(workspaceId(req), orgScope(req), orgId);
  autoScanDuplicates(workspaceId(req), orgScope(req), orgId);
  // Fills in the background — it needs the org's rates over the relay, and the
  // list must not wait on a network call. The next fetch shows the result.
  void backfillTaxRates(workspaceId(req), orgScope(req), orgId).catch((err) =>
    console.error('[bills] tax-rate backfill failed', err)
  );
  void repairZeroTaxAmounts(orgId).catch((err) =>
    console.error('[bills] zero-tax repair failed', err)
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

// May this caller read this document? The global by-id lookup deliberately
// crosses entity books (a claim's item can live in another one), so the entity
// is taken from the BILL and checked against the caller's access — the same
// question the X-Org-Id guard asks, for a route that carries no such header.
//
// A refusal answers 404, not 403: whether a document exists is itself something
// the caller isn't entitled to learn.
function canReadBill(req: Request, bill: { orgId?: string }): boolean {
  const me = memberForSession(req);
  if (!me) return true; // sessionless mock/dev, as everywhere else
  const scope = String(bill.orgId ?? '');
  // A bill's orgId is a data SCOPE: the primary entity folds to WORKSPACE_ID.
  const orgId = !scope || scope === WORKSPACE_ID ? primaryOrgId() : scope;
  return canAccessOrg(me, orgId);
}

// Line items as they are stored: every cell a string, nothing else carried over
// from whatever the caller sent. Shared by the create and the update paths — a
// merged document arrives with its rows already resolved, and they have to be
// stored the same way the detail page's own edits are.
type LineItem = NonNullable<Bill['lineItems']>[number];

// A cell's number, or null when it holds nothing usable. Null is the point: it
// keeps "this cell is empty" apart from a real zero. Mirrors cellNumber in
// src/lib/lineItems.js, which the grid uses.
function cellNumber(value: unknown): number | null {
  const text = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normaliseLineItems(rows: unknown[]): LineItem[] {
  return rows.map((raw) => {
    const li = raw as Record<string, unknown>;
    const row = {
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
    };
    // Net, Tax and Total are one row seen three ways, so a row that states two
    // of them has stated the third. Stored with the third missing, it is not a
    // row with an empty field — it is a row that does not add up: the grid's
    // Item total reads it as nothing ("Out by 33.00" against a document that is
    // perfectly correct), and the publish path refuses the whole breakdown for
    // failing to reconcile, falling back to one summary line.
    //
    // A row with nothing in it at all is left exactly as it is — that is an
    // empty row somebody just added, not a contradiction. Same rule as
    // completeLine in src/lib/lineItems.js.
    const net = cellNumber(row.net);
    const tax = cellNumber(row.tax);
    const total = cellNumber(row.total);
    if (net === null && tax === null && total === null) return row;
    if (tax === null) row.tax = (total !== null && net !== null ? total - net : 0).toFixed(2);
    const t = cellNumber(row.tax) ?? 0;
    if (total === null && net !== null) row.total = (net + t).toFixed(2);
    else if (net === null && total !== null) row.net = (total - t).toFixed(2);
    return row;
  });
}

// Does this document's entity allow its images to be shared with exports?
// Business settings -> Exports -> Image sharing, Dext's own toggle. Read on
// every request rather than baked into the link, so switching it to No revokes
// the links already sitting in somebody's spreadsheet. Absent = on, which is
// how the setting ships and how exports behaved before it existed.
function imageSharingOn(req: Request, bill: { orgId?: string }): boolean {
  const scope = String(bill.orgId ?? '');
  const org = !scope || scope === WORKSPACE_ID ? primaryOrgId() : scope;
  const s = readSetting<{ imageSharing?: boolean }>(workspaceId(req), 'cybills.export-settings.v1', org);
  return s?.imageSharing !== false;
}

// POST /api/costs/share-links — mint a share link per document id, for the
// links an export writes into its Image column. Minting is the guarded step:
// the caller must be able to read the document and its entity must allow
// sharing, so an export can never hand out a link its owner couldn't open.
billsRouter.post('/share-links', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 2000).map(String) : [];
  const links: Record<string, string> = {};
  for (const id of ids) {
    if (!id || links[id]) continue;
    const bill = getBillById(orgIdFor(req), id) || getBillByIdAny(id);
    if (!bill || !bill.storageKey) continue;
    if (!canReadBill(req, bill) || !imageSharingOn(req, bill)) continue;
    links[id] = `/api/costs/bills/${encodeURIComponent(id)}/file?s=${shareToken(id)}`;
  }
  res.json({ links, expiresInDays: SHARE_TTL_DAYS });
});

// GET /api/costs/bills/:id/file — stream the original file (R2 or local disk).
// 404 when the bill has no stored file.
billsRouter.get('/bills/:id/file', async (req, res) => {
  // This route used to skip the session guard entirely, on the reasoning that a
  // bill id is an unguessable capability token — Dext's receipt-link model. That
  // held for `bill_<base36>_<8 hex>`. It did NOT hold for the other key this
  // resolves by: a purely numeric Item ID, which is a TIMESTAMP
  // (260825131730 = 25 Aug 2026, 13:17:30). A day of them can be enumerated by
  // counting, so anyone at all could pull any client's receipts — card digits,
  // addresses, amounts — without signing in.
  //
  // It needs a session now. And a session alone is not enough: an <img> sends no
  // X-Org-Id, so the entity has to be taken from the BILL and checked against
  // the caller, or one client's staff could read another's receipts by id.
  //
  // A link in an exported CSV or an emailed claim PDF has no session behind it,
  // so it carries a signed, expiring token for that one document instead
  // (shareLinks.ts) — and is refused the moment its entity turns Image sharing
  // off, however long the link has left to run.
  const bill = getBillById(orgIdFor(req), req.params.id) || getBillByIdAny(req.params.id);
  if (!bill || !bill.storageKey) return res.status(404).json({ error: 'no_file' });
  const shared = verifyShareToken(req.params.id, String(req.query.s ?? ''));
  const mayRead = shared ? imageSharingOn(req, bill) : canReadBill(req, bill);
  if (!mayRead) return res.status(404).json({ error: 'no_file' });

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
  if (!bill || !canReadBill(req, bill)) return res.json({ hasFile: false });
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
billsRouter.patch('/bills/:id', async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const k of ['supplier', 'invoiceNumber', 'documentType', 'currency', 'date', 'category', 'categoryReason', 'taxRate', 'taxRateReason', 'description', 'status', 'paymentMethod', 'customer', 'project', 'projectReason', 'cardLast4', 'note', 'dueDate']) {
    if (typeof b[k] === 'string') patch[k] = b[k];
  }
  // Reassigning the owner never rewrites createdBy: who uploaded a document is
  // a fact about the past, and overwriting it with a display name is what left
  // one person listed twice in the first place.
  if (typeof b.owner === 'string') patch.owner = ownerEmail(req, b.owner);
  // A person editing a field takes it over from the supplier rule, so the rule
  // stops rewriting it. Without this, changing a rule later would overwrite the
  // correction somebody made on this document — and never changing it would
  // leave an edited rule unable to reach the documents it had itself filled.
  const edited = Object.keys(patch).filter((k) => k !== 'status');
  if (edited.length) {
    const current = getBillById(orgIdFor(req), req.params.id);
    const owned = Array.isArray(current?.ruleFields) ? current!.ruleFields : [];
    const kept = owned.filter((f) => !edited.includes(f));
    if (kept.length !== owned.length) patch.ruleFields = kept;
  }
  if (typeof b.paid === 'boolean') patch.paid = b.paid;
  // "Not a duplicate" — the reviewer's verdict, which clears the flag and
  // survives every later re-check.
  if (b.duplicateDismissed === true) {
    patch.duplicateDismissed = true;
    patch.duplicateOfId = '';
    patch.duplicateType = '';
  }
  if (Array.isArray(b.lineItems)) patch.lineItems = normaliseLineItems(b.lineItems);
  // Recharged to a client: Xero's billable expense. Only meaningful alongside a
  // customer, and cleared with one — a rebillable cost with nobody to bill is a
  // flag that can never be acted on.
  if (typeof b.rebillable === 'boolean') patch.rebillable = b.rebillable;
  if ('customer' in b && !String(b.customer ?? '').trim()) patch.rebillable = false;
  if (b.total != null) patch.total = parseAmount(b.total);
  if (b.tax != null) patch.tax = parseAmount(b.tax);

  const explicitStatus = typeof b.status === 'string';
  const orgId = orgIdFor(req);
  // A code that carries no tax means no tax recorded — the same invariant the
  // form applies when somebody picks the code, applied again here so no other
  // caller can store the pair. Reads the rate being SET, else the one the
  // document already has, since either can be the half that makes it wrong.
  const effectiveRate = 'taxRate' in patch ? String(patch.taxRate ?? '') : String(getBillById(orgId, req.params.id)?.taxRate ?? '');
  if (effectiveRate && (await isZeroTaxRate(effectiveRate))) {
    patch.tax = 0;
    // The lines are part of the same document. Left carrying tax the document
    // says it doesn't have, they contradict it — and a breakdown that
    // contradicts its own paper is refused by the publish path, so the
    // correction would quietly lock the bill out of Xero.
    const rows = 'lineItems' in patch ? patch.lineItems : getBillById(orgId, req.params.id)?.lineItems;
    if (Array.isArray(rows) && rows.length) {
      const folded = await foldLineTaxIntoCost(rows);
      if (folded) patch.lineItems = folded;
    }
  }
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
    // Cut from a multi-page PDF by "Split PDF by page": which file, and which
    // page of it. Merge detection reads these instead of guessing — pages of one
    // receipt often share nothing it could match on (a trip map has no supplier,
    // no total and no date), and here there is nothing to guess about.
    // A merged document arrives with its rows already resolved (read from the
    // combined PDF, or carried from the source that had them). Dropping them
    // here is what made "Extract line items" look broken after a merge.
    ...(Array.isArray(b.lineItems) && b.lineItems.length
      ? { lineItems: normaliseLineItems(b.lineItems) }
      : {}),
    ...(b.splitGroup
      ? {
          splitGroup: String(b.splitGroup),
          splitPage: Number(b.splitPage) || 0,
          splitPages: Number(b.splitPages) || 0,
        }
      : {}),
  });

  // Echo the overridden match back so the client can note "added despite dup".
  res.json({ ok: true, bill: { ...bill, hasFile: Boolean(bill.storageKey) }, duplicate: dup ?? null });
});
