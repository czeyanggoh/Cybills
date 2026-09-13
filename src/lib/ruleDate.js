// The invoice date a supplier's rule gives a document, for the suppliers who
// bill AFTER the period they bill for.
//
// A virtual assistant agency invoicing on 2 September for August's hours has
// done nothing in September: the cost belongs to August, and a practice closing
// August's books needs it there. So the rule can move the date to the last day
// of the month before the one printed — 02/09/2026 becomes 31/08/2026 — while
// the DUE date stays as printed, because that is when the money is actually
// owed.
//
// Pure on purpose, like mileage.js: the upload, the re-read and the page apply
// it in the browser, and the server loads this very file by path for the
// emailed and WhatsApp'd documents (server/src/ruleDate.ts), so the two can
// never move a date differently.

export const INVOICE_DATE_MODES = [
  { value: 'endOfPreviousMonth', label: 'End of the previous month' },
];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const p2 = (n) => String(n).padStart(2, '0');

// The last day of the month before `iso`'s month, or '' for anything that isn't
// an ISO date. Day 0 of a month is the last day of the one before, which also
// carries January back into December of the previous year.
export function endOfPreviousMonth(iso) {
  const m = ISO.exec(String(iso ?? '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 0));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function isMonthEnd(iso) {
  const m = ISO.exec(String(iso ?? '').trim());
  if (!m) return false;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return Number(m[3]) === last;
}

// The date the rule gives a document dated `iso`, or '' when the rule says
// nothing (or the date can't be read).
//
// `keepMonthEnd` is for applying the rule to a document ALREADY on screen,
// whose date may be the one this rule moved it to a moment ago: applied again,
// 31/08 must stay 31/08 rather than walk back to 31/07. A READ always passes
// the date printed on the paper, so it never needs it.
export function ruleInvoiceDate(mode, iso, { keepMonthEnd = false } = {}) {
  if (mode !== 'endOfPreviousMonth') return '';
  if (!ISO.test(String(iso ?? '').trim())) return '';
  if (keepMonthEnd && isMonthEnd(iso)) return String(iso).trim();
  return endOfPreviousMonth(iso);
}
