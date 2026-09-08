// The star a read puts in front of its own description.
//
// A cost's description is written by two hands: the reader's, on the way in,
// and a person's, when they correct it. In the ledger, in an export and in the
// Costs list those look identical — so "* Lunch at Din Tai Fung — attendees not
// stated" says at a glance which of the two wrote this one, and a description
// somebody has since rewritten stops saying it the moment they drop the star.
//
// Only what a READ writes carries it. A person typing in a description is not
// asked to type a star, nothing re-adds one to what they saved, and a document
// read before this existed is left as it is rather than swept — a mass edit
// across a book of published paperwork to add punctuation is not worth the
// history it would write.
const STAR = '*';

/**
 * Put the read's star in front of a description.
 *
 * Idempotent, because the same description is composed again on every re-read
 * and the star must not stack up. A blank stays blank: a lone star describes
 * nothing, and a read that got nothing back is a document the inbox has its own
 * word for.
 */
export function starDescription(description) {
  const text = String(description ?? '').trim();
  if (!text) return text;
  return text.startsWith(STAR) ? text : `${STAR} ${text}`;
}
