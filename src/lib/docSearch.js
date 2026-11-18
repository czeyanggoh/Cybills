// The quick search box on the Costs and Sales lists: one rule for both, so a
// number that finds a document in one list finds it in the other.
//
// It reads who the document belongs to (the name the User column shows AND the
// email behind it, plus whoever uploaded it) and what is printed on the paper:
// the counterparty, the category, the date, the invoice number, the Item ID,
// the description and the total. A total is matched with its thousands commas
// taken out and also as a two-decimal figure, so "1,200", "1200" and "1200.00"
// all find 1200.00; a foreign document is found by its SGD restatement too.
//
// `itemId` is the Item ID as the list prints it (`itemNumber` in bills.js),
// passed in so this module stays pure.

const textFields = (d, itemId) => [
  d.supplier, d.user, d.ownerEmail, d.createdByEmail, d.category, d.date,
  d.invoiceNumber, itemId, d.description,
];

function totalMatches(v, qNum) {
  if (v === undefined || v === null || v === '') return false;
  const raw = String(v).replace(/,/g, '');
  const n = Number(raw);
  return raw.includes(qNum) || (Number.isFinite(n) && n.toFixed(2).includes(qNum));
}

export function matchesQuickSearch(d, query, itemId) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  if (textFields(d, itemId).some((v) => String(v ?? '').toLowerCase().includes(q))) return true;
  const qNum = q.replace(/,/g, '');
  return qNum !== '' && [d.total, d.baseTotal].some((v) => totalMatches(v, qNum));
}
