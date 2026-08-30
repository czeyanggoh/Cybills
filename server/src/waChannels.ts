import { loadCollection, saveCollection } from './jsonStore.js';

// The collection groups CYBills holds, stored.
//
// Its own module for the same reason the mirrored thread has one: three
// concerns read these rows and none of them should have to import the router
// to do it — whatsapp.ts, which opens the groups and receives the bills, and
// waRename.ts, which renames one when the person it belongs to changes their
// address. Kept in whatsapp.ts, the rename had to reach back into the router
// module, and through it into users.ts, which whatsapp.ts imports already.

// --- The channel record ------------------------------------------------------
// One per submission = one WhatsApp group. `id` IS the submission_id CYWS files
// everything under, and it is written to disk BEFORE the group is asked for
// (see createChannel) — that is what makes a retry safe.
export type WaChannel = {
  id: string;
  workspaceId: string;
  orgId: string; // the organisation RECORD id (not the bills scope)
  // The one person this group was opened for, when it was opened from their own
  // page. A group is a conversation with SOMEBODY — the person who holds the
  // paperwork — and CYWS's own model is one group per submission, so this is
  // the ordinary case. Empty for an entity-wide group set up under Connections,
  // which is the same thing with more people in it.
  userId: string;
  subject: string;
  chatId: string; // '' until CYWS answers
  // 'replaced' — a group superseded because the person's number changed. Kept,
  // never deleted: its submission id is what CYWS still files that group's
  // messages under, and bills sent into it have to keep arriving.
  // 'disconnected' — CYBills has stopped collecting through it; the WhatsApp
  // group is untouched and carries on without us. 'deleted' — CYBot removed
  // everyone and left, so there is no group at the far end any more. Both are
  // closed, and the difference between them is only what happened in WhatsApp.
  // The ROW survives either way: the documents already collected reference this
  // submission id, and so does every mirrored message.
  status: 'pending' | 'open' | 'failed' | 'replaced' | 'disconnected' | 'deleted';
  participantsRequested: string[];
  participantsAdded: string[];
  // Whether CYWS actually told us who ended up in the group. An ADOPTED group
  // (`already_existed`) comes back with empty participant arrays — CYWS is
  // saying "this already exists", not "nobody is in it" — so without this the
  // two are indistinguishable and a resumed channel would announce that
  // WhatsApp had refused every single person.
  participantsKnown: boolean;
  // This group was already a conversation before CYBills was pointed at it
  // (POST /channels/attach) rather than one CYBot opened. It matters when it is
  // closed down: emptying and leaving a group the client started is destroying
  // something that was never ours, so the two ways out are offered with that
  // said rather than assumed either way. Absent on rows written before adoption
  // existed, all of which we opened.
  adopted?: boolean;
  createdAt: string;
  createdBy: string;
  openedAt: string;
  lastError: string;
  lastMessageAt: string;
  received: number;
};

const CHANNELS = 'whatsapp-channels';
export const loadChannels = () => loadCollection<WaChannel>(CHANNELS);
export const saveChannels = (items: WaChannel[]) => saveCollection(CHANNELS, items);

export function channelsForOrg(ws: string, orgId: string): WaChannel[] {
  return loadChannels().filter((c) => c.workspaceId === ws && c.orgId === orgId);
}

export function channelById(submissionId: string): WaChannel | null {
  return loadChannels().find((c) => c.id === submissionId) ?? null;
}

export function patchChannel(id: string, patch: Partial<WaChannel>): WaChannel | null {
  const items = loadChannels();
  const row = items.find((c) => c.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  saveChannels(items);
  return row;
}
