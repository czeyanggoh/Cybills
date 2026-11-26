// Import GST, server-side: a document on the GST account carries "GST on
// Imports" and no tax amount (src/lib/importGst.js, loaded by path so the rule
// has one copy).
//
// The decision in taxRateOutcome covers every read. This covers every WRITE
// after it — the page's pickers, Bulk edit, a supplier rule landing on the
// document — through keepPracticeNoTax, which calls it first.

import type { Bill } from './store.js';
import { foldLineTaxIntoCost } from './taxRules.js';

type ImportGstRules = {
  IMPORT_GST_TAX_RATE: string;
  isImportGstCategory: (label: unknown) => boolean;
  isImportGstDocument: (args: { category?: unknown; lineItems?: unknown; kind?: unknown }) => boolean;
  codeImportGstRows: (rows: unknown, name?: string) => any[] | null;
  importGstReason: (name?: string) => string;
};

let loaded: Promise<ImportGstRules | null> | null = null;
export function loadImportGstRules(): Promise<ImportGstRules | null> {
  loaded ??= import(new URL('../../src/lib/importGst.js', import.meta.url).href)
    .then((m) => (typeof m?.isImportGstCategory === 'function' ? (m as ImportGstRules) : null))
    .catch((e) => {
      console.error('[importGst] rules unavailable', e);
      return null;
    });
  return loaded;
}

/**
 * Hold a write to the import GST rule, mutating `patch`.
 *
 * Returns whether it changed anything for a document that IS import GST, or null
 * for any other document, so the caller goes on to its own rules. Unlike the
 * No Tax rules it does not defer to a hand-picked code: the GST account has one
 * valid code. A published document is touched only by a write that codes it (the
 * road to Update in Xero), never by the listing's sweep.
 */
export async function keepImportGst(current: Partial<Bill> | null, patch: Record<string, unknown>): Promise<boolean | null> {
  const rules = await loadImportGstRules();
  if (!rules) return null;
  const doc = { ...(current || {}), ...patch } as Partial<Bill> & Record<string, unknown>;
  if (doc.kind === 'sales') return null;
  const coding = 'category' in patch || 'lineItems' in patch || 'taxRate' in patch;
  const settled = Boolean(doc.xeroInvoiceId) || ['deleted', 'merged', 'expenseclaim'].includes(String(doc.status || ''));
  const name = rules.IMPORT_GST_TAX_RATE;

  // Moved OFF the GST account: its code goes with it, or an expense line would
  // go to Xero under GST on Imports. Left blank for the usual decision.
  if (
    'category' in patch &&
    rules.isImportGstCategory(current?.category) &&
    !rules.isImportGstCategory(patch.category) &&
    String(doc.taxRate || '') === name
  ) {
    patch.taxRate = '';
    patch.taxRateReason = '';
    patch.taxRateEdited = false;
    patch.taxRateCleared = false;
    if (Array.isArray(doc.lineItems) && doc.lineItems.some((r) => r.taxRate === name)) {
      patch.lineItems = doc.lineItems.map((r) => (r.taxRate === name && !rules.isImportGstCategory(r.category) ? { ...r, taxRate: '' } : r));
    }
    return null;
  }

  const whole = rules.isImportGstDocument({ category: doc.category, lineItems: doc.lineItems, kind: doc.kind || 'cost' });
  const coded = rules.codeImportGstRows(doc.lineItems, name);
  if (!whole && !coded) return null;
  if (settled && !coding) return false;
  // A mixed bill: its GST rows take the import code, the rest of it is its own.
  if (!whole) {
    patch.lineItems = coded;
    return null;
  }

  const rows = coded ?? doc.lineItems;
  const rowTax = (Array.isArray(rows) ? rows : []).some((r) => Number((r as { tax?: unknown }).tax) > 0);
  const wrongRate = String(doc.taxRate || '') !== name;
  const wrongMoney = Number(doc.tax) > 0 || Number(doc.baseTax) > 0 || rowTax;
  if (!wrongRate && !wrongMoney && !coded) return false;
  if (wrongRate) {
    patch.taxRate = name;
    patch.taxRateReason = rules.importGstReason(name);
    // A supplier rule that last wrote the code no longer owns it.
    const owned = Array.isArray(current?.ruleFields) ? current!.ruleFields : [];
    if (owned.includes('taxRate')) patch.ruleFields = owned.filter((f) => f !== 'taxRate');
  }
  // The total never moves: all of it is the GST, carried by the line itself.
  patch.tax = 0;
  patch.baseTax = 0;
  if (rowTax) {
    const folded = await foldLineTaxIntoCost(rows);
    if (folded) patch.lineItems = rules.codeImportGstRows(folded, name) ?? folded;
  } else if (coded) {
    patch.lineItems = coded;
  }
  return true;
}
