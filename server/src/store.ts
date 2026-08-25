import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { WORKSPACE_ID } from './workspace.js';

// Tiny persistent JSON store for uploaded bills. Deliberately dependency-free:
// the VPS deploys with `npm ci` and recompiles native modules on every pull, so
// a JSON file (atomic write + in-memory cache) is the lowest-risk way to add
// persistence at the app's current scale. The dedup logic below is identical to
// what a real DB would run, so swapping the backing store later is mechanical.

export type Bill = {
  id: string;
  orgId: string;
  fileHash: string; // sha256 hex of the raw upload; exact-file dedup key
  fileName: string;
  supplier: string;
  invoiceNumber: string;
  documentType: string;
  currency: string;
  total: number;
  tax: number;
  date: string; // as extracted, ISO YYYY-MM-DD when determinable
  category: string;
  categoryReason?: string; // why the AI chose this category (account/rule cited)
  projectReason?: string; // why this project/PIC — the rule or the evidence cited
  // The message a document arrived in, when it came by email rather than an
  // upload. Kept so the reviewer can see WHAT was sent and by whom — a receipt
  // forwarded with "this is the deposit, not the balance" is a different
  // document from the same PDF uploaded silently, and the covering note is
  // often the only place that says so.
  email?: { from: string; to: string; subject: string; date: string; text: string };
  taxRate?: string; // GST/tax-rate name, e.g. "Standard-Rated Purchases" (9%)
  taxRateReason?: string; // why that tax code — the "when to use" rule it matched
  // A PERSON chose to leave the tax rate blank. An empty `taxRate` on its own
  // says nothing — a reader writes one when it has no code to offer — so this is
  // what separates "nobody has decided yet" from "somebody decided: none", and
  // it is the only thing that stops the backfill filling a deliberate blank.
  taxRateCleared?: boolean;
  description?: string; // plain-language summary of what was purchased
  paymentMethod?: string; // Xero payment account label the cost was paid from
  paid?: boolean; // whether the cost has been paid
  customer?: string; // Xero customer contact the cost is allocated to
  project?: string; // Xero tracking option (project) the cost is allocated to
  cardLast4?: string; // last 4 digits of the payment card (a merge-match signal)
  note?: string; // free-text note the reviewer adds on the document (Note tab)
  dueDate?: string; // ISO YYYY-MM-DD payment due date (from Extraction settings)
  // Per-line breakdown of the document (Dext-style). Stored as strings so they
  // round-trip through the editable form unchanged.
  lineItems?: Array<{
    description: string;
    category: string;
    // The two Xero tracking categories, per line ('' = follow the bill's own).
    project?: string;
    project2?: string;
    net: string;
    tax: string;
    total: string;
  }>;
  // The public document number — what the UI shows, exports print and the claim
  // PDF links. Assigned once at insert and STORED, because it has to be unique
  // and a derived number can't promise that (see nextDisplayId).
  displayId: string;
  createdAt: string; // ISO timestamp
  createdBy: string; // signed-in email of whoever UPLOADED it, or '' in mock mode
  // The document's owner — the person the User column names and the Document
  // owner field sets. Always an email, and separate from createdBy: an owner
  // can be reassigned, but who uploaded a document is a fact that shouldn't be
  // overwritten by doing so. Empty means "follow createdBy".
  owner?: string;
  storageKey: string; // storage key for the original file (r2:/local: prefixed), or ''
  contentType: string; // MIME type of the stored file, or ''
  status: string; // workflow state: 'new' (inbox) | 'ready' | 'archived' | 'merged'
  kind: string; // 'cost' (default) | 'sales' — which workspace inbox it belongs to
  // Duplicate detection, recorded on the document rather than shown once at
  // upload and forgotten. Set on the LATER of a matching pair, so the original
  // stays clean. `duplicateDismissed` is the reviewer saying "not a duplicate",
  // which survives re-checks.
  duplicateOfId?: string;
  duplicateType?: string; // exact_file | same_invoice | likely_duplicate
  duplicateDismissed?: boolean;
  // Set on a merged document: the ids of the originals it combined. Their own
  // status becomes 'merged' (out of the active inbox); Unmerge restores them.
  mergedFrom?: string[];
  // Set once the bill has been published to Xero (via the cyworkspace relay).
  // A non-empty xeroInvoiceId means "already posted" and blocks re-publishing.
  xeroInvoiceId?: string;
  xeroTenantId?: string;
  xeroTenantName?: string;
  xeroPostedAt?: string; // ISO timestamp
};

// What the caller knows about an incoming upload before it is stored.
export type Candidate = {
  fileHash: string;
  supplier: string;
  invoiceNumber: string;
  total: number;
  date: string;
  // Which book the document belongs to. Duplicate checking never crosses books:
  // an invoice you ISSUED is not a duplicate of a bill you RECEIVED, even when
  // the supplier, amount and date line up — and a match the Costs list can't
  // show is a flag nobody can act on.
  kind?: string;
  // Id of a stored document to search BEFORE: only documents that arrived
  // earlier than it are considered. Whatever comes back is then, by
  // construction, the original — so only the later of a pair is ever marked.
  beforeId?: string;
};

export type DuplicateMatch = {
  // exact_file    — byte-identical file already stored (highest confidence)
  // same_invoice  — same supplier + invoice number + amount (different scan)
  // likely_dup    — same supplier + amount + date, no invoice number to key on
  type: 'exact_file' | 'same_invoice' | 'likely_duplicate';
  bill: Bill;
};

// --- Normalization: make fuzzy human/OCR values comparable -------------------
export function normSupplier(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
export function normInvoice(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Coerce "SGD 1,240.00" / "1240" / 1240 → 1240 (0 when unparseable).
// Split a money total across weighted parts, in CENTS, so the parts sum to the
// whole exactly. Largest remainder: each part gets its floor share, and the
// spare cents go to the parts whose exact share was cut by the most (ties to
// the bigger part), so every part is the nearest cent to its true share.
//
// Used wherever one stated figure has to become per-line figures — a GST total
// printed once at the foot of an invoice, most of all. Weights are cents too;
// a non-positive total or weight-sum yields all zeroes.
export function apportion(totalCents: number, weights: number[]): number[] {
  const w = weights.map((x) => Math.max(0, Math.round(x)));
  const wSum = w.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(totalCents) || totalCents === 0 || wSum <= 0) return w.map(() => 0);
  const out = w.map((x) => Math.floor((totalCents * x) / wSum));
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const remainder = (i: number) => (totalCents * w[i]) % wSum;
  const order = w.map((_, i) => i).sort((x, y) => remainder(y) - remainder(x) || w[y] - w[x]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]] += 1;
  return out;
}

export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// --- Persistence ------------------------------------------------------------
// Default under server/.data (gitignored) so `git reset --hard` on deploy never
// clobbers it; override with BILLS_DATA_DIR. Resolves the same in dev (tsx from
// src/) and prod (compiled dist/) because it is relative to this module.
const DATA_DIR = env.BILLS_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url));
const DATA_FILE = `${DATA_DIR}/bills.json`;

let cache: Bill[] | null = null;

function load(): Bill[] {
  if (cache) return cache;
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      cache = Array.isArray(parsed?.bills) ? (parsed.bills as Bill[]) : [];
      // Documents written before numbers were stored get one now, oldest first.
      if (backfillDisplayIds(cache)) persist(cache);
    } else {
      cache = [];
    }
  } catch (err) {
    console.error('[store] could not read bills file; starting empty', err);
    cache = [];
  }
  // Legacy tenancy migration: fold old email-domain-scoped bills into the shared
  // scope. Per-org bills (orgId 'org_…', from the per-organisation books) are
  // left alone — only true legacy domain values get re-tagged.
  let migrated = false;
  for (const b of cache) {
    if (b.orgId !== WORKSPACE_ID && !b.orgId.startsWith('org_')) {
      b.orgId = WORKSPACE_ID;
      migrated = true;
    }
    // Readiness is now auto-derived: promote already-complete inbox costs into
    // Ready so existing data matches the rule. Promote-only here (never yank a
    // doc already in Ready back) to avoid surprising demotions on deploy.
    if (b.kind !== 'sales' && b.status === 'new' && costComplete(b)) {
      b.status = 'ready';
      migrated = true;
    }
  }
  if (migrated) persist(cache);
  return cache;
}

// Atomic write: tmp file + rename, so a crash mid-write can't truncate the data.
// Bumped on every write. Lets a caller skip work that only matters when the
// book has actually changed — the automatic duplicate scan reads it, so a
// listing that changed nothing costs nothing.
let revision = 0;
export const bookRevision = (): number => revision;

function persist(bills: Bill[]): void {
  revision += 1;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ bills }, null, 2));
  renameSync(tmp, DATA_FILE);
}

// --- Public API -------------------------------------------------------------
export function listBills(orgId: string): Bill[] {
  return load()
    .filter((b) => b.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// The public item id for a bill: the number the UI shows and the URL carries —
// its creation time in Singapore as YYMMDDHHMMSS (e.g. 260822123051). Derived
// from the ms embedded in the id, so it needs no storage and matches
// displayItemId() on the client exactly.
export function itemIdFor(id: string): string {
  const m = /^bill_([0-9a-z]+)_/.exec(String(id ?? ''));
  if (!m) return '';
  const ms = parseInt(m[1], 36);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms + 8 * 60 * 60 * 1000); // shift to SGT, then read UTC parts
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// The next free document number for a bill created at `ms`.
//
// The number reads as a chronological sequence — creation time in Singapore as
// YYMMDDHHMMSS — and that is exactly why it cannot be derived and left at that:
// two files uploaded in the same second produce the same twelve digits. The
// number is the document's identity (it addresses the detail page, prints on
// exports and the claim PDF, and rides into the Xero bill's description), so a
// duplicate is not a cosmetic clash — it is two documents answering to one name.
//
// So: take the plain stamp when it is free, and otherwise append the smallest
// suffix that is. A suffixed number is thirteen digits or more and a plain stamp
// is always twelve (YY covers 2000-2099), so a suffixed number can never collide
// with another second's plain stamp; against other suffixed numbers, `taken`
// settles it. Uniqueness is therefore checked, not hoped for.
//
// The previous approach — stepping the creation TIME forward a second until its
// derived number was free — bought uniqueness with a lie: a twenty-file upload
// left the last document claiming it was created nineteen seconds in the future,
// which is the field the list sorts by.
export function nextDisplayId(taken: Set<string>, ms: number): string {
  const base = itemIdFor(`bill_${ms.toString(36)}_`);
  if (!base) return '';
  if (!taken.has(base)) return base;
  for (let n = 1; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Give a number to every bill stored before they were assigned, oldest first, so
// the one that has been carrying a number in URLs and exports keeps it and only
// the documents that were SHARING it are renumbered. Runs once — after this the
// field is set and the loop does nothing.
function backfillDisplayIds(bills: Bill[]): boolean {
  const missing = bills.filter((b) => !b.displayId);
  if (!missing.length) return false;
  const taken = new Set(bills.map((b) => b.displayId).filter(Boolean));
  for (const b of [...missing].sort((x, y) => x.id.localeCompare(y.id))) {
    const m = /^bill_([0-9a-z]+)_/.exec(b.id);
    const ms = m ? parseInt(m[1], 36) : NaN;
    b.displayId = Number.isFinite(ms) && ms > 0
      ? nextDisplayId(taken, ms)
      : nextDisplayId(taken, new Date(b.createdAt).getTime() || Date.now());
    taken.add(b.displayId);
  }
  return true;
}

// The number to PRINT for a bill, by internal id: the one it was assigned, and
// only failing that the one its second derives (a bill that isn't in the store —
// a claim line for a document since deleted — still needs something to show).
export function displayIdOf(id: string): string {
  const stored = load().find((b) => b.id === id)?.displayId;
  return stored || itemIdFor(id) || (/^\d+$/.test(String(id ?? '')) ? String(id) : '');
}

// A bill answers to two keys: its internal id and its item id. Detail URLs carry
// the item id (/costs/260822123051), so every by-id lookup accepts it. The two
// can't be confused — an internal id always starts "bill_", an item id is all
// digits. Documents stored before insertBill started spacing them out can still
// share a second; the oldest wins, so the same URL always opens the same
// document (the other stays reachable by its internal id).
function byItemId(rows: Bill[], key: string): Bill | null {
  if (!/^\d+$/.test(key)) return null;
  const exact = rows.find((b) => b.displayId === key);
  if (exact) return exact;
  // A link made before a renumbering still resolves: it carries the number this
  // document's second DERIVES, which is what was shown at the time. Where two
  // shared it, the oldest wins — the one that kept the plain number.
  return rows.filter((b) => itemIdFor(b.id) === key).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

export function getBillById(orgId: string, id: string): Bill | null {
  const rows = load().filter((b) => b.orgId === orgId);
  return rows.find((b) => b.id === id) ?? byItemId(rows, id);
}

// Look up a bill by id alone, across every org. The bill id is a long,
// unguessable random token, so this is used as a capability URL for serving a
// receipt file when the caller's session/org can't be resolved (e.g. an
// exported CSV link opened in a browser that isn't signed in).
export function getBillByIdAny(id: string): Bill | null {
  const rows = load();
  return rows.find((b) => b.id === id) ?? byItemId(rows, id);
}

// Which entity's book a bill belongs to. Used to work out, from a claim's own
// items, which client entity a claim that predates per-entity scoping is for.
export function billOrgId(id: string): string {
  return getBillByIdAny(id)?.orgId ?? '';
}

// Filler a language model reaches for when a field is described as "never empty"
// and it has nothing real to say. These are worse than a blank: `description` is
// published to the ledger as the bill's line description, where "placeholder"
// reads as a genuine answer. Blank them and let the fallbacks take over.
const FILLER = new Set([
  'placeholder', 'place holder', 'n/a', 'na', 'n.a.', 'none', 'nil', 'null', 'undefined',
  'unknown', 'unspecified', 'not specified', 'not available', 'no description',
  'description', 'summary', 'tbd', 'tba', 'todo', 'xxx', '-', '--', '.',
]);
export const notFiller = (v: unknown): string => {
  const text = String(v ?? '').trim();
  const base = text.toLowerCase().replace(/[.!]+$/, '');
  // Also compare with the dots gone, so "n.a." lands on "na". Whole-string
  // matches only — "Placeholder Ltd — office rent" is a real description.
  return FILLER.has(base) || FILLER.has(base.replace(/\./g, '')) ? '' : text;
};

// A description assembled from what was actually read, for when the reader gives
// nothing back: "Singtel — Telephone & Internet", or "Singtel invoice" when the
// document isn't categorised. Derived from the document, never invented. Empty
// when there isn't even a supplier to build on.
export function derivedDescription(supplier: unknown, category: unknown, documentType: unknown): string {
  const who = String(supplier ?? '').trim();
  if (!who || who.toLowerCase() === 'unknown supplier') return '';
  // Categories read "489 - Telephone & Internet"; the code adds nothing here.
  const what = String(category ?? '').replace(/^\s*\d+\s*-\s*/, '').trim();
  if (what && what.toLowerCase() !== 'uncategorised') return `${who} — ${what}`;
  const type = String(documentType ?? '').trim().toLowerCase();
  return type ? `${who} ${type}` : who;
}

// A bill for a stretch of service reads very differently with its period on it:
// "Singtel — Telephone & Internet (25 May – 24 Jun 2026)" says which month's
// charge this is, which matters when twelve of them look otherwise identical.
// Appended rather than asked for inline, so the reader can't fold it in twice.
export function withPeriod(description: unknown, period: unknown): string {
  const text = String(description ?? '').trim();
  const span = String(period ?? '').trim().slice(0, 60);
  if (!span || !text) return text;
  // Already said it — a reader that worked the dates into its own sentence
  // keeps its wording rather than getting them twice.
  const loose = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (loose(text).includes(loose(span))) return text;
  return `${text} (${span})`;
}

// One-off cleanup for documents read before the reader stopped emitting filler.
// Idempotent (a blank stays blank), so it is safe to run at every boot. Returns
// how many documents it cleaned.
export function scrubFillerText(): number {
  const bills = load();
  let n = 0;
  for (const b of bills) {
    let touched = false;
    for (const key of ['description', 'categoryReason', 'taxRateReason', 'projectReason'] as const) {
      const before = b[key];
      if (before && notFiller(before) === '') {
        // A description is the one of the three worth replacing rather than
        // just clearing — it's what publishes to the ledger as the line.
        b[key] = key === 'description' ? derivedDescription(b.supplier, b.category, b.documentType) : '';
        touched = true;
      }
    }
    for (const li of b.lineItems ?? []) {
      if (li.description && notFiller(li.description) === '') {
        li.description = '';
        touched = true;
      }
    }
    if (touched) n += 1;
  }
  if (n) persist(bills);
  return n;
}

// The inbox: documents still being worked on. One that has LEFT it — archived,
// published to Xero (which archives it), sitting on an expense claim, or merged
// away — is settled, and re-raising a duplicate flag on it is noise about a
// decision already taken. So the automatic check only ever flags an inbox
// document. Settled documents stay in the corpus it compares against, because
// re-submitting an invoice that was published last month is exactly the
// duplicate worth catching — what never happens is archived being matched
// against archived.
const INBOX_STATUSES = new Set(['new', 'viewed', 'processing', 'review', 'ready']);
const inInbox = (b: Bill) => INBOX_STATUSES.has(String(b.status || 'new'));

// Costs / Sales / Supplier statements are separate books; anything unrecognised
// is a cost, matching how insertBill normalises it.
export const billKind = (k: unknown): string =>
  k === 'sales' ? 'sales' : k === 'supplier_statement' ? 'supplier_statement' : 'cost';

// First (highest-confidence) duplicate for `cand`, or null. Cheapest checks
// first; each tier requires the fields it keys on to actually be present.
export function findDuplicate(orgId: string, cand: Candidate, excludeId?: string): DuplicateMatch | null {
  // A deleted bill must not block re-uploading the same file, or a receipt the
  // user removed becomes impossible to add back. A merged-away source is
  // superseded by the document it was merged into, which carries the same
  // fields — matching it would raise the same pair twice. `excludeId` skips the
  // row being finalized so a doc never matches itself after its fields are read.
  const kind = billKind(cand.kind);
  const all = load();
  // "Earlier" is position in the store, which is insertion order — not the
  // createdAt timestamp, which a batch upload gives several documents at once,
  // and not the id, whose random suffix makes same-millisecond ids sort
  // arbitrarily. This way each pair has exactly one original, and it's the one
  // that really did arrive first.
  const cutoff = cand.beforeId ? all.findIndex((b) => b.id === cand.beforeId) : -1;
  const bills = all.filter(
    (b, i) =>
      b.orgId === orgId &&
      billKind(b.kind) === kind &&
      b.status !== 'deleted' &&
      b.status !== 'merged' &&
      b.id !== excludeId &&
      (cutoff < 0 || i < cutoff)
  );

  if (cand.fileHash) {
    const hit = bills.find((b) => b.fileHash && b.fileHash === cand.fileHash);
    if (hit) return { type: 'exact_file', bill: hit };
  }

  const supplier = normSupplier(cand.supplier);
  const invoice = normInvoice(cand.invoiceNumber);
  const total = parseAmount(cand.total);

  if (supplier && invoice) {
    const hit = bills.find(
      (b) =>
        normSupplier(b.supplier) === supplier &&
        normInvoice(b.invoiceNumber) === invoice &&
        Math.abs(b.total - total) < 0.01
    );
    if (hit) return { type: 'same_invoice', bill: hit };
  }

  if (supplier && total > 0 && cand.date) {
    const hit = bills.find(
      (b) =>
        normSupplier(b.supplier) === supplier &&
        Math.abs(b.total - total) < 0.01 &&
        b.date === cand.date
    );
    if (hit) return { type: 'likely_duplicate', bill: hit };
  }

  return null;
}

// Re-check ONE bill against every other stored document and record the verdict
// on it. Only the later of a pair is flagged — the earlier one is the original,
// and marking both would double every duplicate in the list. A reviewer's
// "not a duplicate" is never overwritten. Returns the updated bill.
export function flagDuplicate(orgId: string, id: string): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  // Drop a pointer the document is no longer entitled to carry, so nothing
  // counts or renders it. Two cases end up here:
  //   - the reviewer said "not a duplicate", which is final; and
  //   - the document has left the inbox (archived / claimed / merged), which
  //     settles it either way.
  const clearFlag = (): Bill => {
    if (!bill.duplicateOfId && !bill.duplicateType) return bill;
    bill.duplicateOfId = undefined;
    bill.duplicateType = undefined;
    persist(bills);
    return bill;
  };
  if (bill.duplicateDismissed) return clearFlag();
  // Settled document: never flag it, and drop any flag it picked up before it
  // was archived / claimed / merged, so nothing stale is left behind.
  if (!inInbox(bill)) return clearFlag();

  const match = findDuplicate(
    orgId,
    {
      fileHash: bill.fileHash,
      supplier: bill.supplier,
      invoiceNumber: bill.invoiceNumber,
      total: bill.total,
      date: bill.date,
      kind: bill.kind,
      // Only documents that arrived before this one, so a match IS the original
      // and this one carries the flag. The search used to run over the whole
      // book and its single result was then tested for age — so a document
      // whose first match happened to be a NEWER copy came back clean even when
      // an older copy existed, and three copies of one invoice flagged one or
      // two of themselves depending on store order.
      beforeId: bill.id,
    },
    bill.id
  );
  const nextId = match ? match.bill.id : '';
  const nextType = match ? match.type : '';
  if ((bill.duplicateOfId ?? '') === nextId && (bill.duplicateType ?? '') === nextType) return bill;

  bill.duplicateOfId = nextId || undefined;
  bill.duplicateType = nextType || undefined;
  persist(bills);
  return bill;
}

// Re-check EVERY stored document, oldest first, so a corpus that predates
// duplicate flagging (or was added with "Add anyway") gets marked. Settled
// documents (and dismissed ones) are walked too — not to flag them, but so
// flagDuplicate drops any pointer they are still carrying.
//
// Walks ONE book (Costs by default), so the number it reports is a number the
// list in front of you can be reconciled against.
//
// `flagged` counts what the list will actually show a chip for, and `changed`
// only documents that GAINED a flag. Counting every write here is what made a
// scan report "1 document flagged" over a list showing none: a document the
// reviewer had marked "not a duplicate" still carried its pointer, so it was
// counted while the UI — correctly — hid it.
export function scanDuplicates(orgId: string, kind = 'cost'): { flagged: number; changed: number } {
  const wanted = billKind(kind);
  const ordered = load()
    .filter((b) => b.orgId === orgId && billKind(b.kind) === wanted && b.status !== 'deleted')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  let changed = 0;
  let flagged = 0;
  for (const b of ordered) {
    const before = b.duplicateOfId ?? '';
    const after = flagDuplicate(orgId, b.id);
    if (!after?.duplicateOfId) continue;
    flagged += 1;
    if (after.duplicateOfId !== before) changed += 1;
  }
  return { flagged, changed };
}

export type BillInput = Omit<Bill, 'id' | 'createdAt' | 'displayId'>;

// A cost is "Ready" when it carries the fields the rest of the workflow needs.
// The system decides readiness by validating these (per the Support Desk ask),
// rather than relying on a manual "Move to ready" click.
const amount = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const filled = (v: unknown) => v != null && String(v).trim() !== '' && String(v).trim() !== '—';
export function costComplete(b: Bill): boolean {
  const supplier = filled(b.supplier) && String(b.supplier).trim().toLowerCase() !== 'unknown supplier';
  const category = filled(b.category) && String(b.category).trim().toLowerCase() !== 'uncategorised';
  return supplier && filled(b.date) && category && amount(b.total) > 0;
}

// Auto-move a cost between the inbox ('new') and 'ready' based on completeness.
// Only ever toggles those two states — never touches processing/review/archived/
// expenseclaim/deleted, or sales. Returns true if the status changed.
function applyAutoReady(b: Bill): boolean {
  if (b.kind !== 'cost') return false; // only cost docs use the inbox↔ready flow
  if (b.status === 'new' && costComplete(b)) { b.status = 'ready'; return true; }
  if (b.status === 'ready' && !costComplete(b)) { b.status = 'new'; return true; }
  return false;
}

export function insertBill(input: BillInput): Bill {
  const bills = load();
  // The creation time is the creation time — the document number carries the
  // uniqueness, so nothing here has to bend the clock to get it.
  const ms = Date.now();
  const taken = new Set(bills.map((b) => b.displayId).filter(Boolean));
  const bill: Bill = {
    ...input,
    id: `bill_${ms.toString(36)}_${randomUUID().slice(0, 8)}`,
    displayId: nextDisplayId(taken, ms),
    createdAt: new Date(ms).toISOString(),
  };
  applyAutoReady(bill); // a fully-extracted upload lands straight in Ready
  bills.push(bill);
  persist(bills);
  return bill;
}

// Re-evaluate a bill's ready/inbox status from its current fields, after a
// field edit. Persists if it changed. Returns the bill (or null if not found).
export function reconcileReadiness(orgId: string, id: string): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  if (applyAutoReady(bill)) persist(bills);
  return bill;
}

// Rescue documents stuck in "Processing" — the client advances a doc to the
// inbox right after Vision reads it, but that step is lost if the tab closes
// mid-read. After a grace period, any still-processing cost is moved to the
// inbox (and auto-readied if complete), server-side, so nothing gets stuck.
// Called on every bills fetch, so it self-heals without a background worker.
const PROCESSING_GRACE_MS = 60_000;
export function sweepStuckProcessing(orgId: string): void {
  const bills = load();
  const now = Date.now();
  let changed = false;
  for (const b of bills) {
    if (
      b.orgId === orgId &&
      b.kind !== 'sales' &&
      b.status === 'processing' &&
      b.createdAt &&
      now - new Date(b.createdAt).getTime() > PROCESSING_GRACE_MS
    ) {
      b.status = 'new';
      applyAutoReady(b);
      changed = true;
    }
  }
  if (changed) persist(bills);
}

// Fields a client is allowed to edit on an existing bill.
const EDITABLE: (keyof Bill)[] = [
  'owner',
  'supplier',
  'invoiceNumber',
  'documentType',
  'currency',
  'total',
  'tax',
  'date',
  'category',
  'categoryReason',
  'projectReason',
  'taxRate',
  'taxRateReason',
  'taxRateCleared',
  'description',
  'status',
  'createdBy',
  'paymentMethod',
  'paid',
  'lineItems',
  'customer',
  'project',
  'cardLast4',
  'note',
  'dueDate',
  'duplicateDismissed',
  'duplicateOfId',
  'duplicateType',
];

// Attach (or replace) the stored file on an existing bill. Returns null if not
// found.
export function setBillFile(
  orgId: string,
  id: string,
  storageKey: string,
  contentType: string
): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  bill.storageKey = storageKey;
  bill.contentType = contentType;
  persist(bills);
  return bill;
}

// Record a successful publish to Xero. Separate from updateBill so the Xero
// provenance fields can never be edited through the generic PATCH endpoint.
export function markBillPosted(
  orgId: string,
  id: string,
  info: { xeroInvoiceId: string; xeroTenantId: string; xeroTenantName: string }
): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  bill.xeroInvoiceId = info.xeroInvoiceId;
  bill.xeroTenantId = info.xeroTenantId;
  bill.xeroTenantName = info.xeroTenantName;
  bill.xeroPostedAt = new Date().toISOString();
  // Publishing finishes a document: it drops out of the inbox into Archive, and
  // (see the claims route) can no longer be put on an expense claim. Publishing
  // and claiming are two routes for the same cost to reach the ledger — a
  // document takes one of them, never both.
  if (bill.status !== 'deleted') bill.status = 'archived';
  persist(bills);
  return bill;
}

// Mark cost documents as sitting on an expense claim. Same finishing move as a
// publish: they leave the inbox for Archive, and the claim — not the document —
// is what reaches Xero from here. One pass over the store for the whole batch.
export function markBillsClaimed(ids: string[]): number {
  const wanted = new Set(ids.map(String));
  if (!wanted.size) return 0;
  const bills = load();
  let n = 0;
  for (const bill of bills) {
    if (!wanted.has(bill.id) || bill.status === 'deleted' || bill.status === 'expenseclaim') continue;
    bill.status = 'expenseclaim';
    n += 1;
  }
  if (n) persist(bills);
  return n;
}

// Inverse of markBillsClaimed: return the given bills from a claim back to the
// Costs inbox (→ 'new', then auto-promoted to 'ready' if they're complete). Used
// when a claim is deleted so its items aren't orphaned in the 'expenseclaim'
// state with no claim to belong to.
export function unmarkBillsClaimed(ids: string[]): number {
  const wanted = new Set(ids.map(String));
  if (!wanted.size) return 0;
  const bills = load();
  let n = 0;
  for (const bill of bills) {
    if (!wanted.has(bill.id) || bill.status !== 'expenseclaim') continue;
    bill.status = 'new';
    applyAutoReady(bill);
    n += 1;
  }
  if (n) persist(bills);
  return n;
}

// Forget that a bill was ever published: clears the Xero provenance and brings
// the document back out of Archive. Purely local — it does NOT delete anything
// in Xero. For the case where the bill was deleted (or voided) at the Xero end
// and the document needs to be publishable again.
export function clearBillPosted(orgId: string, id: string): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  const wasPublished = Boolean(bill.xeroInvoiceId);
  bill.xeroInvoiceId = undefined;
  bill.xeroTenantId = undefined;
  bill.xeroTenantName = undefined;
  bill.xeroPostedAt = undefined;
  // Publishing is what archived it, so undoing the publish undoes that too —
  // but only if there was a publish to undo. A document parked in Archive by
  // hand stays there, and one sitting on an expense claim stays on it.
  if (wasPublished && bill.status === 'archived') bill.status = 'new';
  persist(bills);
  return bill;
}

// Update an existing bill's editable fields in place. Returns null if not found.
export function updateBill(orgId: string, id: string, patch: Partial<Bill>): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  for (const key of EDITABLE) {
    if (key in patch && patch[key] !== undefined) {
      (bill as Record<string, unknown>)[key] = patch[key];
    }
  }
  persist(bills);
  return bill;
}

// Permanently remove a bill from the store. Unlike a soft delete (status →
// 'deleted', which keeps the row and its stored file so it can be restored),
// this drops the record entirely. Returns the removed bill so the caller can
// reclaim its stored file (see deleteBillFile); null if not found.
export function deleteBillHard(orgId: string, id: string): Bill | null {
  const bills = load();
  const idx = bills.findIndex((b) => b.orgId === orgId && b.id === id);
  if (idx === -1) return null;
  const [removed] = bills.splice(idx, 1);
  persist(bills);
  return removed;
}

// Whether any remaining bill still references this stored file. Content-addressed
// storage keys by file hash, so identical uploads (e.g. the same receipt emailed
// twice) share ONE object — deleting one bill must not reclaim a file another
// still points at. Call after the bill has been removed.
export function storageKeyInUse(storageKey: string): boolean {
  if (!storageKey) return false;
  return load().some((b) => b.storageKey === storageKey);
}
