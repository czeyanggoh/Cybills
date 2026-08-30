import { loadCollection, saveCollection } from './jsonStore.js';

// The mirrored WhatsApp conversation, stored.
//
// Its own module because two different concerns read it and neither should have
// to import the other: whatsapp.ts, which receives the messages and serves the
// thread, and waReactions.ts, which puts a tick on one of them. Kept here they
// are both leaves; kept in whatsapp.ts the reaction had to reach back into the
// router module, and through it into the Xero routes that trigger a reaction —
// a cycle for the sake of one collection name.

export type WaMirroredMessage = {
  /** CYWS's wa_message_id — WhatsApp's own id, and the upsert key. */
  id: string;
  submissionId: string;
  workspaceId: string;
  orgId: string;
  chatId: string;
  direction: string;
  sender: string;
  senderName: string;
  body: string;
  translation: string;
  msgType: string;
  r2Key: string;
  fileUrl: string;
  fileName: string;
  contentType: string;
  /** What the document is. CYWS's classifier proposes; a reviewer here decides. */
  docCategory: string;
  /** 'cyws' — the classifier's guess; 'manual' — corrected here, and then never
   * overwritten by a later CYWS re-send. The correction is the whole point. */
  categorySource: string;
  /** How sure the classifier was: 'low' | 'medium' | 'high'. Shown beside the
   * category so a shaky guess doesn't read as a settled fact. */
  categoryConfidence: string;
  replyToBody: string;
  reaction: string;
  sentAt: string;
  receivedAt: string;
  /** Set once this message has been filed as a cost document. */
  billId: string;
  billDisplayId: string;
};

// NOT 'whatsapp-messages' — that name belongs to the delivery dedup ledger
// (SEEN, above), and sharing it would have the two overwrite each other's file.
const MIRRORED = 'whatsapp-thread';

export const loadMessages = () => loadCollection<WaMirroredMessage>(MIRRORED);
export const saveMessages = (items: WaMirroredMessage[]) => saveCollection(MIRRORED, items);

/** Every mirrored message for one group, oldest first — a thread reads forwards. */
export function messagesForChannel(submissionId: string): WaMirroredMessage[] {
  return loadMessages()
    .filter((m) => m.submissionId === submissionId)
    .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
}
