import { env } from './env.js';
import { getBillById, markBillWhatsappReaction } from './store.js';
import { loadMessages, saveMessages } from './waThread.js';

// --- Answering back into the group -------------------------------------------
// A person who photographs a receipt into a WhatsApp group gets no receipt of
// their own: the message sits there looking exactly like one that was never
// picked up, so the next thing they do is send it again, or ask. A reaction on
// their own message is the acknowledgement, in the place they are already
// looking, and it costs nobody a notification.
//
// Two states, because "we have it" and "it is settled" are different answers to
// different questions, and the second is the one the sender actually cares
// about:
//
//   READ  — filed here and the reader got something off it.
//   PAID  — Xero says the bill it became has been paid in full.
//
// WhatsApp allows ONE reaction per account per message, so the second REPLACES
// the first rather than sitting beside it. That is the whole design: the tick
// they can see goes from grey to green as the document moves, on the message
// they sent, without anybody typing a word into the group.
export const REACT_READ = '✔️'; // heavy check mark — the grey tick
export const REACT_PAID = '✅'; // white heavy check mark — the green one

/**
 * Ask CYWS to put an emoji on one message. Best-effort by construction.
 *
 * CYBills does not hold the WhatsApp session — CYWS does — so this is the same
 * shape as `askForGroup`: our X-API-Key, CYWS's own webhook surface. It names
 * the message by SUBMISSION ID rather than by chat id, so the group is resolved
 * at CYWS's end from its own record: that key opens every chat on the number,
 * and a bug here should not be able to react in somebody else's conversation.
 */
async function askForReaction(body: { submission_id: string; wa_message_id: string; emoji: string }): Promise<boolean> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return false;
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/react`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': env.CYWORKSPACE_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    // Worth a line in the log and nothing more. An older CYWS has no such route
    // and answers 404 forever; a tick that never appears must not be allowed to
    // hold up filing a bill, and there is no person standing here to tell.
    console.error(`[whatsapp] reaction refused (${res.status})`, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[whatsapp] reaction failed', err);
  }
  return false;
}

/** Which tick this document has earned, '' for none yet. */
export function reactionFor(bill: {
  status?: string;
  supplier?: string;
  total?: unknown;
  xeroStatus?: string;
  whatsapp?: { submissionId: string; waMessageId: string };
}): string {
  if (!bill.whatsapp?.waMessageId || !bill.whatsapp?.submissionId) return '';
  // Deleted here, but the message is still in somebody's chat. Whatever it is
  // wearing is what was true when it was said; a deletion is not news the group
  // needs, and clearing the tick would read as the document going missing.
  if (bill.status === 'deleted') return '';
  if ((bill.xeroStatus ?? '') === 'PAID') return REACT_PAID;
  // A read that came back with neither a supplier nor a total got nothing off
  // the file — a dark photo, a scan the reader could not see. Ticking that
  // would tell the sender their receipt is in hand when what it needs is to be
  // sent again, so it is left bare deliberately.
  if (bill.supplier || Number(bill.total ?? 0) > 0) return REACT_READ;
  return '';
}

/**
 * Put the right tick on the message this document arrived in.
 *
 * Called wherever the document's standing changes — after the read, and after
 * Xero says the bill was paid — and it works out what to say from the document
 * itself rather than from which caller reached it. So a re-read cannot knock a
 * green tick back to grey, and the three separate routes by which Xero's "paid"
 * arrives (the webhook, the payments sweep, the reply to an update) produce
 * exactly one reaction between them.
 *
 * Never throws, and never awaited by anything a person is waiting on.
 */
export async function syncWhatsappReaction(orgId: string, billId: string): Promise<void> {
  const bill = getBillById(orgId, billId);
  if (!bill) return;
  const want = reactionFor(bill);
  // Nothing earned yet, or the message already wears it. A tick is never
  // CLEARED: taking one off says something happened to the document, and
  // nothing here ever means that.
  if (!want || want === (bill.whatsappReaction ?? '')) return;
  const sent = await askForReaction({
    submission_id: bill.whatsapp!.submissionId,
    wa_message_id: bill.whatsapp!.waMessageId,
    emoji: want,
  });
  // Record only what actually reached WhatsApp, so the next thing to happen to
  // this document tries again rather than believing a tick is there.
  if (!sent) return;
  markBillWhatsappReaction(orgId, billId, want);
  // And show it on the thread here too. The tab is a mirror of the group, and
  // the group now has this on the message — waiting for CYWS to re-send the
  // message would leave the two disagreeing for good, since a reaction is not
  // itself a reason for it to send anything.
  const items = loadMessages();
  const row = items.find((m) => m.id === bill.whatsapp!.waMessageId);
  if (row && row.reaction !== want) {
    row.reaction = want;
    saveMessages(items);
  }
}
