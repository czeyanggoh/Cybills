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

// A CARD FEE the bank adds on top of the purchase. UOB charges 1% on some
// debit-card spends and takes it in the same statement line, so a Canva receipt
// of SGD 17.99 clears the bank as 18.17 — never the same money to the cent, and
// so never matched. An entity says which bank account does it, at what percent,
// and to which account the fee posts (Business settings → Extraction → Bank
// match → Card fees), and a line on that account whose amount is EXACTLY the
// document's plus that percent, rounded to the cent (a cent either way), is the
// document's payment plus a fee. Nothing is guessed: no rule, no fee match.
//
// `rules` are the entity's `cardFeeRules`: { bankAccount, percent, accountCode }.
// The bank account is matched by the line's account name (or code), and the fee
// account may be stored as a chart label ("404 - Bank Fees") or a bare code.
const feeCodeOf = (label) => {
  const s = String(label ?? '').trim();
  const m = /^([A-Za-z0-9]*\d[A-Za-z0-9]*)\s*-\s/.exec(s);
  return m ? m[1] : s;
};

export function cardFeeRuleFor(line, rules) {
  const name = String(line?.bank_account_name ?? '').trim().toLowerCase();
  const code = String(line?.bank_account_code ?? '').trim().toLowerCase();
  for (const r of rules || []) {
    const acct = String(r?.bankAccount ?? '').trim().toLowerCase();
    const percent = Number(String(r?.percent ?? '').replace(/[^0-9.]/g, ''));
    const accountCode = feeCodeOf(r?.accountCode);
    if (!acct || !(percent > 0) || !accountCode) continue;
    if (acct === name || (code && acct === code)) return { percent, accountCode, bankAccount: String(r.bankAccount).trim() };
  }
  return null;
}

// The fee inside this line, when the line is this document's money plus the
// bank's card fee — { percent, fee, accountCode, bankAccount } — or null.
export function feeFor(doc, line, rules) {
  // The fee is posted as a line ON THE BILL (so one payment of the line's
  // amount is what Xero pairs with the statement line), which only makes sense
  // for a bill in the bank's own currency: an SGD fee cannot be a line of a USD
  // bill.
  const bank = String(line?.currency ?? '').trim().toUpperCase();
  const docCurrency = String(doc?.currency ?? '').trim().toUpperCase();
  if (bank && docCurrency && bank !== docCurrency) return null;
  const mine = docAmountFor(doc, line);
  if (mine == null) return null;
  const rule = cardFeeRuleFor(line, rules);
  if (!rule) return null;
  const docCents = CENTS(mine);
  const bankCents = Math.abs(CENTS(line?.amount));
  if (docCents <= 0 || bankCents <= docCents) return null;
  const expected = Math.round(docCents * (1 + rule.percent / 100));
  if (Math.abs(bankCents - expected) > 1) return null;
  return { percent: rule.percent, fee: (bankCents - docCents) / 100, accountCode: rule.accountCode, bankAccount: rule.bankAccount };
}

// A document a bank line could pay: a VENDOR INVOICE or a RECEIPT. The other
// kinds are not costs a line settles — a PAYMENT PROOF is the bank's own record
// that a line was paid (matched, it would publish a transfer confirmation as a
// bill and pay it, beside the invoice it actually paid); a MILEAGE record is a
// journey reimbursed through a claim; a credit note is money the supplier owes
// us; a statement, a delivery note and an ATM slip carry no cost of their own.
// A blank type (documents read before there was one) and "Other" (the reader's
// name for a bill it could not place) are still offered: refusing them would
// hide a real bill for want of a label.
export function payableKind(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t || t === 'other') return true;
  if (/credit|payment proof|mileage|statement|remittance|delivery|atm|expense statement/.test(t)) return false;
  return /receipt|invoice/.test(t);
}

// Cost documents only; of a payable kind (above); never one on an expense
// claim (its money reaches the ledger as a line of the claim's bill) or merged
// away (another document's money); never one Xero already calls PAID. A
// document already PUBLISHED but still awaiting payment is offered: publishing
// is not paying, and the bank line is the payment.
export function matchable(doc) {
  if (!doc) return false;
  if ((doc.kind || 'cost') !== 'cost') return false;
  const status = String(doc.status || '');
  if (['expenseclaim', 'merged', 'deleted', 'processing'].includes(status)) return false;
  if (!payableKind(doc.type || doc.documentType)) return false;
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

// The word of the supplier's name found in the bank text, or ''. A bank
// narrative truncates and abbreviates ("GRAB* SINGAPORE", "AMZN MKTP SG"), so
// one distinctive word of the name found whole is taken as the name, and a word
// of the name found as the START of a bank word covers "GRAB" in "GRABPAY".
//
// `ownNames` are the ENTITY's own names. An outgoing transfer's narrative very
// often carries the payer — "IVPT Excellence AS Pte Ltd" on Excellence's own
// statement — so a document whose supplier shares a word with the entity (a
// payment proof read as "EXCELLENCE A.S PTE. LTD.", an intercompany recharge)
// was reported as naming its supplier when the bank was only naming us. A word
// the entity's own name carries is evidence of nothing, so it is not counted.
export function nameMatchIn(supplier, line, { ownNames = [] } = {}) {
  const own = new Set((ownNames || []).flatMap((n) => nameTokens(n)));
  const words = nameTokens(supplier).filter((w) => !own.has(w));
  if (!words.length) return '';
  const text = ` ${bankText(line)} `;
  const bankWords = text.trim().split(/\s+/).filter(Boolean);
  return words.find((w) => text.includes(` ${w} `) || (w.length >= 4 && bankWords.some((b) => b.startsWith(w)))) || '';
}

export function nameInBankText(supplier, line, opts) {
  return Boolean(nameMatchIn(supplier, line, opts));
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
export function candidatesFor(line, docs, opts = {}) {
  if (!isMoneyOut(line)) return [];
  const out = [];
  for (const doc of docs || []) {
    if (!matchable(doc)) continue;
    // The same money to the cent — or, on an account whose bank adds a card fee,
    // the document's money plus exactly that fee (feeFor).
    const exact = amountsAgree(doc, line);
    const fee = exact ? null : feeFor(doc, line, opts.feeRules);
    if (!exact && !fee) continue;
    if (!inWindow(doc, line)) continue;
    // The word itself, not just whether one was found: it is what the page
    // shows as the reason, so a person can see WHICH word tied the two.
    const word = nameMatchIn(doc.supplier, line, opts);
    const named = Boolean(word);
    const numbered = numberInBankText(doc, line);
    const days = daysAfter(doc, line);
    const reasons = ['amount'];
    if (numbered) reasons.push('number');
    if (named) reasons.push('name');
    if (fee) reasons.push('fee');
    out.push({ doc, days, reasons, word, fee, confidence: named || numbered ? 'firm' : 'possible' });
  }
  // A lone document at this figure within a week of the line is firm even
  // unnamed — most card narratives name nobody a person would recognise. Not
  // for a match that needed a card fee to agree: an amount worked out from a
  // percentage is weaker evidence than one that simply matches, so it has to be
  // NAMED (supplier or number) to be suggested on its own.
  if (out.length === 1 && out[0].confidence === 'possible' && !out[0].fee && Math.abs(out[0].days) <= 7) {
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
export function bankMatches(lines, docs, opts = {}) {
  const all = new Map();
  for (const line of lines || []) all.set(lineKey(line), candidatesFor(line, docs, opts));

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

// WHY a line and a document were paired, in words a person can check against
// the bank text in front of them. "Names this supplier" was shown for every
// firm match, including the two that name nothing at all (the document number,
// and being the only document at that figure) — so nobody could tell which of
// the three it was, or see that the word was the entity's own name.
export function matchReason(match, doc) {
  const base = (() => {
    const r = match?.reasons || [];
    if (r.includes('elsewhere')) return 'Also fits a closer payment — check which is right';
    if (r.includes('number')) return `Bank text has invoice number ${String(doc?.invoiceNumber ?? '').trim()}`.trim();
    if (r.includes('name')) return match?.word ? `Bank text names the supplier (${match.word})` : 'Bank text names the supplier';
    if (r.includes('only')) return 'Only document at this amount within a week';
    return 'Same amount, close date';
  })();
  // The fee is part of WHY the money agrees, so it is said beside the reason —
  // the line is not this document's figure, and a person should see why not.
  const f = match?.fee;
  return f ? `${base} · incl. ${f.percent}% card fee ${Number(f.fee).toFixed(2)}` : base;
}

// The one document a line SUGGESTS — its first firm candidate, or null. A
// line with several firm candidates suggests none: a person has to choose.
export function suggestionFor(candidates) {
  const firm = (candidates || []).filter((c) => c.confidence === 'firm');
  return firm.length === 1 ? firm[0] : null;
}

/**
 * The same pairing seen from the DOCUMENT's side — what the Costs inbox's
 * Match column draws: for each document, the statement lines that could be
 * its payment, best first. `bankMatches` decides the pairing (one line
 * suggests one document); this only turns it round, so the inbox and the Bank
 * tab can never disagree about which line pays which document. A document
 * with one line is "Match found", with several "Matches found" — Dext's words.
 */
export function matchesByDoc(lines, docs, opts = {}) {
  const byDoc = new Map();
  for (const [key, cands] of bankMatches(lines, docs, opts)) {
    const line = (lines || []).find((l) => lineKey(l) === key);
    if (!line) continue;
    for (const c of cands) {
      const list = byDoc.get(c.doc.id) || [];
      list.push({ line, confidence: c.confidence, days: c.days, reasons: c.reasons, word: c.word, fee: c.fee });
      byDoc.set(c.doc.id, list);
    }
  }
  const rank = (m) => (m.confidence === 'firm' ? 0 : 1);
  for (const list of byDoc.values()) list.sort((a, b) => rank(a) - rank(b) || Math.abs(a.days) - Math.abs(b.days));
  return byDoc;
}
