// Who sent a WhatsApp message, said in a name and a number.
//
// WhatsApp increasingly identifies a sender by a LID ('127676509610071@lid') —
// an opaque per-user id it hands out so a group does not leak everyone's number
// — and it happens to be fifteen digits, which is exactly the length of a long
// international number. Printed where a sender belongs it read as a phone
// number that belongs to nobody, and matched against the roster it found no
// one. Nothing here can turn a LID back into a number: that mapping is held at
// WhatsApp's end, and CYWS is the side with a session that could ask for it.
//
// What CYBills DOES hold is the roster. A group opened for one person is a
// conversation with that person — settled when the group was made, never worked
// out again from the sender field — and their roster row carries the name and
// the mobile the group was opened with. An entity-wide group is a real question,
// answered by the number when WhatsApp sent one. Either way the answer is the
// same shape, so the thread page and the document page cannot disagree about who
// sent a message.
//
// A leaf: the document listing reads it too, and must not import the router.
import { canAccessOrg, ensure as ensureUsers, type User } from './users.js';
import type { WaChannel } from './waChannels.js';

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
  // The name WhatsApp sent (the sender's own push name), else the roster's, else ''.
  name: string;
  // '+60123456789' — the number WhatsApp sent, else the roster's, else ''.
  number: string;
  // What WhatsApp put in the sender field, as-is, so a message can always be
  // traced back even when all it gave us was an opaque id.
  id: string;
};

const live = (u: User) => !u.removed && !u.deactivated;
const plus = (mobile: string) => {
  const n = normaliseMobile(mobile);
  return n ? `+${n}` : '';
};

// The roster row behind a message: the person the group was opened for, else
// the person whose Mobile is the number it came from. The same two steps
// `ownerFor` takes to decide whose document it is, so the name printed beside a
// document and the owner it was filed under are the same person.
function rosterRowFor(ws: string, channel: Pick<WaChannel, 'userId' | 'orgId'>, sender: string): User | null {
  const users = ensureUsers(ws);
  if (channel.userId) {
    const person = users.find((u) => u.id === channel.userId && !u.removed);
    if (person) return person;
  }
  const number = mobileOf(sender);
  if (!number) return null;
  return users.find((u) => live(u) && normaliseMobile(u.mobile) === number && canAccessOrg(u, channel.orgId)) ?? null;
}

export function senderIdentity(
  ws: string,
  channel: Pick<WaChannel, 'userId' | 'orgId'>,
  sender: string,
  senderName: string,
): SenderIdentity {
  const id = String(sender ?? '');
  const row = rosterRowFor(ws, channel, id);
  const sent = mobileOf(id);
  return {
    name: String(senderName ?? '').trim() || (row ? row.name || row.email || '' : ''),
    number: sent ? `+${sent}` : row ? plus(row.mobile || '') : '',
    id,
  };
}
