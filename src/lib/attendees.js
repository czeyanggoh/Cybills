// Who was at the table.
//
// A restaurant bill states what was spent and says nothing about the one thing
// an accountant asks of it afterwards: who it was for. "Din Tai Fung —
// Entertainment" is an amount with no business purpose attached, and a year
// later nobody can tell a staff lunch from client entertainment, or say what
// the meeting was about. IRAS asks the same question of an entertainment
// expense, and the answer is expected to have been written down at the time —
// which is here, on the document, not remembered at year end.
//
// So on the categories where the people ARE half the record — a meal, a round
// of coffees, entertainment, a meeting — the description has to say who was
// present. It comes off the paper (a named booking, a function sheet, "4 pax")
// or out of the covering message the sender wrote with it ("lunch with Dean and
// two of the ARC3 team"), and where neither says, the description says THAT:
// a meal whose guests were never recorded is an incomplete record, and a line
// that admits it is what sends a reviewer to fill it in. Never guessed — an
// invented guest list is worse than none, because it reads as evidence.
//
// Pure, and shared by both halves of the read: the reader's prompt
// (server/src/extract.ts) names the entity's own categories this applies to and
// asks for `attendees`, and `withAttendees` is what puts the answer on the
// description — so the question asked and the answer recorded cannot drift.
// The re-read applies it again once a supplier rule has had its say on the
// category, which is why it is idempotent.

// The words that make a category one about people rather than about things.
// Matched as whole words against the label, so "Retreat" is not "eat" and the
// account code in front of a Xero label ("420 - Entertainment") matches
// nothing. Deliberately the vocabulary a chart of accounts and a claim policy
// actually use, rather than anything that could be eaten: a pantry restock and
// a coffee machine are supplies, and nobody was entertained.
const PEOPLE_WORDS = new Set([
  'meal', 'meals', 'food', 'dining', 'restaurant', 'restaurants',
  'catering', 'caterer', 'refreshment', 'refreshments',
  'entertainment', 'entertaining', 'entertainments', 'hospitality',
  'beverage', 'beverages', 'drinks',
  'breakfast', 'lunch', 'lunches', 'dinner', 'dinners', 'supper', 'banquet',
  'meeting', 'meetings', 'welfare',
]);

const words = (label) =>
  String(label ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Is this a category where the description has to name who was there? */
export function isAttendeeCategory(label) {
  return words(label).some((w) => PEOPLE_WORDS.has(w));
}

/** The ones among an entity's own categories — what the reader's prompt names. */
export function attendeeCategories(labels) {
  return (Array.isArray(labels) ? labels : []).filter((l) => isAttendeeCategory(l));
}

// What the description says when nobody was recorded. A marker rather than a
// silence, because a blank there is indistinguishable from a meal that simply
// had no guests worth naming — and this is the sentence that sends somebody to
// type them in.
export const NO_ATTENDEES = 'attendees not stated';
const SUFFIX = / — attendees(?::.*| not stated)$/;

const loose = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Put who was there onto a description, for the categories that call for it.
 *
 * Appended rather than asked for inline (the same arrangement `withPeriod` has
 * server-side): a reader told to work the names into its own sentence folds
 * them in twice as often as not, and there would be nothing to check.
 * Idempotent — a description that already carries the suffix keeps the one it
 * has — so the re-read may apply it again after a supplier rule has changed the
 * category. Where the category is NOT one about people, the bare "not stated"
 * marker is taken back off: it was written for a meal, and this is no longer
 * one. Names already found are left, since they are still true of the document.
 */
export function withAttendees(description, attendees, category) {
  const text = String(description ?? '').trim();
  if (!text) return text;
  if (!isAttendeeCategory(category)) {
    return text.replace(new RegExp(` — ${NO_ATTENDEES}$`), '').trim();
  }
  if (SUFFIX.test(text)) return text;
  const who = String(attendees ?? '').trim().slice(0, 160);
  if (!who) return `${text} — ${NO_ATTENDEES}`;
  // The reader said it in its own sentence as well — one telling is enough.
  if (loose(text).includes(loose(who))) return text;
  return `${text} — attendees: ${who}`;
}
