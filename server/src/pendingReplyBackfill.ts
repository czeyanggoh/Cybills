// Replies sent before "Pending reply" existed left their documents in Ready.
// Once, on the first boot that has the feature, mark the documents of replies
// from the last week as waiting — and note where the person replied to has written
// since ("Reply received"), which still wants a person's look. A marker collection makes it one-off: running it every
// boot would bring back a wait somebody had cleared with "Mark as answered".
import { loadCollection, saveCollection } from './jsonStore.js';
import { loadReplies } from './mailReplies.js';
import { loadMail } from './mailThread.js';
import { normaliseSender } from './trustedSenders.js';
import { getBillById, setPendingReply } from './store.js';

const MARKER = 'pending-reply-backfill-v1';
const WEEK = 7 * 24 * 3600 * 1000;

export function backfillPendingReplies(now = Date.now()): number {
  if (loadCollection<{ at: string }>(MARKER).length) return 0;
  const mail = loadMail();
  let marked = 0;
  for (const r of loadReplies()) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || now - at > WEEK) continue;
    const recipients = new Set(r.to.map((a) => normaliseSender(a)));
    const answer = mail.find(
      (m) => m.scope === r.scope && Date.parse(m.receivedAt) > at && recipients.has(normaliseSender(m.from))
    );
    for (const id of r.billIds) {
      const b = getBillById(r.scope, id);
      if (!b || b.xeroInvoiceId || b.pendingReply || !['new', 'ready'].includes(String(b.status))) continue;
      setPendingReply(r.scope, id, { at: r.at, to: r.to.join(', '), by: r.by, ...(answer ? { answeredAt: answer.receivedAt } : {}) });
      marked++;
    }
  }
  saveCollection(MARKER, [{ at: new Date(now).toISOString() }]);
  return marked;
}
