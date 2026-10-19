// Which part of a Xero chart a document may be coded to.
//
// A cost posts to an expense account, a sales invoice to a revenue one — and a
// cost can also be CAPITALISED: a laptop, a fit-out, a deposit or a prepaid
// year of insurance is paid by bill exactly like a utility, but it belongs on
// the balance sheet. So the asset accounts are offered on the Costs side too,
// with one difference: each is OFF until somebody switches it on in Business
// settings -> Lists -> Categories. A chart's assets include Accumulated
// Depreciation, loans to directors and intercompany balances; offered by
// default, the reader would be choosing among them on every receipt, and an
// expense list is a judgement the practice made long ago while an asset list
// is one nobody has made yet.
//
// Pure and dependency-free: the browser reads it for the pickers and the upload
// read, the server loads it by path (server/src/accountSides.ts) for the read
// an emailed or WhatsApp'd document gets, so the two cannot offer different
// accounts.

export const EXPENSE_TYPES = ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'];
export const REVENUE_TYPES = ['REVENUE', 'SALES', 'OTHERINCOME'];
// Every asset type a bill line may post to. BANK is not one: money paid INTO a
// bank account is a payment, never a bill line.
export const ASSET_TYPES = ['FIXED', 'CURRENT', 'NONCURRENT', 'PREPAYMENT', 'INVENTORY'];

const typeOf = (a) => String(a?.type ?? '').toUpperCase();

export const isExpenseAccount = (a) => EXPENSE_TYPES.includes(typeOf(a));
export const isRevenueAccount = (a) => REVENUE_TYPES.includes(typeOf(a));
// A system account (Accounts Receivable, and the like) is Xero's own and refuses
// a bill line, so it is never offered.
export const isAssetAccount = (a) => ASSET_TYPES.includes(typeOf(a)) && !String(a?.systemAccount ?? '').trim();

// The key an account is switched on or off by — its code, the field every
// accounts listing shares.
export const accountKey = (a) => String(a?.code || a?.name || '');

// The asset accounts switched ON, out of the Lists blob. Junk reads as none.
export function shownAssetKeys(blob) {
  const shown = blob && typeof blob === 'object' && !Array.isArray(blob) ? blob.shown : null;
  const list = shown && typeof shown === 'object' && Array.isArray(shown.categories) ? shown.categories : [];
  return new Set(list.map((x) => String(x)));
}

// The accounts a document of this kind may be coded to: revenue for a sale;
// for a cost, the expense accounts plus the asset accounts switched on.
export function accountsForSide(accounts, kind = 'cost', shownAssets = new Set()) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (kind === 'sales') return list.filter(isRevenueAccount);
  return list.filter((a) => isExpenseAccount(a) || (isAssetAccount(a) && shownAssets.has(accountKey(a))));
}
