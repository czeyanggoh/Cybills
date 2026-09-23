import { Router, type Request, type Response } from 'express';
import { env } from './env.js';
import { readSession } from './auth.js';
import { WORKSPACE_ID } from './workspace.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import { listOrganisations, dataScopeForOrg, getOrganisation } from './organisations.js';
import { listBills, displayIdOf, type Bill } from './store.js';
import { ensure, memberForSession, canManagePractice, canAccessOrg, peopleForOrg, type User } from './users.js';
import { sendMail, dailyDigestEmail, type DigestRow, type MailResult } from './mailer.js';
import { practiceDayKey } from './usage.js';

// The daily digest: each morning, a colleague who asked for one is emailed what
// their clients have sent in that is still waiting to be paid — Dext's
// "Unprocessed items requiring payment", narrowed to the clients they look after
// and, inside each, to the people they are responsible for there
// ("finance@dart.com.sg", not the whole of Dart's book).
//
// WHICH documents is src/lib/digest.js, loaded by path the way mileage.ts loads
// its module, so the dialog and the email cannot disagree. This file is the
// subscription rows, the routes over them and the clock that sends.
//
// A subscription belongs to a COLLEAGUE (practice team): they are the people
// who look after several clients and never open most of their books. It names
// entities, and access is checked again at send time — a colleague taken off a
// client stops hearing about it the next morning, without anybody having to
// remember to edit their digest too.

type DigestRules = {
  digestRows: (docs: unknown[], o: { addresses?: string[]; unpaidOnly?: boolean; since?: string }) => Array<{ doc: Bill; isNew: boolean }>;
  digestDue: (digest: unknown, today: string, hourNow: number) => boolean;
  DIGEST_HOURS: number[];
  DEFAULT_DIGEST_HOUR: number;
};

let rules: DigestRules | null = null;
async function loadRules(): Promise<DigestRules> {
  if (rules) return rules;
  // From server/dist (or server/src under tsx) up to the repo root.
  const url = new URL('../../src/lib/digest.js', import.meta.url).href;
  rules = (await import(url)) as DigestRules;
  return rules;
}

export type Digest = {
  userId: string;
  workspaceId: string;
  enabled: boolean;
  hour: number; // the practice's local hour it goes out at
  unpaidOnly: boolean;
  // One entry per client entity; `addresses` empty means everybody in it.
  clients: Array<{ orgId: string; addresses: string[] }>;
  updatedAt: string;
  updatedBy: string;
  lastSentDay?: string; // YYYY-MM-DD in the practice's timezone
  lastSentAt?: string; // ISO; what "new since the last digest" is measured from
  lastResult?: { at: string; sent: boolean; count: number; error?: string };
};

const COLLECTION = 'daily-digests';
const all = () => loadCollection<Digest>(COLLECTION);
const persist = (items: Digest[]) => saveCollection(COLLECTION, items);

export function digestFor(ws: string, userId: string): Digest | null {
  return all().find((d) => d.workspaceId === ws && d.userId === userId) ?? null;
}

function upsert(digest: Digest): Digest {
  const items = all().filter((d) => !(d.workspaceId === digest.workspaceId && d.userId === digest.userId));
  items.push(digest);
  persist(items);
  return digest;
}

const colleague = (ws: string, id: string): User | null =>
  ensure(ws).find((u) => u.workspaceId === ws && u.id === id && !u.removed && u.practice) ?? null;

// --- Building one ---------------------------------------------------------------

const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: env.PRACTICE_TIMEZONE, hour: '2-digit', hourCycle: 'h23' });
export function practiceHour(d: Date): number {
  try {
    return Number(hourFormatter.format(d)) % 24;
  } catch {
    return d.getUTCHours();
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

const money = (n: unknown) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The rows a digest would carry right now, across every client it names that
// its colleague can still open. `since` marks what counts as new.
export async function buildDigest(ws: string, digest: Digest, recipient: User, since: string): Promise<DigestRow[]> {
  const { digestRows } = await loadRules();
  const organisations = listOrganisations(ws);
  const rows: DigestRow[] = [];
  for (const entry of digest.clients || []) {
    const org = organisations.find((o) => o.id === entry.orgId);
    if (!org || !canAccessOrg(recipient, org.id)) continue;
    const names = new Map(
      peopleForOrg(ws, org.id).map((p) => [p.email.toLowerCase(), p.general ? 'General' : p.name])
    );
    const who = (email: unknown) => {
      const e = String(email || '').trim().toLowerCase();
      return names.get(e) || e;
    };
    const picked = digestRows(listBills(dataScopeForOrg(org.id)), {
      addresses: entry.addresses,
      unpaidOnly: digest.unpaidOnly,
      since,
    });
    for (const { doc, isNew } of picked) {
      rows.push({
        entity: org.name,
        type: doc.status === 'processing' ? 'Processing' : doc.documentType || '',
        date: dayLabel(doc.date),
        invoiceNumber: doc.invoiceNumber || '',
        supplier: /^unknown supplier$/i.test(doc.supplier || '') ? '' : doc.supplier || '',
        category: doc.category || '',
        total: doc.total ? money(doc.total) : '',
        currency: doc.currency || '',
        owner: who(doc.owner || doc.createdBy) + (doc.email?.from ? ` (sent by ${doc.email.from})` : ''),
        description: String(doc.description || '').replace(/^\*\s*/, ''),
        received: dayLabel(practiceDayKey(new Date(doc.createdAt))),
        isNew,
        url: `${env.APP_ORIGIN}/costs/${encodeURIComponent(displayIdOf(doc.id) || doc.id)}?org=${encodeURIComponent(org.id)}`,
      });
    }
  }
  return rows;
}

// Build and send one digest. An empty one is NOT sent: a daily email saying
// "nothing" is the kind people learn to ignore, and then the day it says
// something is ignored too. It still counts as that day's digest.
export async function sendDigest(
  ws: string,
  digest: Digest,
  now: Date,
  opts: { force?: boolean } = {}
): Promise<MailResult & { count: number; newCount: number; skipped?: string }> {
  const recipient = colleague(ws, digest.userId);
  if (!recipient || recipient.deactivated || !recipient.email) {
    return { sent: false, count: 0, newCount: 0, skipped: 'no_recipient' };
  }
  const since = digest.lastSentAt || new Date(now.getTime() - 24 * 3600_000).toISOString();
  const rows = await buildDigest(ws, digest, recipient, since);
  const newCount = rows.filter((r) => r.isNew).length;
  let result: MailResult & { skipped?: string };
  if (!rows.length && !opts.force) {
    result = { sent: false, skipped: 'nothing_to_report' };
  } else {
    const mail = dailyDigestEmail({
      name: recipient.name || recipient.email,
      day: dayLabel(practiceDayKey(now)),
      rows,
      newCount,
      unpaidOnly: digest.unpaidOnly,
      settingsUrl: `${env.APP_ORIGIN}/colleagues`,
    });
    result = await sendMail({ to: { email: recipient.email, name: recipient.name }, ...mail });
  }
  return { ...result, count: rows.length, newCount };
}

// The clock. Every few minutes, every subscription that is due goes out. The day
// is written BEFORE the send so a slow mail server and the next tick cannot both
// send it; a failure is recorded on the row (and shown in the dialog) rather
// than retried all day into somebody's inbox.
let running = false;
export async function runDueDigests(now = new Date(), ws = WORKSPACE_ID): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const { digestDue } = await loadRules();
    const today = practiceDayKey(now);
    const hour = practiceHour(now);
    for (const digest of all().filter((d) => d.workspaceId === ws)) {
      if (!digestDue(digest, today, hour)) continue;
      upsert({ ...digest, lastSentDay: today });
      const r = await sendDigest(ws, digest, now).catch((err) => ({
        sent: false,
        count: 0,
        newCount: 0,
        error: err instanceof Error ? err.message : String(err),
      }));
      const current = digestFor(ws, digest.userId) ?? digest;
      upsert({
        ...current,
        lastSentDay: today,
        // Only a digest that actually went out moves "new since" forward, so a
        // day the mailbox was down does not quietly swallow that day's arrivals.
        ...(r.sent ? { lastSentAt: now.toISOString() } : {}),
        lastResult: { at: now.toISOString(), sent: r.sent, count: r.count, ...(r.error ? { error: r.error } : {}) },
      });
      if (r.sent) sent += 1;
      else if (r.error) console.error(`[digest] ${digest.userId}: ${r.error}`);
    }
  } finally {
    running = false;
  }
  return sent;
}

export function startDigestClock(): void {
  const tick = () => void runDueDigests().catch((err) => console.error('[digest] run failed', err));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}

// --- Routes ---------------------------------------------------------------------

export const digestRouter = Router();

// Whose digest the caller may see and change: their own, or — for whoever runs
// the practice — anybody's on the team. Mock/dev (no session) stays open.
function mayEdit(req: Request, res: Response, userId: string): boolean {
  if (!readSession(req)) return true;
  const me = memberForSession(req);
  if (!me || !me.practice || me.deactivated) {
    res.status(403).json({ error: 'not_practice_team' });
    return false;
  }
  if (me.id === userId || canManagePractice(me)) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}

const view = (d: Digest | null, userId: string) =>
  d ?? { userId, enabled: false, hour: 8, unpaidOnly: true, clients: [] };

// GET /api/digests — every colleague's digest the caller may see, for the
// Colleagues table's column.
digestRouter.get('/', (req, res) => {
  const ws = WORKSPACE_ID;
  const me = readSession(req) ? memberForSession(req) : null;
  if (readSession(req) && (!me || !me.practice || me.deactivated)) return res.status(403).json({ error: 'not_practice_team' });
  const everything = !me || canManagePractice(me);
  const digests = all().filter((d) => d.workspaceId === ws && (everything || d.userId === me?.id));
  res.json({ digests });
});

// GET /api/digests/:userId — their digest, and what it can be pointed at: the
// clients they can open, each with the people a document there can be under.
digestRouter.get('/:userId', async (req, res) => {
  const ws = WORKSPACE_ID;
  const userId = String(req.params.userId);
  if (!mayEdit(req, res, userId)) return;
  const who = colleague(ws, userId);
  if (!who) return res.status(404).json({ error: 'not_found' });
  const { DIGEST_HOURS } = await loadRules();
  const clients = listOrganisations(ws)
    .filter((o) => canAccessOrg(who, o.id))
    .map((o) => ({
      id: o.id,
      name: o.name,
      people: peopleForOrg(ws, o.id)
        .filter((p) => !p.deactivated)
        .map((p) => ({ email: p.email, name: p.general ? `General (${p.address || 'unclaimed paperwork'})` : p.name, external: p.external, general: p.general })),
    }));
  res.json({ digest: view(digestFor(ws, userId), userId), clients, hours: DIGEST_HOURS, timezone: env.PRACTICE_TIMEZONE });
});

const cleanAddresses = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : []).map((a) => String(a ?? '').trim().toLowerCase()).filter((a) => a.includes('@')))];

// PUT /api/digests/:userId — { enabled, hour, unpaidOnly, clients: [{orgId, addresses}] }
digestRouter.put('/:userId', async (req, res) => {
  const ws = WORKSPACE_ID;
  const userId = String(req.params.userId);
  if (!mayEdit(req, res, userId)) return;
  const who = colleague(ws, userId);
  if (!who) return res.status(404).json({ error: 'not_found' });
  const { DIGEST_HOURS, DEFAULT_DIGEST_HOUR } = await loadRules();
  const body = req.body ?? {};
  const hour = Number(body.hour);
  const seen = new Set<string>();
  const clients = (Array.isArray(body.clients) ? body.clients : [])
    .map((c: any) => ({ orgId: String(c?.orgId ?? ''), addresses: cleanAddresses(c?.addresses) }))
    // Only entities they can open: a digest must never be a way of reading a
    // client's book that client access would refuse.
    .filter((c: { orgId: string }) => c.orgId && !seen.has(c.orgId) && seen.add(c.orgId) && getOrganisation(ws, c.orgId) && canAccessOrg(who, c.orgId));
  const previous = digestFor(ws, userId);
  const saved = upsert({
    ...(previous ?? {}),
    userId,
    workspaceId: ws,
    enabled: Boolean(body.enabled),
    hour: DIGEST_HOURS.includes(hour) ? hour : DEFAULT_DIGEST_HOUR,
    unpaidOnly: body.unpaidOnly !== false,
    clients,
    updatedAt: new Date().toISOString(),
    updatedBy: readSession(req)?.email || '',
  });
  res.json({ digest: saved });
});

// POST /api/digests/:userId/send — send it now, to see what it looks like. Sent
// even when empty (the person pressing asked for it), and it does not count as
// the day's digest: tomorrow's still says what is new since the last real one.
digestRouter.post('/:userId/send', async (req, res) => {
  const ws = WORKSPACE_ID;
  const userId = String(req.params.userId);
  if (!mayEdit(req, res, userId)) return;
  const digest = digestFor(ws, userId);
  if (!digest || !digest.clients.length) return res.status(400).json({ error: 'no_clients', message: 'Pick at least one client and save first.' });
  const r = await sendDigest(ws, digest, new Date(), { force: true });
  res.json(r);
});
