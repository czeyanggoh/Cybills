// What a LID stands for.
//
// WhatsApp increasingly identifies the sender of a group message by a LID
// ('127676509610071@lid'), an opaque per-user id it hands out so a group does
// not leak everyone's number. It is STABLE — one WhatsApp account, one LID —
// which is what makes it worth learning: once it is known who a LID is, every
// message that account ever sends is theirs, and "Pls pay." beside a receipt
// has a name on it, which is what an approval trail is.
//
// Two ways of learning it, kept in one ledger (`whatsapp-lids`):
// - CYWS, which holds the WhatsApp session and can ask WAHA what number a LID
//   maps to (`POST /api/webhooks/cybills/resolve-lid`, deploy/WHATSAPP.md), or
//   sends the number outright as `sender_pn`. Best-effort, like the reaction.
// - A person, on the document: "this was sent by Astrid Yang". A reviewer who
//   knows the group knows who wrote "Pls pay.", and saying it once is enough.
//
// A leaf. The sender resolver reads it, so it must not import the router.
import { env } from './env.js';
import { loadCollection, saveCollection } from './jsonStore.js';

export type LidRow = {
  /** The raw sender id, '127676509610071@lid'. */
  lid: string;
  /** Bare international digits, '60123456789', or ''. */
  number: string;
  /** The roster row it is, when a person said so (or the number matched one). */
  userId: string;
  /** A name CYWS sent back, if any. */
  name: string;
  source: 'cyws' | 'manual';
  at: string;
};

const LIDS = 'whatsapp-lids';
const isLid = (sender: string) => /@lid$/i.test(String(sender ?? ''));

export const lidFor = (lid: string): LidRow | null =>
  loadCollection<LidRow>(LIDS).find((r) => r.lid === lid) ?? null;

/** Every mapping, for a sweep that would otherwise read the file per row. */
export const lidMap = (): Map<string, LidRow> => new Map(loadCollection<LidRow>(LIDS).map((r) => [r.lid, r]));

export function rememberLid(row: Omit<LidRow, 'at'>): LidRow {
  const items = loadCollection<LidRow>(LIDS);
  const stored: LidRow = { ...row, at: new Date().toISOString() };
  const i = items.findIndex((r) => r.lid === row.lid);
  // A person's word outranks a machine's: what a reviewer said about a LID is
  // not undone by CYWS answering later with a number and no name.
  if (i >= 0 && items[i].source === 'manual' && row.source !== 'manual') {
    if (!items[i].number && row.number) {
      items[i] = { ...items[i], number: row.number };
      saveCollection(LIDS, items);
    }
    return items[i];
  }
  if (i >= 0) items[i] = stored;
  else items.push(stored);
  saveCollection(LIDS, items);
  return stored;
}

// Asked once per LID per process. An older CYWS has no such route and answers
// 404 for ever; asking it again on every message would be a call per message
// for nothing, and a LID that IS resolvable is resolved the first time.
const asked = new Set<string>();

/**
 * Learn what a sender id stands for, before the message it came on is filed.
 *
 * Nothing to learn for a number (`60123@c.us` — WhatsApp said who it was) or a
 * LID already in the ledger. Otherwise the number CYWS sent alongside
 * (`sender_pn`) is taken as read, else CYWS is asked. Best-effort throughout:
 * filing never waits on more than a few seconds of this, and a LID that stays
 * unknown is what the reviewer's own "Sent by" is for.
 */
export async function learnLid(submissionId: string, sender: string, senderPn = ''): Promise<void> {
  const lid = String(sender ?? '');
  if (!isLid(lid) || lidFor(lid)) return;
  const pn = String(senderPn ?? '').replace(/@.*$/, '').replace(/\D+/g, '');
  if (pn) {
    rememberLid({ lid, number: pn, userId: '', name: '', source: 'cyws' });
    return;
  }
  if (asked.has(lid)) return;
  asked.add(lid);
  const answer = await askCywsForLid(submissionId, lid);
  if (answer?.number) rememberLid({ lid, number: answer.number, userId: '', name: answer.name, source: 'cyws' });
}

async function askCywsForLid(submissionId: string, lid: string): Promise<{ number: string; name: string } | null> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return null;
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/resolve-lid`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': env.CYWORKSPACE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ submission_id: submissionId, lid }),
      // Filing answers CYWS inside its 30s; this must not eat that budget.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // 404 is an older CYWS, or a LID WhatsApp has never told it the number
      // for. Either way there is nobody standing here to tell.
      if (res.status !== 404) console.error(`[whatsapp] resolve-lid refused (${res.status})`, await res.text().catch(() => ''));
      return null;
    }
    const body = (await res.json().catch(() => null)) as { pn?: string; number?: string; name?: string } | null;
    const number = String(body?.pn ?? body?.number ?? '').replace(/@.*$/, '').replace(/\D+/g, '');
    return number ? { number, name: String(body?.name ?? '').trim() } : null;
  } catch (err) {
    console.error('[whatsapp] resolve-lid failed', err);
    return null;
  }
}
