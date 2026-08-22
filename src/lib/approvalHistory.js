// What belongs on a claim's APPROVAL HISTORY page.
//
// A claim carries ONE activity log — created, items added, bulk edits, end date
// changed, submitted, approved, rejected, emailed, sent to HR, published. That
// log is the right thing to show on the claim's own History tab, and the wrong
// thing to print under a heading that says "approval history": five lines of
// "Item 260822144031 was added to the expense claim" tell an approver nothing
// about the approval, and bury the two lines that do.
//
// So this decides what an approval event IS, in one tested place, rather than
// each surface guessing. Two groups survive:
//
//   - the approval itself — submitted, approved, rejected, re-submitted
//   - what happened to the claim BECAUSE it was approved — emailed for
//     approval, sent to HR for payment, published to Xero. These are the
//     disposition of the decision and belong on a signed document; without them
//     the page can't answer "and then what happened to the money?"
//
// Everything else is editing, and editing is not approval.
//
// Matching is on the event TEXT because that is all a stored event has — the
// log predates any typed `kind`, and a claim filed months ago must still print
// correctly. The phrases are the ones written in server/src/claims.ts; a new
// one that matches neither list is treated as editing (left off), which is the
// safe direction for a document someone signs.
const APPROVAL = [
  /\bsubmitted for approval\b/i,
  /\bwas approved\b/i,
  /\bwas rejected\b/i,
  /\bapproval was (?:requested|cancelled|withdrawn)\b/i,
];

const DISPOSITION = [
  /\bwas emailed to\b/i,
  /\bsent to (?:cyhr|hr)\b/i,
  /\bpublished to\b/i,
  /\bposted to\b/i,
];

// True when this event is part of the approval trail rather than claim editing.
export function isApprovalEvent(event) {
  const text = String(event?.text ?? event ?? '');
  return [...APPROVAL, ...DISPOSITION].some((re) => re.test(text));
}

// The approval trail, in the order it was given. Returns [] when a claim has
// never been submitted — the caller says so in words rather than printing an
// empty page, which reads as a bug.
export function approvalHistory(events) {
  return (Array.isArray(events) ? events : []).filter(isApprovalEvent);
}
