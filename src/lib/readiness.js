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
