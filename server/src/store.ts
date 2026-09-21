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
  // Set on every page cut from one multi-page PDF (Add documents → "Split PDF
  // by page"): a shared id for the file they came from, and this page's place
  // in it. Not a guess about what belongs together — the app did the cutting.
  splitGroup?: string;
  splitPage?: number;
  splitPages?: number;
  // A cost incurred on a client's behalf and billed back to them — Xero's
  // "billable expense", Dext's "rebillable". With `customer`, publishing links
  // the posted bill's lines to that client so Xero offers them on their next
  // invoice. Meaningless without a customer: there would be nobody to bill.
  rebillable?: boolean;
  fileHash: string; // sha256 hex of the raw upload; exact-file dedup key
  fileName: string;
  supplier: string;
  invoiceNumber: string;
  documentType: string;
  currency: string;
  total: number;
  tax: number;
  // What the document says the same money is worth in the base currency, and
  // the rate it printed to say so. Only ever set on a foreign-currency document
  // that restates itself for tax purposes (see `restatement` in extract.ts):
  // it decides the GST percentage, and it is what goes to Xero as CurrencyRate
  // so the ledger's GST report agrees with the figure on the paper.
  baseCurrency?: string;
  baseTotal?: number; // including tax, in baseCurrency
  baseTax?: number; // in baseCurrency
  exchangeRate?: number; // units of baseCurrency per 1 unit of `currency`
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
  // The WhatsApp message a document arrived in, when it came through a bill
  // collection group rather than by email or upload. Same purpose as `email`
  // above and kept separate rather than folded into it: they are different
  // envelopes (a chat has no subject and no recipient, and the sender is a
  // phone number), and the document page shows each under its own tab.
  whatsapp?: {
    submissionId: string;
    chatId: string;
    chatSubject: string;
    messageId: string;
    waMessageId: string;
    from: string;
    senderName: string;
    // '+60123456789'. WhatsApp's own where it sent one, else the roster's for
    // the person the group was opened for — WhatsApp increasingly puts a LID in
    // `from`, which is not a number. Absent on rows filed before it existed;
    // the listing fills those in (`backfillWhatsappSenders`).
    senderNumber?: string;
    // The roster row of the person who ACTUALLY sent it, once identified — by
    // their number, by what a LID was learned to be, or by a reviewer saying so
    // on the document. '' means the name above is a stand-in (the group's own
    // person, or a bare push name), which is what offers the "Sent by" picker.
    senderUserId?: string;
    // The push name WhatsApp sent, as sent, so a later repair can start from
    // what was received rather than from a name CYBills itself resolved.
    senderPushName?: string;
    text: string;
    sentAt: string;
    fileName: string;
  };
  // A document that arrived as a LINK rather than as a file: an emailed invoice
  // whose PDF is behind a portal login. It is a real row in the inbox from the
  // moment the mail lands — with no file yet, because following a stranger's
  // link with n8n's portal credentials is a decision somebody has to make. This
  // is the question and its answer: who sent it, what the links were, and where
  // the fetch got to. Not EDITABLE — like `whatsapp`, it is the record of what
  // was received rather than a field anybody types into.
  emailLink?: {
    /** The mirrored message (mailThread.ts) this document came from. */
    messageId: string;
    /** The sender the trust question is ABOUT, normalised. */
    from: string;
    links: string[];
    /** 'awaiting_trust' — asking; 'fetched' — the file below came from a link;
     *  'failed' — it was tried and n8n could not produce a document. */
    status: 'awaiting_trust' | 'fetched' | 'failed';
    /** n8n's own words on the last attempt, or why it has not been attempted. */
    note: string;
    at: string;
  };
  taxRate?: string; // GST/tax-rate name, e.g. "Standard-Rated Purchases" (9%)
  taxRateReason?: string; // why that tax code — the "when to use" rule it matched
  // A PERSON chose to leave the tax rate blank. An empty `taxRate` on its own
  // says nothing — a reader writes one when it has no code to offer — so this is
  // what separates "nobody has decided yet" from "somebody decided: none", and
  // it is the only thing that stops the backfill filling a deliberate blank.
  taxRateCleared?: boolean;
  // A person PICKED the code. The pair say the same thing about two different
  // answers — this document's code was decided by a human, not worked out — and
  // between them they are what stops anything that runs by itself (the
  // listing's backfill, a supplier rule, a re-read) overruling somebody.
  taxRateEdited?: boolean;
  // Which fields the SUPPLIER RULE last wrote. Provenance, not a guess: it is
  // what lets an edited rule update the documents it already filled while
  // leaving alone anything a person typed. A field a person edits drops out of
  // here, because they have taken it over.
  ruleFields?: string[];
  description?: string; // plain-language summary of what was purchased
  paymentMethod?: string; // Xero payment account label the cost was paid from
  paid?: boolean; // whether the cost has been paid
  // The bank statement line this document is going to be paid AGAINST — Dext's
  // "Autofill payment": the inbox found the line in the bank feed that pays
  // this document, a person accepted it, and when the document is PUBLISHED
  // the payment is recorded from that bank account on the statement date, so
  // the line reconciles in Xero. Pending until publish; cleared by it (the
  // settlement is then in the bank-lines record) or by the person. Not in
  // EDITABLE — written only by the autofill route, which checks the money
  // first (server/src/bankMatch.ts).
  bankMatch?: {
    key: string;
    date: string;
    amount: number; // signed, negative = money out
    currency: string;
    reference: string;
    description: string;
    bankAccountId: string;
    bankAccountName: string;
    bankAccountCode: string;
    // What the document said before the autofill turned Paid on, so clearing
    // it puts them back.
    paidBefore: boolean;
    paymentMethodBefore: string;
    at: string;
    by: string;
  };
  customer?: string; // Xero customer contact the cost is allocated to
  project?: string; // Xero tracking option (project) the cost is allocated to
  // The option of the org's SECOND tracking category ("Staff", say), set by hand.
  // Posted beside `project` on a single-line bill, and the fallback for a line
  // item that names none of its own.
  project2?: string;
  cardLast4?: string; // last 4 digits of the payment card (a merge-match signal)
  // A Mileage document's own two figures: the distance driven, read off the
  // map route / odometer / log it is a record of, and the rate per km it is
  // reimbursed at (the entity's default unless changed on the document). Its
  // total is DERIVED from them — see src/lib/mileage.js — never typed.
  distanceKm?: number;
  mileageRate?: number;
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
    // The line's own tax code ('' = the bill's). A discount taken off after tax
    // or a fee outside GST posts under its own code beside a 9% supply.
    taxRate?: string;
    net: string;
    tax: string;
    total: string;
  }>;
  // The public document number — what the UI shows, exports print and the claim
  // PDF links. Assigned once at insert and STORED, because it has to be unique
  // and a derived number can't promise that (see nextDisplayId).
  displayId: string;
  // The document's Item ID in Dext (their export calls the column "Receipt ID"),
  // set only by an import. It is the one identity two systems agree on, so a
  // second import of the same export — or an overlapping one — finds it and
  // skips the row rather than filing the same cost twice.
  dextId?: string;
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
  // Who the document is billed TO, as the reader found it on the paper. Read
  // for ONE purpose: checking the document against the entity it was filed
  // under. Which book a document lands in is decided by provenance — who
  // uploaded it, which address it was emailed to, which WhatsApp group it came
  // through — and nothing had ever read the paper, so an invoice made out to
  // one client and filed under another published into the wrong ledger looking
  // entirely correct. Never used to code anything (see src/lib/billedTo.js).
  billedTo?: string;
  billedToRegNo?: string;
  // The evidence the tax code was decided on: the supplier's GST registration
  // number and what the paper calls its tax ("GST 9%"), as the read found them.
  // Read on every document for years and thrown away the moment the code was
  // chosen, so "why didn't it take the GST?" could never be answered from the
  // record — only by reading the paper again and guessing what the reader saw.
  // `supplierGstRegNoRemembered` says the number was NOT on this read at all,
  // but carried over from an earlier document of the same supplier's
  // (server/src/supplierGst.ts) — never itself a source for the next one.
  supplierGstRegNo?: string;
  supplierGstRegNoRemembered?: boolean;
  // Where a remembered number came from: this entity's supplier rule, another
  // entity's, or an earlier document ('rule' | 'ruleOther' | 'document').
  supplierGstRegNoFrom?: string;
  // The reader's judgement that the paper is the cost of owning or running a
  // motor vehicle — fuel, parking, servicing. With a motor vehicle account it is
  // what makes the document No Tax in every client's book (motorVehicle.ts).
  motorVehicle?: boolean;
  taxLabel?: string;
  // The reviewer saying the entity is right after all — an intercompany
  // recharge, a trading name, a group company paying for a subsidiary. Same
  // shape and the same reason as `duplicateDismissed`: a warning nobody can
  // silence is one everybody learns to scroll past.
  entityCheckDismissed?: boolean;
  // Where this document was before somebody moved it to another entity. One
  // field rather than a log: it exists so the History tab can say the move
  // happened and who did it, which is the whole record a move needs.
  movedFrom?: { orgId: string; orgName: string; at: string; by: string };
  // Set on a merged document: the ids of the originals it combined. Their own
  // status becomes 'merged' (out of the active inbox); Unmerge restores them.
  mergedFrom?: string[];
  // Set once the bill has been published to Xero (via the cyworkspace relay).
  // A non-empty xeroInvoiceId means "already posted" and blocks re-publishing.
  xeroInvoiceId?: string;
  // WHAT it was posted as. A credit note goes up as an ACCPAYCREDIT credit note
  // rather than an ACCPAY bill, and Xero keeps the two in different endpoints
  // with different ids — so every later read, update or attachment has to know
  // which one to ask for. Absent on rows published before credit notes could
  // be, which were all bills.
  xeroDocType?: 'ACCPAY' | 'ACCPAYCREDIT';
  xeroTenantId?: string;
  xeroTenantName?: string;
  xeroPostedAt?: string; // ISO timestamp
  // What XERO says has happened to the published bill since, read back when its
  // invoice webhook fires (xeroWebhook.ts). Deliberately NOT `paid`: that one is
  // the reviewer's own flag, meaning "this was already settled when it was
  // captured, so publish it as paid" — Dext's sense, defaulted per document type
  // in Extraction settings and written by supplier rules. These three are the
  // ledger's answer, they are never edited here, and they are absent until the
  // bill has been published and something has touched it in Xero.
  xeroStatus?: string; // Xero's own Status: PAID | AUTHORISED | VOIDED | …
  xeroPaidDate?: string; // FullyPaidOnDate, ISO YYYY-MM-DD; only ever set on PAID
  xeroPaymentRef?: string; // the payment's own Reference in Xero, joined if several
  // The emoji CYBills last put on the WhatsApp message this document arrived
  // in — '' when none has been sent. Not a person's field and not WhatsApp's
  // answer either: it is what WE last said, kept so the same tick is not sent
  // again on every read, every webhook burst and every payments sync. WhatsApp
  // allows one reaction per account per message, so a later one REPLACES the
  // earlier — which is exactly the progression wanted (received, then paid).
  whatsappReaction?: string;
  // A PAYMENT PROOF and the invoices it pays (src/lib/proofMatch.js). On the
  // proof: which documents it settles, when, by whom, and whether it applied
  // itself. `proofAutoDeclined` is somebody undoing an automatic match, which the
  // sweep must not simply make again. On each invoice: the proof that paid it,
  // and what Paid and the payment method said before, so Undo puts them back.
  // Their own writers (applyPaymentProof / unapplyPaymentProof), never EDITABLE.
  paysBills?: string[];
  // Set the moment a proof is archived for being one — by the write that typed
  // it, or by the sweep over the ones typed before that rule existed. It is
  // what makes the setting-aside happen ONCE: a proof somebody pulls back out
  // of Archived keeps the flag, so nothing puts it back there behind them.
  proofSetAside?: boolean;
  paysBillsAppliedAt?: string;
  paysBillsAppliedBy?: string;
  paysBillsAuto?: boolean;
  proofAutoDeclined?: boolean;
  paidByProof?: {
    proofId: string;
    proofDisplayId: string;
    date: string;
    reference: string;
    appliedAt: string;
    appliedBy: string;
    auto: boolean;
    before: { paid: boolean; paymentMethod: string };
  };
  // A QUOTATION or PRO-FORMA paid in advance (src/lib/prepayment.js), recorded
  // in Xero as an OVERPAYMENT to the supplier rather than published as a bill.
  // On the quotation: the overpayment, where the money came from, and each
  // invoice it has since been allocated against. On each invoice: the
  // prepayments it used. Their own writers (setBillPrepayment /
  // recordPrepaymentAllocation), never EDITABLE — both are records of what Xero
  // was told.
  prepayment?: {
    overpaymentId: string;
    bankTransactionId: string;
    amount: number;
    currency: string;
    date: string;
    reference: string;
    bankAccount: { code: string; name: string };
    contactId: string;
    recordedAt: string;
    recordedBy: string;
    allocations: PrepaymentAllocation[];
    // What the document said before recording made it Paid and set it aside,
    // so taking the prepayment back out of Xero puts it back.
    before?: { status: string; paid: boolean; paymentMethod: string };
  };
  prepaymentsApplied?: Array<PrepaymentAllocation & { fromId: string; fromDisplayId: string; reference: string; overpaymentId: string }>;
};

export type PrepaymentAllocation = {
  billId: string;
  displayId: string;
  invoiceId: string;
  amount: number;
  date: string;
  at: string;
  by: string;
  auto: boolean;
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

// Every document published as this Xero invoice, across every entity's book.
// A Xero InvoiceID is unique, so this is normally none or one — a list because
// the caller (the webhook receiver) has no business assuming that and nothing
// here enforces it. Deliberately scope-free: a webhook event names a TENANT,
// and a bridge entity's documents live in their own book while posting into
// the parent's tenant, so "which book" can't be worked out from the event.
export function billsByXeroInvoiceId(invoiceId: string): Bill[] {
  const want = String(invoiceId ?? '').trim().toLowerCase();
  if (!want) return [];
  return load().filter((b) => String(b.xeroInvoiceId ?? '').toLowerCase() === want);
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

// The live document in this entity that was imported from Dext under `dextId`.
//
// A document imported before the ID was stored carries it only in its file
// name — "21616969450" for one fetched from the export's link, the downloaded
// file's own name otherwise — so a row with no `dextId` is matched by a whole
// run of digits in that name. Mirrored by `importedDextIds` in
// src/lib/dextImport.js, which the import screen uses to count the skips
// before it fetches anything. A deleted document does not count: removing one
// must not make it impossible to bring back.
export function billByDextId(orgId: string, dextId: string): Bill | null {
  const id = String(dextId ?? '').trim();
  if (!id) return null;
  return (
    load().find(
      (b) =>
        b.orgId === orgId &&
        b.status !== 'deleted' &&
        (b.dextId ? b.dextId === id : (String(b.fileName ?? '').match(/\d{6,}/g) ?? ([] as string[])).includes(id))
    ) ?? null
  );
}

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
      !isPaymentProofType(b.documentType) &&
      !isAdvanceType(b.documentType) &&
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

// A credit note or refund: the supplier owes US, so the document's money runs
// the other way. Decided by the TYPE a person (or the reader) gave it, not by
// the sign of the total — a negative total on an ordinary invoice is a misread,
// and treating it as a credit note would post a refund nobody received.
// Matches "Credit note/refund" (the document page's list), "Credit note" (bulk
// edit), and whatever else says credit.
export function isCreditNote(b: { documentType?: unknown }): boolean {
  return String(b?.documentType ?? '').trim().toLowerCase().includes('credit');
}

// A payment proof (src/lib/paymentProof.js, whose isPaymentProof this mirrors
// for the synchronous store). Never a duplicate of the invoice it pays: the two
// share a supplier, a total and often a date, and they are the payment and the
// bill — which is what proofMatch.js pairs, not what the duplicate check flags.
export function isPaymentProofType(type: unknown): boolean {
  return String(type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ') === 'payment proof';
}

// A quotation or pro-forma (src/lib/prepayment.js, whose isAdvanceDocument this
// mirrors for the synchronous store). Never a duplicate of the invoice that
// follows it: the two share a supplier and often an amount, and they are the
// advance and the bill it is used up by.
export function isAdvanceType(type: unknown): boolean {
  const t = String(type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return ['quotation', 'quote', 'pro forma invoice', 'proforma invoice', 'pro forma', 'proforma'].includes(t);
}

// The total a document needs to be complete. A bill's must be above 0; a
// credit note's may be typed either way round — "-530" as the paper shows it
// or "530" as the amount credited — so it only has to be non-zero. Both post
// as 530 of credit (see buildBillInvoice in xero.ts).
export function totalComplete(b: Bill): boolean {
  const n = amount(b.total);
  return isCreditNote(b) ? n !== 0 : n > 0;
}

export function costComplete(b: Bill): boolean {
  const supplier = filled(b.supplier) && String(b.supplier).trim().toLowerCase() !== 'unknown supplier';
  const category = filled(b.category) && String(b.category).trim().toLowerCase() !== 'uncategorised';
  return supplier && filled(b.date) && category && totalComplete(b);
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

// Move every document from one identity to another, inside one book.
//
// Somebody added to a roster without an email owns documents under an internal
// identity (users.ts, internalEmailFor). The day they sign in for the first
// time and claim that row, the identity becomes their real address — and the
// documents already theirs have to come with it, or their name silently drops
// off work they did. Returns how many moved.
export function reassignPerson(orgId: string, from: string, to: string): number {
  const a = String(from ?? '').trim().toLowerCase();
  const b = String(to ?? '').trim();
  if (!a || !b || a === b.toLowerCase()) return 0;
  const bills = load();
  let moved = 0;
  for (const bill of bills) {
    if (bill.orgId !== orgId) continue;
    let touched = false;
    if (String(bill.owner ?? '').trim().toLowerCase() === a) { bill.owner = b; touched = true; }
    // The uploader is history and normally never rewritten — but this is the
    // same person under a new address, not a different one.
    if (String(bill.createdBy ?? '').trim().toLowerCase() === a) { bill.createdBy = b; touched = true; }
    if (touched) moved += 1;
  }
  if (moved) persist(bills);
  return moved;
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

// A background read has ENDED — successfully, emptily, or not at all — so the
// document is no longer being processed and says so. Moves it out of
// 'processing' and then applies the ordinary auto-ready, which is what decides
// between Ready and To review from what the read left behind.
//
// Deliberately not folded into reconcileReadiness, which must NOT demote
// 'processing': the browser sets that status on its own upload and clears it
// itself, so a PATCH arriving mid-read would end the state early and put a
// half-read document back in the inbox.
//
// Where it lands is the caller's to say, because only the caller knows what the
// read RETURNED. A document the reader got nothing off is set aside rather than
// filed (`landAs: 'archived'` — see blankRead.ts): there is nothing on it to
// code, so in the inbox it is noise in the one list that is supposed to be the
// work. Everything else, failures included, lands in the inbox as it always
// did — a read that never completed means nobody has looked at this yet, which
// is not the same thing at all.
export function settleProcessing(orgId: string, id: string, landAs: 'new' | 'archived' = 'new'): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  let changed = false;
  if (bill.status === 'processing') {
    bill.status = landAs;
    changed = true;
  }
  // Never for a document that was set aside: applyAutoReady reads completeness,
  // and a blank document is not complete, so this is only ever the ordinary
  // new-vs-ready decision it has always been.
  if (applyAutoReady(bill) || changed) persist(bills);
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
  'baseCurrency',
  'baseTotal',
  'baseTax',
  'exchangeRate',
  'date',
  'category',
  'categoryReason',
  'projectReason',
  'taxRate',
  'taxRateReason',
  'taxRateCleared',
  'taxRateEdited',
  'ruleFields',
  'description',
  'status',
  'createdBy',
  'paymentMethod',
  'paid',
  'lineItems',
  'customer',
  'rebillable',
  'project',
  'project2',
  'cardLast4',
  'distanceKm',
  'mileageRate',
  'note',
  'dueDate',
  'duplicateDismissed',
  'duplicateOfId',
  'duplicateType',
  // Evidence off the paper, written by the read and re-written by a re-read —
  // not typed by anybody, but they travel the same PATCH the rest of a read's
  // answer does.
  'billedTo',
  'billedToRegNo',
  'supplierGstRegNo',
  'supplierGstRegNoRemembered',
  'supplierGstRegNoFrom',
  'motorVehicle',
  'taxLabel',
  'entityCheckDismissed',
  // Written by keepPaymentProofInStep beside the status it archives, never taken
  // from a request body (the PATCH route copies named fields only).
  'proofSetAside',
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
  info: { xeroInvoiceId: string; xeroDocType?: 'ACCPAY' | 'ACCPAYCREDIT'; xeroTenantId: string; xeroTenantName: string }
): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  bill.xeroInvoiceId = info.xeroInvoiceId;
  bill.xeroDocType = info.xeroDocType || 'ACCPAY';
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

// Put back into Archive every published document a stale save moved into a
// working status (new / ready / review / processing) — the document page used
// to resend the status it last knew before Update in Xero, which reopened bills
// that were already in the ledger. Run off the listing; writes only on a change.
export function archivePublishedWorkingDocs(orgId: string): number {
  const bills = load();
  let n = 0;
  for (const b of bills) {
    if (b.orgId !== orgId || !b.xeroInvoiceId) continue;
    if (['new', 'ready', 'review', 'processing'].includes(String(b.status))) {
      b.status = 'archived';
      n += 1;
    }
  }
  if (n) persist(bills);
  return n;
}

// Record what Xero last said about a published bill: its status, the date it
// was fully paid, and the reference on the payment(s) behind that. Its own
// writer rather than a patch through updateBill, for the same reason
// markBillPosted is: EDITABLE is the surface a PERSON may change, and none of
// these are that — they are Xero's answer, mirrored.
//
// Writes only when something actually differs. A bill can draw several webhook
// events in a burst (approve, attach, pay), and persisting rewrites the whole
// store, so an event that tells us nothing new must not cost a write.
export function markBillXeroPayment(
  orgId: string,
  id: string,
  info: { xeroStatus: string; xeroPaidDate: string; xeroPaymentRef: string }
): boolean {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return false;
  const same =
    (bill.xeroStatus ?? '') === info.xeroStatus &&
    (bill.xeroPaidDate ?? '') === info.xeroPaidDate &&
    (bill.xeroPaymentRef ?? '') === info.xeroPaymentRef;
  if (same) return false;
  bill.xeroStatus = info.xeroStatus;
  bill.xeroPaidDate = info.xeroPaidDate;
  bill.xeroPaymentRef = info.xeroPaymentRef;
  persist(bills);
  return true;
}

// Record where a LINKED document's fetch has got to — asking, fetched, failed.
//
// Its own writer rather than a field of updateBill's EDITABLE list, for the
// reason markBillXeroPayment has one: this is what HAPPENED to the document, not
// a field a reviewer fills in, and a PATCH from the browser must not be able to
// declare a document fetched.
export function setBillEmailLink(orgId: string, id: string, patch: Partial<NonNullable<Bill['emailLink']>>): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  const was = bill.emailLink;
  bill.emailLink = {
    messageId: patch.messageId ?? was?.messageId ?? '',
    from: patch.from ?? was?.from ?? '',
    links: patch.links ?? was?.links ?? [],
    status: patch.status ?? was?.status ?? 'awaiting_trust',
    note: patch.note ?? was?.note ?? '',
    at: patch.at ?? new Date().toISOString(),
  };
  persist(bills);
  return bill;
}

// The file a LINK finally yielded, landing on the document that was already
// standing in the inbox for it.
//
// A fetch fills the row that asked rather than inserting a second one: the
// placeholder IS the cost — it has been in the list, it may already have been
// coded or owned by somebody — and a new row beside it would be the same cost
// twice, which is the one thing the inbox exists to prevent. The file hash
// moves to the real bytes' with it, so duplicate detection sees the document
// rather than the placeholder it was.
export function attachFetchedFile(
  orgId: string,
  id: string,
  file: { fileHash: string; fileName: string; storageKey: string; contentType: string }
): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  bill.fileHash = file.fileHash;
  bill.fileName = file.fileName;
  bill.storageKey = file.storageKey;
  bill.contentType = file.contentType;
  // Being read, and saying so — the same state the attachment road creates a
  // document in, cleared by autoRead's finally.
  bill.status = 'processing';
  persist(bills);
  return bill;
}

// Set or clear the bank statement line a document will be paid against on
// publish (see Bill.bankMatch). Its own writer, like the Xero fields: EDITABLE
// is the surface a PERSON may patch freely, and this one is written only after
// the money has been checked against the line.
export function setBillBankMatch(orgId: string, id: string, match: Bill['bankMatch'] | null): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  if (match) bill.bankMatch = match;
  else delete bill.bankMatch;
  persist(bills);
  return bill;
}

// Remember which emoji we last put on this document's WhatsApp message.
//
// Its own writer for the same reason markBillXeroPayment is: EDITABLE is the
// surface a PERSON may change, and this is not that — it is a record of what
// CYBills said out loud in somebody's WhatsApp group. Writing only on a real
// change is what keeps a webhook burst, a payments sweep and a re-read from
// each re-sending a tick that is already sitting on the message.
export function markBillWhatsappReaction(orgId: string, id: string, emoji: string): boolean {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return false;
  if ((bill.whatsappReaction ?? '') === emoji) return false;
  bill.whatsappReaction = emoji;
  persist(bills);
  return true;
}

// Fill in who sent a WhatsApp'd document, on a row filed before the sender was
// resolved. Its own writer for the same reason: the message a document arrived
// in is the document's record of what was received, not a field a person edits,
// so `whatsapp` is not in EDITABLE and never will be. Only the two identity
// fields move; the raw sender id, the text and the file name are left as they
// arrived.
export function setBillWhatsappSender(orgId: string, id: string, who: { name: string; number: string; userId: string }): boolean {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill?.whatsapp) return false;
  const wa = bill.whatsapp;
  // Written only on a real change: the listing sweep asks on every load.
  if (wa.senderName === who.name && wa.senderNumber === who.number && (wa.senderUserId ?? '') === who.userId) return false;
  bill.whatsapp = { ...wa, senderName: who.name, senderNumber: who.number, senderUserId: who.userId };
  persist(bills);
  return true;
}

/** Every document, whichever entity's book it is in. For a repair keyed on a
 * fact that is not scoped — a WhatsApp account is one LID in every group. */
export function listBillsAcrossScopes(): Bill[] {
  return load().slice();
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

// Inverse of markBillsClaimed: take the given bills off a claim.
//
// They go to ARCHIVE, not back to the inbox. Taking a receipt off a claim is a
// decision that it doesn't belong there — putting it back at the top of the
// inbox makes it look like new work every time, and the reviewer has to deal
// with it again to make it go away. Archive keeps it, out of the way, one click
// from being brought back.
//
// Never deleted: the claim is not a bin, and the document may well be somebody
// else's to claim, or belong on a different claim next month.
// Put a claim's documents back in the Costs tab. Used when the CLAIM goes away
// entirely, where the documents on it are real costs that still have to be
// accounted for — they were never the claim's property, only its evidence.
//
// The inbox rather than Archive, and that is the difference from
// unmarkBillsClaimed: taking ONE item off a claim says "this doesn't belong
// here", so it is set aside; losing the whole claim says the work has to be done
// again, and work to be done lives in the inbox. Readiness re-derives itself, so
// a complete document lands straight in Ready rather than as new work to type in.
//
// Only a document the claim was actually holding. A published one is left where
// it is by the caller — its money is already in the ledger through the claim's
// own bill, and offering it as unpublished work is how a cost gets paid twice.
export function returnBillsToInbox(ids: string[]): number {
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

export function unmarkBillsClaimed(ids: string[]): number {
  const wanted = new Set(ids.map(String));
  if (!wanted.size) return 0;
  const bills = load();
  let n = 0;
  for (const bill of bills) {
    if (!wanted.has(bill.id) || bill.status !== 'expenseclaim') continue;
    bill.status = 'archived';
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
  bill.xeroDocType = undefined;
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

// Move one document from one entity's book into another's.
//
// The document was filed in the wrong client's book — uploaded while the wrong
// entity was open, emailed to the wrong address, sent into the wrong group —
// and the paper itself says so (see src/lib/billedTo.js). Moving it is the
// repair; the alternative is deleting a real cost and asking somebody to upload
// it again somewhere else.
//
// What travels and what does NOT is the whole of it. The supplier, the date,
// the money, the file and the number are facts about the document, so they come.
// Everything CODED against the old entity is dropped: an account code, a tax
// code and a tracking option are names in THAT chart, and carried across they
// would post this bill to an account of the same number meaning something else
// entirely. The duplicate verdict goes too — it points at a document in a book
// this one has left. And the OWNER is re-resolved by the caller, because an
// address is a person on one entity's roster, not a fact about the paper.
//
// The stored file needs nothing done to it: a bill records the whole storage
// key it was written with, and every read routes by that key alone, so the
// bytes stay where they are under the old entity's prefix and keep resolving.
//
// Returns the moved bill, or null when it isn't there.
export function moveBillToScope(
  fromScope: string,
  id: string,
  toScope: string,
  from: { orgId: string; orgName: string; by: string; owner: string }
): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === fromScope && b.id === id);
  if (!bill) return null;
  bill.orgId = toScope;
  // Who owns it in the entity it is arriving in, decided by the caller (which
  // is where the roster lives). The address it was carrying belongs to the
  // entity it has left — usually that entity's own general account, an internal
  // identity naming an organisation this book knows nothing about.
  //
  // `createdBy` is deliberately untouched: who UPLOADED a document is a fact
  // about the past, and it does not stop being true because the document moved.
  bill.owner = from.owner;
  bill.movedFrom = { orgId: from.orgId, orgName: from.orgName, at: new Date().toISOString(), by: from.by };
  bill.category = '';
  bill.categoryReason = '';
  bill.taxRate = '';
  bill.taxRateReason = '';
  bill.taxRateEdited = false;
  bill.taxRateCleared = false;
  bill.customer = '';
  bill.rebillable = false;
  bill.project = '';
  bill.projectReason = '';
  bill.ruleFields = [];
  if (Array.isArray(bill.lineItems)) {
    // The rows themselves are the document's own — what was bought, and for how
    // much. Only their coding belongs to the entity they were coded in.
    bill.lineItems = bill.lineItems.map((li) => ({ ...li, category: '', project: '', project2: '' }));
  }
  bill.duplicateOfId = undefined;
  bill.duplicateType = undefined;
  bill.duplicateDismissed = undefined;
  // The reviewer's "this entity is right" was about the entity it has just
  // left, so it cannot go on standing for the one it arrives in.
  bill.entityCheckDismissed = undefined;
  // It arrives as work to be done: it has lost its category, so it is not ready
  // for anything, and the inbox is where a document waiting on somebody lives.
  if (bill.status !== 'deleted') bill.status = 'new';
  applyAutoReady(bill);
  persist(bills);
  return bill;
}

// Update an existing bill's editable fields in place. Returns null if not found.
// The payment proofs typed before a proof was archived for being one, still
// sitting in the inbox as if they were work: set aside, once each. Only a proof
// never set aside before (`proofSetAside`), so one somebody has since pulled
// back out stays where they put it; never one being read (its read archives it),
// published (Xero has it — Update in Xero is that road), on a claim, merged away
// or deleted. One pass over the store; returns how many it archived.
export function archiveStandingProofs(orgId: string): number {
  const bills = load();
  let n = 0;
  for (const b of bills) {
    if (b.orgId !== orgId || (b.kind || 'cost') !== 'cost') continue;
    if (!isPaymentProofType(b.documentType) || b.proofSetAside || b.xeroInvoiceId) continue;
    if (!['new', 'viewed', 'review', 'ready'].includes(String(b.status || ''))) continue;
    b.status = 'archived';
    b.proofSetAside = true;
    n += 1;
  }
  if (n) persist(bills);
  return n;
}

// A payment proof settles these invoices. Each is marked Paid — unless it is
// already in Xero, where the ledger's own payment is the answer and the copy
// here is left as published — takes the proof's payment method where it has
// none, and remembers what both said before. Invoices this proof paid before
// and no longer does are put back first, so re-applying a different set is one
// act. One pass over the store. Null when the proof or any invoice is missing.
export function applyPaymentProof(
  orgId: string,
  proofId: string,
  ids: string[],
  by: string,
  auto: boolean
): { proof: Bill; invoices: Bill[] } | null {
  const bills = load();
  const proof = bills.find((b) => b.orgId === orgId && b.id === proofId);
  if (!proof) return null;
  const wanted = new Set(ids.map(String));
  const invoices = bills.filter((b) => b.orgId === orgId && wanted.has(b.id));
  if (invoices.length !== wanted.size || wanted.has(proofId)) return null;
  const now = new Date().toISOString();
  for (const b of bills) {
    if (b.orgId === orgId && b.paidByProof?.proofId === proofId && !wanted.has(b.id)) releaseProof(b);
  }
  for (const inv of invoices) {
    const before = inv.paidByProof?.proofId === proofId
      ? inv.paidByProof.before
      : { paid: Boolean(inv.paid), paymentMethod: String(inv.paymentMethod ?? '') };
    inv.paidByProof = {
      proofId,
      proofDisplayId: proof.displayId || '',
      date: proof.date || '',
      reference: proof.invoiceNumber || '',
      appliedAt: now,
      appliedBy: by,
      auto,
      before,
    };
    if (!inv.xeroInvoiceId) {
      inv.paid = true;
      if (!inv.paymentMethod && proof.paymentMethod) inv.paymentMethod = proof.paymentMethod;
    }
  }
  proof.paysBills = [...wanted];
  proof.paysBillsAppliedAt = now;
  proof.paysBillsAppliedBy = by;
  proof.paysBillsAuto = auto;
  persist(bills);
  return { proof, invoices };
}

function releaseProof(b: Bill): void {
  const before = b.paidByProof?.before;
  if (before && !b.xeroInvoiceId) {
    b.paid = before.paid;
    b.paymentMethod = before.paymentMethod;
  }
  b.paidByProof = undefined;
}

// Undo: every invoice this proof paid goes back to what it said before, and the
// proof stops applying itself — somebody said this match was wrong, and the next
// listing must not make it again. Returns the proof and the invoices released.
export function unapplyPaymentProof(orgId: string, proofId: string, by: string): { proof: Bill; invoices: Bill[] } | null {
  const bills = load();
  const proof = bills.find((b) => b.orgId === orgId && b.id === proofId);
  if (!proof) return null;
  const invoices = bills.filter((b) => b.orgId === orgId && b.paidByProof?.proofId === proofId);
  for (const inv of invoices) releaseProof(inv);
  proof.paysBills = [];
  proof.paysBillsAppliedAt = new Date().toISOString();
  proof.paysBillsAppliedBy = by;
  proof.paysBillsAuto = false;
  proof.proofAutoDeclined = true;
  persist(bills);
  return { proof, invoices };
}

// Record (or, with null, forget) the Xero overpayment a quotation was paid as.
export function setBillPrepayment(orgId: string, id: string, prepayment: Bill['prepayment'] | null): Bill | null {
  const bills = load();
  const bill = bills.find((b) => b.orgId === orgId && b.id === id);
  if (!bill) return null;
  if (prepayment) bill.prepayment = prepayment;
  else delete bill.prepayment;
  persist(bills);
  return bill;
}

// An overpayment allocated against an invoice's Xero bill: written on BOTH
// documents in one pass, so the quotation's remaining balance and the invoice's
// record of what it used cannot disagree. Null when either is missing.
export function recordPrepaymentAllocation(
  orgId: string,
  fromId: string,
  invoiceBillId: string,
  alloc: Omit<PrepaymentAllocation, 'billId' | 'displayId'>
): { from: Bill; invoice: Bill } | null {
  const bills = load();
  const from = bills.find((b) => b.orgId === orgId && b.id === fromId);
  const invoice = bills.find((b) => b.orgId === orgId && b.id === invoiceBillId);
  if (!from?.prepayment || !invoice) return null;
  const entry: PrepaymentAllocation = { ...alloc, billId: invoice.id, displayId: invoice.displayId || '' };
  from.prepayment.allocations = [...(from.prepayment.allocations || []), entry];
  invoice.prepaymentsApplied = [
    ...(invoice.prepaymentsApplied || []),
    {
      ...entry,
      fromId: from.id,
      fromDisplayId: from.displayId || '',
      reference: from.prepayment.reference,
      overpaymentId: from.prepayment.overpaymentId,
    },
  ];
  persist(bills);
  return { from, invoice };
}

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
