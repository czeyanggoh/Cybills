// A QUOTATION or PRO-FORMA INVOICE is paid before the tax invoice exists.
//
// A supplier asks for the money up front — "Windee quotation QUO-2609239, S$999,
// please pay to confirm" — and the real tax invoice follows weeks later, when
// the work is done. The quotation is not a bill: published as one, the same
// spending would go into the ledger twice, once now and once when the invoice
// arrives. What it IS, once paid, is money the supplier is holding for us, and
// Xero's word for that is an OVERPAYMENT to the supplier (a SPEND-OVERPAYMENT
// bank transaction, carried on the supplier's contact until it is used).
//
// So the type says three things about the document, and every road applies them
// from here:
//   - it carries NO TAX. A quotation is not a tax invoice, and no GST is claimed
//     on it; the overpayment goes up without tax, and the GST is claimed on the
//     tax invoice that follows. A code a person picked is left alone, as always;
//   - it is never PUBLISHED as a bill (postBillToXero in xero.ts refuses one) —
//     it is RECORDED AS A PREPAYMENT instead, from the bank account it was paid
//     out of, carrying its own number as the reference;
//   - and the invoice that follows USES IT UP: `prepaymentCandidates` says which
//     recorded prepayment an invoice draws on, and publishing the invoice
//     allocates the overpayment against the new bill in Xero.
//
// Pure, loaded server-side by path (server/src/prepayment.ts) the way
// paymentProof.js is, so the page's suggestion and the server's allocation
// cannot disagree. Tested by test/prepayment.test.mjs.

export const QUOTATION_TYPE = 'Quotation';
export const PROFORMA_TYPE = 'Pro-forma invoice';
export const ADVANCE_TYPES = [QUOTATION_TYPE, PROFORMA_TYPE];

const typeKey = (t) => String(t ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const ADVANCE_KEYS = new Set(['quotation', 'quote', 'pro forma invoice', 'proforma invoice', 'pro forma', 'proforma']);

/** Whether a document's type is one paid in ADVANCE of its tax invoice. */
export const isAdvanceDocument = (type) => ADVANCE_KEYS.has(typeKey(type));

export const ADVANCE_TAX_RATE = 'No Tax';
export const ADVANCE_TAX_REASON =
  'Quotation / pro-forma invoice — not a tax invoice, so no GST is claimed on it. Paid in advance, it goes to Xero as a prepayment to the supplier without tax; the GST is claimed on the tax invoice that follows.';

/**
 * What typing a document as a quotation or pro-forma says about it: the fields to
 * write over what it holds. `{}` for any other type, so a caller can apply it
 * blind. Nothing about Paid — a quotation may not have been paid yet, and
 * recording the prepayment is the act that says it was.
 */
export function advancePatch(doc, noTaxName = ADVANCE_TAX_RATE) {
  if (!isAdvanceDocument(doc?.type ?? doc?.documentType)) return {};
  if (doc?.taxRateEdited === true || doc?.taxRateCleared === true) return {};
  const name = String(noTaxName || '').trim() || ADVANCE_TAX_RATE;
  const patch = { tax: 0, baseTax: 0, taxRateReason: ADVANCE_TAX_REASON };
  if (String(doc?.taxRate || '') !== name) patch.taxRate = name;
  return patch;
}

const cents = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** What of a recorded prepayment is still unused, in cents (0 when none recorded). */
export function prepaymentRemainingCents(doc) {
  const p = doc?.prepayment;
  if (!p || !p.overpaymentId) return 0;
  const used = (Array.isArray(p.allocations) ? p.allocations : []).reduce((s, a) => s + cents(a?.amount), 0);
  return Math.max(0, cents(p.amount) - used);
}

// A document number compared as its letters and digits alone: "QUO-2609239",
// "QUO 2609239" and "quo2609239" are one reference.
const refKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The words that NAME a supplier — no legal form — joined, so "Windee Private
// Limited" and "WINDEE PTE. LTD." are one supplier.
const LEGAL = new Set(['pte', 'ltd', 'private', 'limited', 'llp', 'llc', 'inc', 'co', 'company', 'corp', 'corporation', 'sdn', 'bhd', 'the', 'plc', 'pty']);
const supplierKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');

export function sameSupplier(a, b) {
  const x = supplierKey(a);
  const y = supplierKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One name inside the other, anchored on the first word ("windee" and
  // "windee singapore"), and never on a scrap too short to mean anything.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && (long === short || long.startsWith(`${short} `));
}

// Everything on an invoice that could QUOTE the quotation it follows: its
// reference, description, note, the covering message and its rows.
function invoiceText(inv) {
  const rows = Array.isArray(inv?.lineItems) ? inv.lineItems.map((l) => l?.description) : [];
  const email = inv?.email && typeof inv.email === 'object' ? [inv.email.subject, inv.email.text, inv.email.note] : [];
  return [inv?.invoiceNumber, inv?.description, inv?.note, ...email, ...rows].filter(Boolean).join(' ');
}

/** Whether an invoice quotes this reference anywhere on it. */
export function invoiceQuotes(inv, reference) {
  const key = refKey(reference);
  if (key.length < 4) return false;
  // Its OWN number is not a quotation of anything.
  if (refKey(inv?.invoiceNumber) === key) return false;
  return refKey(invoiceText(inv)).includes(key);
}

const isoDay = (v) => {
  const s = String(v ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

// The kinds of document a prepayment can be used up by: an invoice, and the
// ordinary blank / Other / Receipt a reader sometimes gives one. Never another
// quotation, a payment proof, a credit note, a statement or a mileage record.
function drawsOnPrepayment(inv) {
  const t = typeKey(inv?.type ?? inv?.documentType);
  return t === '' || t === 'invoice' || t === 'receipt' || t === 'other' || t === 'document';
}

/**
 * The recorded prepayments an invoice could use, best first:
 *   { doc, reference, remainingCents, amountCents, tie: 'reference' | 'supplier', firm }
 *
 * Tied by the invoice QUOTING the quotation's number (anywhere on it), or by
 * being from the same supplier. FIRM — applied by itself on publish — is a
 * quoted number, or the supplier's ONLY open prepayment with the invoice dated
 * on or after it was paid. Everything else is offered to a person. Same
 * currency only: a prepayment is money in one currency, and converting it is
 * a guess nobody asked for.
 */
export function prepaymentCandidates(invoice, docs) {
  if (!invoice || !drawsOnPrepayment(invoice)) return [];
  const invCents = cents(invoice.total);
  if (invCents <= 0) return [];
  const currency = String(invoice.currency || '').toUpperCase();
  const open = (Array.isArray(docs) ? docs : []).filter(
    (d) =>
      d &&
      d.id !== invoice.id &&
      String(d.status || '') !== 'deleted' &&
      prepaymentRemainingCents(d) > 0 &&
      (!currency || !d.prepayment.currency || String(d.prepayment.currency).toUpperCase() === currency)
  );
  const invDay = isoDay(invoice.date);
  const out = [];
  for (const d of open) {
    const reference = String(d.prepayment.reference || d.invoiceNumber || '');
    const quoted = invoiceQuotes(invoice, reference);
    const supplier = sameSupplier(invoice.supplier, d.supplier);
    if (!quoted && !supplier) continue;
    const remaining = prepaymentRemainingCents(d);
    const paidDay = isoDay(d.prepayment.date);
    const sameSupplierOpen = open.filter((o) => sameSupplier(o.supplier, d.supplier)).length;
    const firm = quoted || (supplier && sameSupplierOpen === 1 && (!invDay || !paidDay || invDay >= paidDay));
    out.push({
      doc: d,
      reference,
      remainingCents: remaining,
      amountCents: Math.min(remaining, invCents),
      tie: quoted ? 'reference' : 'supplier',
      firm,
    });
  }
  return out.sort((a, b) => Number(b.firm) - Number(a.firm) || Number(b.tie === 'reference') - Number(a.tie === 'reference'));
}

/** The one prepayment an invoice uses up by itself, or null — two firm answers are a choice, and a choice is a person's. */
export function firmPrepayment(invoice, docs) {
  const firm = prepaymentCandidates(invoice, docs).filter((c) => c.firm);
  return firm.length === 1 ? firm[0] : null;
}
