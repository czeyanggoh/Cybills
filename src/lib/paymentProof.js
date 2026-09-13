// A payment proof is evidence that money was SENT, not a bill for it.
//
// A bank transfer confirmation, a PayNow / PayLah / GIRO screenshot, an
// internet-banking "transfer successful" page, a card-payment notification —
// what somebody hands in when the supplier's invoice went to somebody else, or
// never came, and all they have is the proof that they paid. The Type dropdown
// had nowhere to put it: typed as a Receipt it arrived Not paid by default,
// waiting on a payment that had already happened, and its tax was whatever the
// reader made of a page that states none.
//
// So the type says two things about the document, and both are applied on every
// road it arrives by (the upload, the page's own Type field, an emailed or
// WhatsApp'd document's background read) so the page and the store agree:
//   - it is PAID — that is what the paper proves. `defaultPaidFor` says so
//     whatever the entity's Paid-by-default settings say for receipts and
//     invoices, since those are about documents that MAY have been paid;
//   - it carries NO TAX. A transfer states no tax; the GST, if any, is on the
//     invoice it pays, and that is where it is claimed. A code a person picked
//     by hand is left alone, the way it is everywhere else.
//
// The payee is the supplier, the amount transferred is the total, and the
// transaction reference is the document number — the reader is told so
// (server/src/extract.ts). It is still a cost document like any other: if the
// invoice it pays is ALSO in the book, the duplicate check and merge detection
// ("a payment papered twice") are what pair the two.
//
// Pure, loaded server-side by path (server/src/paymentProof.ts) the way
// mileage.js is. Tested by test/payment-proof.test.mjs.

export const PAYMENT_PROOF_TYPE = 'Payment proof';

// Whether a document's type is the payment proof one, however spelt or cased.
export const isPaymentProof = (type) =>
  String(type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ') === 'payment proof';

export const PAYMENT_PROOF_TAX_RATE = 'No Tax';
export const PAYMENT_PROOF_TAX_REASON =
  'Payment proof — a transfer or payment confirmation states no tax. Any GST is on the invoice it pays and is claimed there, not here.';

/**
 * What typing a document as a payment proof says about it: the fields to write
 * over what it holds. `{}` for any other type, so a caller can apply it blind.
 *
 * Paid is always set. The tax half is skipped where a person has picked a code
 * or cleared one on purpose (`taxRateEdited` / `taxRateCleared`) — they may know
 * the transfer settled a GST invoice and want it coded so — and otherwise the
 * document goes to No Tax (under the entity's own name for it) with its reason,
 * and no tax amount in either currency. The total never moves.
 */
export function paymentProofPatch(doc, noTaxName = PAYMENT_PROOF_TAX_RATE) {
  if (!isPaymentProof(doc?.type ?? doc?.documentType)) return {};
  const patch = { paid: true };
  if (doc?.taxRateEdited === true || doc?.taxRateCleared === true) return patch;
  const name = String(noTaxName || '').trim() || PAYMENT_PROOF_TAX_RATE;
  patch.tax = 0;
  patch.baseTax = 0;
  if (String(doc?.taxRate || '') !== name) patch.taxRate = name;
  patch.taxRateReason = PAYMENT_PROOF_TAX_REASON;
  return patch;
}
