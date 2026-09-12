// The mirrored email conversation, stored.
//
// Its own module, and a leaf, for the reason waThread.ts is one: two concerns
// read it and neither should have to import the other — inbound.ts, which
// receives the mail and files what it carries, and email.ts, which serves the
// threads and re-runs a link fetch somebody asks for again. Kept inside
// inbound.ts the router would have had to reach back into the delivery road,
// and through it into everything the read imports.
//
// It exists because Costs can only ever show what a delivery PRODUCED. A mail
// that filed nothing — no attachment, a link nobody could follow, an
// attachment of a kind the reader cannot take — appeared nowhere in CYBills at
// all, so "I emailed that last week" had no answer here. Every delivery is
// mirrored, whatever became of it, with the reason written down.
import { loadCollection, saveCollection } from './jsonStore.js';

export type MailDocument = {
  billId: string;
  displayId: string;
  fileName: string;
  /** How it got here: an attachment on the mail, or a link n8n followed. */
  via: 'attachment' | 'link';
};

export type MailAttachment = {
  fileName: string;
  contentType: string;
  bytes: number;
  /** Empty when it was filed; otherwise why it was not (a kind we cannot read). */
  skipped: string;
};

export type MailMessage = {
  /** The message's own id (Message-ID where the MIME carried one), and the
   *  upsert key: a Worker that retries must not mirror one mail twice. */
  id: string;
  workspaceId: string;
  /** The organisation RECORD id — what the thread is listed under. */
  orgId: string;
  /** The bills-store scope its documents were filed into. */
  scope: string;
  /** Whose address it was delivered to. The thread IS this person. */
  userId: string;
  to: string;
  from: string;
  subject: string;
  /** The covering message, capped the way the document's own copy is. */
  text: string;
  sentAt: string;
  receivedAt: string;
  attachments: MailAttachment[];
  documents: MailDocument[];
  /** Every http(s) link in the message, in the order it was written. */
  links: string[];
  /** What n8n said when it was asked to follow them. Empty = never asked. */
  linkNote: string;
  linkFetchedAt: string;
  /** 'documents' | 'forwarding_confirmation' | 'nothing' — what the delivery
   *  came to. Recomputed whenever a link fetch lands a document later. */
  outcome: string;
};

const MIRRORED = 'email-thread';

export const loadMail = () => loadCollection<MailMessage>(MIRRORED);
export const saveMail = (items: MailMessage[]) => saveCollection(MIRRORED, items);

export const mailById = (id: string): MailMessage | null =>
  loadMail().find((m) => m.id === id) ?? null;

/**
 * Every mirrored message in one entity.
 *
 * Named by the organisation RECORD id and by the bills SCOPE it filed into,
 * because a delivery that arrived before the entity was linked carries only the
 * second. No two entities share a scope — it is the boundary the documents
 * themselves are isolated by — so widening to it lets nothing across.
 */
export function mailForOrg(ws: string, orgId: string, scope = ''): MailMessage[] {
  return loadMail().filter(
    (m) => m.workspaceId === ws && (m.orgId === orgId || (Boolean(scope) && m.scope === scope))
  );
}

// Upserted on the message id, never appended blindly: a delivery that is
// retried (the Worker's fetch timing out after we had already stored it) must
// leave one row, not two.
//
// A retry re-states what the delivery CARRIED; it does not undo what was made
// from it. So the documents are unioned rather than replaced and a link fetch
// that has already run keeps its answer — written flat, a second POST of one
// mail would erase the record of the documents the first one filed, which is
// the one thing the row is there to hold.
export function recordMail(row: MailMessage): MailMessage {
  const items = loadMail();
  const at = items.findIndex((m) => m.id === row.id);
  if (at < 0) {
    items.push(row);
    saveMail(items);
    return row;
  }
  const was = items[at];
  const documents = [
    ...was.documents,
    ...row.documents.filter((d) => !was.documents.some((x) => x.billId === d.billId)),
  ];
  const merged: MailMessage = {
    ...was,
    ...row,
    documents,
    linkNote: row.linkNote || was.linkNote,
    linkFetchedAt: row.linkFetchedAt || was.linkFetchedAt,
    outcome: documents.length ? 'documents' : row.outcome || was.outcome,
  };
  items[at] = merged;
  saveMail(items);
  return merged;
}

/** Add what a link fetch produced to a message already mirrored. */
export function recordLinkFetch(id: string, note: string, documents: MailDocument[]): MailMessage | null {
  const items = loadMail();
  const row = items.find((m) => m.id === id);
  if (!row) return null;
  row.linkNote = note;
  row.linkFetchedAt = new Date().toISOString();
  for (const doc of documents) {
    if (!row.documents.some((d) => d.billId === doc.billId)) row.documents.push(doc);
  }
  // The outcome is what the delivery CAME TO, so it is restated rather than
  // stuck at what it was the moment the mail landed: a message that filed
  // nothing until n8n answered is a message that filed something.
  if (row.documents.length) row.outcome = 'documents';
  saveMail(items);
  return row;
}
