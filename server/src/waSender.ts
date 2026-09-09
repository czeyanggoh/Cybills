// Who sent a WhatsApp message, said in a name and a number.
//
// WhatsApp increasingly identifies a sender by a LID ('127676509610071@lid') —
// an opaque per-user id it hands out so a group does not leak everyone's number
// — and it happens to be fifteen digits, which is exactly the length of a long
// international number. Printed where a sender belongs it read as a phone
// number that belongs to nobody, and matched against the roster it found no
// one. Nothing here can turn a LID back into a number by itself: that mapping
// is WhatsApp's, and what CYBills has learned of it is in waLids.ts.
//
// What CYBills DOES hold is the roster, and the question that matters is who
// ACTUALLY pressed send — "Pls pay." under a receipt is an approval, and an
// approval needs a name on it. So the actual sender comes first wherever one
// can be identified: the number WhatsApp sent, or the number/person a LID has
// been learned to be, matched to a roster row. Only when nothing identifies
// them does the group's own person stand in — a group opened for one person is
// usually that person — and the answer says so (`confirmed: false`), which is
// what puts the "Sent by" picker on the document.
//
// A leaf: the document listing reads it too, and must not import the router.
import { canAccessOrg, ensure as ensureUsers, type User } from './users.js';
import type { WaChannel } from './waChannels.js';
import { lidFor, type LidRow } from './waLids.js';

// --- Phone numbers -----------------------------------------------------------
// CYWS wants bare international format: digits only, no '+', no spaces, dashes
// or brackets, 8-15 digits. People type all of those, and a number that arrives
// malformed doesn't fail loudly — WhatsApp just doesn't add anybody — so it is
// normalised and checked HERE, before a group is created around it.
//
// Returns '' for anything that can't be a number CYWS will accept. A leading 0
// is refused rather than repaired: no country code begins with one, so "0123
// 456 789" is somebody's national format and we cannot know which country to
// prepend. Guessing that would add a stranger in another country to a group
// holding a client's bills.
export function normaliseMobile(raw: string): string {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  // '00' is the other way of writing '+' — international access, not part of
  // the number.
  const bare = digits.startsWith('00') ? digits.slice(2) : digits;
  if (bare.startsWith('0')) return '';
  if (bare.length < 8 || bare.length > 15) return '';
  return bare;
}

// The same normalisation applied to WhatsApp's own sender id ('60123@c.us'), so
// a sender can be matched against a roster row's Mobile field.
//
// '@lid' is NOT one of those. Stripping the domain off a LID produced a
// plausible number that belongs to nobody: matched against the roster it found
// no one, and printed to a person it read as their colleague's mobile. It is
// refused here rather than at each call site, because it is never a number
// anywhere.
export const mobileOf = (waId: string) => {
  const raw = String(waId ?? '');
  if (/@lid$/i.test(raw)) return '';
  return normaliseMobile(raw.split('@')[0]);
};

export type SenderIdentity = {
  /** The roster's name for the actual sender; else the push name WhatsApp
   * sent; else the group's own person. '' when there is nobody to name. */
  name: string;
  /** '+60123456789' — sent by WhatsApp, learned for the LID, or the roster's. */
  number: string;
  /** What WhatsApp put in the sender field, as-is, so a message can always be
   * traced back even when all it gave us was an opaque id. */
  id: string;
  /** The roster row of the ACTUAL sender, when one was identified. */
  userId: string;
  email: string;
  /** false when the name is the group's person standing in, or a bare push
   * name — somebody, but not somebody the roster can vouch for. */
  confirmed: boolean;
};

const live = (u: User) => !u.removed && !u.deactivated;
const plus = (mobile: string) => {
  const n = normaliseMobile(mobile);
  return n ? `+${n}` : '';
};

type Lookup = (lid: string) => LidRow | null;

// The roster row of the person who actually sent it: the row a learned LID
// names outright, else the row whose Mobile is the number — WhatsApp's own, or
// the one learned for the LID. Always within the entity: a mapping learned in
// one client's group must not name somebody the sender's entity cannot see.
function actualSender(
  users: User[],
  channel: Pick<WaChannel, 'orgId'>,
  sender: string,
  lookup: Lookup,
): { row: User | null; number: string } {
  const learned = /@lid$/i.test(sender) ? lookup(sender) : null;
  const inOrg = (u: User) => live(u) && canAccessOrg(u, channel.orgId);
  if (learned?.userId) {
    const row = users.find((u) => u.id === learned.userId && inOrg(u)) ?? null;
    if (row) return { row, number: learned.number || normaliseMobile(row.mobile || '') };
  }
  const number = mobileOf(sender) || learned?.number || '';
  if (!number) return { row: null, number: '' };
  return { row: users.find((u) => inOrg(u) && normaliseMobile(u.mobile) === number) ?? null, number };
}

export function senderIdentity(
  ws: string,
  channel: Pick<WaChannel, 'userId' | 'orgId'>,
  sender: string,
  senderName: string,
  lookup: Lookup = lidFor,
): SenderIdentity {
  const id = String(sender ?? '');
  const users = ensureUsers(ws);
  const pushName = String(senderName ?? '').trim();
  const actual = actualSender(users, channel, id, lookup);
  if (actual.row) {
    return {
      name: actual.row.name || actual.row.email || pushName,
      number: actual.number ? `+${actual.number}` : plus(actual.row.mobile || ''),
      id,
      userId: actual.row.id,
      email: actual.row.email || '',
      confirmed: true,
    };
  }
  // A number that is nobody's on the roster, or a push name on its own: real
  // facts about the sender, but not a person CYBills can vouch for.
  if (actual.number || pushName) {
    return { name: pushName, number: actual.number ? `+${actual.number}` : '', id, userId: '', email: '', confirmed: false };
  }
  // Nothing identifies them. The group's own person stands in — a group opened
  // for one person is usually that person — but is never claimed as confirmed.
  const person = channel.userId ? users.find((u) => u.id === channel.userId && !u.removed) : null;
  if (person) {
    return { name: person.name || person.email || '', number: plus(person.mobile || ''), id, userId: '', email: '', confirmed: false };
  }
  return { name: '', number: '', id, userId: '', email: '', confirmed: false };
}
