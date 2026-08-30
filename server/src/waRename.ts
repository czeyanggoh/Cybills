import { env } from './env.js';
import { loadChannels, patchChannel } from './waChannels.js';

// --- Keeping a group's name and its address the same thing -------------------
// A collection group is NAMED after the person's own CYBills address, because
// they are one pipe: send a bill to `gcy.cybm@cybills.sg` or into the group
// called `gcy.cybm@cybills.sg` and it is filed under exactly the same person.
//
// The name was a snapshot, though — written when the group was created and
// never touched again — so changing somebody's handle, or the entity's short
// form, left the group standing there under the address they used to have.
// Which reads, correctly, as the two halves having come apart: the card said
// `czeyanggoh.cybm@cybills.sg` while the address above it said `gcy.cybm`.
//
// So an address that moves takes its group with it. CYBills does not hold the
// WhatsApp session, so it asks CYWS, the same shape as a reaction: our
// X-API-Key, CYWS's own webhook surface, the group named by SUBMISSION ID
// rather than chat id so it is resolved at CYWS's end from its own record.

/** Ask CYWS to rename one group. Best-effort by construction — see below. */
async function askForRename(body: { submission_id: string; subject: string }): Promise<boolean> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return false;
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/rename-group`;
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
    // A line in the log and nothing more. An older CYWS has no such route and
    // answers 404 forever; a group wearing last week's name is untidy, not
    // broken — every bill sent into it still files under the same person, since
    // a channel names its `userId` and not its subject — so it must never hold
    // up saving somebody's details.
    console.error(`[whatsapp] rename refused (${res.status})`, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[whatsapp] rename failed', err);
  }
  return false;
}

/**
 * Rename every group opened for one person, so each carries their address as it
 * is now. `subject` is what it should say — the caller computes it through
 * `groupSubjectFor`, the same function the group was opened with.
 *
 * Two kinds of group are deliberately left alone:
 *
 *   ADOPTED — a conversation the client already had, merely pointed at CYBills
 *   (`/channels/attach`). It is theirs, it was named by them, and renaming it
 *   from an accounting app is the same species of act as taking it apart: the
 *   close path refuses to do that unasked, and so does this.
 *
 *   CLOSED or REPLACED — the collection is over, or superseded. Renaming a
 *   group CYBills has stopped collecting through would edit a chat that is no
 *   longer any of its business.
 *
 * Never throws and is never awaited by anything a person is waiting on.
 */
export async function renameChannelsForUser(ws: string, userId: string, subject: string): Promise<void> {
  if (!userId || !subject) return;
  const mine = loadChannels().filter(
    (c) =>
      c.workspaceId === ws &&
      c.userId === userId &&
      c.status === 'open' &&
      !c.adopted &&
      c.chatId &&
      c.subject !== subject
  );
  for (const channel of mine) {
    const done = await askForRename({ submission_id: channel.id, subject });
    // Only what actually reached WhatsApp is recorded. A refusal leaves the row
    // saying what the group is really called, which is the honest state and
    // what makes the next address change try again rather than believing the
    // two already agree.
    if (done) patchChannel(channel.id, { subject });
  }
}

/** The same, for a list of people — one entity's roster after its short form
 * changed, which moves everybody's address at once. */
export async function renameChannelsForUsers(
  ws: string,
  people: { id: string; subject: string }[]
): Promise<void> {
  for (const person of people) await renameChannelsForUser(ws, person.id, person.subject);
}
