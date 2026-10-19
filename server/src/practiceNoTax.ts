import { bookRevision, listBills, parseAmount, updateBill, type Bill } from './store.js';
import { foldLineTaxIntoCost } from './taxRules.js';

// The practice's No Tax rules, server-side: a motor vehicle expense
// (src/lib/motorVehicle.js) and a bill from a hospital or clinic
// (src/lib/medicalProvider.js). Each is No Tax in every client's book whatever
// GST the paper prints.
//
// The rules themselves are NOT written here: they are the same pure modules the
// tax decision uses, loaded by path the way mileage.ts loads its own — a second
// copy of what counts would drift, and the drift would be input tax claimed in
// one client's return and not in another's for the same receipt.
//
// The decision in taxRateOutcome covers every READ. What it cannot cover is a
// document whose category or supplier changes AFTER it was read — the page's
// pickers, the inline cell, Bulk edit, a supplier rule landing on it — nor what
// is already stored. So this runs on every write (`keepPracticeNoTax`) and over
// each book on the listing (`enforcePracticeNoTax`).
//
// Left alone, deliberately:
//   - a document PUBLISHED to Xero: its figures are in the ledger, and editing
//     the copy here would only make the two disagree (Update in Xero is the road);
//   - a document on an EXPENSE CLAIM or merged away: its money reaches the ledger
//     through another document, which a quiet change here would drift from;
//   - a code a PERSON picked, or a blank they chose (`taxRateEdited` /
//     `taxRateCleared`): a goods van's GST is claimable, and so is a
//     work-injury claim's, and the person who knows that is the one who picks
//     the code. A re-read clears those markers, since it is asked to decide the
//     document again.

type MotorRules = {
  isMotorVehicleExpense: (args: { category?: unknown; motorVehicle?: boolean; kind?: unknown }) => boolean;
  motorVehicleReason: (args: { category?: unknown; motorVehicle?: boolean }) => string;
  MOTOR_VEHICLE_TAX_RATE: string;
};
type MedicalRules = {
  isMedicalProviderExpense: (args: { supplier?: unknown; medicalProvider?: boolean; kind?: unknown }) => boolean;
  medicalProviderReason: (args: { supplier?: unknown }) => string;
};

// From server/dist (or server/src under tsx) up to the repo root. Null when the
// module can't be loaded, so a missing rule degrades to nothing rather than
// failing the write.
const loaded = new Map<string, Promise<unknown>>();
function loadRules<T>(file: string, check: (m: any) => boolean): Promise<T | null> {
  if (!loaded.has(file)) {
    loaded.set(
      file,
      import(new URL(`../../src/lib/${file}`, import.meta.url).href)
        .then((m) => (check(m) ? m : null))
        .catch((e) => {
          console.error(`[practiceNoTax] ${file} unavailable`, e);
          return null;
        })
    );
  }
  return loaded.get(file) as Promise<T | null>;
}
const loadMotorRules = () =>
  loadRules<MotorRules>('motorVehicle.js', (m) => typeof m?.isMotorVehicleExpense === 'function');
const loadMedicalRules = () =>
  loadRules<MedicalRules>('medicalProvider.js', (m) => typeof m?.isMedicalProviderExpense === 'function');

// Which rule, if any, holds this document at No Tax — and the sentence saying so.
async function noTaxReason(doc: Partial<Bill> & Record<string, unknown>): Promise<string> {
  const kind = doc.kind || 'cost';
  const motor = await loadMotorRules();
  if (motor?.isMotorVehicleExpense({ category: doc.category, motorVehicle: doc.motorVehicle === true, kind })) {
    return motor.motorVehicleReason({ category: doc.category, motorVehicle: doc.motorVehicle === true });
  }
  const medical = await loadMedicalRules();
  if (medical?.isMedicalProviderExpense({ supplier: doc.supplier, medicalProvider: doc.medicalProvider === true, kind })) {
    return medical.medicalProviderReason({ supplier: doc.supplier });
  }
  return '';
}

const NO_TAX = 'No Tax';

const lineTax = (rows: unknown) =>
  (Array.isArray(rows) ? rows : []).reduce((t, li) => t + parseAmount((li as { tax?: unknown })?.tax), 0);

/**
 * Hold a motor vehicle or medical expense at No Tax.
 *
 * Mutates `patch` in place so the document as it will stand after the write —
 * `current` with `patch` laid over it — carries No Tax, no tax amount (in either
 * currency), no tax on its lines, and no supplier rule claiming its tax code.
 * Returns whether it changed anything, and does nothing to a document that is
 * already right, so an ordinary edit costs nothing and the reason a person or
 * an earlier read wrote is not rewritten for the sake of it.
 */
export async function keepPracticeNoTax(current: Partial<Bill> | null, patch: Record<string, unknown>): Promise<boolean> {
  const doc = { ...(current || {}), ...patch } as Partial<Bill> & Record<string, unknown>;
  if (doc.xeroInvoiceId) return false;
  if (['deleted', 'merged', 'expenseclaim'].includes(String(doc.status || ''))) return false;
  if (doc.taxRateEdited === true || doc.taxRateCleared === true) return false;
  const reason = await noTaxReason(doc);
  if (!reason) return false;
  const rate = String(doc.taxRate || '');
  const wrongRate = rate !== NO_TAX;
  const rows = 'lineItems' in patch ? patch.lineItems : current?.lineItems;
  const wrongMoney = parseAmount(doc.tax) > 0 || parseAmount(doc.baseTax) > 0 || lineTax(rows) > 0;
  if (!wrongRate && !wrongMoney) return false;

  if (wrongRate) {
    patch.taxRate = NO_TAX;
    patch.taxRateReason = reason;
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

// Over what is already stored — the petrol receipts and clinic bills read
// before the rules existed, and any document whose category was changed by a road that does not
// write through PATCH. Once per book revision, like the other listing sweeps.
const sweptAt = new Map<string, number>();
export async function enforcePracticeNoTax(scope: string): Promise<number> {
  const revision = bookRevision();
  if (sweptAt.get(scope) === revision) return 0;
  sweptAt.set(scope, revision);
  let n = 0;
  for (const b of listBills(scope)) {
    if (b.kind === 'sales' || b.kind === 'supplier_statement') continue;
    const patch: Record<string, unknown> = {};
    if (!(await keepPracticeNoTax(b, patch))) continue;
    if (updateBill(scope, b.id, patch)) n += 1;
  }
  return n;
}
