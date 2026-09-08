// Bank match: which document a bank statement line pays.
//
// CYWorkspace's auto bank reconciliation reads the Xero Bank Reconciliation
// report for a client and settles each unreconciled statement line against the
// Xero bill it pays. What it cannot settle is, more often than not, a document
// that is still only in CYBills — read, coded, maybe marked Ready, and not yet
// published — because as far as Xero is concerned that bill does not exist.
// Those outstanding lines come here, and this module says which document each
// of them pays, the way Dext's Bank Match does: a bank line and a document are
// the same money when they agree on the AMOUNT to the cent, the bank date sits
// in the window a payment lands in, and — the clincher — the supplier's name or
// the document's number is in the bank text.
//
// Pure, so the page and the server apply the same rules. The page runs it over
// the outstanding lines to draw the suggestion beside each; the server loads
// this file by path (server/src/bankMatch.ts, the way mileage.ts loads
// mileage.js) and holds the money to the same `docAmountFor` before it records
// a payment — so a document the page offered as a match can never be refused by
// the server for its amount, and one the page would never offer can never be
// paid by asking the API directly. Tested by test/bank-match.test.mjs.

const CENTS = (n) => Math.round(Number(n || 0) * 100);

// A number out of anything the app stores an amount as: a number, a form
// string, "SGD 1,234.50", or the "—" a blank row wears.
export function amountOf(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// A stable key for one statement line, so a match recorded against it can be
// found again on the next retrieval — CYWS hands the same lines back until the
// statement line is reconciled in Xero, and a line CYBills has already matched
// must not be offered a second time. Date, signed amount to the cent, and the
// bank's own reference; the description is left out because the report and a
// re-export can word it differently around the same reference.
export function lineKey(line) {
  const date = String(line?.date ?? '').slice(0, 10);
  const cents = CENTS(line?.amount);
  const ref = String(line?.reference ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return `${date}|${cents}|${ref}`;
}

// Money OUT of the account: a payment to a supplier. Money in is a customer
// paying, or a refund, and neither is a cost document.
export const isMoneyOut = (line) => CENTS(line?.amount) < 0;

// The document's own figure for the currency this line was paid in, or null
// when the two cannot be compared at all. A document billed in the bank's
// currency answers with its total. A FOREIGN-currency document answers with the
// SGD figure it restated itself in (baseTotal, see the foreign-currency notes in
// CLAUDE.md) when the bank account is in that currency — the supplier printed
// what the money was worth, and that is the figure the bank actually moved.
// Anything else is no comparison rather than a converted guess.
export function docAmountFor(doc, line) {
  const bank = String(line?.currency ?? '').trim().toUpperCase();
  const docCurrency = String(doc?.currency ?? '').trim().toUpperCase();
  if (!bank || !docCurrency || bank === docCurrency) return amountOf(doc?.total);
  const base = String(doc?.baseCurrency ?? '').trim().toUpperCase();
  if (base === bank && amountOf(doc?.baseTotal) > 0) return amountOf(doc?.baseTotal);
  return null;
}

// Whether this line's money and the document's are the same to the cent.
export function amountsAgree(doc, line) {
  const mine = docAmountFor(doc, line);
  if (mine == null) return false;
  return CENTS(mine) === Math.abs(CENTS(line?.amount));
}

// A document a bank line could pay. Cost documents only; never a credit note
// (money the supplier owes us — a payment in, not out); never one on an expense
// claim (its money reaches the ledger as a line of the claim's bill) or merged
// away (another document's money); never one Xero already calls PAID. A
// document already PUBLISHED but still awaiting payment is offered: publishing
// is not paying, and the bank line is the payment.
export function matchable(doc) {
  if (!doc) return false;
  if ((doc.kind || 'cost') !== 'cost') return false;
  const status = String(doc.status || '');
  if (['expenseclaim', 'merged', 'deleted', 'processing'].includes(status)) return false;
  if (/credit/i.test(String(doc.type || doc.documentType || ''))) return false;
  if (String(doc.xeroStatus || '').toUpperCase() === 'PAID') return false;
  if (String(doc.xeroStatus || '').toUpperCase() === 'VOIDED') return false;
  return amountOf(doc.total) > 0;
}

const DAY = 24 * 60 * 60 * 1000;
function dayOf(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

// How many days AFTER the document's date the bank line is. Negative means the
// bank moved the money before the paper is dated — a card authorisation is
// dated a day or two before the merchant's receipt clears, and an invoice paid
// on receipt can be dated after its transfer — so a few days either side are
// ordinary. NaN when either side has no date.
export function daysAfter(doc, line) {
  const d = dayOf(doc?.date);
  const b = dayOf(line?.date);
  if (Number.isNaN(d) || Number.isNaN(b)) return NaN;
  return Math.round((b - d) / DAY);
}

// The window a payment can land in: up to five days before the paper is dated,
// and up to ninety days after (thirty-day terms, paid late, is still the same
// bill). A line outside it is not this document's payment, however the money
// agrees — a subscription charges the same figure every month.
export const WINDOW = { before: 5, after: 90 };
export function inWindow(doc, line) {
  const n = daysAfter(doc, line);
  if (Number.isNaN(n)) return false;
  return n >= -WINDOW.before && n <= WINDOW.after;
}

// Words that name nobody: legal forms, the country, and the fillers half a
// supplier list shares. What is left of a supplier's name is what has to turn
// up in the bank text for the name to count as evidence.
const NOISE = new Set([
  'PTE', 'LTD', 'LIMITED', 'INC', 'LLC', 'LLP', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'PLC', 'BHD', 'SDN',
  'SINGAPORE', 'SG', 'THE', 'AND', 'OF', 'FOR', 'A', 'AN',
  'SERVICES', 'SERVICE', 'GROUP', 'HOLDINGS', 'INTERNATIONAL', 'GLOBAL', 'ASIA', 'PACIFIC',
  'PAYMENT', 'PAYMENTS', 'TRANSFER', 'TRF', 'FAST', 'GIRO', 'PAYNOW', 'CARD', 'DEBIT', 'CREDIT', 'VISA', 'MASTERCARD',
]);

export function nameTokens(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w));
}

function bankText(line) {
  return `${line?.description ?? ''} ${line?.reference ?? ''}`.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
}

// Whether the supplier's name is in the bank text. A bank narrative truncates
// and abbreviates ("GRAB* SINGAPORE", "AMZN MKTP SG"), so one distinctive word
// of the name found whole is taken as the name, and a word of the name found
// as the START of a bank word covers "GRAB" in "GRABPAY".
export function nameInBankText(supplier, line) {
  const words = nameTokens(supplier);
  if (!words.length) return false;
  const text = ` ${bankText(line)} `;
  const bankWords = text.trim().split(/\s+/).filter(Boolean);
  return words.some((w) => text.includes(` ${w} `) || (w.length >= 4 && bankWords.some((b) => b.startsWith(w))));
}

// Whether the document's own number is in the bank text — the strongest tie
// there is, since a person typed it into the transfer.
export function numberInBankText(doc, line) {
  const num = String(doc?.invoiceNumber ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (num.length < 4) return false;
  return bankText(line).replace(/\s+/g, '').includes(num);
}

/**
 * The documents one bank line could pay, best first.
 *
 * Each candidate carries a `confidence`: 'firm' when the money agrees, the date
 * is in the window, and the bank text NAMES the document (supplier or number)
 * — or when the money agrees within a week and this is the only document at
 * that figure, which is what a card slip beside its receipt looks like;
 * 'possible' when only the money and the window agree, which is offered but
 * never taken without a person. A line paying nothing here answers [].
 */
export function candidatesFor(line, docs) {
  if (!isMoneyOut(line)) return [];
  const out = [];
  for (const doc of docs || []) {
    if (!matchable(doc)) continue;
    if (!amountsAgree(doc, line)) continue;
    if (!inWindow(doc, line)) continue;
    const named = nameInBankText(doc.supplier, line);
    const numbered = numberInBankText(doc, line);
    const days = daysAfter(doc, line);
    const reasons = ['amount'];
    if (numbered) reasons.push('number');
    if (named) reasons.push('name');
    out.push({ doc, days, reasons, confidence: named || numbered ? 'firm' : 'possible' });
  }
  // A lone document at this figure within a week of the line is firm even
  // unnamed — most card narratives name nobody a person would recognise.
  if (out.length === 1 && out[0].confidence === 'possible' && Math.abs(out[0].days) <= 7) {
    out[0].confidence = 'firm';
    out[0].reasons.push('only');
  }
  const rank = (c) => (c.confidence === 'firm' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || Math.abs(a.days) - Math.abs(b.days) || String(a.doc.id).localeCompare(String(b.doc.id)));
  return out;
}

/**
 * Every line's candidates at once, keyed by `lineKey`, with each document
 * claimed by ONE line: a firm candidate is taken by the line it is closest to,
 * so two identical charges a week apart do not both point at the same receipt.
 * A document still stands as a 'possible' candidate on other lines — the
 * person choosing sees it — but only one line SUGGESTS it.
 */
export function bankMatches(lines, docs) {
  const all = new Map();
  for (const line of lines || []) all.set(lineKey(line), candidatesFor(line, docs));

  // Which line each firm document goes to: the line nearest in date.
  const best = new Map(); // doc id -> { key, days }
  for (const [key, cands] of all) {
    for (const c of cands) {
      if (c.confidence !== 'firm') continue;
      const cur = best.get(c.doc.id);
      if (!cur || Math.abs(c.days) < Math.abs(cur.days)) best.set(c.doc.id, { key, days: c.days });
    }
  }
  const out = new Map();
  for (const [key, cands] of all) {
    const mine = cands.map((c) => {
      if (c.confidence !== 'firm') return c;
      const owner = best.get(c.doc.id);
      return owner && owner.key !== key ? { ...c, confidence: 'possible', reasons: [...c.reasons, 'elsewhere'] } : c;
    });
    const rank = (c) => (c.confidence === 'firm' ? 0 : 1);
    mine.sort((a, b) => rank(a) - rank(b) || Math.abs(a.days) - Math.abs(b.days));
    out.set(key, mine);
  }
  return out;
}

// The one document a line SUGGESTS — its first firm candidate, or null. A
// line with several firm candidates suggests none: a person has to choose.
export function suggestionFor(candidates) {
  const firm = (candidates || []).filter((c) => c.confidence === 'firm');
  return firm.length === 1 ? firm[0] : null;
}
