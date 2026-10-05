// What was sent BACK, stored.
//
// The mirror (mailThread.ts) is the record of what arrived; this is the record
// of what somebody here answered. Its own collection rather than a field on the
// mirrored message, because a reply is written from a DOCUMENT as often as from
// the Email tab, and a document emailed in before the mirror existed has an
// envelope of its own and no mirrored row to hang anything on. So a reply names
// both — the message where there is one, and the documents it was about — and
// either page finds it.
//
// A leaf, like mailThread.ts, and for the same reason.
import { randomBytes } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';

export type MailReply = {
  id: string;
  workspaceId: string;
  /** The organisation RECORD id and the bills scope, as the mirror keeps both. */
  orgId: string;
  scope: string;
  /** The mirrored message it answers. '' for a document older than the mirror. */
  messageId: string;
  /** The documents that message produced, and the one it was written from. */
  billIds: string[];
  to: string[];
  cc: string[];
  /** Where the recipient's own answer comes back to. */
  replyTo: string[];
  subject: string;
  /** What the person typed, and nothing else: no signature, no quoted original. */
  text: string;
  at: string;
  /** Who pressed Send — an address, and the name it resolved to at the time. */
  by: string;
  byName: string;
};

const COLLECTION = 'email-replies';

const load = () => loadCollection<MailReply>(COLLECTION);

export function recordReply(row: Omit<MailReply, 'id' | 'at'>): MailReply {
  const items = load();
  const reply: MailReply = { ...row, id: `rep_${randomBytes(8).toString('hex')}`, at: new Date().toISOString() };
  items.push(reply);
  saveCollection(COLLECTION, items);
  return reply;
}

/**
 * The replies sent about one message, or about any of these documents, oldest
 * first — a conversation is read downwards.
 *
 * Held to the entity as the mirror is: by the record id or by the scope, which
 * no two entities share.
 */
export function repliesFor(
  ws: string,
  orgId: string,
  scope: string,
  about: { messageId?: string; billIds?: string[] }
): MailReply[] {
  const bills = new Set((about.billIds || []).filter(Boolean));
  return load()
    .filter((r) => r.workspaceId === ws && (r.orgId === orgId || (Boolean(scope) && r.scope === scope)))
    .filter(
      (r) =>
        (Boolean(about.messageId) && r.messageId === about.messageId) || r.billIds.some((id) => bills.has(id))
    )
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
