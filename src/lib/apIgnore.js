// "Ignore future mail like this", worked out from the mail a document came in.
//
// The rule is kept in CYWorkspace, on the AP Mailbox that forwarded the mail,
// so the next one is never forwarded at all (no document here, no model read):
// `POST /api/email/documents/:billId/ignore-sender` -> CYWS
// `/api/webhooks/cybills/ap-mailbox/ignore`. What CYBills supplies is the
// starting point for the rule, which is all this module is (pure, `npm test`).
//
// The SENDER is the awkward half. The mail CYBills received was written by the
// AP Mailbox, so its From is the mailbox that forwarded it; the supplier is only
// in the covering lines CYWS puts above the original ("Original sender:
// Airwallex <support@info.airwallex.com>"). CYWS matches its rules against the
// ORIGINAL From, so that line is what is read, and the From only where there is
// no such line.

const ADDRESS = /[a-z0-9._%+'-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/i;

/** Whether the mail is one the CYWS AP Mailbox forwarded (its covering line). */
export function isApMailboxForward(text) {
  return /forwarded automatically from\s+\S+@\S+\s+for\s+/i.test(String(text || ''));
}

/** The original sender's address, lowercased, or ''. */
export function originalSenderOf(text, from) {
  const line = String(text || '').match(/original sender:\s*([^\n]+)/i);
  const fromLine = line && line[1].match(ADDRESS);
  if (fromLine) return fromLine[0].toLowerCase();
  const own = String(from || '').match(ADDRESS);
  return own ? own[0].toLowerCase() : '';
}

/**
 * The subject words a rule starts from: Fwd:/Re: taken off, and the numbers,
 * amounts and dates removed (they change from one statement to the next), cut
 * to a short phrase. The same reduction CYWS's own "Ignore similar" makes.
 * '' when fewer than two words are left — one word is too wide to match on.
 */
export function ignoreSubjectFor(subject) {
  const words = String(subject || '')
    .replace(/^\s*((re|fw|fwd)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\[item #[^\]]*\]/gi, ' ')
    // A word with a digit in it is an invoice number, a date or an amount.
    .split(/\s+/)
    .filter((w) => !/\d/.test(w))
    .join(' ')
    .replace(/\b(usd|sgd|aud|eur|gbp|myr|hkd|jpy|cny|inr)\b/gi, ' ')
    .replace(/[^\p{L}\s'&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6);
  return words.length >= 2 ? words.join(' ') : '';
}
