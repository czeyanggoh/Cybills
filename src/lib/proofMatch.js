// Which invoices a payment proof pays.
//
// A payment proof — a bank transfer confirmation, a PayNow / GIRO screenshot —
// is not a cost and never reaches Xero (it would post the same spending a second
// time, beside the invoice it settled). What it IS good for is the question every
// unpaid invoice is waiting on: has this been paid? So a proof is set aside to
// Archived on arrival (server/src/paymentProof.ts) and this module says which
// invoices in the book it settles — one invoice for the whole amount, or several
// of the same payee's invoices that add up to it, which is how a supplier with a
// month of small bills is actually paid.
//
// A proof and an invoice are the same money when the amounts agree TO THE CENT
// (a combination must add up exactly), the invoice is dated in the window a
// payment follows it, and something ties the two: the payee named on the proof
// is the invoice's supplier, or the proof quotes the invoice's own number.
//
// Every match carries a `confidence`, and only one kind acts by itself:
//   - 'firm' — the proof quotes exactly these invoices by number and they add up;
//     or one invoice of this payee's at the amount; or exactly ONE combination of
//     this payee's invoices adds up. And it is the only firm answer: two firm
//     answers are a choice, and a choice is a person's.
//   - 'possible' — everything else that adds up: an unnamed invoice at the amount,
//     one of several combinations. Offered, never taken.
//
// Pure, so the document page and the server apply the same rules. The server
// loads this file by path (server/src/proofMatch.ts) and holds an Apply to
// `sumsExactly` — so a set the page offered can never be refused for its money,
// and one that does not add up can never be applied by asking the API directly.
// Tested by test/proof-match.test.mjs.

import { amountOf, nameTokens, payableKind } from './bankMatch.js';
import { isPaymentProof } from './paymentProof.js';

export { isPaymentProof };

const cents = (v) => Math.round(amountOf(v) * 100);
const upper = (v) => String(v ?? '').trim().toUpperCase();
const typeOf = (d) => d?.type ?? d?.documentType;

// An invoice dated up to 180 days BEFORE the payment (a slow payer is still
// paying the same bill), or up to a week after it (a deposit paid against a
// quote, invoiced once the money landed).
export const PROOF_WINDOW = { before: 180, after: 7 };

const DAY = 24 * 60 * 60 * 1000;
function dayOf(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

// How many days the payment came AFTER the invoice. NaN when either is undated.
export function daysPaidAfter(doc, proof) {
  const d = dayOf(doc?.date);
  const p = dayOf(proof?.date);
  if (Number.isNaN(d) || Number.isNaN(p)) return NaN;
  return Math.round((p - d) / DAY);
}

// The invoice's figure in the currency the proof moved, or null when the two
// cannot be compared: its own total in the same currency, else the SGD figure a
// foreign-currency invoice restated itself in. Never a converted guess.
export function invoiceAmountFor(doc, proof) {
  const paidIn = upper(proof?.currency);
  const billedIn = upper(doc?.currency);
  if (!paidIn || !billedIn || paidIn === billedIn) return amountOf(doc?.total);
  if (upper(doc?.baseCurrency) === paidIn && amountOf(doc?.baseTotal) > 0) return amountOf(doc?.baseTotal);
  return null;
}

/**
 * Could this proof pay this document? A cost invoice or bill (never another
 * proof, a credit note or a mileage record), still a live document, not one Xero
 * already calls PAID or VOIDED, not paid by ANOTHER proof, and not already
 * marked paid — a receipt settled at the till has no payment still to find. A
 * document this very proof is paying stays payable, or its own match could not
 * be shown back. `anyDate` lifts the date window, for a person picking by hand.
 */
export function payableByProof(doc, proof, { anyDate = false } = {}) {
  if (!doc || !proof || doc.id === proof.id) return false;
  if ((doc.kind || 'cost') !== 'cost') return false;
  if (isPaymentProof(typeOf(doc)) || !payableKind(typeOf(doc))) return false;
  if (['merged', 'deleted', 'processing', 'expenseclaim'].includes(String(doc.status || ''))) return false;
  const xero = upper(doc.xeroStatus);
  if (xero === 'PAID' || xero === 'VOIDED') return false;
  const payer = doc.paidByProof?.proofId || '';
  if (payer && payer !== proof.id) return false;
  if (doc.paid && payer !== proof.id) return false;
  const amount = invoiceAmountFor(doc, proof);
  if (amount == null || amount <= 0) return false;
  if (anyDate) return true;
  const n = daysPaidAfter(doc, proof);
  return !Number.isNaN(n) && n >= -PROOF_WINDOW.after && n <= PROOF_WINDOW.before;
}

// Everything a person wrote on the proof that could name what it pays: the
// transaction reference, the description, the note, the file name.
function proofText(proof) {
  return [proof?.invoiceNumber, proof?.description, proof?.note, proof?.fileName].map((v) => String(v ?? '')).join(' ');
}

// The payee on the proof is this invoice's supplier: a distinctive word of the
// supplier's name is the payee's, or turns up in what the proof says. A bank
// screen truncates a payee ("NUPHAR DESIG"), so a word of four letters or more
// counts where one starts the other.
export function namesPayee(doc, proof) {
  const words = nameTokens(doc?.supplier);
  if (!words.length) return false;
  const theirs = [...nameTokens(proof?.supplier), ...nameTokens(proofText(proof))];
  return words.some((w) => theirs.some((t) => t === w || (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t)))));
}

// The proof quotes this invoice's own number — the strongest tie there is,
// since somebody typed it into the transfer.
export function quotesNumber(doc, proof) {
  const num = String(doc?.invoiceNumber ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (num.length < 4) return false;
  return proofText(proof).replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(num);
}

// The subsets of `items` (two or more) whose cents add up to `target`. Bounded:
// at most `maxSize` invoices a set, `maxResults` sets, and a step budget — a
// payee with forty identical invoices has no unique answer to find, and saying
// the search was cut short (`complete: false`) is what stops a partial answer
// from being mistaken for the only one.
function combinations(items, target, { maxSize = 8, maxResults = 6, budget = 50000 } = {}) {
  const sorted = [...items].sort((a, b) => b.cents - a.cents);
  const suffix = new Array(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + sorted[i].cents;
  const sets = [];
  const pick = [];
  let steps = 0;
  let complete = true;
  const walk = (start, remaining) => {
    if (sets.length >= maxResults) { complete = false; return; }
    if ((steps += 1) > budget) { complete = false; return; }
    if (remaining === 0) {
      if (pick.length >= 2) sets.push([...pick]);
      return;
    }
    if (pick.length >= maxSize) return;
    for (let i = start; i < sorted.length; i += 1) {
      if (suffix[i] < remaining) return;
      if (sorted[i].cents > remaining) continue;
      pick.push(sorted[i]);
      walk(i + 1, remaining - sorted[i].cents);
      pick.pop();
      if (!complete) return;
    }
  };
  walk(0, target);
  return { sets, complete };
}

const keyOf = (members) => members.map((m) => m.doc.id).sort().join('|');

/**
 * The invoices this proof could pay, best first. Each match is
 * `{ ids, docs, total, confidence, reasons }` — `reasons` among 'number' (the
 * proof quotes them), 'name' (paid to their supplier), 'amount' (one invoice at
 * the figure), 'combo' (several adding up), 'ambiguous' (downgraded because it
 * was not the only firm answer). A proof paying nothing here answers [].
 */
export function proofMatches(proof, docs, { pool = 14 } = {}) {
  if (!proof || !isPaymentProof(typeOf(proof))) return [];
  const target = cents(proof.total);
  if (target <= 0) return [];

  const cands = [];
  for (const doc of docs || []) {
    if (!payableByProof(doc, proof)) continue;
    cands.push({
      doc,
      cents: cents(invoiceAmountFor(doc, proof)),
      named: namesPayee(doc, proof),
      numbered: quotesNumber(doc, proof),
      days: Math.abs(daysPaidAfter(doc, proof)),
    });
  }

  const found = new Map();
  const add = (members, confidence, reasons) => {
    const key = keyOf(members);
    const prev = found.get(key);
    if (prev && (prev.confidence === 'firm' || confidence !== 'firm')) return;
    const ordered = [...members].sort((a, b) => String(a.doc.date).localeCompare(String(b.doc.date)) || String(a.doc.id).localeCompare(String(b.doc.id)));
    found.set(key, {
      key,
      ids: ordered.map((m) => m.doc.id),
      docs: ordered.map((m) => m.doc),
      total: members.reduce((s, m) => s + m.cents, 0) / 100,
      confidence,
      reasons,
      days: members.reduce((s, m) => s + m.days, 0),
    });
  };

  // 1. The invoices the proof quotes by number, when they are the whole of it.
  const quoted = cands.filter((c) => c.numbered);
  const quotedKey = quoted.length && quoted.reduce((s, c) => s + c.cents, 0) === target ? keyOf(quoted) : '';
  if (quotedKey) add(quoted, 'firm', quoted.length > 1 ? ['number', 'combo'] : ['number']);

  // 2. One invoice for the whole amount.
  for (const c of cands) {
    if (c.cents !== target) continue;
    const reasons = [...(c.numbered ? ['number'] : []), ...(c.named ? ['name'] : []), 'amount'];
    add([c], c.named || c.numbered ? 'firm' : 'possible', reasons);
  }

  // 3. Several of this payee's invoices that add up to it — nearest first, so a
  //    payee with a long history is searched where the payment most likely is.
  const payees = cands.filter((c) => c.named || c.numbered).sort((a, b) => a.days - b.days).slice(0, pool);
  const { sets, complete } = combinations(payees, target);
  for (const s of sets) add(s, 'possible', ['name', 'combo']);
  if (complete && sets.length === 1) add(sets[0], 'firm', ['name', 'combo']);

  // A firm answer is firm only while it is the only one — except the set the
  // proof quotes by number, which a person wrote down.
  let list = [...found.values()];
  if (list.filter((m) => m.confidence === 'firm').length > 1) {
    list = list.map((m) =>
      m.confidence === 'firm' && m.key !== quotedKey ? { ...m, confidence: 'possible', reasons: [...m.reasons, 'ambiguous'] } : m
    );
  }
  const rank = (m) => (m.confidence === 'firm' ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || a.ids.length - b.ids.length || a.days - b.days || a.key.localeCompare(b.key));
  return list.slice(0, 8).map(({ key: _key, days: _days, ...m }) => m);
}

// The one match a proof applies by itself: its only firm answer, else null.
export function suggestionFor(matches) {
  const firm = (matches || []).filter((m) => m.confidence === 'firm');
  return firm.length === 1 ? firm[0] : null;
}

// Whether these documents are ones this proof may pay AND add up to it to the
// cent — the check every Apply is held to, whoever chose the set.
export function sumsExactly(proof, docs) {
  const list = docs || [];
  if (!proof || !isPaymentProof(typeOf(proof)) || !list.length) return false;
  if (new Set(list.map((d) => d?.id)).size !== list.length) return false;
  if (!list.every((d) => payableByProof(d, proof, { anyDate: true }))) return false;
  return list.reduce((s, d) => s + cents(invoiceAmountFor(d, proof)), 0) === cents(proof.total);
}
