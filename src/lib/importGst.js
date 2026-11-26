// Import GST: what a freight forwarder or courier paid Singapore Customs on the
// business's behalf, and bills on.
//
// That money is not an expense. It is input tax already paid, so the whole line
// goes to the ledger's own GST account (Xero's system account, "820 - GST" in
// the standard chart) under the tax code "GST on Imports", with no tax amount
// beside it — the line IS the tax. The account was never offered (a system
// account of the liability type), so a forwarder's GST bill was coded to
// freight expense and the GST was never claimed.
//
// The account is OFF until switched on in Lists -> Categories, and is offered for
// this one use: a line on it carries GST on Imports and nothing else, whoever
// coded it.
//
// Pure and dependency-free: the pickers and the tax decision read it in the
// browser, and the server loads it by path (server/src/importGst.ts).

import { categoryCode, categoryName } from './categoryList.js';

export const IMPORT_GST_TAX_RATE = 'GST on Imports';

// Xero's GST system account, out of a chart.
export const isImportGstAccount = (a) => String(a?.systemAccount ?? '').trim().toUpperCase() === 'GST';

// The same account, from the "<code> - <name>" label a document stores. Xero
// names its one GST account "GST"; a code is required, so a bridge entity's
// plain category of that name is not taken for a ledger account.
export const isImportGstCategory = (label) =>
  Boolean(categoryCode(label)) && categoryName(label).trim().toLowerCase() === 'gst';

// What the reader is told about the account. Xero's own description of it is
// about paying the tax authority, which says nothing about when a bill belongs
// there.
export const IMPORT_GST_READER_DESCRIPTION =
  'Import GST ONLY: GST paid to Singapore Customs on imported goods and billed on by a freight forwarder or courier ' +
  '("import GST", "GST paid on behalf", a reimbursement of GST on a shipment). Never for GST a supplier charges on its own ' +
  'services, and never for freight, handling or duty — those go to their expense accounts. Where one document bills both, ' +
  'only the import GST line belongs here.';

// The org's own name for the import rate — matched by name, else by Xero's
// system tax type — or the standard name where the list is not to hand.
export function importGstRateName(rates) {
  const list = Array.isArray(rates) ? rates : [];
  const named = list.find((r) => String(r?.name || '').trim().toLowerCase() === IMPORT_GST_TAX_RATE.toLowerCase());
  const typed = list.find((r) => /^(IMINPUT2|GSTONIMPORTS)$/i.test(String(r?.code || r?.taxType || '')));
  return String((named || typed)?.name || IMPORT_GST_TAX_RATE);
}

export const importGstReason = (name = IMPORT_GST_TAX_RATE) =>
  `Coded ${name}: this is on the GST account, which takes import GST paid on the business's behalf. ` +
  'The whole amount is the GST, so no separate tax amount is recorded.';

/**
 * The document's rows with every GST-account row coded to the import rate, or
 * null when none needed it. A row carrying a tax amount is left alone: moving
 * money between its columns is a person's call, and publishing refuses it.
 */
export function codeImportGstRows(rows, name = IMPORT_GST_TAX_RATE) {
  if (!Array.isArray(rows)) return null;
  let changed = false;
  const next = rows.map((row) => {
    if (!isImportGstCategory(row?.category)) return row;
    if (Number(String(row.tax ?? '').replace(/,/g, '')) || String(row.taxRate || '') === name) return row;
    changed = true;
    return { ...row, taxRate: name };
  });
  return changed ? next : null;
}

// Whether the WHOLE document is import GST: coded to the account, with no row
// coded anywhere else. A forwarder's bill with freight rows beside the GST row
// keeps its own code, and only the GST row takes the import rate.
export function isImportGstDocument({ category = '', lineItems = [], kind = 'cost' } = {}) {
  if (kind === 'sales' || !isImportGstCategory(category)) return false;
  return (Array.isArray(lineItems) ? lineItems : []).every(
    (row) => !String(row?.category || '').trim() || isImportGstCategory(row.category)
  );
}
