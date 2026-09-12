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
import { googleEnabled } from './env.js';
import { resolveProvider } from './llm.js';
import { readSetting } from './settings.js';
import { mailById, mailForOrg, type MailMessage } from './mailThread.js';
import { followMessageLinks } from './inbound.js';
import { n8nEnabled } from './n8n.js';

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
        unfiled: rows.filter((m) => !m.documents.length && m.outcome !== 'forwarding_confirmation').length,
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
    messages: messages.map((m) => ({ ...m, summary: summaryOf(m) })),
    linkFetchEnabled: n8nEnabled(),
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
  const { note, documents } = await followMessageLinks(req, message, person.user, provider);
  res.json({ ok: documents.length > 0, note, documents });
});
