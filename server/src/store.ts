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
  createdAt: string; // ISO timestamp
  createdBy: string; // signed-in email, or '' in mock mode
  storageKey: string; // storage key for the original file (r2:/local: prefixed), or ''
  contentType: string; // MIME type of the stored file, or ''
  status: string; // workflow state: 'new' (inbox) | 'ready' | 'archived'
  kind: string; // 'cost' (default) | 'sales' — which workspace inbox it belongs to
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
  // Tenancy migration: fold any legacy (email-domain-scoped) bills into the one
  // shared workspace so all users see them. One-time + idempotent.
  let migrated = false;
  for (const b of cache) {
    if (b.orgId !== WORKSPACE_ID) {
      b.orgId = WORKSPACE_ID;
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
export function findDuplicate(orgId: string, cand: Candidate): DuplicateMatch | null {
  // A deleted bill must not block re-uploading the same file, or a receipt the
  // user removed becomes impossible to add back.
  const bills = load().filter((b) => b.orgId === orgId && b.status !== 'deleted');

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

export function insertBill(input: BillInput): Bill {
  const bills = load();
  const bill: Bill = {
    ...input,
    id: `bill_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  };
  bills.push(bill);
  persist(bills);
  return bill;
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
  'status',
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
