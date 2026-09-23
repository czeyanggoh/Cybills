// The daily digest: which documents a colleague is told about each morning.
//
// A colleague looks after a handful of clients, and the paperwork those clients
// send in arrives by four roads — an upload, an email, a WhatsApp group, a Dext
// import — into books they only open when somebody asks. So once a day CYBills
// emails them what is still sitting there waiting to be paid, the way Dext's
// "Unprocessed items requiring payment" does, narrowed to the people they are
// responsible for: "only what finance@dart.com.sg sent in", not the whole book.
//
// Pure, so `npm test` holds the rules to account; loaded by path server-side
// (server/src/digest.ts) the way mileage.js is, so the dialog and the email
// cannot disagree about what "sent in by" means.

import { inCostsTab, isCreditNote, isSale } from './readiness.js';
import { isPaymentProof } from './paymentProof.js';

// An address as it is compared: lowercased, and taken out of "Name <x@y>".
export function digestAddress(value) {
  const s = String(value ?? '').trim().toLowerCase();
  const angled = /<([^>]+)>/.exec(s);
  return (angled ? angled[1] : s).trim();
}

// Every address a document can be said to be "under": who OWNS it (the Costs
// User column), who UPLOADED it, and who EMAILED it in. The last matters most
// for a client's shared finance mailbox — mail from finance@dart.com.sg to the
// entity's own address files under the General account, so its owner never
// names the person who actually sent it.
export function docAddresses(d) {
  return [d?.owner, d?.createdBy, d?.email?.from]
    .map(digestAddress)
    .filter((a) => a.includes('@'));
}

// Whether a document is still somebody's work AND money still has to leave for
// it. Only a cost: a sales invoice is money coming IN. Not a credit note (owed
// to us), not a payment proof (it IS the payment), and not a document already
// marked paid — a receipt paid at the till needs coding, not paying.
// `unpaidOnly: false` widens it to everything still in the Costs tab.
export function inDigest(d, { unpaidOnly = true } = {}) {
  if (!d || isSale(d)) return false;
  if (!inCostsTab(d)) return false;
  if (isCreditNote(d) || isPaymentProof(d.documentType)) return false;
  if (unpaidOnly && d.paid) return false;
  return true;
}

// The rows for one client entity. `addresses` empty means everybody in it; a
// list keeps only documents under one of those addresses. `since` (an ISO
// instant) marks what arrived after the last digest as new. Oldest first —
// the one that has waited longest is the one most likely to be overdue.
export function digestRows(docs, { addresses = [], unpaidOnly = true, since = '' } = {}) {
  const wanted = new Set((addresses || []).map(digestAddress).filter(Boolean));
  return (docs || [])
    .filter((d) => inDigest(d, { unpaidOnly }))
    .filter((d) => !wanted.size || docAddresses(d).some((a) => wanted.has(a)))
    .map((d) => ({ doc: d, isNew: Boolean(since) && String(d.createdAt || '') > since }))
    .sort((a, b) =>
      String(a.doc.date || a.doc.createdAt || '').localeCompare(String(b.doc.date || b.doc.createdAt || ''))
    );
}

// The hours a digest may be sent at, in the practice's own timezone.
export const DIGEST_HOURS = Array.from({ length: 15 }, (_, i) => i + 6); // 06:00 – 20:00
export const DEFAULT_DIGEST_HOUR = 8;

export const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

// Whether a digest is due: switched on, not yet sent today, and today's hour
// reached. Measured by DAY rather than by 24 hours, so a server restart or a
// slow tick can never send twice in one day, and one that was down at 08:00
// catches up when it comes back rather than skipping the day.
export function digestDue(digest, today, hourNow) {
  if (!digest?.enabled) return false;
  if (digest.lastSentDay === today) return false;
  const hour = Number.isInteger(digest.hour) ? digest.hour : DEFAULT_DIGEST_HOUR;
  return hourNow >= hour;
}
