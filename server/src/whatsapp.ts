import { Router, type Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { env, whatsappEnabled, r2Enabled, googleEnabled } from './env.js';
import { workspaceId } from './workspace.js';
import { dataScopeForOrg, getOrganisation, primaryOrgId } from './organisations.js';
import {
  canAccessOrg,
  canManagePractice,
  effectiveRoleFor,
  ensure as ensureUsers,
  save as saveUsers,
  generalUserFor,
  isBusinessAdminRole,
  memberForSession,
  appOrigin,
  groupSubjectFor,
  type User,
} from './users.js';
import { insertBill, listBills, displayIdOf } from './store.js';
import { getBill, putBill, putBillFile } from './storage.js';
import { readSetting } from './settings.js';
import { resolveProvider } from './llm.js';
import { autoRead } from './inbound.js';
import { type WaMirroredMessage, loadMessages, saveMessages, messagesForChannel } from './waThread.js';
import { syncWhatsappReaction } from './waReactions.js';
import {
  type WaChannel,
  loadChannels,
  saveChannels,
  channelsForOrg,
  channelById,
  patchChannel,
} from './waChannels.js';
import { renameChannelsForUser } from './waRename.js';
import { inboundKey, keyMatches } from './inboundKey.js';

// Bill collection over WhatsApp, in partnership with CYWorkspace (CYWS).
//
// CYWS runs the WhatsApp number ("CYBot") on its own WAHA server and owns
// everything WhatsApp-shaped: the session, the group, and the LLM pass that
// decides whether an attachment is a supplier bill at all. CYBills owns two
// ends of that pipe and nothing in between:
//
//   1. ASKING for a group  — one per submission, created only when a person
//      presses the button (§ createGroup). A real WhatsApp group appears and
//      real people are added to it, so this is never called speculatively,
//      never in a loop, and never as a side effect of loading a page.
//   2. RECEIVING the bills — CYWS POSTs one message per classified supplier
//      bill (§ POST /invoice) and CYBills files it into that entity's Costs
//      inbox, read the same way an emailed document is.
//
// The two systems share one Cloudflare R2 bucket, so a bill's bytes are never
// copied between them: CYWS passes the object KEY and CYBills stores a
// reference to it. See `shared:` in storage.ts for what that means for delete.
//
// Everything here rides on the SAME X-API-Key CYBills already sends to CYWS's
// Xero relay (CYWORKSPACE_API_KEY). The key CYWS sends BACK is a different one
// and ours to choose — see `inboundKey()`.

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
// '@lid' is NOT one of those. A LID is a linked identity — an opaque per-user id
// WhatsApp increasingly sends instead of the number so a group does not leak
// everyone's — and it happens to be 15 digits, which is exactly the length of a
// long international number. So stripping the domain produced a plausible
// number that belongs to nobody: matched against the roster it found no one,
// and printed to a person it read as their colleague's mobile. It is refused
// here rather than at each call site, because it is never a number anywhere.
export const mobileOf = (waId: string) => {
  const raw = String(waId ?? '');
  if (/@lid$/i.test(raw)) return '';
  return normaliseMobile(raw.split('@')[0]);
};

// The channel record and its storage live in waChannels.ts — a leaf, so the
// rename can read the same rows without importing this router. Re-exported here
// because this is where callers have always found them.
export { type WaChannel, channelsForOrg, channelById };

// A submission id that says where it came from. CYWS files everything under it
// and an operator reads it in their logs, so it names the system and the client
// entity rather than being an opaque number.
const mintSubmissionId = (orgId: string) => `CYB-${orgId}-${randomBytes(4).toString('hex')}`;

// --- Calling CYWS ------------------------------------------------------------
type CreateGroupOk = {
  chat_id: string;
  subject: string;
  submission_id: string;
  participants_added: string[];
  participants_requested: string[];
  already_existed: boolean;
};

type CreateResult =
  | { ok: true; data: CreateGroupOk }
  | { ok: false; status: number; error: string; message: string; retryable: boolean };

// Which failures are worth pressing the button again for. `group_create_failed`
// is WhatsApp/WAHA declining a request that was itself fine; the two 503s mean
// CYWS is misconfigured, and retrying those just makes the same call fail
// again — an operator has to be told instead.
const RETRYABLE = new Set(['group_create_failed', 'relay_unreachable']);

const MESSAGES: Record<string, string> = {
  submission_id_required: 'CYWS could not file the group: no submission id was sent.',
  participant_required: 'No usable WhatsApp number — give at least one in full international format.',
  invalid_api_key: 'CYWS rejected the API key. Check CYWORKSPACE_API_KEY.',
  group_create_failed: 'WhatsApp refused to create the group. Try again in a moment.',
  group_create_unavailable: 'The WhatsApp service on CYWS is not available. Tell the CYWS operator — retrying will not help.',
  webhook_not_configured: 'CYWS has not configured the CYBills webhook yet. Tell the CYWS operator.',
  relay_unreachable: 'Could not reach CYWorkspace.',
};

async function askForGroup(body: {
  submission_id: string;
  participants: string[];
  subject: string;
}): Promise<CreateResult> {
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/create-group`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': env.CYWORKSPACE_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Unreachable, or the timeout fired. The group may well have been created
    // anyway — which is exactly why the submission id was persisted first, so
    // pressing the button again adopts it instead of making a second one.
    console.error('[whatsapp] CYWS unreachable', err);
    return {
      ok: false,
      status: 502,
      error: 'relay_unreachable',
      message: MESSAGES.relay_unreachable,
      retryable: true,
    };
  }
  const payload = (await res.json().catch(() => null)) as { data?: CreateGroupOk; error?: string } | null;
  if (res.ok && payload?.data?.chat_id) return { ok: true, data: payload.data };
  const error = String(payload?.error ?? 'group_create_failed');
  return {
    ok: false,
    status: res.status,
    error,
    message: MESSAGES[error] ?? `CYWS returned ${res.status}.`,
    retryable: RETRYABLE.has(error),
  };
}

// Create the group for one submission, or adopt the one a previous attempt may
// already have made.
//
// The order here is the whole point. The record — and with it the submission id
// — is written to disk BEFORE the call goes out, because the dangerous failure
// is not "the call failed", it is "the call succeeded and the answer was lost".
// CYWS is idempotent on submission_id, so a retry that reuses the stored id
// comes back with `already_existed: true` and the original group. A retry that
// minted a FRESH id would create a second real WhatsApp group, in front of the
// client, with no way to tell which one to use.
export async function createChannel(
  ws: string,
  orgId: string,
  opts: { participants: string[]; subject: string; createdBy: string; userId?: string }
): Promise<{ ok: true; channel: WaChannel } | { ok: false; status: number; error: string; message: string; retryable: boolean; channel: WaChannel | null }> {
  const items = loadChannels();
  const userId = opts.userId ?? '';
  // Resume rather than start again: a half-made channel already owns a
  // submission id, and possibly a group at the far end.
  //
  // Scoped to the same person (or to neither), because these are different
  // conversations: connecting one person must not adopt the entity-wide
  // group's pending id and quietly put their bills wherever that was pointed.
  // Only a HALF-MADE one. A replaced group must never be resumed: reusing its
  // submission id would have CYWS hand back the very group being replaced.
  const existing = items.find(
    (c) =>
      c.workspaceId === ws &&
      c.orgId === orgId &&
      (c.userId ?? '') === userId &&
      (c.status === 'pending' || c.status === 'failed')
  );
  const channel: WaChannel = existing ?? {
    id: mintSubmissionId(orgId),
    workspaceId: ws,
    orgId,
    userId,
    subject: opts.subject,
    chatId: '',
    status: 'pending',
    participantsRequested: opts.participants,
    participantsAdded: [],
    participantsKnown: false,
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy,
    openedAt: '',
    lastError: '',
    lastMessageAt: '',
    received: 0,
  };
  if (existing) {
    channel.participantsRequested = opts.participants;
    channel.subject = opts.subject;
    channel.status = 'pending';
    channel.lastError = '';
  } else {
    items.push(channel);
  }
  saveChannels(items);

  const res = await askForGroup({
    submission_id: channel.id,
    participants: opts.participants,
    subject: opts.subject,
  });

  if (!res.ok) {
    patchChannel(channel.id, { status: 'failed', lastError: res.message });
    return { ...res, channel: channelById(channel.id) };
  }

  // `participants_added` can legitimately be SHORTER than what was asked for:
  // WhatsApp silently refuses to add someone whose privacy settings disallow
  // it. That is not an error and must not read as one — but it must not pass
  // unsaid either, or a client sits waiting to be added to a group they will
  // never see. Both lists are kept, and the UI names the difference.
  //
  // An adopted group (`already_existed`) returns empty participant arrays, so
  // what was recorded the first time is left alone.
  const adopted = res.data.already_existed;
  const added = adopted ? channel.participantsAdded : res.data.participants_added ?? [];
  const updated = patchChannel(channel.id, {
    chatId: res.data.chat_id,
    subject: res.data.subject || channel.subject,
    status: 'open',
    participantsAdded: added,
    participantsKnown: channel.participantsKnown || !adopted,
    openedAt: channel.openedAt || new Date().toISOString(),
    lastError: '',
  });
  return { ok: true, channel: updated as WaChannel };
}

// Two numbers that are the same person. WhatsApp/WAHA echo an id back in
// whatever form they hold it, so a country code may be present on one side and
// not the other; an 8-digit suffix match is the most either side can promise.
function sameNumber(a: string, b: string): boolean {
  const x = normaliseMobile(a) || String(a ?? '').replace(/\D+/g, '');
  const y = normaliseMobile(b) || String(b ?? '').replace(/\D+/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y;
  return short.length >= 8 && (x.endsWith(y) || y.endsWith(x));
}

// Requested but demonstrably NOT added — the people somebody has to get into
// the group by hand. Derived, never stored: both lists are on the record.
//
// This has to be able to answer "I don't know", because usually it doesn't.
// WhatsApp no longer hands back phone numbers: `participants_added` comes back
// as LIDs (`217630539546875`), the opaque per-user ids it uses so a group
// doesn't leak everyone's number. Compared against the numbers we asked with,
// every one of those looks like a stranger — which is how a person who WAS
// added, and could see the group on her phone, was reported as having refused.
//
// So a name is only ever claimed when a returned id actually matches a number
// we sent. Where the ids are opaque, the count is the only true thing there is
// to say, and `addedShortfall` says it instead.
export function participantsMissing(c: WaChannel): string[] {
  if (!c.participantsKnown) return [];
  const named = c.participantsRequested.filter((p) => c.participantsAdded.some((a) => sameNumber(a, p)));
  // Nothing matched at all: these are LIDs, not numbers. We learned who is in
  // the group only as a count, so naming anybody here would be a guess.
  if (!named.length && c.participantsAdded.length) return [];
  if (c.participantsAdded.length >= c.participantsRequested.length) return [];
  return c.participantsRequested.filter((p) => !c.participantsAdded.some((a) => sameNumber(a, p)));
}

// How many of the people we asked for WhatsApp did not add, when it won't say
// which. 0 when everyone is accounted for, or when we were never told.
export function addedShortfall(c: WaChannel): number {
  if (!c.participantsKnown) return 0;
  return Math.max(0, c.participantsRequested.length - c.participantsAdded.length);
}

const publicChannel = (c: WaChannel) => ({
  submissionId: c.id,
  orgId: c.orgId,
  userId: c.userId ?? '',
  subject: c.subject,
  chatId: c.chatId,
  status: c.status,
  adopted: Boolean(c.adopted),
  participantsRequested: c.participantsRequested,
  // A COUNT, not the ids themselves. What WhatsApp returns is LIDs — opaque
  // per-user ids — and printing them under "In the group" put two 15-digit
  // numbers in front of somebody with no way to tell whose they were. The
  // numbers we asked with are the ones a person recognises, and those are
  // already above.
  participantsAddedCount: c.participantsAdded.length,
  participantsMissing: participantsMissing(c),
  addedShortfall: addedShortfall(c),
  participantsKnown: c.participantsKnown,
  createdAt: c.createdAt,
  createdBy: c.createdBy,
  lastError: c.lastError,
  lastMessageAt: c.lastMessageAt,
  received: c.received,
});

// --- The key CYWS sends BACK -------------------------------------------------
// Lives in its own leaf now (inboundKey.ts), because the payables hand-off has
// to check the same key and cannot import this router — it would import back.

// --- Getting the file ---------------------------------------------------------
// PREFERRED: read the object straight out of the shared bucket. Both systems
// hold the same R2 bucket, so the bytes never move and CYBills stores a
// reference to CYWS's object rather than a second copy of it.
//
// FALLBACK: the permanent signed URL CYWS mints, which 302s to a fresh
// presigned link on every request. Used when this deploy has no R2 credentials
// (a dev box) or the object isn't readable — and then the bytes ARE stored
// here, because a reference to something we cannot read is worse than a copy.
//
// The fallback URL is only ever fetched when it points at CYWS itself. Whoever
// holds the inbound key could otherwise hand us any URL at all and use the
// server as a fetcher for addresses only it can reach.
function allowedFileHost(raw: string): boolean {
  try {
    const target = new URL(raw);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    const allowed = [env.CYWORKSPACE_RELAY_URL, env.CYWORKSPACE_PUBLIC_URL]
      .filter(Boolean)
      .map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      });
    return allowed.includes(target.host);
  } catch {
    return false;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

type Fetched = { bytes: Buffer; contentType: string; storageKey: string };

async function fetchDocument(
  scope: string,
  payload: { r2_key?: string; file_url?: string; content_type?: string }
): Promise<Fetched | null> {
  const r2Key = String(payload.r2_key ?? '').trim();
  const declaredType = String(payload.content_type ?? '') || 'application/octet-stream';

  if (r2Key && r2Enabled) {
    const obj = await getBill(r2Key);
    if (obj) {
      const bytes = await readAll(obj.body).catch(() => null);
      // `shared:` — an object in the shared bucket that CYWS owns. Read it,
      // never delete it: the same key is CYWS's own record of the message.
      if (bytes?.length) {
        return { bytes, contentType: obj.contentType || declaredType, storageKey: `shared:${r2Key}` };
      }
    }
    console.error('[whatsapp] shared R2 object unreadable, falling back to the signed URL', r2Key);
  }

  const url = String(payload.file_url ?? '').trim();
  if (!url || !allowedFileHost(url)) return null;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return null;
    const contentType = res.headers.get('content-type')?.split(';')[0].trim() || declaredType;
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    const stored = await putBillFile(scope, fileHash, contentType, bytes);
    return { bytes, contentType: stored.contentType, storageKey: stored.storageKey };
  } catch (err) {
    console.error('[whatsapp] could not fetch the file', err);
    return null;
  }
}

// --- Who the document belongs to ----------------------------------------------
// The sender's WhatsApp number, matched against the Mobile on the roster. These
// are people submitting their own company's bills, so when the number is one we
// hold, the document is theirs and says so.
//
// When it isn't — a colleague's second phone, somebody's spouse forwarding the
// utility bill — it lands on the entity's GENERAL account, which exists for
// exactly this: the documents nobody claimed. Never on whoever opened the
// group, which would put their name on work they did not do.
function ownerFor(ws: string, channel: WaChannel, senderWaId: string): string {
  // A group opened for ONE person is a conversation with that person, and that
  // is the ordinary case. Whose it is was settled when the group was made, so
  // it does not have to be worked out again from whatever WhatsApp puts in the
  // sender field — which is increasingly not a phone number at all but a LID,
  // the opaque per-user id it uses so a group doesn't leak everyone's number.
  // Matched against a roster of phone numbers, a LID is a stranger, and every
  // bill the person sent landed on the entity's General account.
  if (channel.userId) {
    const person = ensureUsers(ws).find((u: User) => u.id === channel.userId && !u.removed);
    if (person?.email) return person.email;
  }
  // The entity-wide group has several people in it, so who sent it is a real
  // question: the number, matched against the Mobile on the roster.
  const sender = mobileOf(senderWaId);
  if (sender) {
    const match = ensureUsers(ws).find(
      (u: User) =>
        !u.removed && !u.deactivated && normaliseMobile(u.mobile) === sender && canAccessOrg(u, channel.orgId)
    );
    if (match?.email) return match.email;
  }
  // Nobody we hold a number for: the entity's General account, which is what it
  // is for. Never the person who created the group.
  return generalUserFor(ws, channel.orgId)?.email ?? '';
}

// --- Already seen? ------------------------------------------------------------
// CYWS's `message_id` is stable, and CYWS does NOT retry on its own — an
// operator re-tags a message to send it again. So a repeat is either that
// deliberate re-send or a delivery we already handled, and both want the same
// answer: the document we already made, and a 2xx. Answering non-2xx would
// leave it marked undelivered and invite an operator to send it a third time.
type SeenRow = { id: string; billId: string; submissionId: string; at: string };
const SEEN = 'whatsapp-messages';
const seenMessage = (messageId: string) => loadCollection<SeenRow>(SEEN).find((r) => r.id === messageId) ?? null;
function rememberMessage(row: SeenRow): void {
  const items = loadCollection<SeenRow>(SEEN);
  items.push(row);
  saveCollection(SEEN, items);
}

// --- What actually arrived ----------------------------------------------------
// "I sent a bill into the group and nothing turned up" has two very different
// answers — CYWS never called us, or it called and we turned it away — and
// until this existed there was no way to tell them apart from inside the app.
// Every attempt is recorded, including the ones refused before a document could
// exist: a wrong key, a submission id we don't hold, a file neither the bucket
// nor the link would give up.
//
// The last 50, which is a few days of an ordinary client and enough to see a
// pattern in a bad one.
type Delivery = {
  id: string;
  at: string;
  submissionId: string;
  messageId: string;
  outcome: 'filed' | 'duplicate' | 'bad_key' | 'unknown_submission' | 'incomplete' | 'file_unavailable' | 'closed';
  detail: string;
};
const DELIVERIES = 'whatsapp-deliveries';
const MAX_DELIVERIES = 50;

function recordDelivery(row: Omit<Delivery, 'id' | 'at'>): void {
  const items = loadCollection<Delivery>(DELIVERIES);
  items.push({ id: randomBytes(6).toString('hex'), at: new Date().toISOString(), ...row });
  saveCollection(DELIVERIES, items.slice(-MAX_DELIVERIES));
}

export const recentDeliveries = (limit = 10): Delivery[] =>
  [...loadCollection<Delivery>(DELIVERIES)].reverse().slice(0, limit);

// --- Routes -------------------------------------------------------------------
export const whatsappRouter = Router();

const orgIdFor = (req: Request) => String(req.header('X-Org-Id') || '').trim();

// Only somebody who administers this entity may open a group in its name: it
// creates a real WhatsApp group and puts real phone numbers into it.
function mayManage(req: Request, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled; // dev/mock mode has no session to judge
  if (!canAccessOrg(me, orgId)) return false;
  return isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

// One person's own row, and the entity their documents are filed under.
//
// A colleague belongs to no single client entity, so theirs go where an EMAILED
// document of theirs goes: their own organisation, else the practice's primary
// one. Same rule in one more place rather than a second answer to the same
// question (inbound.ts does it for mail).
function personFor(ws: string, userId: string): { user: User; orgId: string } | null {
  const user = ensureUsers(ws).find((u) => u.id === userId && !u.removed);
  if (!user) return null;
  return { user, orgId: user.organisationId || primaryOrgId() };
}

// GET /api/whatsapp/directory — every collection group, said in names.
//
// CYWS files a document under a submission id and nothing else, so its own
// inbox can only ever show the hex: an operator looking at a group there cannot
// tell whose books it feeds, and has nothing to choose from when a group needs
// pointing at somebody. Both are the same missing fact — who a submission id
// IS — and it is a fact only this side holds.
//
// Machine-to-machine like /invoice, and allowlisted past the session guard for
// the same reason: it carries the inbound key instead of a session. Read-only,
// and deliberately no phone numbers — naming the person and the entity is the
// whole job, and a directory of everyone's mobile is not a thing to hand over
// for it. A user or entity that no longer resolves is reported as absent rather
// than skipped, because a group filing to nobody is exactly what an operator
// needs to see.
whatsappRouter.get('/directory', (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  const all = loadChannels();
  const channels = all.map((c) => {
    const person = c.userId ? personFor(c.workspaceId, c.userId) : null;
    const org = getOrganisation(c.workspaceId, c.orgId);
    return {
      submission_id: c.id,
      // Empty when this is the entity-wide group rather than one person's —
      // that is a real distinction, not a lookup that failed, so the caller is
      // told which of the two it has.
      person_name: person ? person.user.name || person.user.email || '' : '',
      person_email: person ? person.user.email || '' : '',
      entity_wide: !c.userId,
      person_missing: Boolean(c.userId && !person),
      org_id: c.orgId,
      // Falls back to the id: organisations are linked separately, so a group
      // can legitimately outlive (or precede) a named entity record.
      org_name: org?.name || '',
      // The group CYBills believes this id belongs to. CYWS compares it against
      // the chat it is about to forward from, so pointing a chat at somebody
      // else's submission shows up as a mismatch instead of silently misfiling.
      subject: c.subject,
      chat_id: c.chatId,
      status: c.status,
      // Whether a chat may be POINTED at this collection. Said here rather than
      // left for CYWS to work out from `status`, because what a status means is
      // CYBills' to know — and getting it wrong is silent: a chat assigned to a
      // superseded or closed collection goes on forwarding into a submission id
      // that nothing reads. The WhatsApp tab hides those, so the documents
      // simply would not appear, which looks exactly like nothing arriving.
      //
      // Everything is still LISTED. A group filing to nobody is precisely what
      // an operator needs to see, and hiding it would leave them wondering why
      // the id on their chat matches nothing at all.
      assignable: c.status === 'open',
      received: c.received,
      last_message_at: c.lastMessageAt,
    };
  });
  // Who a group COULD be pointed at, alongside who one already feeds. The
  // operator on the CYWS side is looking at a group that already exists and
  // asking "whose is this?" — a question a list of channels can only answer
  // for the people who already have one, which is exactly the people who need
  // nothing. Same rule as above about numbers: names and entities, never a
  // mobile.
  //
  // The GENERAL account is left out. It is the entity's unclaimed-documents
  // bucket rather than a person, so there is nobody at the far end of a group
  // opened for it.
  const ws = workspaceId(req);
  const connected = new Set(all.filter((c) => c.status === 'open' && c.userId).map((c) => c.userId));
  const people = ensureUsers(ws)
    .filter((u: User) => !u.removed && !u.deactivated && !u.general)
    .map((u: User) => {
      // Resolved exactly as personFor does, so the entity named here is the
      // entity an attach would actually file into.
      const orgId = u.organisationId || primaryOrgId();
      return {
        user_id: u.id,
        name: u.name || u.email || '',
        email: u.email || '',
        org_id: orgId,
        org_name: getOrganisation(ws, orgId)?.name || '',
        has_channel: connected.has(u.id),
      };
    });
  res.json({ channels, people });
});

// Whose number this is, and who may connect it. Your own always; otherwise
// whoever administers them — the practice for a colleague, a Business Admin for
// a client entity's own staff.
function mayManagePerson(req: Request, target: User, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled;
  if (me.id === target.id) return true;
  if (canManagePractice(me)) return true;
  return canAccessOrg(me, orgId) && isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

// The group's name as it appears in WhatsApp: the person's own CYBills address,
// `astrid4@cybills.sg`.
//
// It is the same pipe under a second name — send a bill to that address or into
// this group and it is filed under exactly the same person — so naming them the
// same thing is the truest label there is, and it is unique per person without
// having to bolt an entity onto a name. A person with no address yet falls back
// to their name.
// The whole address, suffix included — the group is named after the address
// precisely because they are one pipe, so naming it after half of one would undo
// the point. It lives in users.ts (`groupSubjectFor`) because a group is renamed
// from two places that cannot import this router, and a group opened under one
// rule and renamed under another would be worse than not renaming it at all.
const subjectFor = groupSubjectFor;

// The entity's name, for the fallback in `subjectFor` — a person with no
// address yet, whose group is called after them instead.
const orgNameFor = (ws: string, orgId: string) => getOrganisation(ws, orgId)?.name || orgId;

// GET /api/whatsapp/channels — the collection groups this entity has, or (with
// ?userId=) the one opened for a single person.
//
// The per-person lookup is deliberately NOT scoped to the header entity: a
// colleague's group is filed under the practice's own organisation while the
// browser is usually sitting in some client entity, and their own page must
// still find it.
//
// The listing also REPAIRS a group whose name has fallen behind the address it
// collects for. The rename normally rides on the change that moved the address,
// but every group opened before that existed is already wearing an old name,
// and nothing about editing a person again would ever mention it — the dialog
// only sends a handle that CHANGED, so re-saving the right one asks for
// nothing. The same repair-on-next-read the document owners and the stale claim
// names get. It costs nothing when the two already agree, which after the first
// pass is every time.
whatsappRouter.get('/channels', (req, res) => {
  const ws = workspaceId(req);
  const userId = String(req.query.userId ?? '').trim();
  if (userId) {
    const person = personFor(ws, userId);
    if (!person) return res.status(404).json({ error: 'unknown_user' });
    if (!mayManagePerson(req, person.user, person.orgId)) return res.status(403).json({ error: 'not_an_admin' });
    void renameChannelsForUser(ws, userId, subjectFor(person.user, orgNameFor(ws, person.orgId)));
    return res.json({
      channels: loadChannels().filter((c) => c.workspaceId === ws && c.userId === userId).map(publicChannel),
      enabled: whatsappEnabled,
      canManage: true,
      mobile: person.user.mobile || '',
    });
  }
  const orgId = orgIdFor(req);
  if (!orgId) return res.json({ channels: [], enabled: whatsappEnabled });
  // EVERY group this entity collects through, not just the entity-wide one.
  // Showing only the latter meant the card reported "0 bills" beside a group
  // nobody was using, while the person's own group — the one three bills had
  // just arrived through — was not on the page at all. A replaced group is left
  // out: it is superseded, and its successor is right there.
  const people = ensureUsers(ws);
  const mine = channelsForOrg(ws, orgId).filter((c) => c.status !== 'replaced');
  for (const id of new Set(mine.map((c) => c.userId).filter(Boolean))) {
    const person = people.find((u: User) => u.id === id);
    if (person) void renameChannelsForUser(ws, id, subjectFor(person, orgNameFor(ws, orgId)));
  }
  res.json({
    channels: mine
      .map((c) => ({
        ...publicChannel(c),
        personName: c.userId ? people.find((u: User) => u.id === c.userId)?.name ?? '' : '',
      })),
    enabled: whatsappEnabled,
    canManage: mayManage(req, orgId),
  });
});

// POST /api/whatsapp/channels/user — connect ONE person: open a WhatsApp group
// with them, for the entity their documents are filed under.
//
// The number comes from the form rather than from the stored row, and is SAVED
// as part of connecting. Pressing this is somebody asserting "this is their
// WhatsApp number", and it has to be the stored one or the bills that arrive
// can't be matched back to them — they would all land on the entity's General
// account instead, which is the one thing this page exists to prevent.
whatsappRouter.post('/channels/user', async (req, res) => {
  if (!whatsappEnabled) return res.status(503).json({ error: 'whatsapp_not_configured' });
  const ws = workspaceId(req);
  const userId = String(req.body?.userId ?? '').trim();
  const person = personFor(ws, userId);
  if (!person) return res.status(404).json({ error: 'unknown_user' });
  if (!mayManagePerson(req, person.user, person.orgId)) return res.status(403).json({ error: 'not_an_admin' });
  if (!person.orgId) return res.status(400).json({ error: 'org_required' });

  const asked = String(req.body?.mobile ?? person.user.mobile ?? '').trim();
  const mobile = normaliseMobile(asked);
  if (!mobile) {
    return res.status(400).json({
      error: 'participant_required',
      message: MESSAGES.participant_required,
      rejected: asked ? [asked] : [],
    });
  }
  if (normaliseMobile(person.user.mobile) !== mobile) {
    const items = ensureUsers(ws);
    const row = items.find((u) => u.id === userId);
    if (row) {
      row.mobile = asked;
      saveUsers(items);
    }
  }

  // Already connected. Two different things are being asked for here and only
  // one of them is a new group:
  //
  //   • the NUMBER changed — that is saved above, and from now on a bill from
  //     it is filed under this person. Their existing group is untouched and
  //     keeps working, so there is nothing to create.
  //   • `replace` — the caller has decided the group itself is pointed at the
  //     wrong number and wants a new one. That is a second real WhatsApp group,
  //     so it happens only when asked for in those words.
  //
  // The old group is marked replaced rather than removed: CYWS still files its
  // messages under that submission id, and anything sent into it has to keep
  // arriving until somebody deletes the group at the WhatsApp end.
  // A person can now collect through several groups (see /channels/attach), so
  // "the group" has to be chosen rather than found. The one CYBot OPENED is the
  // one this card is about — it is the only one that was opened with a number,
  // and so the only one a changed number can be said to have drifted from.
  const mine = loadChannels().filter((c) => c.workspaceId === ws && c.userId === userId && c.status === 'open');
  const live = mine.find((c) => !c.adopted) ?? mine[0] ?? null;
  if (live && req.body?.replace !== true) {
    return res.json({ ok: true, channel: publicChannel(live), unchanged: true, mobile });
  }
  // Only ever a group of OUR making. Marking an adopted conversation replaced
  // would quietly stop collecting from a chat the client is still using, on the
  // strength of somebody fixing a phone number — and CYBot cannot swap a number
  // inside a group it merely joined any more than one it opened.
  if (live && !live.adopted) patchChannel(live.id, { status: 'replaced' });

  const org = getOrganisation(ws, person.orgId);
  const me = memberForSession(req);
  const result = await createChannel(ws, person.orgId, {
    participants: [mobile],
    subject: subjectFor(person.user, org?.name || person.orgId),
    createdBy: me?.email ?? '',
    userId,
  });
  if (!result.ok) {
    return res.status(result.status === 401 ? 502 : result.status).json({
      error: result.error,
      message: result.message,
      retryable: result.retryable,
      channel: result.channel ? publicChannel(result.channel) : null,
    });
  }
  res.json({ ok: true, channel: publicChannel(result.channel), mobile, replaced: Boolean(live) });
});

// POST /api/whatsapp/channels/attach — body { user_id, chat_id, subject? }.
//
// Bind a group that ALREADY EXISTS to a person: mint their submission id
// against it and open nothing in WhatsApp.
//
// Connecting somebody (above) is the only thing that mints an id, and it makes
// a real group every time. So a client already talking to us in a group of
// their own could not be pointed at CYBills without a second, empty group
// appearing in front of them — and the first one, the one with all the bills
// in it, stayed unfiled. Adoption was already possible in the pipe (CYWS
// answers `already_existed` for an id it holds, and createChannel keeps that
// group rather than making another) but nothing could ever ASK for it: the id
// is minted inside the same call that creates the group. This is the missing
// half — the id first, the group named rather than made.
//
// Machine-to-machine like /invoice and /directory, and allowlisted past the
// session guard for the same reason: CYWS calls it from the chat its operator
// has open, proving itself with the inbound key. No mobile is asked for. The
// group exists, its members are whoever is already in it, and the number that
// matters for matching is the one on the person's row.
whatsappRouter.post('/channels/attach', (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  const ws = workspaceId(req);
  const userId = String(req.body?.user_id ?? '').trim();
  const chatId = String(req.body?.chat_id ?? '').trim();
  if (!chatId) return res.status(400).json({ error: 'chat_id_required' });
  const person = personFor(ws, userId);
  if (!person) return res.status(404).json({ error: 'unknown_user' });
  if (!person.orgId) return res.status(400).json({ error: 'org_required' });

  const items = loadChannels();
  // A person may collect through MORE THAN ONE group, and this is the route
  // where that has to be true.
  //
  // It used to refuse — one person, one group — on the reasoning that a second
  // id would split their bills across two collections with nothing saying which
  // is current. That reasoning is right for OPENING a group and wrong for
  // adopting one: the conversation already exists and people are already
  // sending bills into it, so refusing does not prevent a split. It forces an
  // ALIAS instead — the operator's only way to point the chat at somebody is to
  // hand it the submission id of a group they already have — and two chats on
  // one id is strictly worse, because CYBills cannot then tell them apart at
  // all: one row in the WhatsApp tab, one thread, two conversations folded into
  // it. That is how a bridge chat came to appear as somebody's personal group.
  //
  // Nothing actually splits. Both channels carry the same `userId`, so the
  // documents file under the same person in the same book. What stays separate
  // is the THREAD and its counts, which is correct — they are separate
  // conversations, and the whole point of the tab is to show what was said in
  // each. Opening a second group is still refused (see /channels/user): that
  // one would put a needless empty group in front of a client.
  //
  // One group, one person, though. Two open channels on one chat id would file
  // the same bill into two people's books.
  const taken = items.find((c) => c.chatId === chatId && c.status === 'open');
  if (taken) {
    return res.status(409).json({
      error: 'chat_in_use',
      message: `That group already files under ${taken.id}.`,
      channel: publicChannel(taken),
    });
  }

  const channel: WaChannel = {
    id: mintSubmissionId(person.orgId),
    workspaceId: ws,
    orgId: person.orgId,
    userId,
    // CYWS sends the group's real WhatsApp name, which is what the operator
    // there is looking at. Falls back to the address-derived name a group we
    // opened ourselves would have carried.
    subject: String(req.body?.subject ?? '').trim()
      || subjectFor(person.user, getOrganisation(ws, person.orgId)?.name || person.orgId),
    chatId,
    status: 'open',
    // Somebody else's conversation, borrowed. Recorded now because the moment
    // it matters is much later, when a person is deciding whether closing this
    // collection should also take the group apart.
    adopted: true,
    // Nothing was asked of WhatsApp, so there is nothing to measure a shortfall
    // against. Left explicitly UNKNOWN rather than empty — empty-and-known is
    // how the card says "everybody refused to join", which is a lie about a
    // group that has been running for months.
    participantsRequested: [],
    participantsAdded: [],
    participantsKnown: false,
    createdAt: new Date().toISOString(),
    createdBy: 'cyworkspace',
    openedAt: new Date().toISOString(),
    lastError: '',
    lastMessageAt: '',
    received: 0,
  };
  items.push(channel);
  saveChannels(items);
  console.log(`[whatsapp] attached existing group ${chatId} to ${person.user.email || userId} as ${channel.id}`);
  res.json({ ok: true, channel: publicChannel(channel) });
});

// POST /api/whatsapp/channels — body { mobile? | participants?, subject? }.
// Creates the WhatsApp group for this entity, or resumes a half-made one.
whatsappRouter.post('/channels', async (req, res) => {
  if (!whatsappEnabled) return res.status(503).json({ error: 'whatsapp_not_configured' });
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!orgId) return res.status(400).json({ error: 'org_required' });
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'not_an_admin' });

  const raw: unknown = Array.isArray(req.body?.participants)
    ? req.body.participants
    : [req.body?.mobile].filter(Boolean);
  const asked = (raw as unknown[]).map((p) => String(p ?? '').trim()).filter(Boolean);
  const participants = asked.map(normaliseMobile).filter(Boolean);
  // Name the number that was wrong rather than refusing the lot silently: a
  // typo'd digit and a number in national format look identical in a toast.
  const rejected = asked.filter((p) => !normaliseMobile(p));
  if (!participants.length) {
    return res.status(400).json({
      error: 'participant_required',
      message: MESSAGES.participant_required,
      rejected,
    });
  }

  const org = getOrganisation(ws, orgId);
  const subject = String(req.body?.subject || '').trim() || `CYBills - ${org?.name || orgId}`;
  const me = memberForSession(req);
  const result = await createChannel(ws, orgId, {
    participants,
    subject,
    createdBy: me?.email ?? '',
  });
  if (!result.ok) {
    return res.status(result.status === 401 ? 502 : result.status).json({
      error: result.error,
      message: result.message,
      retryable: result.retryable,
      channel: result.channel ? publicChannel(result.channel) : null,
    });
  }
  res.json({ ok: true, channel: publicChannel(result.channel), rejected });
});

// A collection that has been shut. Enforced HERE rather than trusted to stop at
// CYWS, because "CYBills has stopped collecting through this group" is CYBills'
// own decision and must hold even when the call asking CYWS to stop forwarding
// never landed. A REPLACED channel is deliberately not closed: its group is
// still live, and anything sent into it has to keep arriving.
const isClosed = (c: WaChannel) => c.status === 'disconnected' || c.status === 'deleted';

// --- Closing a collection down -----------------------------------------------
// Two acts, and they are not degrees of one another:
//
//   Stop collecting  — CYBills forgets the group. It carries on in WhatsApp
//                      exactly as it was, with everyone still in it.
//   Delete the group — CYBot removes everyone and leaves.
//
// Both are offered for every group, whoever opened it, because only the person
// pressing the button knows which they mean. A group CYBills opened for one
// colleague is usually finished with; a client's own conversation that was
// merely POINTED at CYBills is theirs, and taking it apart from an accounting
// app would be destroying something that was never ours.
//
// What is NOT touched either way: the documents already collected (they are
// accounting records, and they belong to the book, not to the group) and the
// mirrored thread (it is the record of what was said). The channel row survives
// too — every one of those references its submission id.

/** Ask CYWS to close a group down. Unlike a reaction this is REPORTED, never
 * best-effort: a group somebody believes is gone, that is still sitting in
 * front of a client, is the failure that matters here. */
async function askToDeleteGroup(body: { submission_id: string; keep_group: boolean }): Promise<
  { ok: true; removed: number; left: boolean } | { ok: false; status: number; error: string; message: string }
> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) {
    return { ok: false, status: 503, error: 'whatsapp_not_configured', message: 'CYWorkspace is not connected on this deployment.' };
  }
  const url = `${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/delete-group`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': env.CYWORKSPACE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      // Emptying a group is one call per member at the far end, so it is given
      // longer than the 30s a create gets.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error('[whatsapp] CYWS unreachable (delete-group)', err);
    return { ok: false, status: 502, error: 'relay_unreachable', message: MESSAGES.relay_unreachable };
  }
  const payload = (await res.json().catch(() => null)) as { data?: { removed?: number; left?: boolean }; error?: string; message?: string } | null;
  if (res.ok) return { ok: true, removed: Number(payload?.data?.removed ?? 0), left: Boolean(payload?.data?.left) };
  // CYWS writes these for a person to read — "could not remove everyone, so the
  // group was left alone rather than half-dismantled" — so they are passed
  // through rather than restated as a status code.
  return {
    ok: false,
    status: res.status,
    error: String(payload?.error ?? 'delete_failed'),
    message: String(payload?.message ?? `CYWorkspace returned ${res.status}.`),
  };
}

/** The channel, and whether this caller may close it. A group opened for one
 * person is administered by whoever administers THEM; an entity-wide one by an
 * admin of the entity it collects for. Same two rules that opened it. */
function channelToClose(req: Request, submissionId: string): { channel: WaChannel; error?: undefined } | { channel?: undefined; error: { status: number; body: object } } {
  const ws = workspaceId(req);
  const channel = channelById(submissionId);
  if (!channel || channel.workspaceId !== ws) return { error: { status: 404, body: { error: 'unknown_channel' } } };
  const person = channel.userId ? personFor(ws, channel.userId) : null;
  const allowed = person ? mayManagePerson(req, person.user, person.orgId) : mayManage(req, channel.orgId);
  if (!allowed) return { error: { status: 403, body: { error: 'not_an_admin' } } };
  return { channel };
}

// POST /api/whatsapp/channels/:submissionId/close — body { deleteGroup?: boolean }
//
// One route for both, because they are one decision with two answers and
// splitting them would let the UI drift into offering a third.
whatsappRouter.post('/channels/:submissionId/close', async (req, res) => {
  const found = channelToClose(req, String(req.params.submissionId ?? ''));
  if (found.error) return res.status(found.error.status).json(found.error.body);
  const channel = found.channel;

  const deleteGroup = req.body?.deleteGroup === true;
  // Already closed. Answered as success with what is true now: somebody pressing
  // it twice wants the group gone, and it is.
  if (channel.status === 'disconnected' || channel.status === 'deleted') {
    return res.json({ ok: true, channel: publicChannel(channel), already: true });
  }

  // A group that was never opened has nothing at the far end to close — the
  // submission id was minted and the call failed or never went out. Forgetting
  // it locally is the whole of it, and asking CYWS about a group it has never
  // heard of would 404 and read as a failure.
  const atFarEnd = Boolean(channel.chatId);
  if (atFarEnd) {
    const out = await askToDeleteGroup({ submission_id: channel.id, keep_group: !deleteGroup });
    if (!out.ok) {
      // Nothing is marked closed. The group is still collecting, and saying
      // otherwise here would leave documents arriving into a collection the
      // page says is shut.
      patchChannel(channel.id, { lastError: out.message });
      return res.status(out.status).json({ error: out.error, message: out.message, retryable: out.error === 'relay_unreachable' });
    }
    const updated = patchChannel(channel.id, {
      status: deleteGroup ? 'deleted' : 'disconnected',
      lastError: '',
    });
    return res.json({
      ok: true,
      channel: updated ? publicChannel(updated) : publicChannel(channel),
      removed: out.removed,
      left: out.left,
      deleted: deleteGroup,
    });
  }

  const updated = patchChannel(channel.id, { status: 'disconnected', lastError: '' });
  res.json({ ok: true, channel: updated ? publicChannel(updated) : publicChannel(channel), removed: 0, left: false, deleted: false });
});

// GET /api/whatsapp/config — what the CYWS operator needs: where to POST, and
// the key to send with it.
//
// PRACTICE TEAM ONLY, and for the same reason the inbound-email secret is: this
// key authorises filing documents into ANY client entity's book, so it belongs
// to the deployment rather than to whichever entity happens to be open.
whatsappRouter.get('/config', (req, res) => {
  const member = memberForSession(req);
  if (member && (!member.practice || member.deactivated)) {
    return res.status(403).json({ error: 'not_practice_team' });
  }
  if (!member && googleEnabled) return res.status(403).json({ error: 'forbidden' });
  res.json({
    url: `${appOrigin(req)}/api/whatsapp/invoice`,
    apiKey: inboundKey(),
    enabled: whatsappEnabled,
    // So "nothing turned up" can be answered rather than guessed at.
    deliveries: recentDeliveries(),
  });
});

// --- Testing it without CYWorkspace -------------------------------------------
// A one-page PDF, assembled here so a test delivery carries a real file rather
// than a blob the viewer can't open. Offsets are computed rather than typed:
// a PDF with a wrong xref opens in some readers and not others, which is
// exactly the ambiguity a test is supposed to remove.
function testPdf(line: string): Buffer {
  const body = `BT /F1 13 Tf 24 74 Td (CYBills test delivery) Tj 0 -22 Td (${line}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${body.length}>>stream\n${body}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj${o}endobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// POST /api/whatsapp/test — deliver one document the way CYWorkspace would.
//
// Until CYWS is wired up there is no way to find out whether THIS side works,
// and "nothing turned up" is the least useful bug report there is. So the
// server posts to its own public endpoint, over the real URL, with the real
// key, naming a real group: if a document appears, everything from the network
// in — reachability, the key, the group lookup, the shared bucket, filing,
// reading — is working, and what is left is CYWS's half. It shows up in the
// delivery log like any other call, because it IS one.
whatsappRouter.post('/test', async (req, res) => {
  const member = memberForSession(req);
  if (member && (!member.practice || member.deactivated)) {
    return res.status(403).json({ error: 'not_practice_team' });
  }
  if (!member && googleEnabled) return res.status(403).json({ error: 'forbidden' });

  const ws = workspaceId(req);
  const wanted = String(req.body?.submissionId ?? '').trim();
  // The group named, else this person's own, else the entity's.
  const channel =
    (wanted ? channelById(wanted) : null) ||
    loadChannels().find((c) => c.workspaceId === ws && c.userId === member?.id && c.status === 'open') ||
    loadChannels().find((c) => c.workspaceId === ws && c.orgId === orgIdFor(req) && c.status === 'open');
  if (!channel) return res.status(400).json({ error: 'no_group', message: 'No WhatsApp group has been set up yet.' });

  // The file half only exists when the shared bucket does. Said plainly rather
  // than failing at `file_unavailable`, which would look like a fault.
  if (!r2Enabled) {
    return res.status(503).json({
      error: 'no_bucket',
      message: 'R2 is not configured on this deploy, so there is no shared bucket to put a test file in.',
    });
  }

  const bytes = testPdf('Safe to delete.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const key = `bills/${dataScopeForOrg(channel.orgId)}/${hash}.pdf`;
  // Written with the RAW bucket call, not through putBillFile: that one catches
  // an R2 failure and quietly writes to local disk instead, which is right for
  // a receipt (never lose the bytes) and useless here. This test exists to find
  // out whether the SHARED bucket works — the thing the whole integration rests
  // on — so the error has to come back rather than be recovered from, and it is
  // reported in the far end's own words. Same bytes every time, so however
  // often the button is pressed there is only ever one such object.
  try {
    await putBill(key, bytes, 'application/pdf');
  } catch (err) {
    // Worth saying what this does and does not break, because the two are
    // easily confused and only one of them is urgent. A REAL inbound bill is
    // never written to the bucket — CYWorkspace has already put it there, and
    // CYBills only reads it back by key (see fetchDocument). So a write
    // permission stops uploads through the app, and stops this test, which has
    // to put a file there to have something to deliver. It does not, on its
    // own, stop WhatsApp.
    return res.status(502).json({
      error: 'store_failed',
      message:
        `Could not write to the R2 bucket "${env.R2_BUCKET}": ${err instanceof Error ? err.message : String(err)}. ` +
        'That blocks uploads and this test, which needs to put a file in the bucket first — but not inbound ' +
        'WhatsApp bills, which are only ever read from it.',
    });
  }
  // And read back, because writing to a bucket nobody can read from would pass
  // a test the real path then fails.
  const readable = await getBill(key);
  if (!readable) {
    return res.status(502).json({
      error: 'read_failed',
      message: `Wrote ${key} to "${env.R2_BUCKET}" but could not read it back.`,
    });
  }

  const url = `${appOrigin(req)}/api/whatsapp/invoice`;
  let reply: { status: number; body: Record<string, unknown> };
  try {
    const out = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': inboundKey() },
      body: JSON.stringify({
        submission_id: channel.id,
        chat_id: channel.chatId,
        chat_subject: channel.subject,
        // A new id every time, so the test is never answered "already had it".
        message_id: `cybills-test-${randomBytes(6).toString('hex')}`,
        r2_key: key,
        file_name: 'cybills-test-delivery.pdf',
        content_type: 'application/pdf',
        body: 'Test delivery from CYBills. Safe to delete.',
        sender_name: member?.name || 'CYBills',
        sender: `${normaliseMobile(member?.mobile || '') || '0'}@c.us`,
        sent_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    reply = { status: out.status, body: (await out.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (err) {
    // The endpoint could not be reached from the server itself — which is a
    // real finding, and the one CYWS would hit too.
    return res.status(502).json({
      error: 'unreachable',
      message: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      url,
    });
  }

  if (reply.status !== 200) {
    return res.status(502).json({ error: String(reply.body?.error ?? 'refused'), status: reply.status, url });
  }
  res.json({
    ok: true,
    url,
    group: channel.subject,
    orgId: channel.orgId,
    itemId: String(reply.body?.item_id ?? ''),
    billId: String(reply.body?.bill_id ?? ''),
  });
});

// --- The conversation itself --------------------------------------------------
// A collection group is a conversation, and until now CYBills only ever saw the
// documents CYWS picked out of it — so "I sent that last week" could not be
// answered here at all, and a receipt the classifier called a holiday photo
// vanished silently. CYWS now mirrors EVERY message, text included, and the
// WhatsApp tab is where they are read.
//
// Kept separate from the cost document a message may also become. The mirror is
// the record of what was said; filing is an accounting act performed on one of
// them, and `billId` below is the link once somebody does it.

// What the reader can call an attachment that makes it a COST. Both are records
// of money spent — an invoice that bills the business, and proof a purchase was
// already paid — so both are filed on arrival. Everything else it can say (a
// bank statement, a sales invoice, a photo of a cat) is kept in the thread and
// filed by nobody unless a person says otherwise.
const FILEABLE = new Set(['supplier_bill', 'receipt']);
/**
 * Files one WhatsApp document as a cost document, and starts the read.
 *
 * ONE builder, because there are now two ways in and they must not drift: CYWS
 * handing over a bill its classifier picked out (/invoice), and a reviewer
 * pressing the button on the WhatsApp tab for one it classified as something
 * else. The second exists precisely because the model is guessing from a photo
 * while the person looking at it knows — so it has to produce exactly the
 * document the first one would have.
 *
 * The read is deliberately NOT awaited. It comes back as `finishRead` so the
 * caller can answer first: a model call takes 10-30s and CYWS gives up at 30.
 */
async function fileWhatsappDocument(
  req: Request,
  channel: WaChannel,
  b: Record<string, any>,
): Promise<{ ok: false } | { ok: true; bill: ReturnType<typeof insertBill>; orgId: string; finishRead: () => void }> {
  const ws = channel.workspaceId;
  const orgId = channel.orgId;
  const scope = dataScopeForOrg(orgId);
  // Attribute the read's API spend to this client entity on the Clients page
  // (recordUsage reads the header; CYWS sends none).
  (req.headers as Record<string, string>)['x-org-id'] = orgId;

  const file = await fetchDocument(scope, b);
  if (!file) return { ok: false };

  const fileHash = createHash('sha256').update(file.bytes).digest('hex');
  const sentAt = String(b.sent_at ?? '');
  const owner = ownerFor(ws, channel, String(b.sender ?? ''));
  // What the sender typed when they attached the file. This is the covering
  // note — "recharge this to CY-Biz" — and it is kept on the document so a
  // RE-READ sees it too: read once with it and again without, and the second
  // read quietly undoes the first.
  const message = {
    submissionId: channel.id,
    chatId: String(b.chat_id ?? channel.chatId),
    chatSubject: String(b.chat_subject ?? channel.subject),
    messageId: String(b.message_id ?? ''),
    waMessageId: String(b.wa_message_id ?? ''),
    from: String(b.sender ?? ''),
    senderName: String(b.sender_name ?? ''),
    text: String(b.body ?? '').trim().slice(0, 4000),
    sentAt,
    fileName: String(b.file_name ?? ''),
  };

  const bill = insertBill({
    orgId: scope,
    fileHash,
    fileName: message.fileName || 'whatsapp-document',
    supplier: '',
    invoiceNumber: '',
    documentType: '',
    currency: '',
    total: 0,
    tax: 0,
    date: '',
    category: '',
    // Who UPLOADED it is the person who sent it in; the owner is resolved the
    // same way (they are the same person whenever we hold their number).
    createdBy: owner,
    owner,
    whatsapp: message,
    storageKey: file.storageKey,
    contentType: file.contentType,
    // Being read — `finishRead` below starts it and autoRead clears the status
    // when it settles, the same as an emailed document.
    status: 'processing',
    kind: 'cost',
  });

  patchChannel(channel.id, {
    lastMessageAt: sentAt || new Date().toISOString(),
    received: (channel.received || 0) + 1,
  });

  const finishRead = () => {
    const settings = readSetting<{ readerProvider?: string }>(ws, 'cybills.extraction-settings.v1', orgId);
    const provider = resolveProvider(settings?.readerProvider);
    // The tick goes on when the READ settles, not when the file lands: a
    // document nothing could be got off gets no tick, and that silence is the
    // signal to send a clearer photo. autoRead swallows its own failures, so
    // this runs either way and `reactionFor` decides from what the read left
    // behind.
    void autoRead(req, scope, orgId, provider, bill.id, file.bytes.toString('base64'), file.contentType, {
      via: 'whatsapp',
      from: message.senderName || mobileOf(message.from),
      text: message.text,
    })
      .then(() => syncWhatsappReaction(scope, bill.id))
      .catch((err) => console.error('[whatsapp] read/react failed', err));
  };

  return { ok: true, bill, orgId, finishRead };
}

// POST /api/whatsapp/invoice — CYWS hands over one supplier bill.
//
// Called machine-to-machine, so it carries its own proof (X-API-Key) instead of
// a session, and is allowlisted past the session guard in index.ts.
whatsappRouter.post('/invoice', async (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) {
    // Logged without echoing the key back or storing it: what matters is that
    // somebody IS calling and being turned away, which is the difference
    // between a misconfigured CYWS and a silent one.
    recordDelivery({ submissionId: '', messageId: '', outcome: 'bad_key', detail: 'X-API-Key did not match' });
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  const b = req.body ?? {};
  const submissionId = String(b.submission_id ?? '').trim();
  const messageId = String(b.message_id ?? '').trim();
  if (!submissionId || !messageId) {
    recordDelivery({
      submissionId,
      messageId,
      outcome: 'incomplete',
      detail: submissionId ? 'no message_id' : 'no submission_id',
    });
    return res.status(400).json({ error: submissionId ? 'message_id_required' : 'submission_id_required' });
  }

  const channel = channelById(submissionId);
  // A submission CYBills has no record of. Deliberately not "create one": the
  // whole point of the id is that it names an entity's book, and guessing which
  // one would file a client's bills into somebody else's.
  if (!channel) {
    recordDelivery({ submissionId, messageId, outcome: 'unknown_submission', detail: 'no group here under that id' });
    return res.status(404).json({ error: 'unknown_submission', submission_id: submissionId });
  }

  if (isClosed(channel)) {
    recordDelivery({ submissionId, messageId, outcome: 'closed', detail: `${channel.subject} was ${channel.status}` });
    return res.status(409).json({ error: 'channel_closed', submission_id: submissionId });
  }

  const already = seenMessage(messageId);
  if (already) {
    recordDelivery({ submissionId, messageId, outcome: 'duplicate', detail: already.billId });
    return res.json({ ok: true, duplicate: true, bill_id: already.billId });
  }

  const filed = await fileWhatsappDocument(req, channel, b);
  if (!filed.ok) {
    recordDelivery({
      submissionId,
      messageId,
      outcome: 'file_unavailable',
      detail: String(b.r2_key ?? b.file_name ?? ''),
    });
    return res.status(502).json({ error: 'file_unavailable' });
  }
  const { bill, orgId, finishRead } = filed;

  rememberMessage({ id: messageId, billId: bill.id, submissionId, at: new Date().toISOString() });
  recordDelivery({
    submissionId,
    messageId,
    outcome: 'filed',
    detail: `${bill.fileName || 'document'} → ${bill.displayId}`,
  });

  // Answer as soon as it is durably stored, then read it in the background: a
  // model call takes 10-30s, CYWS gives up at 30, and it does not retry — so a
  // slow read must never be what decides whether the bill was delivered.
  res.json({ ok: true, bill_id: bill.id, item_id: bill.displayId, org_id: orgId });
  finishRead();
});

// POST /api/whatsapp/message — CYWS mirrors one message from a collection group.
//
// Machine-to-machine like /invoice: its own X-API-Key, allowlisted past the
// session guard. Everything arrives, text included — this is the conversation,
// not the accounting, and a message nobody files is still what somebody said.
//
// Upserts on WhatsApp's own message id, because CYWS sends a message TWICE by
// design: once the moment it lands (so the thread is live) and again once its
// classifier has decided what the attachment is. The second must revise the
// first, not sit beside it.
whatsappRouter.post('/message', async (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) {
    recordDelivery({ submissionId: '', messageId: '', outcome: 'bad_key', detail: 'X-API-Key did not match (message mirror)' });
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  const b = req.body ?? {};
  const submissionId = String(b.submission_id ?? '').trim();
  const waMessageId = String(b.wa_message_id ?? '').trim();
  // CYWS's own row id for the message. Only used to recognise a document the
  // RETIRED /invoice path already filed: that path deduped on this id, the
  // mirror dedups on WhatsApp's, and without checking both a message filed
  // before the two were merged would be filed a second time the first time it
  // is mirrored. Every such document is already in somebody's Costs inbox.
  const cywsMessageId = String(b.message_id ?? '').trim();
  if (!submissionId) return res.status(400).json({ error: 'submission_id_required' });
  if (!waMessageId) return res.status(400).json({ error: 'wa_message_id_required' });

  const channel = channelById(submissionId);
  // Same refusal as /invoice, for the same reason: the id is what names the
  // entity, and a group we have no record of belongs to nobody here.
  if (!channel) return res.status(404).json({ error: 'unknown_submission', submission_id: submissionId });

  if (isClosed(channel)) {
    recordDelivery({ submissionId, messageId: waMessageId, outcome: 'closed', detail: `${channel.subject} was ${channel.status}` });
    return res.status(409).json({ error: 'channel_closed', submission_id: submissionId });
  }

  const items = loadMessages();
  const existing = items.find((m) => m.id === waMessageId);
  const incomingCategory = String(b.doc_category ?? '');

  const row: WaMirroredMessage = {
    id: waMessageId,
    submissionId,
    workspaceId: channel.workspaceId,
    orgId: channel.orgId,
    chatId: String(b.chat_id ?? channel.chatId),
    direction: String(b.direction ?? 'in'),
    sender: String(b.sender ?? ''),
    senderName: String(b.sender_name ?? ''),
    body: String(b.body ?? '').slice(0, 8000),
    translation: String(b.translation ?? '').slice(0, 8000),
    msgType: String(b.msg_type ?? 'chat'),
    r2Key: String(b.r2_key ?? ''),
    fileUrl: String(b.file_url ?? ''),
    fileName: String(b.file_name ?? ''),
    contentType: String(b.content_type ?? ''),
    // A correction made here outranks anything CYWS says later. Its classifier
    // is guessing from a photo; somebody who opened the document is not, and
    // having their answer quietly replaced on the next re-send would make the
    // correction pointless.
    docCategory: existing?.categorySource === 'manual' ? existing.docCategory : incomingCategory,
    categorySource: existing?.categorySource === 'manual' ? 'manual' : (incomingCategory ? 'cyws' : ''),
    categoryConfidence: existing?.categorySource === 'manual' ? '' : String(b.doc_confidence ?? ''),
    replyToBody: String(b.reply_to_body ?? ''),
    reaction: String(b.reaction ?? ''),
    sentAt: String(b.sent_at ?? new Date().toISOString()),
    receivedAt: existing?.receivedAt || new Date().toISOString(),
    // Filing is this side's act, and it survives a re-send. A document the old
    // /invoice path filed is adopted by its id rather than re-filed, so the
    // thread shows it as filed instead of offering to file it again.
    billId: existing?.billId || (cywsMessageId ? seenMessage(cywsMessageId)?.billId || '' : ''),
    billDisplayId: existing?.billDisplayId || '',
  };

  // Work with the row that is actually IN the collection from here on. When a
  // message is being revised, `row` is a detached copy that gets assigned into
  // `existing` — so stamping the filed bill onto `row` wrote it nowhere, and
  // the document was filed while the thread went on showing it as unfiled with
  // a button to file it again.
  let stored: WaMirroredMessage;
  if (existing) {
    Object.assign(existing, row);
    stored = existing;
  } else {
    items.push(row);
    stored = row;
  }
  saveMessages(items);

  // The group's own "last heard from" follows the conversation, not just the
  // documents — a group that is busy but files nothing is not a quiet group.
  if (!existing) patchChannel(submissionId, { lastMessageAt: stored.sentAt });

  // If the reader says this is a cost, file it now. One post per message
  // carries both the conversation and the verdict, and this is where the
  // verdict is acted on — so a bill is never posted twice (once to be filed and
  // once to be shown), which is what left it sitting in the thread with an
  // "Add to Costs" button that would have made a second copy of a document
  // already in the inbox.
  //
  // Guarded three ways because the classification arrives on a RE-SEND, so this
  // path runs again for a message already handled: not already filed here, not
  // already delivered under this id, and there has to be a file at all.
  const alreadyDelivered = Boolean(seenMessage(stored.id) || (cywsMessageId && seenMessage(cywsMessageId)));
  if (!stored.billId && FILEABLE.has(stored.docCategory) && (stored.r2Key || stored.fileUrl) && !alreadyDelivered) {
    const filed = await fileWhatsappDocument(req, channel, {
      chat_id: stored.chatId,
      chat_subject: channel.subject,
      message_id: stored.id,
      wa_message_id: stored.id,
      r2_key: stored.r2Key,
      file_url: stored.fileUrl,
      file_name: stored.fileName,
      content_type: stored.contentType,
      body: stored.body,
      sender: stored.sender,
      sender_name: stored.senderName,
      sent_at: stored.sentAt,
    });
    if (filed.ok) {
      stored.billId = filed.bill.id;
      stored.billDisplayId = filed.bill.displayId;
      saveMessages(items);
      rememberMessage({ id: stored.id, billId: filed.bill.id, submissionId, at: new Date().toISOString() });
      recordDelivery({
        submissionId,
        messageId: stored.id,
        outcome: 'filed',
        detail: (stored.fileName || 'document') + ' -> ' + filed.bill.displayId + ' (' + stored.docCategory + ')',
      });
      // Answer before the read, same as /invoice: a model call takes 10-30s and
      // CYWS gives up at 30.
      res.json({ ok: true, updated: Boolean(existing), filed: true, bill_id: filed.bill.id, item_id: filed.bill.displayId });
      filed.finishRead();
      return;
    }
    recordDelivery({
      submissionId,
      messageId: stored.id,
      outcome: 'file_unavailable',
      detail: stored.r2Key || stored.fileName || '',
    });
    // The message is still mirrored — losing the conversation because the file
    // could not be read would be worse — and the tab's own button can retry.
    return res.json({ ok: true, updated: Boolean(existing), filed: false, error: 'file_unavailable' });
  }

  return res.json({ ok: true, updated: Boolean(existing), filed: false });
});

// GET /api/whatsapp/threads — the collection groups of the entity in the header,
// each with what has actually arrived in it. This is the WhatsApp tab's index.
whatsappRouter.get('/threads', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!orgId) return res.json({ threads: [], canManage: false });
  const me = memberForSession(req);
  if (googleEnabled && (!me || !canAccessOrg(me, orgId))) return res.status(403).json({ error: 'no_client_access' });

  const all = loadMessages().filter((m) => m.workspaceId === ws && m.orgId === orgId);
  const forOrg = channelsForOrg(ws, orgId);
  // What the page is FOR is the groups bills are still arriving through, so a
  // collection that has been closed, superseded or deleted drops out of the
  // default list. It is not thrown away — `?all=1` brings them back, and the
  // thread itself always opens by id — because the conversation is the record
  // of what was said and closing a group does not unsay it.
  //
  // Same shape as the Costs tab's Unpublished / All costs: one list, a toggle
  // saying how much of it to look at, and a count on each so neither is a
  // guess.
  const collecting = (c: WaChannel) => c.status !== 'replaced' && !isClosed(c);
  const showAll = String(req.query.all ?? '') === '1';
  const threads = forOrg
    .filter((c) => showAll || collecting(c))
    .map((c) => {
      const mine = all.filter((m) => m.submissionId === c.id);
      const last = mine.reduce<WaMirroredMessage | null>((acc, m) => (!acc || String(m.sentAt) > String(acc.sentAt) ? m : acc), null);
      const person = c.userId ? personFor(ws, c.userId) : null;
      return {
        submissionId: c.id,
        subject: c.subject,
        chatId: c.chatId,
        status: c.status,
        personName: person ? person.user.name || person.user.email || '' : '',
        entityWide: !c.userId,
        messages: mine.length,
        attachments: mine.filter((m) => m.r2Key).length,
        // What is sitting there un-actioned: an attachment nobody has filed.
        unfiled: mine.filter((m) => m.r2Key && !m.billId).length,
        lastMessageAt: last?.sentAt || c.lastMessageAt || '',
        lastMessagePreview: last ? (last.body ? last.body.slice(0, 120) : '[' + last.msgType + ']') : '',
      };
    })
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));

  // Both counts, always, so the toggle can say how much it is hiding without a
  // second request — and so "All groups" never looks like it would show the
  // same thing.
  const collectingCount = forOrg.filter(collecting).length;
  res.json({
    threads,
    collecting: collectingCount,
    total: forOrg.length,
    showingAll: showAll,
    canManage: mayManage(req, orgId),
  });
});

// GET /api/whatsapp/threads/:submissionId — one conversation, oldest first.
whatsappRouter.get('/threads/:submissionId', (req, res) => {
  const channel = channelById(String(req.params.submissionId ?? ''));
  if (!channel) return res.status(404).json({ error: 'unknown_submission' });
  const me = memberForSession(req);
  if (googleEnabled && (!me || !canAccessOrg(me, channel.orgId))) return res.status(403).json({ error: 'no_client_access' });

  const person = channel.userId ? personFor(channel.workspaceId, channel.userId) : null;
  res.json({
    channel: {
      submissionId: channel.id,
      subject: channel.subject,
      chatId: channel.chatId,
      status: channel.status,
      // Whether CYBot opened this group or merely joined a conversation the
      // client already had. The close control asks, because emptying somebody
      // else's group is not the same act as ending one of ours.
      adopted: Boolean(channel.adopted),
      personName: person ? person.user.name || person.user.email || '' : '',
      entityWide: !channel.userId,
    },
    messages: messagesForChannel(channel.id).map((m) => ({
      ...m,
      // Never the raw sender id. WhatsApp increasingly sends a LID
      // ('127676509610071@lid') — an opaque per-user id, not a number and not
      // convertible to one — so showing it puts a meaningless 15-digit string
      // where a name belongs. A group opened for one person is a conversation
      // with that person, which was settled when it was made, so that is the
      // answer; an entity-wide group falls back to the number when there
      // really is one.
      senderLabel: m.direction === 'out'
        ? 'Us'
        : m.senderName
          || (person ? person.user.name || person.user.email : '')
          || (mobileOf(m.sender) ? `+${mobileOf(m.sender)}` : '')
          || 'Unknown',
      // The number to reply on, and the id to trace by — separate fields
      // because they are separate things. WhatsApp increasingly identifies a
      // sender only by a LID, which is not a number and cannot be turned into
      // one; the number then comes from the roster row of the person the group
      // was opened for, which is the number somebody would actually message.
      senderNumber: m.direction === 'out'
        ? ''
        : (mobileOf(m.sender) ? `+${mobileOf(m.sender)}` : (person ? normaliseMobile(person.user.mobile || '') && `+${normaliseMobile(person.user.mobile || '')}` : '')) || '',
      // Shown as-is so a message can always be traced back to a sender, even
      // when all WhatsApp gave us was an opaque id.
      senderId: m.direction === 'out' ? '' : String(m.sender || ''),
    })),
    canManage: mayManage(req, channel.orgId),
  });
});

// PATCH /api/whatsapp/messages/:id — correct what the document is.
//
// The classifier reads a photo; the reviewer reads the document. When they
// disagree the reviewer wins, and the answer is marked `manual` so CYWS's next
// re-send leaves it alone.
whatsappRouter.patch('/messages/:id', (req, res) => {
  const items = loadMessages();
  const row = items.find((m) => m.id === String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'unknown_message' });
  if (!mayManage(req, row.orgId)) return res.status(403).json({ error: 'not_an_admin' });

  const category = String(req.body?.doc_category ?? '').trim();
  row.docCategory = category;
  row.categorySource = category ? 'manual' : '';
  // A person's answer has no confidence score; they read the document.
  row.categoryConfidence = '';
  saveMessages(items);
  res.json({ ok: true, message: row });
});

// POST /api/whatsapp/messages/:id/file — file this attachment as a cost document.
//
// The manual counterpart to CYWS's own hand-off, for everything its classifier
// did not send: a receipt it called a photo, an invoice it was unsure about.
// Goes through the same builder, so what lands is the same document.
whatsappRouter.post('/messages/:id/file', async (req, res) => {
  const items = loadMessages();
  const row = items.find((m) => m.id === String(req.params.id ?? ''));
  if (!row) return res.status(404).json({ error: 'unknown_message' });
  if (!mayManage(req, row.orgId)) return res.status(403).json({ error: 'not_an_admin' });
  if (!row.r2Key && !row.fileUrl) return res.status(400).json({ error: 'no_attachment', message: 'This message has no file to file.' });
  // Already filed. Answered with the document rather than an error, because
  // "it is already there" is what whoever pressed it wants to know.
  if (row.billId) return res.json({ ok: true, already: true, bill_id: row.billId, item_id: row.billDisplayId });

  const channel = channelById(row.submissionId);
  if (!channel) return res.status(404).json({ error: 'unknown_submission' });

  const filed = await fileWhatsappDocument(req, channel, {
    chat_id: row.chatId,
    chat_subject: channel.subject,
    message_id: row.id,
    wa_message_id: row.id,
    r2_key: row.r2Key,
    file_url: row.fileUrl,
    file_name: row.fileName,
    content_type: row.contentType,
    body: row.body,
    sender: row.sender,
    sender_name: row.senderName,
    sent_at: row.sentAt,
  });
  if (!filed.ok) return res.status(502).json({ error: 'file_unavailable', message: 'The attachment could not be read from storage.' });

  row.billId = filed.bill.id;
  row.billDisplayId = filed.bill.displayId;
  saveMessages(items);
  recordDelivery({
    submissionId: row.submissionId,
    messageId: row.id,
    outcome: 'filed',
    detail: (row.fileName || 'document') + ' -> ' + filed.bill.displayId + ' (filed by hand)',
  });

  res.json({ ok: true, bill_id: filed.bill.id, item_id: filed.bill.displayId, org_id: filed.orgId });
  filed.finishRead();
});
