import { Router, type Request } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
  INBOUND_MAIL_DOMAIN,
  type User,
} from './users.js';
import { insertBill } from './store.js';
import { getBill, putBill, putBillFile } from './storage.js';
import { readSetting } from './settings.js';
import { resolveProvider } from './llm.js';
import { autoRead } from './inbound.js';

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
export const mobileOf = (waId: string) => normaliseMobile(String(waId ?? '').split('@')[0]);

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
  status: 'pending' | 'open' | 'failed' | 'replaced';
  participantsRequested: string[];
  participantsAdded: string[];
  // Whether CYWS actually told us who ended up in the group. An ADOPTED group
  // (`already_existed`) comes back with empty participant arrays — CYWS is
  // saying "this already exists", not "nobody is in it" — so without this the
  // two are indistinguishable and a resumed channel would announce that
  // WhatsApp had refused every single person.
  participantsKnown: boolean;
  createdAt: string;
  createdBy: string;
  openedAt: string;
  lastError: string;
  lastMessageAt: string;
  received: number;
};

const CHANNELS = 'whatsapp-channels';
const loadChannels = () => loadCollection<WaChannel>(CHANNELS);
const saveChannels = (items: WaChannel[]) => saveCollection(CHANNELS, items);

export function channelsForOrg(ws: string, orgId: string): WaChannel[] {
  return loadChannels().filter((c) => c.workspaceId === ws && c.orgId === orgId);
}

export function channelById(submissionId: string): WaChannel | null {
  return loadChannels().find((c) => c.id === submissionId) ?? null;
}

function patchChannel(id: string, patch: Partial<WaChannel>): WaChannel | null {
  const items = loadChannels();
  const row = items.find((c) => c.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  saveChannels(items);
  return row;
}

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
// Prefer an env override; otherwise generate one on first use and keep it, so a
// practice admin can read it out of the app and hand it to the CYWS operator
// without anybody having shell access to the VPS. Same arrangement as the
// inbound-email secret, and for the same reason.
type InboundKeyRow = { id: string; key: string };
export function inboundKey(): string {
  const fromEnv = (process.env.WHATSAPP_INBOUND_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const items = loadCollection<InboundKeyRow>('whatsapp-inbound-key');
  const existing = items.find((x) => x.id === 'default');
  if (existing?.key) return existing.key;
  const key = randomBytes(24).toString('hex');
  saveCollection('whatsapp-inbound-key', [{ id: 'default', key }]);
  return key;
}

// Constant-time compare, so the key can't be recovered a byte at a time.
function keyMatches(given: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(inboundKey());
  return a.length === b.length && timingSafeEqual(a, b);
}

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
function ownerFor(ws: string, orgId: string, senderWaId: string): string {
  const sender = mobileOf(senderWaId);
  if (sender) {
    const match = ensureUsers(ws).find(
      (u: User) => !u.removed && !u.deactivated && normaliseMobile(u.mobile) === sender && canAccessOrg(u, orgId)
    );
    if (match?.email) return match.email;
  }
  return generalUserFor(ws, orgId)?.email ?? '';
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
  outcome: 'filed' | 'duplicate' | 'bad_key' | 'unknown_submission' | 'incomplete' | 'file_unavailable';
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
function subjectFor(user: User, orgName: string): string {
  if (user.emailHandle) return `${user.emailHandle}@${INBOUND_MAIL_DOMAIN}`;
  return `CYBills - ${user.name || orgName}`;
}

// GET /api/whatsapp/channels — the collection groups this entity has, or (with
// ?userId=) the one opened for a single person.
//
// The per-person lookup is deliberately NOT scoped to the header entity: a
// colleague's group is filed under the practice's own organisation while the
// browser is usually sitting in some client entity, and their own page must
// still find it.
whatsappRouter.get('/channels', (req, res) => {
  const ws = workspaceId(req);
  const userId = String(req.query.userId ?? '').trim();
  if (userId) {
    const person = personFor(ws, userId);
    if (!person) return res.status(404).json({ error: 'unknown_user' });
    if (!mayManagePerson(req, person.user, person.orgId)) return res.status(403).json({ error: 'not_an_admin' });
    return res.json({
      channels: loadChannels().filter((c) => c.workspaceId === ws && c.userId === userId).map(publicChannel),
      enabled: whatsappEnabled,
      canManage: true,
      mobile: person.user.mobile || '',
    });
  }
  const orgId = orgIdFor(req);
  if (!orgId) return res.json({ channels: [], enabled: whatsappEnabled });
  res.json({
    // The entity's own group, not every group of everyone who works in it —
    // this is the Connections card, and a person's is on their own page.
    channels: channelsForOrg(ws, orgId).filter((c) => !c.userId).map(publicChannel),
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
  const live = loadChannels().find(
    (c) => c.workspaceId === ws && c.userId === userId && c.status === 'open'
  );
  if (live && req.body?.replace !== true) {
    return res.json({ ok: true, channel: publicChannel(live), unchanged: true, mobile });
  }
  if (live) patchChannel(live.id, { status: 'replaced' });

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

  const already = seenMessage(messageId);
  if (already) {
    recordDelivery({ submissionId, messageId, outcome: 'duplicate', detail: already.billId });
    return res.json({ ok: true, duplicate: true, bill_id: already.billId });
  }

  const ws = channel.workspaceId;
  const orgId = channel.orgId;
  const scope = dataScopeForOrg(orgId);
  // Attribute the read's API spend to this client entity on the Clients page
  // (recordUsage reads the header; CYWS sends none).
  (req.headers as Record<string, string>)['x-org-id'] = orgId;

  const file = await fetchDocument(scope, b);
  if (!file) {
    recordDelivery({
      submissionId,
      messageId,
      outcome: 'file_unavailable',
      detail: String(b.r2_key ?? b.file_name ?? ''),
    });
    return res.status(502).json({ error: 'file_unavailable' });
  }

  const fileHash = createHash('sha256').update(file.bytes).digest('hex');
  const sentAt = String(b.sent_at ?? '');
  const owner = ownerFor(ws, orgId, String(b.sender ?? ''));
  // What the sender typed when they attached the file. This is the covering
  // note — "recharge this to CY-Biz" — and it is kept on the document so a
  // RE-READ sees it too: read once with it and again without, and the second
  // read quietly undoes the first.
  const message = {
    submissionId,
    chatId: String(b.chat_id ?? channel.chatId),
    chatSubject: String(b.chat_subject ?? channel.subject),
    messageId,
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
    status: 'new',
    kind: 'cost',
  });
  rememberMessage({ id: messageId, billId: bill.id, submissionId, at: new Date().toISOString() });
  recordDelivery({
    submissionId,
    messageId,
    outcome: 'filed',
    detail: `${message.fileName || 'document'} → ${bill.displayId}`,
  });
  patchChannel(submissionId, {
    lastMessageAt: sentAt || new Date().toISOString(),
    received: (channel.received || 0) + 1,
  });

  // Answer as soon as it is durably stored, then read it in the background: a
  // model call takes 10-30s, CYWS gives up at 30, and it does not retry — so a
  // slow read must never be what decides whether the bill was delivered.
  res.json({ ok: true, bill_id: bill.id, item_id: bill.displayId, org_id: orgId });

  const settings = readSetting<{ readerProvider?: string }>(ws, 'cybills.extraction-settings.v1', orgId);
  const provider = resolveProvider(settings?.readerProvider);
  void autoRead(req, scope, orgId, provider, bill.id, file.bytes.toString('base64'), file.contentType, {
    via: 'whatsapp',
    from: message.senderName || mobileOf(message.from),
    text: message.text,
  });
});
