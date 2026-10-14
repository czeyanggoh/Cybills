// Paperwork match: the receipt for a transaction Xero ALREADY has.
//
// Bank match (bankMatch.js) is a statement line still waiting for its bill. This
// is the other way round, and it is Dext's Paperwork match: the money is already
// in the ledger — a Spend Money coded straight off the Amex feed, a bill somebody
// keyed in by hand — and the paper turns up here afterwards. Publishing it would
// post the same spending a second time beside the one Xero has. So the document
// is SENT to that transaction instead: its file is attached there, the
// transaction is recoded to what the paper says, and the document is done.
//
// The money is judged exactly as Bank match judges it (the same `docAmountFor`,
// the same date window, the same supplier-name and number tests), because a
// Xero transaction is a bank movement seen from the ledger's side. Pure, so the
// page and the server apply the same rules; server/src/paperworkMatch.ts loads
// it by path, the way bankMatch.ts loads bankMatch.js. Tested by
// test/paperwork-match.test.mjs.
//
// A Xero transaction, as the server hands it over (`summariseXeroTxn`):
//   { kind: 'spend' | 'bill', id, date, total, currency, contact, reference,
//     number, bankAccount: { name, code }, status, reconciled, hasAttachments,
//     lines: [{ description, accountCode, accountName, taxType, taxName,
//               amount, tax, tracking: [{ category, option }] }] }
import { amountsAgree, daysAfter, inWindow, nameMatchIn, numberInBankText, payableKind } from './bankMatch.js';
import { categoryCode } from './categoryList.js';

const CENTS = (n) => Math.round(Number(n || 0) * 100);

// A document that could still be sent to a Xero transaction: a cost of a kind a
// payment settles, in the working list, with money on it, and not already in
// Xero by any road. Archived by hand, on a claim, merged away or still being
// read is somebody else's business.
export function paperworkEligible(doc) {
  if (!doc) return false;
  if ((doc.kind || 'cost') !== 'cost') return false;
  if (doc.xeroInvoiceId || doc.paperworkMatch || doc.prepayment) return false;
  if (!['new', 'viewed', 'review', 'ready'].includes(String(doc.status || 'new'))) return false;
  if (!payableKind(doc.type ?? doc.documentType)) return false;
  return CENTS(String(doc.total ?? '').replace(/[^0-9.-]/g, '')) > 0;
}

// The transaction read as a bank movement, so Bank match's tests apply to it
// unchanged: money OUT of the stated amount, in its own currency, with the
// contact and the lines' own words as the narrative and its reference (and a
// bill's own number) as the reference.
export function txnAsLine(txn) {
  return {
    date: String(txn?.date ?? '').slice(0, 10),
    amount: -Math.abs(Number(txn?.total) || 0),
    currency: String(txn?.currency ?? ''),
    description: [txn?.contact, ...(txn?.lines || []).map((l) => l?.description)].filter(Boolean).join(' '),
    reference: [txn?.reference, txn?.number].filter(Boolean).join(' '),
  };
}

// The Xero transactions one document could be the paper for, best first. Each
// carries a `confidence` the way Bank match's do: 'firm' when the money agrees,
// the date is in the window and the transaction NAMES the document (its contact
// or narrative carries the supplier, or its reference the document's number) —
// or when it is the only one at that figure within a week; 'possible' when only
// the money and the window agree.
export function paperworkCandidatesFor(doc, txns, opts = {}) {
  if (!paperworkEligible(doc)) return [];
  const linked = opts.linkedIds instanceof Set ? opts.linkedIds : new Set(opts.linkedIds || []);
  const out = [];
  for (const txn of txns || []) {
    if (!txn?.id || linked.has(txn.id)) continue;
    const line = txnAsLine(txn);
    if (!amountsAgree(doc, line)) continue;
    if (!inWindow(doc, line)) continue;
    const word = nameMatchIn(doc.supplier, line, opts);
    const numbered = numberInBankText(doc, line);
    const reasons = ['amount'];
    if (numbered) reasons.push('number');
    if (word) reasons.push('name');
    out.push({ txn, days: daysAfter(doc, line), reasons, word, confidence: word || numbered ? 'firm' : 'possible' });
  }
  if (out.length === 1 && out[0].confidence === 'possible' && Math.abs(out[0].days) <= 7) {
    out[0].confidence = 'firm';
    out[0].reasons.push('only');
  }
  const rank = (c) => (c.confidence === 'firm' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || Math.abs(a.days) - Math.abs(b.days) || String(a.txn.id).localeCompare(String(b.txn.id)));
  return out;
}

/**
 * Every document's candidates at once, keyed by document id, with each Xero
 * transaction FIRM for one document only — the nearest in date — so two
 * identical receipts a month apart do not both claim this month's Spend Money.
 * It stays offered to the other as 'possible', where a person can still see it.
 */
export function paperworkMatches(docs, txns, opts = {}) {
  const all = new Map();
  for (const doc of docs || []) {
    const cands = paperworkCandidatesFor(doc, txns, opts);
    if (cands.length) all.set(doc.id, cands);
  }
  const best = new Map(); // txn id -> { docId, days }
  for (const [docId, cands] of all) {
    for (const c of cands) {
      if (c.confidence !== 'firm') continue;
      const cur = best.get(c.txn.id);
      if (!cur || Math.abs(c.days) < Math.abs(cur.days)) best.set(c.txn.id, { docId, days: c.days });
    }
  }
  const out = new Map();
  for (const [docId, cands] of all) {
    const mine = cands.map((c) =>
      c.confidence === 'firm' && best.get(c.txn.id)?.docId !== docId
        ? { ...c, confidence: 'possible', reasons: [...c.reasons, 'elsewhere'] }
        : c
    );
    const rank = (c) => (c.confidence === 'firm' ? 0 : 1);
    mine.sort((a, b) => rank(a) - rank(b) || Math.abs(a.days) - Math.abs(b.days));
    out.set(docId, mine);
  }
  return out;
}

// The one transaction a document SUGGESTS, or null: its only firm candidate.
export function paperworkSuggestion(candidates) {
  const firm = (candidates || []).filter((c) => c.confidence === 'firm');
  return firm.length === 1 ? firm[0] : null;
}

// Why the two were paired, in words a person can check against Xero.
export function paperworkReason(match, doc) {
  const r = match?.reasons || [];
  if (r.includes('elsewhere')) return 'Also fits another document — check which is right';
  if (r.includes('number')) return `Xero's reference has ${String(doc?.invoiceNumber ?? '').trim()}`.trim();
  if (r.includes('name')) return match?.word ? `Xero names the supplier (${match.word})` : 'Xero names the supplier';
  if (r.includes('only')) return 'Only Xero transaction at this amount within a week';
  return 'Same amount, close date';
}

// What a Xero transaction is called, in Xero's own words.
export const txnNoun = (txn) => (txn?.kind === 'bill' ? 'bill' : 'Spend Money');

// Whether Xero will let an APP change this transaction's lines at all. It will
// not for a Spend Money once it is reconciled with a bank statement line ("This
// Bank Transaction cannot be edited as it has been reconciled with a Bank
// Statement", Excellence's Lalamove, 14 Oct 2026), nor for a bill that is fully
// paid. Xero's own screens still can (Options -> Edit), so the page names the
// change for a person to make there rather than offering a button that can
// only fail.
export function recodeLocked(txn) {
  if (txn?.kind === 'spend') return Boolean(txn?.reconciled);
  if (txn?.kind === 'bill') return String(txn?.status || '').toUpperCase() === 'PAID';
  return false;
}

export function recodeLockedReason(txn) {
  return txn?.kind === 'bill'
    ? 'Xero does not let an app change the lines of a bill that has been paid.'
    : 'Xero does not let an app change a Spend Money once it is reconciled with a bank statement line.';
}

// The change a person makes in Xero, one line per field: "Outlets: HQ → Tangs".
export function recodeInstructions(diffs) {
  return (diffs || []).map((d) => `${d.label}: ${d.xero} → ${d.document}`);
}

// --- the coding, side by side ------------------------------------------------------
//
// What the document says the money is (account, tax code, both tracking
// categories) against what the Xero transaction says. Compared as SETS across
// the lines on each side, so a document posted as three rows and a transaction
// of three lines agree when they carry the same codes, and a difference is a
// difference a person can see in one row of a table. Blank on either side is a
// value ("Not set"), not a pass: recoding a transaction tagged HQ to a document
// with no outlet takes HQ off it, and that has to be said before it happens.

const norm = (s) => String(s ?? '').trim();
const showSet = (xs) => (xs.length ? xs.join(', ') : 'Not set');
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const uniq = (xs) => [...new Set(xs.map(norm))].sort();

function docRows(doc) {
  const rows = Array.isArray(doc?.lineItems) ? doc.lineItems.filter((r) => r && (norm(r.total) || norm(r.net))) : [];
  return rows.length ? rows : [{}];
}

/**
 * [{ key, label, document, xero }] for each piece of coding that differs, or []
 * when the transaction already says what the document says.
 * `trackingNames` are the org's two tracking categories in Xero's order — the
 * first is the document's `project`, the second its `project2`.
 */
export function codingDifferences(doc, txn, trackingNames = []) {
  if (!doc || !txn) return [];
  const rows = docRows(doc);
  const lines = Array.isArray(txn.lines) && txn.lines.length ? txn.lines : [{}];
  const out = [];

  // Account, by CODE: "425 - Freight & Courier" and Xero's 425 are one account
  // however either side spells its name.
  const docAccounts = uniq(rows.map((r) => norm(r.category) || norm(doc.category)).filter(Boolean));
  const docCodes = uniq(docAccounts.map((c) => categoryCode(c) || c));
  const xeroCodes = uniq(lines.map((l) => l.accountCode).filter(Boolean));
  if (!sameSet(docCodes, xeroCodes)) {
    out.push({
      key: 'account',
      label: 'Account',
      document: showSet(docAccounts),
      xero: showSet(uniq(lines.filter((l) => l.accountCode).map((l) => (l.accountName ? `${l.accountCode} - ${l.accountName}` : l.accountCode)))),
    });
  }

  // Tax code, by NAME — the name is what the app stores and what a person chose.
  const docTax = uniq(rows.map((r) => norm(r.taxRate) || norm(doc.taxRate)).filter(Boolean));
  const xeroTax = uniq(lines.map((l) => norm(l.taxName) || norm(l.taxType)).filter(Boolean));
  if (!sameSet(docTax.map((t) => t.toLowerCase()), xeroTax.map((t) => t.toLowerCase()))) {
    out.push({ key: 'tax', label: 'Tax rate', document: showSet(docTax), xero: showSet(xeroTax) });
  }

  // Each tracking category the org has.
  [0, 1].forEach((i) => {
    const name = norm(trackingNames[i]);
    if (!name) return;
    const field = i === 0 ? 'project' : 'project2';
    const docVals = uniq(rows.map((r) => norm(r[field]) || norm(doc[field])).filter(Boolean));
    const xeroVals = uniq(
      lines
        .map((l) => (l.tracking || []).find((t) => norm(t.category).toLowerCase() === name.toLowerCase())?.option)
        .filter(Boolean)
    );
    if (!sameSet(docVals, xeroVals)) {
      out.push({ key: field, label: name, document: showSet(docVals), xero: showSet(xeroVals) });
    }
  });
  return out;
}
