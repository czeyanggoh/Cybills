// A supplier rule's invoice date, on the road where nobody is watching.
//
// For a supplier that invoices after the period it bills for, the rule moves
// the date to the last day of the month before the one printed (02/09/2026 ->
// 31/08/2026). The arithmetic is NOT written here: it is the same pure module
// the upload, the re-read and the document page use (src/lib/ruleDate.js),
// loaded by path the way mileage.ts loads its own, so an emailed document and
// an uploaded one can never be dated differently.

type RuleDateModule = {
  ruleInvoiceDate: (mode: unknown, iso: unknown, opts?: { keepMonthEnd?: boolean }) => string;
};

let mod: RuleDateModule | null = null;
let tried = false;

async function load(): Promise<RuleDateModule | null> {
  if (tried) return mod;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/ruleDate.js', import.meta.url).href;
    const m = (await import(url)) as Partial<RuleDateModule>;
    mod = typeof m?.ruleInvoiceDate === 'function' ? (m as RuleDateModule) : null;
  } catch (e) {
    console.error('[ruleDate] rules unavailable', e);
    mod = null;
  }
  return mod;
}

// Move `patch.date` where the supplier's rule asks, from the date just READ off
// the document. The due date is left exactly as the read found it: that is when
// the money is owed, whatever month the cost belongs to.
export async function applyRuleInvoiceDate(
  rule: Record<string, unknown> | null,
  patch: Record<string, unknown>
): Promise<void> {
  if (!rule?.invoiceDate) return;
  const rules = await load();
  if (!rules) return;
  const read = String(patch.date ?? '');
  const date = rules.ruleInvoiceDate(rule.invoiceDate, read);
  if (date && date !== read) {
    patch.date = date;
    // A "due on receipt" invoice is read with no due date (one equal to the
    // invoice date is dropped by the reader), so the day the supplier actually
    // invoiced would otherwise be lost once the date moves. The same rule
    // supplierRulePatch applies in the browser.
    if (!String(patch.dueDate ?? '').trim()) patch.dueDate = read;
  }
}
