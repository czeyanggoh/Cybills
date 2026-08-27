import { Router, type Request } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { env, whatsappEnabled, r2Enabled, googleEnabled } from './env.js';
import { workspaceId } from './workspace.js';
import { dataScopeForOrg, getOrganisation } from './organisations.js';
import {
  canAccessOrg,
  effectiveRoleFor,
  ensure as ensureUsers,
  generalUserFor,
  isBusinessAdminRole,
  memberForSession,
  appOrigin,
  type User,
} from './users.js';
import { insertBill } from './store.js';
import { getBill, putBillFile } from './storage.js';
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
  subject: string;
  chatId: string; // '' until CYWS answers
  status: 'pending' | 'open' | 'failed';
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
  opts: { participants: string[]; subject: string; createdBy: string }
): Promise<{ ok: true; channel: WaChannel } | { ok: false; status: number; error: string; message: string; retryable: boolean; channel: WaChannel | null }> {
  const items = loadChannels();
  // Resume rather than start again: an entity with a half-made channel already
  // owns a submission id, and possibly a group at the far end.
  const existing = items.find((c) => c.workspaceId === ws && c.orgId === orgId && c.status !== 'open');
  const channel: WaChannel = existing ?? {
    id: mintSubmissionId(orgId),
    workspaceId: ws,
    orgId,
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

// Requested but not added — the people an operator has to send an invite link
// to by hand. Derived, never stored: both lists are already on the record.
export const participantsMissing = (c: WaChannel): string[] =>
  c.participantsKnown ? c.participantsRequested.filter((p) => !c.participantsAdded.includes(p)) : [];

const publicChannel = (c: WaChannel) => ({
  submissionId: c.id,
  orgId: c.orgId,
  subject: c.subject,
  chatId: c.chatId,
  status: c.status,
  participantsRequested: c.participantsRequested,
  participantsAdded: c.participantsAdded,
  participantsMissing: participantsMissing(c),
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

// GET /api/whatsapp/channels — the collection groups this entity has.
whatsappRouter.get('/channels', (req, res) => {
  const orgId = orgIdFor(req);
  if (!orgId) return res.json({ channels: [], enabled: whatsappEnabled });
  res.json({
    channels: channelsForOrg(workspaceId(req), orgId).map(publicChannel),
    enabled: whatsappEnabled,
    canManage: mayManage(req, orgId),
  });
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
  });
});

// POST /api/whatsapp/invoice — CYWS hands over one supplier bill.
//
// Called machine-to-machine, so it carries its own proof (X-API-Key) instead of
// a session, and is allowlisted past the session guard in index.ts.
whatsappRouter.post('/invoice', async (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) return res.status(401).json({ error: 'invalid_api_key' });

  const b = req.body ?? {};
  const submissionId = String(b.submission_id ?? '').trim();
  const messageId = String(b.message_id ?? '').trim();
  if (!submissionId) return res.status(400).json({ error: 'submission_id_required' });
  if (!messageId) return res.status(400).json({ error: 'message_id_required' });

  const channel = channelById(submissionId);
  // A submission CYBills has no record of. Deliberately not "create one": the
  // whole point of the id is that it names an entity's book, and guessing which
  // one would file a client's bills into somebody else's.
  if (!channel) return res.status(404).json({ error: 'unknown_submission', submission_id: submissionId });

  const already = seenMessage(messageId);
  if (already) return res.json({ ok: true, duplicate: true, bill_id: already.billId });

  const ws = channel.workspaceId;
  const orgId = channel.orgId;
  const scope = dataScopeForOrg(orgId);
  // Attribute the read's API spend to this client entity on the Clients page
  // (recordUsage reads the header; CYWS sends none).
  (req.headers as Record<string, string>)['x-org-id'] = orgId;

  const file = await fetchDocument(scope, b);
  if (!file) return res.status(502).json({ error: 'file_unavailable' });

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
