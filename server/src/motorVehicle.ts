import { bookRevision, listBills, parseAmount, updateBill, type Bill } from './store.js';
import { foldLineTaxIntoCost } from './taxRules.js';

// A motor vehicle expense is No Tax, server-side.
//
// The rule itself is NOT written here: it is the same pure module the tax
// decision uses (src/lib/motorVehicle.js), loaded by path the way mileage.ts
// loads its own — a second copy of what counts as a motor vehicle would drift,
// and the drift would be input tax claimed in one client's return and not in
// another's for the same petrol receipt.
//
// The decision in taxRateOutcome covers every READ. What it cannot cover is a
// document whose category changes AFTER it was read — the page's picker, the
// inline cell, Bulk edit, a supplier rule's category landing on it — nor what is
// already stored. So this runs on every write (`keepMotorVehicleNoTax`) and over
// each book on the listing (`enforceMotorVehicleNoTax`).
//
// Left alone, deliberately:
//   - a document PUBLISHED to Xero: its figures are in the ledger, and editing
//     the copy here would only make the two disagree (Update in Xero is the road);
//   - a document on an EXPENSE CLAIM or merged away: its money reaches the ledger
//     through another document, which a quiet change here would drift from;
//   - a code a PERSON picked, or a blank they chose (`taxRateEdited` /
//     `taxRateCleared`): a goods van's GST is claimable, and the person who knows
//     that is the one who picks the code. A re-read clears those markers, since
//     it is asked to decide the document again.

type MotorRules = {
  isMotorVehicleExpense: (args: { category?: unknown; motorVehicle?: boolean; kind?: unknown }) => boolean;
  motorVehicleReason: (args: { category?: unknown; motorVehicle?: boolean }) => string;
  MOTOR_VEHICLE_TAX_RATE: string;
};

let rules: MotorRules | null = null;
let tried = false;

async function loadMotorRules(): Promise<MotorRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/motorVehicle.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<MotorRules>;
    rules =
      typeof mod?.isMotorVehicleExpense === 'function' && typeof mod?.motorVehicleReason === 'function'
        ? (mod as MotorRules)
        : null;
  } catch (e) {
    console.error('[motorVehicle] rules unavailable', e);
    rules = null;
  }
  return rules;
}

const lineTax = (rows: unknown) =>
  (Array.isArray(rows) ? rows : []).reduce((t, li) => t + parseAmount((li as { tax?: unknown })?.tax), 0);

/**
 * Hold a motor vehicle expense at No Tax.
 *
 * Mutates `patch` in place so the document as it will stand after the write —
 * `current` with `patch` laid over it — carries No Tax, no tax amount (in either
 * currency), no tax on its lines, and no supplier rule claiming its tax code.
 * Returns whether it changed anything, and does nothing to a document that is
 * already right, so an ordinary edit costs nothing and the reason a person or
 * an earlier read wrote is not rewritten for the sake of it.
 */
export async function keepMotorVehicleNoTax(current: Partial<Bill> | null, patch: Record<string, unknown>): Promise<boolean> {
  const r = await loadMotorRules();
  if (!r) return false;
  const doc = { ...(current || {}), ...patch } as Partial<Bill> & Record<string, unknown>;
  if (doc.xeroInvoiceId) return false;
  if (['deleted', 'merged', 'expenseclaim'].includes(String(doc.status || ''))) return false;
  if (doc.taxRateEdited === true || doc.taxRateCleared === true) return false;
  if (!r.isMotorVehicleExpense({ category: doc.category, motorVehicle: doc.motorVehicle === true, kind: doc.kind || 'cost' })) {
    return false;
  }
  const rate = String(doc.taxRate || '');
  const wrongRate = rate !== r.MOTOR_VEHICLE_TAX_RATE;
  const rows = 'lineItems' in patch ? patch.lineItems : current?.lineItems;
  const wrongMoney = parseAmount(doc.tax) > 0 || parseAmount(doc.baseTax) > 0 || lineTax(rows) > 0;
  if (!wrongRate && !wrongMoney) return false;

  if (wrongRate) {
    patch.taxRate = r.MOTOR_VEHICLE_TAX_RATE;
    patch.taxRateReason = r.motorVehicleReason({ category: doc.category, motorVehicle: doc.motorVehicle === true });
    // A supplier rule that last wrote the code no longer owns it — or the rule
    // sweep would write its code back on the next listing, and the two would
    // take turns for ever.
    const owned = Array.isArray(current?.ruleFields) ? current!.ruleFields : [];
    if (owned.includes('taxRate')) patch.ruleFields = owned.filter((f) => f !== 'taxRate');
  }
  // The total never moves: the GST stays inside the cost, which is what not
  // claiming it means.
  patch.tax = 0;
  patch.baseTax = 0;
  if (lineTax(rows) > 0) {
    const folded = await foldLineTaxIntoCost(rows);
    if (folded) patch.lineItems = folded;
  }
  return true;
}

// Over what is already stored — the petrol receipts read before the rule
// existed, and any document whose category was changed by a road that does not
// write through PATCH. Once per book revision, like the other listing sweeps.
const sweptAt = new Map<string, number>();
export async function enforceMotorVehicleNoTax(scope: string): Promise<number> {
  const revision = bookRevision();
  if (sweptAt.get(scope) === revision) return 0;
  sweptAt.set(scope, revision);
  let n = 0;
  for (const b of listBills(scope)) {
    if (b.kind === 'sales' || b.kind === 'supplier_statement') continue;
    const patch: Record<string, unknown> = {};
    if (!(await keepMotorVehicleNoTax(b, patch))) continue;
    if (updateBill(scope, b.id, patch)) n += 1;
  }
  return n;
}
