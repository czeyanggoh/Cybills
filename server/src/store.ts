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
  taxRate?: string; // GST/tax-rate name, e.g. "Standard-Rated Purchases" (9%)
  description?: string; // plain-language summary of what was purchased
  createdAt: string; // ISO timestamp
  createdBy: string; // signed-in email, or '' in mock mode
  storageKey: string; // storage key for the original file (r2:/local: prefixed), or ''
  contentType: string; // MIME type of the stored file, or ''
  status: string; // workflow state: 'new' (inbox) | 'ready' | 'archived' | 'merged'
  kind: string; // 'cost' (default) | 'sales' — which workspace inbox it belongs to
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
function persist(bills: Bill[]): void {
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

export function getBillById(orgId: string, id: string): Bill | null {
  return load().find((b) => b.orgId === orgId && b.id === id) ?? null;
}

// Look up a bill by id alone, across every org. The bill id is a long,
// unguessable random token, so this is used as a capability URL for serving a
// receipt file when the caller's session/org can't be resolved (e.g. an
// exported CSV link opened in a browser that isn't signed in).
export function getBillByIdAny(id: string): Bill | null {
  return load().find((b) => b.id === id) ?? null;
}

// First (highest-confidence) duplicate for `cand`, or null. Cheapest checks
// first; each tier requires the fields it keys on to actually be present.
export function findDuplicate(orgId: string, cand: Candidate, excludeId?: string): DuplicateMatch | null {
  // A deleted bill must not block re-uploading the same file, or a receipt the
  // user removed becomes impossible to add back. `excludeId` skips the row being
  // finalized so a doc never matches itself after its fields are read.
  const bills = load().filter(
    (b) => b.orgId === orgId && b.status !== 'deleted' && b.id !== excludeId
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

export type BillInput = Omit<Bill, 'id' | 'createdAt'>;

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
  const bill: Bill = {
    ...input,
    id: `bill_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
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
  'supplier',
  'invoiceNumber',
  'documentType',
  'currency',
  'total',
  'tax',
  'date',
  'category',
  'categoryReason',
  'taxRate',
  'description',
  'status',
  'createdBy',
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
