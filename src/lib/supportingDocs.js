// Supporting documents: the paperwork BEHIND an invoice, sent in with it.
//
// A company recharging costs sends one invoice and, beside it, the receipts or
// expense reports the invoice is made up of. All of them are read as costs, and
// published as they stand the same spending goes into the ledger twice: once as
// the invoice, once again as its own backup. They are not pages of one document
// (different suppliers, different totals) and not a receipt with its card slip
// (the totals differ), so merge detection has nothing to say about them.
//
// A document is SUPPORTING for an invoice when three things hold:
//
//   1. They arrived together — one email is the firm case; one upload or one
//      stretch of a WhatsApp group is the weaker one.
//   2. Exactly one document of the set is the bill to this entity (the entity
//      check's 'ok'), and the supporting one is not billed to this entity.
//   3. The money ties: the supporting document's total is one of the invoice's
//      own line amounts, to the cent — each supporting document its own line —
//      or the supporting documents together add up to the invoice's total or
//      its net. Never "roughly": a recharge invoice usually carries a fee or
//      other lines on top, so the sum is the exception and the lines the rule.
//
// Every group carries a `confidence`, and only one kind acts by itself:
//   - 'firm' — one email, the invoice is billed to this entity, and EVERY other
//     document that mail filed ties to it; two or more of them, or one that is
//     also made out to the invoice's supplier (a single figure can coincide).
//   - 'possible' — some of that: a line tie in an upload batch, only some of
//     the mail's documents tying, or a document made out to the invoice's own
//     supplier with no line to tie it to. Offered, never taken.
//
// Pure, so the Costs list and the server apply the same rules; the server loads
// this file by path (server/src/supportingDocs.ts). Tested by
// test/supporting-docs.test.mjs.

import { sameCompany } from './billedTo.js';
import { payableKind } from './bankMatch.js';

const cents = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const upper = (v) => String(v ?? '').trim().toUpperCase();
const lower = (v) => String(v ?? '').trim().toLowerCase();
const typeOf = (d) => d?.type ?? d?.documentType;

// Uploads (and a WhatsApp group's files) this close together, from one person,
// are one sitting.
export const BATCH_WINDOW_MS = 10 * 60 * 1000;
// A mail carrying more than this is a month of paperwork, not an invoice and
// its backup, and matching inside it would be a search for coincidences.
export const MAX_GROUP = 12;

// Already linked, as either side.
export const isSupporting = (d) => Boolean(d?.supportingFor?.billId);
export const hasSupporting = (d) => Array.isArray(d?.supportingDocs) && d.supportingDocs.length > 0;

// The mail a document arrived in, as a key: one message is one from / to /
// subject / date. '' for anything that did not come by email.
export function mailKey(d) {
  const e = d?.email;
  if (!e || !(e.date || e.subject)) return '';
  return ['mail', lower(e.from), lower(e.to), lower(e.subject), String(e.date ?? '')].join('|');
}

const uploader = (d) => lower(d?.createdByEmail ?? d?.createdBy);
const arrivedAt = (d) => Date.parse(d?.createdAt || '') || 0;

// A cost that could be either side of this at all: a live document, not on a
// claim, not merged away or still being read, not a payment proof, a quotation,
// a credit note or a mileage record, and stating an amount.
function eligible(d) {
  if (!d || (d.kind || 'cost') !== 'cost') return false;
  if (['deleted', 'merged', 'processing', 'expenseclaim'].includes(String(d.status || ''))) return false;
  if (d.paperworkMatch || d.prepayment) return false;
  if (!payableKind(typeOf(d))) return false;
  return cents(d.total) > 0;
}

// Could this document still be SET ASIDE as supporting? Not one already in
// Xero (its money is in the ledger, which is a different problem), not one
// already supporting something, and not one that has supporting documents of
// its own.
export function canSupport(d) {
  return eligible(d) && !d.xeroInvoiceId && !isSupporting(d) && !hasSupporting(d) && d.status !== 'archived';
}

// Could this document be the invoice others support? It may already be in Xero.
export function canBeMain(d) {
  return eligible(d) && !isSupporting(d);
}

// "This is not supporting for that" — either side's verdict about the pair.
export function keptApart(support, main) {
  return Array.isArray(support?.notSupportingFor) && support.notSupportingFor.includes(main?.id);
}

// The support's figure in the invoice's currency, in cents, or null when the two
// cannot be compared: its own total in the same currency, else the figure a
// foreign document restated itself in. Never a converted guess.
export function supportCents(support, main) {
  const mine = upper(support?.currency);
  const theirs = upper(main?.currency);
  if (!mine || !theirs || mine === theirs) return cents(support?.total);
  if (upper(support?.baseCurrency) === theirs && cents(support?.baseTotal) > 0) return cents(support.baseTotal);
  return null;
}

// The amounts the invoice itself itemises: its line items where it has them,
// else the rows the read saw on it (`readLines`, kept as evidence only). Each
// row answers to its total AND its net — a recharge at cost is billed as the
// receipt's gross with GST added on top, or as the gross itself.
export function mainLines(main) {
  const rows = Array.isArray(main?.lineItems) && main.lineItems.length ? main.lineItems : Array.isArray(main?.readLines) ? main.readLines : [];
  return rows
    .map((r, i) => {
      const total = cents(r?.total ?? r?.amount);
      const net = cents(r?.net);
      const amounts = [...new Set([total, net].filter((c) => c > 0))];
      return { index: i, description: String(r?.description ?? '').trim(), amounts };
    })
    .filter((r) => r.amounts.length);
}

// Give each support a line of its own. Small sets, so a plain backtracking
// match: the answer is the assignment covering the MOST supports.
function assignLines(wants) {
  let best = new Map();
  const used = new Set();
  const cur = new Map();
  const walk = (i) => {
    if (cur.size + (wants.length - i) <= best.size) return;
    if (i === wants.length) {
      if (cur.size > best.size) best = new Map(cur);
      return;
    }
    for (const line of wants[i].lines) {
      if (used.has(line.index)) continue;
      used.add(line.index);
      cur.set(wants[i].id, line);
      walk(i + 1);
      cur.delete(wants[i].id);
      used.delete(line.index);
    }
    walk(i + 1);
  };
  walk(0);
  return best;
}

/**
 * How these documents tie to this invoice. Returns one entry per document that
 * ties at all: `{ id, reasons, line }` — `reasons` among 'line' (its total is a
 * line of the invoice), 'sum' (together they add up to the invoice's total or
 * net) and 'billedToSupplier' (it is made out to the invoice's own supplier).
 * A document billed to THIS entity, or one worth as much as the invoice itself,
 * is nobody's backup and is never returned.
 */
export function tiesTo(main, others, { statusOf = () => 'unknown' } = {}) {
  if (!canBeMain(main)) return [];
  const total = cents(main.total);
  const net = total - cents(main.tax);
  const cands = [];
  for (const d of others || []) {
    if (!d || d.id === main.id || !canSupport(d) || keptApart(d, main)) continue;
    if (statusOf(d) === 'ok') continue;
    const c = supportCents(d, main);
    if (c == null || c <= 0 || c >= total) continue;
    cands.push({ doc: d, cents: c });
  }
  if (!cands.length) return [];

  const lines = mainLines(main);
  const assigned = assignLines(
    cands
      .map((c) => ({ id: c.doc.id, lines: lines.filter((l) => l.amounts.includes(c.cents)) }))
      .filter((w) => w.lines.length)
  );
  const sum = cands.reduce((s, c) => s + c.cents, 0);
  const sumTies = cands.length >= 2 && (sum === total || (net > 0 && sum === net));

  const out = [];
  for (const c of cands) {
    const reasons = [];
    const line = assigned.get(c.doc.id) || null;
    if (line) reasons.push('line');
    if (sumTies) reasons.push('sum');
    if (c.doc.billedTo && main.supplier && sameCompany(c.doc.billedTo, main.supplier)) reasons.push('billedToSupplier');
    if (reasons.length) out.push({ id: c.doc.id, reasons, line: line ? line.description : '' });
  }
  return out;
}

const moneyTied = (t) => t.reasons.includes('line') || t.reasons.includes('sum');

// The sets of documents that arrived together: every mail's own documents, then
// what is left grouped by uploader within the batch window.
function arrivals(docs) {
  const byMail = new Map();
  const rest = [];
  for (const d of docs) {
    const k = mailKey(d);
    if (k) byMail.set(k, [...(byMail.get(k) || []), d]);
    else if (uploader(d) && arrivedAt(d)) rest.push(d);
  }
  const groups = [...byMail.values()].map((members) => ({ via: 'mail', members }));
  rest.sort((a, b) => arrivedAt(a) - arrivedAt(b));
  const open = new Map();
  for (const d of rest) {
    const who = `${uploader(d)}|${d.whatsapp?.chatId || ''}`;
    const g = open.get(who);
    if (g && arrivedAt(d) - arrivedAt(g.members[g.members.length - 1]) <= BATCH_WINDOW_MS) g.members.push(d);
    else {
      const fresh = { via: 'batch', members: [d] };
      open.set(who, fresh);
      groups.push(fresh);
    }
  }
  return groups.filter((g) => g.members.length >= 2 && g.members.length <= MAX_GROUP);
}

/**
 * The supporting-document groups in this list. Each is
 * `{ mainId, supports: [{ id, reasons, line }], confidence, via }`. `statusOf`
 * answers the entity check for a document ('ok' = billed to this entity); the
 * Costs list reads it off the row, the server computes it.
 */
export function findSupportingGroups(docs, { statusOf = (d) => d?.entityCheck?.status || 'unknown' } = {}) {
  const out = [];
  for (const g of arrivals((docs || []).filter(eligible))) {
    // The invoice: the one document of the set billed to this entity. Where the
    // paper cannot say (no bill-to party, no Business profile to check against)
    // it is the one document the others tie to — which can only ever be offered.
    const ours = g.members.filter((d) => statusOf(d) === 'ok' && canBeMain(d));
    let main = null;
    let named = false;
    if (ours.length === 1) {
      main = ours[0];
      named = true;
    } else if (!ours.length) {
      const tying = g.members.filter((m) => canBeMain(m) && tiesTo(m, g.members, { statusOf }).some(moneyTied));
      if (tying.length === 1) main = tying[0];
    }
    if (!main) continue;
    const ties = tiesTo(main, g.members, { statusOf });
    if (!ties.length) continue;

    // Firm only when the whole mail is accounted for: every other document it
    // filed is this invoice's backup, by the money.
    const others = g.members.filter((d) => d.id !== main.id && eligible(d));
    const all = others.length === ties.length && ties.every(moneyTied);
    const enough = ties.length >= 2 || ties.every((t) => t.reasons.includes('billedToSupplier'));
    const firm = g.via === 'mail' && named && all && enough;
    out.push({ mainId: main.id, supports: ties, confidence: firm ? 'firm' : 'possible', via: g.via });
  }
  return out;
}

// Why, in words, for the badge's tooltip and the panel.
export function reasonText(support) {
  const r = support?.reasons || [];
  const parts = [];
  if (r.includes('line')) parts.push(support.line ? `its total is the invoice's line "${support.line}"` : "its total is one of the invoice's lines");
  if (r.includes('sum') && !r.includes('line')) parts.push("together they add up to the invoice's amount");
  if (r.includes('billedToSupplier')) parts.push("it is made out to the invoice's supplier");
  if (r.includes('manual')) parts.push('marked by hand');
  return parts.join('; ');
}
