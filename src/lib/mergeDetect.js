// Merge detection: finding the documents in the inbox that are really ONE
// document, so the reviewer is told rather than having to notice.
//
// Two things get captured as separate uploads and both need combining, but they
// are NOT the same shape and one rule cannot find both:
//
//   1. A payment captured twice — the merchant's itemised receipt AND the card
//      slip for it. Same total, DIFFERENT suppliers (merchant vs card issuer).
//   2. Pages of one document — page 1 (the header: supplier, invoice number,
//      date) and page 2 (the body: line items, totals), e.g. a forwarded order
//      confirmation screenshotted in two halves. SAME supplier, and the two
//      halves carry DIFFERENT facts: each has something the other lacks.
//
// The second was the gap: the old scan grouped on total and threw away every
// same-supplier group as "duplicates", which is exactly what a two-page document
// looks like. The difference between "pages of one document" and "the same
// document uploaded twice" is COMPLEMENTARITY — pages fill each other's blanks;
// a re-upload repeats them. So a pair is a page pair when
//
//   * their suppliers are compatible (equal, or one of them is blank),
//   * nothing they BOTH state contradicts (total, reference, date, card),
//   * at least one substantive field is present on exactly one side, and
//   * something positively ties them together (a shared reference, a shared
//     total, or the same supplier uploaded in one go).
//
// The last condition is what stops two unrelated half-read documents pairing up
// just because they are both incomplete.

// Two uploads this far apart are not one trip to the scanner. Used as the
// "arrived together" signal — the closest thing to "came from the same email"
// that a document actually carries.
const BATCH_WINDOW_MS = 30 * 60 * 1000;

const norm = (s) => String(s ?? '').trim().toLowerCase();

// An amount that the document actually STATES, or null. A dash, a blank or a
// zero is the reader having nothing to say — treating it as 0 is what made a
// blank page look like it "disagreed" with its own other half.
function amount(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const money = (n) => (n == null ? '' : n.toFixed(2));

// The comparable facts of one document row, with "absent" told apart from "zero"
// and from "unknown". Everything below reads facts, never raw docs.
export function docFacts(d) {
  const supplier = norm(d?.supplier);
  return {
    id: d?.id,
    supplier: supplier && supplier !== 'unknown supplier' ? supplier : '',
    total: amount(d?.total),
    tax: amount(d?.tax),
    date: d?.date && d.date !== '—' ? String(d.date) : '',
    ref: norm(d?.invoiceNumber),
    lines: Array.isArray(d?.lineItems) ? d.lineItems.length : 0,
    card: (String(d?.cardLast4 ?? '').match(/\d{4}/) || [''])[0],
    by: norm(d?.createdByEmail),
    at: Date.parse(d?.createdAt || '') || 0,
  };
}

// Facts they BOTH state must agree. One side saying nothing is not disagreement.
function contradicts(a, b) {
  if (a.total != null && b.total != null && money(a.total) !== money(b.total)) return true;
  if (a.ref && b.ref && a.ref !== b.ref) return true;
  if (a.date && b.date && a.date !== b.date) return true;
  if (a.card && b.card && a.card !== b.card) return true;
  return false;
}

// The fields that separate a page from a copy. A page 1 has the reference and
// the date; a page 2 has the line items. A re-upload of one document has the
// same answer to every one of these.
const PRESENT = [
  (f) => f.total != null,
  (f) => Boolean(f.date),
  (f) => Boolean(f.ref),
  (f) => f.lines > 0,
  (f) => f.tax != null,
];

// Do these two fill in each other's blanks?
export function complementary(a, b) {
  return PRESENT.some((has) => has(a) !== has(b));
}

function arrivedTogether(a, b) {
  if (!a.by || a.by !== b.by) return false;
  if (!a.at || !b.at) return false;
  return Math.abs(a.at - b.at) <= BATCH_WINDOW_MS;
}

// Positive evidence that these two are the same piece of paper — required, so
// that "both half-read" is never on its own a reason to pair them.
function tie(a, b) {
  if (a.ref && a.ref === b.ref) return 'the same reference';
  if (a.total != null && b.total != null && money(a.total) === money(b.total)) return 'the same total';
  if (a.supplier && a.supplier === b.supplier && arrivedTogether(a, b)) return 'the same supplier, uploaded together';
  return '';
}

// The verdict on one pair of facts: 'payment' (a receipt and its card slip),
// 'pages' (two halves of one document), or null. The two are mutually exclusive
// by construction — 'payment' needs two different suppliers, 'pages' needs
// compatible ones.
export function pairMatch(a, b) {
  if (
    a.total != null && b.total != null && money(a.total) === money(b.total) &&
    a.supplier && b.supplier && a.supplier !== b.supplier &&
    !(a.card && b.card && a.card !== b.card)
  ) {
    return { kind: 'payment', why: 'the same total from two different documents' };
  }
  const compatibleSupplier = !a.supplier || !b.supplier || a.supplier === b.supplier;
  if (compatibleSupplier && !contradicts(a, b) && complementary(a, b)) {
    const why = tie(a, b);
    if (why) return { kind: 'pages', why };
  }
  return null;
}

// Every set of inbox documents worth combining. Returns [{ docs, kind, why }].
//
// The two rules are found in two passes, because they chain differently. Pages
// chain: a three-page document is one group of three, so page-pair edges are
// unioned. A payment pair does NOT chain — it is exactly one receipt and the one
// slip that paid for it, and letting it chain would rope every document sharing
// a total into a single group. So a payment pair is only offered when the two
// documents are each other's ONLY candidate; three documents at the same total
// is an ambiguity to leave to the reviewer, not a guess to make. A multi-page
// document plus its card slip is likewise left as two steps: merge the pages,
// then merge that with the slip — each one reviewed on its own.
export function findMergeCandidates(docs) {
  const pool = (docs || []).filter((d) => d && d.persisted && d.hasFile && d.status !== 'merged');
  const facts = pool.map(docFacts);

  // Pass 1 — pages of one document, chained.
  const parent = pool.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const why = new Map(); // group root -> why its first edge tied it
  const payments = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const m = pairMatch(facts[i], facts[j]);
      if (!m) continue;
      if (m.kind === 'payment') {
        payments.push({ i, j, why: m.why });
        continue;
      }
      if (!why.has(i)) why.set(i, m.why);
      parent[root(i)] = root(j);
    }
  }
  const pageGroups = new Map();
  pool.forEach((d, i) => {
    const r = root(i);
    if (!pageGroups.has(r)) pageGroups.set(r, []);
    pageGroups.get(r).push({ d, i });
  });
  const groups = [];
  const claimed = new Set();
  for (const members of pageGroups.values()) {
    if (members.length < 2) continue;
    members.forEach((m) => claimed.add(m.i));
    groups.push({
      docs: orderForMerge(members.map((m) => m.d), 'pages'),
      kind: 'pages',
      why: members.map((m) => why.get(m.i)).find(Boolean) || 'the same document',
    });
  }

  // Pass 2 — a receipt and its card slip, only where the pairing is unambiguous.
  const counterparts = new Map(); // index -> Set of indexes it could pair with
  const add = (a, b) => {
    if (!counterparts.has(a)) counterparts.set(a, new Set());
    counterparts.get(a).add(b);
  };
  payments.filter((p) => !claimed.has(p.i) && !claimed.has(p.j)).forEach((p) => { add(p.i, p.j); add(p.j, p.i); });
  const seen = new Set();
  for (const p of payments) {
    if (claimed.has(p.i) || claimed.has(p.j) || seen.has(p.i) || seen.has(p.j)) continue;
    if (counterparts.get(p.i)?.size !== 1 || counterparts.get(p.j)?.size !== 1) continue;
    seen.add(p.i);
    seen.add(p.j);
    groups.push({ docs: orderForMerge([pool[p.i], pool[p.j]], 'payment'), kind: 'payment', why: p.why });
  }

  return groups.sort(
    (a, b) => b.docs.length - a.docs.length || String(a.docs[0].id).localeCompare(String(b.docs[0].id)),
  );
}

// What a SET of documents looks like, for callers holding a hand-picked
// selection rather than a scan result: 'payment' | 'pages' | 'unknown'.
export function mergeKind(docs) {
  const facts = (docs || []).map(docFacts);
  let payment = false;
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const m = pairMatch(facts[i], facts[j]);
      if (m?.kind === 'pages') return 'pages';
      if (m?.kind === 'payment') payment = true;
    }
  }
  return payment ? 'payment' : 'unknown';
}

// Same supplier, same amount, and no pair fills in the other's blanks — that is
// one document uploaded twice, which is a duplicate to resolve, not a merge.
// (The same amount from DIFFERENT suppliers is the receipt + card slip case, and
// two halves of one document are a merge, so neither counts here.)
export function looksLikeDuplicates(docs) {
  const facts = (docs || []).map(docFacts);
  if (facts.length < 2) return false;
  if (new Set(facts.map((f) => money(f.total))).size !== 1) return false;
  if (new Set(facts.map((f) => f.supplier)).size !== 1) return false;
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      if (complementary(facts[i], facts[j])) return false;
    }
  }
  return true;
}

// Page order for the combined PDF: the half carrying the document's identity
// (reference, then date, then a named supplier) goes first, the continuation
// after it; upload order breaks ties. A card slip has none of those, so it lands
// behind the receipt it paid for.
function headerScore(f) {
  return (f.ref ? 4 : 0) + (f.date ? 2 : 0) + (f.supplier ? 1 : 0);
}

// Order for the itemised-document-first case: the half that carries line items /
// tax / an "Invoice" type leads, so the merged document takes the MERCHANT's
// identity rather than the card issuer's.
function invoiceScore(d) {
  const f = docFacts(d);
  const type = String(d?.type || d?.documentType || '').toLowerCase();
  return (f.lines > 0 ? 4 : 0) + (f.tax != null ? 2 : 0) + (type === 'invoice' ? 1 : 0);
}

export function orderForMerge(docs, kind) {
  const list = [...(docs || [])];
  if (kind === 'payment') return list.sort((a, b) => invoiceScore(b) - invoiceScore(a));
  return list.sort((a, b) => {
    const fa = docFacts(a);
    const fb = docFacts(b);
    return headerScore(fb) - headerScore(fa) || fa.at - fb.at;
  });
}
