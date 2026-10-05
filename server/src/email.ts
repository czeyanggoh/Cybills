// The Email tab: what actually arrived at this entity's addresses.
//
// Costs can only ever show what a delivery PRODUCED. A mail that filed nothing
// — an invoice as a LINK rather than an attachment, a .docx, a portal login n8n
// could not complete — appeared nowhere in CYBills at all, so "I emailed that
// last week" had no answer here. This is the other half: every delivery, with
// what became of it and why.
//
// Threaded by PERSON, the way the WhatsApp tab is threaded by group, because
// that is what an inbound address is: `martin.redalpha@cybills.sg` is one
// person's pipe, and the entity's short form standing alone is its general
// account's. A mail's thread is therefore decided by where it was DELIVERED,
// never by who sent it.
//
// Business Admin, on the route as well as in the rail — the same bar as the
// Costs inbox it sits beside, and for the same reason: this shows everybody's
// mail in the entity, not the caller's own.
import { Router } from 'express';
import type { Request } from 'express';
import {
  ensure as ensureUsers,
  canAccessOrg,
  effectiveRoleFor,
  isBusinessAdminRole,
  memberForSession,
  addressForUser,
  type User,
} from './users.js';
import { dataScopeForOrg, primaryOrgId } from './organisations.js';
import { workspaceId } from './workspace.js';
import { env, googleEnabled, smtpConfigured } from './env.js';
import { resolveProvider } from './llm.js';
import { readSetting } from './settings.js';
import { mailById, mailForOrg, trustAddressOf, type MailMessage } from './mailThread.js';
import { isTrustedSender, normaliseSender, trustSender, trustedSendersFor, untrustSender } from './trustedSenders.js';
import { followMessageLinks } from './inbound.js';
import { n8nEnabled } from './n8n.js';
import { getBillById, type Bill } from './store.js';
import { getOrganisation } from './organisations.js';
import { isInternalAddress } from './users.js';
import { isMailConnected } from './mailAccount.js';
import { replyEmail, sendMail } from './mailer.js';
import { recordReply, repliesFor } from './mailReplies.js';

export const emailRouter = Router();

const orgIdFor = (req: Request) => String(req.header('X-Org-Id') || '').trim();

// The mail this entity holds.
//
// A message is stored against the organisation RECORD id, which is what the
// browser names in X-Org-Id — but also against the bills SCOPE it filed into,
// and a delivery that arrived before the entity was linked carries only the
// second. So both are accepted: a scope is a function of the entity and no two
// entities ever share one, which makes it exactly the boundary the documents
// themselves are isolated by.
//
// A request naming NO entity is the one implicit scope everyone shares — an
// install with nothing linked yet — exactly as `dataScopeForOrg` and
// `canAccessOrg` already read it, and as the Costs list beside this one behaves.
// Returning nothing there made the tab the one page in the app that was empty
// on a deploy where every other list worked.
function mailHere(ws: string, orgId: string): MailMessage[] {
  const scope = dataScopeForOrg(orgId);
  return mailForOrg(ws, orgId, scope);
}

// Who may look. Everything here is somebody else's mail, so it is the Costs
// inbox's bar rather than the roster's.
function mayRead(req: Request, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled; // dev/mock mode has no session to judge
  if (!canAccessOrg(me, orgId)) return false;
  return isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

// One person's row, and the entity their mail is filed under — resolved exactly
// as the delivery road resolves it (their own organisation, else the practice's
// primary one), so a thread is listed under the entity its documents went to.
function personFor(ws: string, userId: string): { user: User; orgId: string } | null {
  const user = ensureUsers(ws).find((u) => u.id === userId && !u.removed);
  return user ? { user, orgId: user.organisationId || primaryOrgId() } : null;
}

const nameOf = (u: User) => u.name || u.email || '';

// The last thing that happened to a message, in one phrase. The tab is read to
// find out what became of a delivery, so the row says it rather than making
// somebody open every message to find the one that failed.
function summaryOf(m: MailMessage): string {
  if (m.outcome === 'forwarding_confirmation') return 'Forwarding confirmation';
  if (m.documents.length) return `${m.documents.length} document${m.documents.length === 1 ? '' : 's'}`;
  // A mail whose paperwork is the emails attached to it: each is its own row,
  // and saying "Nothing filed" here would send somebody looking for a failure.
  if (m.outcome === 'forwarded') {
    const n = m.forwarded?.length || 0;
    return `${n} attached email${n === 1 ? '' : 's'}, each listed on its own`;
  }
  if (m.linkNote) return m.linkNote;
  const skipped = m.attachments.filter((a) => a.skipped);
  if (skipped.length) return `${skipped.length} attachment${skipped.length === 1 ? '' : 's'} not read — ${skipped[0].skipped}`;
  if (m.links.length) return 'Nothing filed — no link was followed';
  return 'Nothing filed';
}

// GET /api/email/threads — one row per person mail has arrived for.
//
// Only people who have actually received something are listed: an entity's
// whole roster is the Users page's job, and a thread with no messages in it is
// not a conversation.
emailRouter.get('/threads', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const all = mailHere(ws, orgId);
  const byUser = new Map<string, MailMessage[]>();
  for (const m of all) {
    const rows = byUser.get(m.userId) || [];
    rows.push(m);
    byUser.set(m.userId, rows);
  }

  const threads = [...byUser.entries()]
    .map(([userId, rows]) => {
      const person = personFor(ws, userId);
      const last = rows.reduce<MailMessage | null>(
        (acc, m) => (!acc || String(m.sentAt) > String(acc.sentAt) ? m : acc),
        null
      );
      return {
        userId,
        // Named from the roster where it still resolves, and from the address
        // the mail was sent to where it does not — a person who has left still
        // has a mailbox full of what arrived while they were here.
        personName: person ? nameOf(person.user) : last?.to || '',
        address: person ? (person.user.general ? last?.to || '' : addressForUser(person.user)) : last?.to || '',
        general: Boolean(person?.user.general),
        missing: !person,
        messages: rows.length,
        documents: rows.reduce((n, m) => n + m.documents.length, 0),
        // What arrived and became nothing. This is the number the tab exists
        // for, so it is counted rather than left to be eyeballed.
        unfiled: rows.filter(
          (m) => !m.documents.length && m.outcome !== 'forwarding_confirmation' && m.outcome !== 'forwarded'
        ).length,
        lastMessageAt: last?.sentAt || last?.receivedAt || '',
        lastSubject: last?.subject || '',
        lastSummary: last ? summaryOf(last) : '',
      };
    })
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));

  res.json({
    threads,
    messages: all.length,
    unfiled: threads.reduce((n, t) => n + t.unfiled, 0),
    // Whether "Fetch the document" is a button at all. Said by the server, since
    // whether the road exists is a deployment fact the browser cannot see.
    linkFetchEnabled: n8nEnabled(),
  });
});

// GET /api/email/threads/:userId — one person's mail, newest first.
emailRouter.get('/threads/:userId', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const userId = String(req.params.userId ?? '');
  const messages = mailHere(ws, orgId)
    .filter((m) => m.userId === userId)
    .sort((a, b) => String(b.sentAt || b.receivedAt).localeCompare(String(a.sentAt || a.receivedAt)));
  const person = personFor(ws, userId);
  if (!person && !messages.length) return res.status(404).json({ error: 'unknown_thread' });

  res.json({
    person: {
      userId,
      personName: person ? nameOf(person.user) : messages[0]?.to || '',
      address: person && !person.user.general ? addressForUser(person.user) : messages[0]?.to || '',
      general: Boolean(person?.user.general),
      missing: !person,
    },
    // Whether this sender's links are followed without asking. Per MESSAGE
    // rather than once for the thread: a mailbox receives from everybody, and
    // the question is always about the address that sent THIS one — or, for an
    // email attached to another, the address that delivered it.
    messages: messages.map((m) => ({
      ...m,
      summary: summaryOf(m),
      senderTrusted: isTrustedSender(ws, orgId, dataScopeForOrg(orgId), trustAddressOf(m)),
      // What somebody here answered, and who an answer written now would go to.
      replies: repliesFor(ws, orgId, dataScopeForOrg(orgId), { messageId: m.id, billIds: billIdsOf(m) }),
      replyAddress: answerable(normaliseSender(trustAddressOf(m))),
    })),
    linkFetchEnabled: n8nEnabled(),
    replyEnabled: replyEnabled(),
  });
});

// POST /api/email/messages/:id/fetch — ask n8n again what is behind this
// message's links.
//
// The delivery road only follows links for a mail that filed NOTHING, and it
// follows them once. This is the retry a person presses: a workflow that was
// down, a login that had expired, a link somebody has since told n8n how to
// follow. It is deliberately allowed on a message that already has a document
// — pressing it twice on a mail carrying two invoices is how the second one is
// got — but it is the only road that widens that rule, because it is the one
// with a person behind it.
emailRouter.post('/messages/:id/fetch', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const message = mailById(String(req.params.id ?? ''));
  // 404 rather than 403 on an entity mismatch, the way a document the caller
  // may not read answers: whether a message exists is itself something they
  // aren't entitled to learn.
  if (!message || message.workspaceId !== ws || !mailHere(ws, orgId).some((m) => m.id === message.id)) {
    return res.status(404).json({ error: 'unknown_message' });
  }
  if (!message.links.length) return res.status(422).json({ error: 'no_links', message: 'This message carries no link to follow.' });
  if (!n8nEnabled()) {
    return res.status(503).json({ error: 'n8n_not_configured', message: 'No n8n webhook is configured (N8N_FETCH_URL).' });
  }

  const person = personFor(ws, message.userId);
  if (!person) return res.status(422).json({ error: 'unknown_owner', message: 'The person this mail was addressed to is no longer on the roster.' });

  const settings = readSetting<{ readerProvider?: string }>(ws, 'cybills.extraction-settings.v1', message.orgId);
  const provider = resolveProvider(settings?.readerProvider);

  // Waited on, unlike the delivery road's: somebody is watching this one, and
  // the answer is the whole point of having pressed it. The READ that follows
  // still runs in the background — the document exists either way.
  // The placeholder, where one is waiting: the fetch fills the row that has
  // been asking rather than standing a second cost beside it.
  const { note, documents } = await followMessageLinks(req, message, person.user, provider, message.pendingBillId || '');
  res.json({ ok: documents.length > 0, note, documents });
});

// What a fetch needs, for one message: who to file under and which reader.
// Resolved in one place because the three roads below all need the same two.
function fetchContextFor(ws: string, message: MailMessage) {
  const person = personFor(ws, message.userId);
  if (!person) return null;
  const settings = readSetting<{ readerProvider?: string }>(ws, 'cybills.extraction-settings.v1', message.orgId);
  return { user: person.user, provider: resolveProvider(settings?.readerProvider) };
}

// GET /api/email/senders — whose links this entity follows without asking.
emailRouter.get('/senders', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const senders = trustedSendersFor(ws, orgId, dataScopeForOrg(orgId)).map((t) => ({
    address: t.address,
    at: t.at,
    by: t.by,
  }));
  res.json({ senders, linkFetchEnabled: n8nEnabled() });
});

/**
 * POST /api/email/senders/trust — this sender may be followed from now on.
 *
 * Two things at once, deliberately. It records the decision, so every later
 * mail from that address is fetched on arrival without asking again; and it
 * acts on it NOW, for every document of theirs already standing in the inbox
 * waiting for exactly this answer. Trusting a sender and then having to press
 * fetch on each of their documents separately would be the same decision made
 * twice, and the second half is the one people forget.
 */
emailRouter.post('/senders/trust', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const address = normaliseSender(String(req.body?.address ?? ''));
  if (!address || !address.includes('@')) {
    return res.status(422).json({ error: 'bad_address', message: 'That is not an email address.' });
  }
  const me = memberForSession(req);
  trustSender(ws, orgId, dataScopeForOrg(orgId), address, me?.email || '');

  // Everything of theirs that was waiting on the answer. Ordered oldest first,
  // so a backlog is cleared in the order it arrived. An attached email waits on
  // whoever delivered it, never on the From line inside the file.
  const waiting = mailHere(ws, orgId)
    .filter((m) => Boolean(m.pendingBillId) && normaliseSender(trustAddressOf(m)) === address)
    .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));

  const notes: string[] = [];
  let fetched = 0;
  if (n8nEnabled()) {
    for (const message of waiting) {
      const ctx = fetchContextFor(ws, message);
      if (!ctx) continue;
      const out = await followMessageLinks(req, message, ctx.user, ctx.provider, message.pendingBillId || '');
      fetched += out.documents.length;
      if (!out.documents.length) notes.push(out.note);
    }
  } else if (waiting.length) {
    notes.push('No n8n webhook is configured (N8N_FETCH_URL), so nothing could be fetched.');
  }

  res.json({ ok: true, address, waiting: waiting.length, fetched, notes });
});

// POST /api/email/senders/untrust — stop following this sender's links.
//
// What was already fetched under the trust stays: those are documents now, and
// they happened. Only what arrives NEXT goes back to asking.
emailRouter.post('/senders/untrust', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const address = normaliseSender(String(req.body?.address ?? ''));
  const removed = untrustSender(ws, orgId, dataScopeForOrg(orgId), address);
  res.json({ ok: true, address, removed });
});

/**
 * POST /api/email/documents/:billId/fetch — fetch this one, without trusting.
 *
 * The other answer to the question the inbox row asks. Somebody who recognises
 * one invoice but does not want every future mail from that address followed
 * automatically gets the document and nothing else — no rule written, nothing
 * remembered. Addressed by the DOCUMENT because that is where the question was
 * asked; the message behind it is what actually carries the links.
 */
emailRouter.post('/documents/:billId/fetch', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const billId = String(req.params.billId ?? '');
  const message = mailHere(ws, orgId).find((m) => m.pendingBillId === billId)
    || mailHere(ws, orgId).find((m) => m.documents.some((d) => d.billId === billId));
  if (!message) return res.status(404).json({ error: 'unknown_document' });
  if (!message.links.length) return res.status(422).json({ error: 'no_links', message: 'This document carries no link to follow.' });
  if (!n8nEnabled()) {
    return res.status(503).json({ error: 'n8n_not_configured', message: 'No n8n webhook is configured (N8N_FETCH_URL).' });
  }

  const ctx = fetchContextFor(ws, message);
  if (!ctx) return res.status(422).json({ error: 'unknown_owner', message: 'The person this mail was addressed to is no longer on the roster.' });

  const { note, documents } = await followMessageLinks(req, message, ctx.user, ctx.provider, billId);
  res.json({ ok: documents.length > 0, note, documents });
});

// --- Answering a mail --------------------------------------------------------
//
// Everything above reads what arrived. This is the one thing that goes the
// other way: a document that came in as a link with no invoice behind it, a
// photo too dark to read, a bill with a page missing — each ends with somebody
// having to ask the sender for something, and until now that meant leaving the
// app to find the email again in a mailbox CYBills's addresses do not have.
//
// It goes out from the deployment's own mailbox (the one that sends invitations),
// which nobody reads, so the ANSWER is pointed back where the original was
// delivered: Reply-To is the CYBills address the sender wrote to. Their reply,
// and whatever they attach to it, then arrives by the ordinary inbound road and
// is filed under the same person, in the same thread. The person who wrote the
// reply is on Reply-To as well, because a mirrored row tells nobody anything
// has happened.

const replyEnabled = () => smtpConfigured || isMailConnected();

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// An address a reply can actually reach, or ''. Never an internal identity
// (`…@cybills.local`), which is a name for a roster row and not a mailbox.
const answerable = (address: string) => (ADDRESS.test(address) && !isInternalAddress(address) ? address : '');

// Recipients as typed: a list, or one string with commas between them.
function addressList(raw: unknown): { ok: string[]; bad: string[] } {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]/))
    .map((a) => normaliseSender(String(a ?? '')))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  return { ok: unique.filter((a) => answerable(a)), bad: unique.filter((a) => !answerable(a)) };
}

function billIdsOf(m: MailMessage): string[] {
  return [...m.documents.map((d) => d.billId), m.pendingBillId || ''].filter(Boolean);
}

// The Message-ID an answer should name, where the mirror holds a real one. A
// message named by what it IS (`mail_…`, a Worker that forwarded no MIME) has
// none, and the suffix a second delivery of one mail is told apart by is ours.
// An email that arrived ATTACHED to another answers the mail that carried it:
// that is the message the person being answered actually sent.
function messageIdToAnswer(m: MailMessage): string {
  const id = String(m.forwardedIn || m.id || '').split('#')[0].trim();
  return id.includes('@') && !id.startsWith('mail_') ? id : '';
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: env.PRACTICE_TIMEZONE });
};

type Answering = {
  message: MailMessage | null;
  bill: Bill | null;
  envelope: { from: string; to: string; subject: string; date: string; text: string };
  billIds: string[];
};

// What is being answered: a mirrored message, named outright or found through
// the document it produced, else the envelope the document itself carries (one
// emailed in before the mirror existed). Null when the caller's entity holds
// neither — which answers 404, like every other message they may not see.
function answering(ws: string, orgId: string, about: { messageId?: string; billId?: string }): Answering | null {
  const here = mailHere(ws, orgId);
  const bill = about.billId ? getBillById(dataScopeForOrg(orgId), about.billId) : null;
  const message =
    (about.messageId ? here.find((m) => m.id === about.messageId) : null) ||
    (bill ? here.find((m) => m.pendingBillId === bill.id) || here.find((m) => m.documents.some((d) => d.billId === bill.id)) : null) ||
    null;
  if (message) {
    return {
      message,
      bill,
      envelope: {
        from: trustAddressOf(message),
        to: message.to,
        subject: message.subject,
        date: message.sentAt || message.receivedAt,
        text: message.text,
      },
      billIds: [...new Set([...billIdsOf(message), bill?.id || ''].filter(Boolean))],
    };
  }
  if (bill?.email) return { message: null, bill, envelope: bill.email, billIds: [bill.id] };
  return null;
}

// GET /api/email/documents/:billId/replies — what has been answered about the
// mail this document arrived in, and whether (and to whom) it can be answered.
emailRouter.get('/documents/:billId/replies', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const about = answering(ws, orgId, { billId: String(req.params.billId ?? '') });
  if (!about) return res.status(404).json({ error: 'unknown_document' });
  res.json({
    replies: repliesFor(ws, orgId, dataScopeForOrg(orgId), { messageId: about.message?.id, billIds: about.billIds }),
    replyAddress: answerable(normaliseSender(about.envelope.from)),
    replyEnabled: replyEnabled(),
  });
});

/**
 * POST /api/email/reply — answer a mail, from the page it is being read on.
 *
 * `{ messageId | billId, body, to?, cc? }`. The recipient defaults to whoever
 * sent the original (for an email attached to another, whoever sent it IN — the
 * From line inside the file is usually a supplier's no-reply address, and
 * never the person who can be asked for anything).
 *
 * Business Admin, the bar everything else here holds: this sends mail to an
 * outside address in the entity's name.
 */
emailRouter.post('/reply', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayRead(req, orgId)) return res.status(403).json({ error: 'no_client_access' });

  const about = answering(ws, orgId, {
    messageId: String(req.body?.messageId ?? '').trim(),
    billId: String(req.body?.billId ?? '').trim(),
  });
  if (!about) return res.status(404).json({ error: 'unknown_message' });

  const body = String(req.body?.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return res.status(422).json({ error: 'empty_reply', message: 'Write something to send.' });
  if (body.length > 10_000) return res.status(422).json({ error: 'reply_too_long', message: 'That reply is too long to send from here.' });

  const typedTo = addressList(req.body?.to);
  const cc = addressList(req.body?.cc);
  const fallback = answerable(normaliseSender(about.envelope.from));
  const to = typedTo.ok.length || typedTo.bad.length ? typedTo.ok : fallback ? [fallback] : [];
  const bad = [...typedTo.bad, ...cc.bad];
  if (bad.length) return res.status(422).json({ error: 'bad_address', message: `${bad[0]} is not an email address.` });
  if (!to.length) {
    return res.status(422).json({ error: 'no_recipient', message: 'There is nobody to send this to — the original carries no usable sender address.' });
  }
  if (to.length + cc.ok.length > 10) {
    return res.status(422).json({ error: 'too_many_recipients', message: 'A reply from here goes to at most ten addresses.' });
  }

  if (!replyEnabled()) {
    return res.status(503).json({
      error: 'mail_not_connected',
      message: 'No mailbox is connected to send from. The practice connects one under Business settings -> Email.',
    });
  }

  const me = memberForSession(req);
  // The address the original was delivered to first: that is what files the
  // sender's answer. Then the person writing, so they hear about it.
  const replyTo = [
    ...new Set([answerable(normaliseSender(about.envelope.to)), answerable(normaliseSender(me?.email || ''))].filter(Boolean)),
  ];
  const subject = /^\s*re\s*:/i.test(about.envelope.subject)
    ? about.envelope.subject.trim()
    : `Re: ${about.envelope.subject.trim() || 'your email'}`;
  const inReplyTo = about.message ? messageIdToAnswer(about.message) : '';

  const out = await sendMail({
    to: to.map((email) => ({ email })),
    ...(cc.ok.length ? { cc: cc.ok.map((email) => ({ email })) } : {}),
    replyTo: replyTo.map((email) => ({ email })),
    ...(inReplyTo ? { inReplyTo } : {}),
    subject,
    html: replyEmail({
      body,
      fromName: me?.name || me?.email || '',
      entityName: getOrganisation(ws, orgId)?.name || '',
      original: { from: about.envelope.from, date: stamp(about.envelope.date), text: about.envelope.text },
    }),
  });
  // Recorded only once it has actually gone: a reply shown under a message is a
  // claim that the sender was told something.
  if (!out.sent) {
    return res.status(502).json({ error: 'send_failed', message: `The reply was not sent — ${out.error || 'the mailbox refused it'}.` });
  }

  const reply = recordReply({
    workspaceId: ws,
    orgId,
    scope: dataScopeForOrg(orgId),
    messageId: about.message?.id || '',
    billIds: about.billIds,
    to,
    cc: cc.ok,
    replyTo,
    subject,
    text: body,
    by: me?.email || '',
    byName: me?.name || me?.email || '',
  });
  res.json({ ok: true, reply });
});
