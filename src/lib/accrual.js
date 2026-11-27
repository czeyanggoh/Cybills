// What the "asset and accrual" dialog offers (components/AccrualPanel.jsx; the
// server holds the same rules in server/src/accrual.ts). Pure, tested by
// test/billing-plan.test.mjs.

const ASSET_TYPES = ['FIXED', 'NONCURRENT', 'CURRENT', 'PREPAYMENT', 'INVENTORY'];
const LIABILITY_TYPES = ['CURRLIAB', 'LIABILITY', 'TERMLIAB'];

const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

/**
 * The chart split into what can be taken up (assets, fixed ones first) and what
 * it can be accrued to (liabilities), never a system account, with the account
 * to start on: the first named for accruals.
 */
export function accountsForAccrual(accounts) {
  const open = (Array.isArray(accounts) ? accounts : []).filter((a) => a?.code && !a.systemAccount);
  const of = (types) =>
    open
      .filter((a) => types.includes(String(a.type || '').toUpperCase()))
      .sort(
        (a, b) =>
          types.indexOf(String(a.type).toUpperCase()) - types.indexOf(String(b.type).toUpperCase()) ||
          String(a.code).localeCompare(String(b.code), undefined, { numeric: true })
      );
  const liabilities = of(LIABILITY_TYPES);
  return {
    assets: of(ASSET_TYPES),
    liabilities,
    accrualDefault: liabilities.find((a) => /accru/i.test(a.name))?.code || '',
  };
}

/**
 * The asset lines to start from: one for the document's amount before GST, or —
 * `itemised` — one per item read off it, before GST where the item states it.
 */
export function accrualLinesFrom(doc, { itemised = false } = {}) {
  const items = (doc?.lineItems?.length ? doc.lineItems : doc?.readLines) || [];
  if (itemised) {
    return items
      .map((r) => ({ description: String(r.description || ''), amount: num(r.net) || num(r.total), accountCode: '' }))
      .filter((r) => r.amount > 0)
      .map((r) => ({ ...r, amount: r.amount.toFixed(2) }));
  }
  const net = num(doc?.total) - num(doc?.tax);
  const reference = String(doc?.invoiceNumber || '').trim();
  const said = String(doc?.description || '').replace(/^\*\s*/, '').trim();
  return [
    {
      description: [reference, said].filter(Boolean).join(': '),
      amount: net > 0 ? net.toFixed(2) : '',
      accountCode: '',
    },
  ];
}
