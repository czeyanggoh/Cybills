// What state a cost document is in, decided from the document itself.
//
// Nothing here is stored. Readiness was already derived — the server re-derives
// it on every save — and "To review" now is too: it is the documents the reader
// could not finish, the ones where a human has to supply what the AI could not
// determine (most often the account code). It used to be a status that only a
// toolbar button could write, which meant a document needing attention showed up
// there only if somebody had already noticed it and pressed the button — exactly
// backwards.
//
// Pure, so `npm test` can hold the rules to account.

const has = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '—';
const named = (v, placeholder) => has(v) && String(v).trim().toLowerCase() !== placeholder;
const amount = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

// The fields a cost document needs before it's "ready" (moves out of the inbox).
// Surfaced in the UI so users know exactly why something is still in the inbox.
export const READY_FIELDS = ['Supplier', 'Date', 'Category', 'Total'];

// A cost is "complete" (→ Ready) when it carries those fields: a real supplier
// (not "Unknown supplier"), a date, a real category (not "Uncategorised"), and a
// total above 0. Mirrors the server's costComplete so both follow one rule.
export function isComplete(d) {
  return (
    named(d?.supplier, 'unknown supplier') &&
    has(d?.date) &&
    named(d?.category, 'uncategorised') &&
    amount(d?.total) > 0
  );
}

// The specific fields still missing on a document (for a per-row explanation).
export function missingFields(d) {
  const out = [];
  if (!named(d?.supplier, 'unknown supplier')) out.push('Supplier');
  if (!has(d?.date)) out.push('Date');
  if (!named(d?.category, 'uncategorised')) out.push('Category');
  if (!(amount(d?.total) > 0)) out.push('Total');
  return out;
}

// The inbox statuses: documents still being worked on. Anything else — archived,
// on an expense claim, merged away — is settled, and the automatic duplicate and
// merge scans leave it alone (you can still merge archived documents by hand).
// 'review' is here for the rows written while it was a status; nothing sets it
// any more.
export const INBOX_STATUSES = ['new', 'viewed', 'review', 'ready'];
export const isInInbox = (d) => INBOX_STATUSES.includes(d?.status);

// The two halves of the inbox, and they are halves: every document waiting on
// nobody is Ready, every other one is waiting on a person — the reader could
// not determine a field the document needs, so the answer has to come from a
// human. Both read the document rather than its stored status, so a legacy row
// (or one edited without the server re-deriving) can't fall between them.
export function isReady(d) {
  return isInInbox(d) && isComplete(d);
}
export function needsReview(d) {
  return isInInbox(d) && !isComplete(d);
}

// The settled statuses — everything that has left the inbox. These used to be a
// tab of their own ("Archive"); they are now the far half of one list.
export const ARCHIVE_STATUSES = ['expenseclaim', 'archived', 'merged'];
export const isArchived = (d) => ARCHIVE_STATUSES.includes(d?.status);

// A document still being read. Not in the inbox yet — the reader hasn't
// finished with it — but it IS work in flight, so it belongs to the Costs tab.
export const isProcessing = (d) => d?.status === 'processing';

// What the Costs tab holds: the work still in front of somebody. Processing, To
// review and Ready are its three tabs and this is exactly their sum, which is
// the point — an ARCHIVED document is settled, it has a tab of its own, and
// counting it here made the first badge say 15 while the three beside it added
// up to 8. Archived rows are reached through their own tab (and, with the
// published ones, through its "All costs" scope), never by sitting in the
// working list wearing a badge that says they are finished.
export const inCostsTab = (d) => isProcessing(d) || isInInbox(d);

// Every document the book holds that somebody could still act on — inbox and
// archive together. This is the ARCHIVED tab's "All costs" reach rather than
// the Costs tab's; the only thing left out is a document still being read.
export const inCostsList = (d) => isInInbox(d) || isArchived(d);

// Xero has this document's money. It is what takes a document out of the
// working list, and — because publishing is what archives one — it is also what
// tells a published archived document apart from one somebody archived by hand.
export const isPublished = (d) => Boolean(d?.xeroInvoiceId);

// A document somebody deliberately kept just in case: the duplicate invoice
// that turned up twice, the screenshot of a bank screen, the thing that is not
// a cost but is worth not throwing away. Archived BY HAND — it never reached
// Xero, so it is not history, and it is the one thing the Costs tab's "All
// costs" leaves out, because a filtered supplier search is looking for the real
// documents and the set-aside pile is where the near-misses were put.
export const isSetAside = (d) => d?.status === 'archived' && !isPublished(d);

// The Costs tab's "All costs": the whole book minus that pile. It exists for a
// question the working list cannot answer — "which month of this subscription
// is missing?" — which needs the PUBLISHED documents in the list to filter a
// supplier across. A claimed or merged-away document is in it too: both are
// real costs that happened, they simply reached the ledger by another road.
export const inCostsAll = (d) => inCostsTab(d) || (isArchived(d) && !isSetAside(d));

// The working half of that list: nothing has carried this document's figures
// into Xero yet, so somebody still has to.
//
// Publishing is what archives a document (markBillPosted), so this is NOT the
// old Inbox tab renamed — it also surfaces the documents that were archived by
// hand and never published, which is precisely what folding the two tabs
// together is for. A document sitting on an EXPENSE CLAIM is excluded because
// its route to the ledger is the claim's bill rather than its own, and one
// MERGED away is excluded because it no longer exists as a cost — the document
// it was folded into carries its money. Both are still there under "All costs".
export function isUnpublished(d) {
  if (!inCostsList(d)) return false;
  if (d?.xeroInvoiceId) return false;
  return d?.status !== 'expenseclaim' && d?.status !== 'merged';
}
