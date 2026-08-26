// How a published bill's Xero status is worded in CYBills.
//
// Pure, and shared by the Costs list, the document page and anything else that
// shows it, so the same ledger state can't be described two ways in one app.
//
// The distinction this exists to keep is between the DOCUMENT's Paid toggle and
// the LEDGER's answer. The toggle is Dext's: the reviewer saying "this was
// already settled when it was captured, publish it as paid", set per document
// type in Extraction settings and by supplier rules. What's below is what Xero
// reports about the bill after it was published — read back on its invoice
// webhook, never edited here. A document can legitimately show an unticked Paid
// toggle and a Paid status, or the reverse; neither is wrong, they answer
// different questions.

// Xero's statuses, in Xero's own words, mapped to what a reviewer reads.
// 'AWAITING' rather than 'UNPAID' for the middle group: an approved bill that
// nobody has paid yet is not the same news as a bill that was voided, and
// flattening both to "Unpaid" hides that.
const WORDING = {
  PAID: { label: 'Paid', tone: 'paid' },
  AUTHORISED: { label: 'Awaiting payment', tone: 'awaiting' },
  SUBMITTED: { label: 'Awaiting approval', tone: 'awaiting' },
  DRAFT: { label: 'Draft in Xero', tone: 'awaiting' },
  VOIDED: { label: 'Voided in Xero', tone: 'void' },
  DELETED: { label: 'Deleted in Xero', tone: 'void' },
};

// `{ label, tone }` for a document, or null when there is nothing to say —
// which is most documents most of the time: one that was never published, or
// one published but not yet touched in Xero, so no webhook has fired for it.
// Null rather than a cheerful "Unknown": a column that claims a status for a
// bill nobody has asked Xero about would be inventing one.
export function xeroPaidStatus(doc) {
  const status = String(doc?.xeroStatus || '').trim().toUpperCase();
  if (!status) return null;
  return WORDING[status] || { label: status.charAt(0) + status.slice(1).toLowerCase(), tone: 'awaiting' };
}

// Whether Xero says this bill is settled. For a filter or a count — anything
// that needs the boolean the wording deliberately doesn't reduce to.
export function isPaidInXero(doc) {
  return String(doc?.xeroStatus || '').trim().toUpperCase() === 'PAID';
}
