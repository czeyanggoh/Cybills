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
// So are the LIABILITY accounts, for a bill that settles something already on the
// balance sheet — an expense accrued at month end is posted to Accrued Expenses,
// or it is expensed twice. Off until switched on too, and Xero's system accounts
// are never among them, bar one: the GST account, for import GST alone
// (src/lib/importGst.js).
//
// Pure, with no dependency outside src/lib: the browser reads it for the pickers
// and the upload read, the server loads it by path (server/src/accountSides.ts)
// for the read an emailed or WhatsApp'd document gets, so the two cannot offer
// different accounts.

import { isImportGstAccount, IMPORT_GST_READER_DESCRIPTION } from './importGst.js';

export { isImportGstAccount };

export const EXPENSE_TYPES = ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'];
export const REVENUE_TYPES = ['REVENUE', 'SALES', 'OTHERINCOME'];
// Every asset type a bill line may post to. BANK is not one: money paid INTO a
// bank account is a payment, never a bill line.
export const ASSET_TYPES = ['FIXED', 'CURRENT', 'NONCURRENT', 'PREPAYMENT', 'INVENTORY'];

export const LIABILITY_TYPES = ['CURRLIAB', 'LIABILITY', 'TERMLIAB'];

const typeOf = (a) => String(a?.type ?? '').toUpperCase();

export const isExpenseAccount = (a) => EXPENSE_TYPES.includes(typeOf(a));
export const isRevenueAccount = (a) => REVENUE_TYPES.includes(typeOf(a));
// A system account (Accounts Receivable, and the like) is Xero's own and refuses
// a bill line, so it is never offered.
export const isAssetAccount = (a) => ASSET_TYPES.includes(typeOf(a)) && !String(a?.systemAccount ?? '').trim();

export const isLiabilityAccount = (a) => LIABILITY_TYPES.includes(typeOf(a)) && !String(a?.systemAccount ?? '').trim();

// The key an account is switched on or off by — its code, the field every
// accounts listing shares.
export const accountKey = (a) => String(a?.code || a?.name || '');

// Said in front of a liability account's own description: nothing on a supplier's
// paper shows that a cost was accrued, so the reader may not infer it.
export const LIABILITY_READER_NOTE =
  'Balance sheet liability: use ONLY where the document or the message sent with it says this amount was already ' +
  'accrued or settles this balance. Otherwise code the expense account.';

// What the reader is told an account is for: the account's own description,
// except on the GST account and the liabilities.
export const readerDescription = (a) => {
  if (isImportGstAccount(a)) return IMPORT_GST_READER_DESCRIPTION;
  const own = a?.description || '';
  return isLiabilityAccount(a) ? `${LIABILITY_READER_NOTE} ${own}`.trim() : own;
};

// The accounts switched ON (assets, liabilities, the GST account), out of the Lists blob.
// Junk reads as none.
export function shownAssetKeys(blob) {
  const shown = blob && typeof blob === 'object' && !Array.isArray(blob) ? blob.shown : null;
  const list = shown && typeof shown === 'object' && Array.isArray(shown.categories) ? shown.categories : [];
  return new Set(list.map((x) => String(x)));
}

// The accounts a document of this kind may be coded to: revenue for a sale;
// for a cost, the expense accounts plus whichever asset and liability accounts
// (and the GST account) are switched on.
export function accountsForSide(accounts, kind = 'cost', shownAssets = new Set()) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (kind === 'sales') return list.filter(isRevenueAccount);
  return list.filter(
    (a) =>
      isExpenseAccount(a) ||
      ((isAssetAccount(a) || isLiabilityAccount(a) || isImportGstAccount(a)) && shownAssets.has(accountKey(a)))
  );
}
