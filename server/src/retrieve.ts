// Costs -> Retrieve: signing into a supplier's portal for its invoices.
//
// Some suppliers never send the bill. SP Group's is on its customer portal, and
// so is a growing list of utilities, telcos and SaaS vendors: somebody has to
// sign in each month, find the invoice and download it, and until they do the
// cost is in nobody's book. n8n already runs browser retrievals of exactly that
// kind (the link fetch, n8n.ts), so this is the same road with the other half
// of the problem solved here: WHICH portal, signed into as WHOM.
//
// So an entity keeps its logins here — one per portal account — and pressing
// Retrieve hands one to N8N_RETRIEVE_URL, which signs in and answers with the
// invoices in the shapes the link fetch already reads (`readDocumentsReply`).
// What comes back is filed into the Costs inbox and read exactly as an emailed
// attachment is (`autoRead`), so a retrieved bill is indistinguishable
// afterwards from one that arrived any other way.
//
// The password is the care here. It is a third party's credential, held so a
// robot can use it, so:
//   * it is SEALED at rest (`sealSecret`, AES-GCM keyed off SESSION_SECRET under
//     its own purpose), so a copy of the data file is not a copy of the logins;
//   * it never leaves the server except in the one request to n8n — no listing,
//     no reply, no log line carries it, and the page only learns THAT one is set;
//   * replacing it is the only edit — it is never shown, so it cannot be read
//     back by anybody who can open the page;
//   * deleting a login deletes the sealed password with it, not a soft flag.
// Business Admin, on the route as well as in the page: this decides what CYBills
// signs into on the client's behalf.
//
// Every retrieval is a background job, because a portal sign-in and a handful of
// downloads take minutes and a proxy will not hold a request open that long. The
// page polls the login's `run` until it settles.
//
// And a login can retrieve BY ITSELF, which is the point of keeping it: a bill
// that waits on somebody remembering to press a button is the shoebox again.
// Each login carries a schedule (off / daily / a day of the month, at an hour
// of the practice's day — src/lib/retrieveSchedule.js is the rule, loaded by
// path so the dialog and the clock read one), and `startRetrieveClock` runs
// the due ones, one at a time across every entity, because n8n drives one
// browser.
import { Router } from 'express';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { env, googleEnabled } from './env.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import { sealSecret, openSecret } from './totp.js';
import {
  canAccessOrg,
  effectiveRoleFor,
  isBusinessAdminRole,
  memberForSession,
  ownerForOrg,
  generalUserFor,
  peopleForOrg,
} from './users.js';
import { dataScopeForOrg, getOrganisation } from './organisations.js';
import { workspaceId } from './workspace.js';
import { readSetting } from './settings.js';
import { resolveProvider } from './llm.js';
import { readDocumentsReply, type FetchedDocument } from './n8n.js';
import { insertBill, listBills, noteReading } from './store.js';
import { putBillFile } from './storage.js';
import { autoRead } from './inbound.js';
import { practiceDayKey } from './usage.js';
import { practiceHour } from './digest.js';
import { robotRequest } from './robotRequest.js';
import { isoClaimDate } from './claimDates.js';

export const retrieveRouter = Router();

/** Whether a retrieval can run at all. Unset, logins are kept and nothing is fetched. */
export const retrieveEnabled = (): boolean => Boolean(String(env.N8N_RETRIEVE_URL || '').trim());

const SEAL_PURPOSE = 'cybills-portal-login';

// The portals the workflow has a recipe for, by id. The id is what n8n branches
// on; the name is what a person reads. "Another portal" carries its own sign-in
// page, and n8n says so in words when it has no recipe for it.
export const PORTALS = [
  {
    id: 'spgroup',
    name: 'SP Group',
    description: 'Electricity, water and gas bills from the SP Utilities portal.',
    usernameLabel: 'Email',
    loginUrl: '',
  },
  {
    id: 'other',
    name: 'Another portal',
    description: 'Any other supplier portal. n8n needs a recipe for it before it can sign in.',
    usernameLabel: 'Username or email',
    loginUrl: '',
  },
] as const;
const portalById = (id: string) => PORTALS.find((p) => p.id === id);

export type Schedule = { frequency: 'off' | 'daily' | 'monthly'; day: number; hour: number };
type ScheduleState = { lastDay?: string; from?: string };
type ScheduleRules = {
  normaliseSchedule: (value: unknown) => Schedule;
  validSchedule: (value: unknown) => boolean;
  scheduleDue: (schedule: unknown, state: ScheduleState, today: string, hourNow: number) => boolean;
  nextScheduledDay: (schedule: unknown, state: ScheduleState, today: string, hourNow: number) => string;
};

// An invoice date in any of the shapes a portal or a reader writes one ("05 Oct
// 2026", 05/10/2026, ISO) as ISO, '' when it is none of them. claimDate.js's
// rule, loaded with the schedule rules; until then only ISO is recognised.
let isoDate: (v: unknown) => string = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};

let rules: ScheduleRules | null = null;
async function loadRules(): Promise<ScheduleRules> {
  if (rules) return rules;
  // From server/dist (or server/src under tsx) up to the repo root.
  const url = new URL('../../src/lib/retrieveSchedule.js', import.meta.url).href;
  rules = (await import(url)) as ScheduleRules;
  isoDate = (await isoClaimDate()) || isoDate;
  return rules;
}

type FiledRecord = {
  hash: string;
  reference: string;
  billId: string;
  at: string;
  /** The invoice's own date, ISO, where n8n said it. */
  date?: string;
};

type RunRecord = {
  id: string;
  /** 'queued' — Retrieve all is working through the logins before it. */
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** Who pressed Retrieve, as an address. */
  by: string;
  /** Started by the schedule rather than by a person. */
  scheduled?: boolean;
  /** n8n's own words, or why it was not asked. Always set once it settles. */
  note: string;
  filed: Array<{ billId: string; displayId: string; fileName: string }>;
  /** Documents n8n returned that were filed before (same bytes or same number). */
  skipped: number;
};

export type PortalLogin = {
  id: string;
  workspaceId: string;
  /** The organisation RECORD id it belongs to. */
  orgId: string;
  /** The bills scope its documents are filed into. */
  scope: string;
  portal: string;
  /** What a person calls this account — "SP Group — 1 Raffles Place". */
  label: string;
  /** For "Another portal": the sign-in page n8n is pointed at. */
  loginUrl: string;
  username: string;
  /** SEALED. Never returned, never logged. */
  password: string;
  passwordSetAt: string;
  /** Narrows the retrieval to one account on a login that holds several. */
  accountRef: string;
  /** Whose documents they are, as an email; '' = the entity's general account. */
  owner: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  run?: RunRecord;
  /** Every document this login has filed, so a re-run never files one twice. */
  filed: FiledRecord[];
  /** When a retrieval last came back without failing. */
  lastRetrievedAt?: string;
  /** When it retrieves by itself; absent = off. */
  schedule?: Schedule;
  /** The practice day the schedule was set — a slot before it is not owed. */
  scheduleFrom?: string;
  /** The practice day the schedule last STARTED a run, written before it runs. */
  lastScheduledDay?: string;
};

const COLLECTION = 'portal-logins';
const MAX_LEDGER = 1000;
const load = () => loadCollection<PortalLogin>(COLLECTION);
const persist = (rows: PortalLogin[]) => saveCollection(COLLECTION, rows);

const orgIdFor = (req: Request) => String(req.header('X-Org-Id') || '').trim();

function mayManage(req: Request, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled; // dev/mock mode has no session to judge
  if (!canAccessOrg(me, orgId)) return false;
  return isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

const loginsHere = (ws: string, orgId: string) =>
  load().filter((l) => l.workspaceId === ws && l.orgId === orgId);

// The newest invoice date among what this login has filed, ISO, '' when none is
// known — what n8n is told so it fetches only the invoices dated AFTER it. The
// portal's own date (what n8n said when it handed the file over) first, since
// that is the list n8n compares against; else the date the reader took off the
// paper, which also covers everything filed before n8n said dates. A date past
// today is a misread, and would stop every later invoice being fetched, so it
// is not believed.
function latestInvoiceDate(login: PortalLogin, today = practiceDayKey(new Date())): string {
  const read = new Map(listBills(login.scope).map((b) => [b.id, b.date]));
  let latest = '';
  for (const f of login.filed) {
    const d = isoDate(f.date) || isoDate(read.get(f.billId));
    if (d && d <= today && d > latest) latest = d;
  }
  return latest;
}

// A run that has said "running" for longer than the workflow is allowed to take
// died with the process that started it — a restart, a deploy. Reported as
// what it is rather than spinning on the page for ever.
const STALE_MS = () => (Number(env.N8N_RETRIEVE_TIMEOUT_MS) || 300000) + 120000;
function runOf(l: PortalLogin): RunRecord | undefined {
  const r = l.run;
  // A queued login waits on every one ahead of it, so it gets the same grace
  // several times over before it is called dead.
  const grace = r?.status === 'queued' ? STALE_MS() * 6 : STALE_MS();
  if ((r?.status === 'running' || r?.status === 'queued') && Date.now() - Date.parse(r.startedAt) > grace) {
    return { ...r, status: 'failed', note: 'The retrieval never reported back — the server restarted while it ran. Try again.' };
  }
  return r;
}

// What the page sees. No password — only that one is set, and when.
function view(ws: string, l: PortalLogin, r: ScheduleRules, now = new Date()) {
  const schedule = r.normaliseSchedule(l.schedule);
  const state = { lastDay: l.lastScheduledDay, from: l.scheduleFrom };
  const portal = portalById(l.portal);
  const people = peopleForOrg(ws, l.orgId);
  const ownerEmail = l.owner || generalUserFor(ws, l.orgId)?.email || '';
  const ownerRow = people.find((p) => p.email.toLowerCase() === ownerEmail.toLowerCase());
  return {
    id: l.id,
    portal: l.portal,
    portalName: portal?.name || l.portal,
    label: l.label,
    loginUrl: l.loginUrl,
    username: l.username,
    hasPassword: Boolean(l.password),
    passwordSetAt: l.passwordSetAt,
    accountRef: l.accountRef,
    owner: l.owner,
    ownerName: ownerRow?.name || ownerEmail,
    createdAt: l.createdAt,
    createdBy: l.createdBy,
    updatedAt: l.updatedAt,
    run: runOf(l) || null,
    filedCount: l.filed.length,
    lastRetrievedAt: l.lastRetrievedAt || '',
    lastInvoiceDate: latestInvoiceDate(l, practiceDayKey(now)),
    schedule,
    // The practice day the schedule next runs on; the hour is the schedule's.
    nextScheduledDay: r.nextScheduledDay(schedule, state, practiceDayKey(now), practiceHour(now)),
    lastScheduledDay: l.lastScheduledDay || '',
  };
}

const clean = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

// The owner a login's documents file under, as the upload resolves one: a
// client's own person is kept, a practice colleague from outside becomes the
// general account, and an address nobody here knows is refused rather than
// filed under a stranger.
function resolveOwner(ws: string, orgId: string, requested: string): { ok: true; owner: string } | { ok: false } {
  const raw = clean(requested);
  if (!raw) return { ok: true, owner: '' };
  const known = peopleForOrg(ws, orgId).some((p) => p.email.toLowerCase() === raw.toLowerCase());
  if (!known) return { ok: false };
  const owner = ownerForOrg(ws, orgId, raw, '');
  const general = generalUserFor(ws, orgId)?.email || '';
  return { ok: true, owner: owner && owner.toLowerCase() !== general.toLowerCase() ? owner : '' };
}

// GET /api/retrieve/logins — this entity's portal logins, and the portals offered.
retrieveRouter.get('/logins', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const r = await loadRules();
  const logins = loginsHere(ws, orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((l) => view(ws, l, r));
  res.json({ logins, portals: PORTALS, enabled: retrieveEnabled(), timezone: env.PRACTICE_TIMEZONE });
});

const BAD_SCHEDULE = { error: 'bad_schedule', message: 'Choose when it retrieves: off, daily, or a day of the month, at an hour.' };

// A schedule from the dialog onto the row. A CHANGED schedule starts counting
// from today, so a slot that passed before it was set is not made up for.
function applySchedule(row: PortalLogin, raw: unknown, r: ScheduleRules): void {
  const next = r.normaliseSchedule(raw);
  const changed = !row.schedule || JSON.stringify(next) !== JSON.stringify(r.normaliseSchedule(row.schedule));
  row.schedule = next;
  if (changed) row.scheduleFrom = practiceDayKey(new Date());
}

// POST /api/retrieve/logins — save a portal login.
retrieveRouter.post('/logins', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const b = req.body ?? {};
  const portal = portalById(clean(b.portal));
  if (!portal) return res.status(422).json({ error: 'bad_portal', message: 'Choose which portal this login is for.' });
  const username = clean(b.username);
  // Not trimmed: a password is exactly what was typed.
  const password = String(b.password ?? '').slice(0, 500);
  if (!username) return res.status(422).json({ error: 'no_username', message: `Enter the ${portal.usernameLabel.toLowerCase()} you sign in with.` });
  if (!password) return res.status(422).json({ error: 'no_password', message: 'Enter the password.' });
  const loginUrl = clean(b.loginUrl, 500);
  if (portal.id === 'other' && !validUrl(loginUrl)) {
    return res.status(422).json({ error: 'bad_login_url', message: 'Enter the portal’s sign-in page, starting https://.' });
  }
  const owner = resolveOwner(ws, orgId, b.owner);
  if (!owner.ok) return res.status(422).json({ error: 'bad_owner', message: 'That person is not on this entity’s list.' });
  const r = await loadRules();
  if (b.schedule !== undefined && !r.validSchedule(b.schedule)) return res.status(422).json(BAD_SCHEDULE);

  const me = memberForSession(req);
  const now = new Date().toISOString();
  const row: PortalLogin = {
    id: `pl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    workspaceId: ws,
    orgId,
    scope: dataScopeForOrg(orgId),
    portal: portal.id,
    label: clean(b.label) || portal.name,
    loginUrl: portal.id === 'other' ? loginUrl : '',
    username,
    password: sealSecret(password, SEAL_PURPOSE),
    passwordSetAt: now,
    accountRef: clean(b.accountRef),
    owner: owner.owner,
    createdAt: now,
    createdBy: me?.email || '',
    updatedAt: now,
    filed: [],
  };
  if (b.schedule !== undefined) applySchedule(row, b.schedule, r);
  const rows = load();
  rows.push(row);
  persist(rows);
  res.status(201).json({ login: view(ws, row, r) });
});

// PATCH /api/retrieve/logins/:id — change a login. A blank password keeps the
// one already sealed: it is never shown, so the form cannot send it back.
retrieveRouter.patch('/logins/:id', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const rows = load();
  const row = rows.find((l) => l.id === req.params.id && l.workspaceId === ws && l.orgId === orgId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const b = req.body ?? {};
  const r = await loadRules();
  if (b.schedule !== undefined && !r.validSchedule(b.schedule)) return res.status(422).json(BAD_SCHEDULE);
  if (b.username !== undefined) {
    const username = clean(b.username);
    if (!username) return res.status(422).json({ error: 'no_username', message: 'The username cannot be blank.' });
    row.username = username;
  }
  if (typeof b.password === 'string' && b.password) {
    row.password = sealSecret(b.password.slice(0, 500), SEAL_PURPOSE);
    row.passwordSetAt = new Date().toISOString();
  }
  if (b.label !== undefined) row.label = clean(b.label) || portalById(row.portal)?.name || row.label;
  if (b.accountRef !== undefined) row.accountRef = clean(b.accountRef);
  if (b.loginUrl !== undefined && row.portal === 'other') {
    const loginUrl = clean(b.loginUrl, 500);
    if (!validUrl(loginUrl)) {
      return res.status(422).json({ error: 'bad_login_url', message: 'Enter the portal’s sign-in page, starting https://.' });
    }
    row.loginUrl = loginUrl;
  }
  if (b.owner !== undefined) {
    const owner = resolveOwner(ws, orgId, b.owner);
    if (!owner.ok) return res.status(422).json({ error: 'bad_owner', message: 'That person is not on this entity’s list.' });
    row.owner = owner.owner;
  }
  if (b.schedule !== undefined) applySchedule(row, b.schedule, r);
  row.updatedAt = new Date().toISOString();
  persist(rows);
  res.json({ login: view(ws, row, r) });
});

// DELETE /api/retrieve/logins/:id — the password goes with it. The documents it
// filed stay: they are costs now, and they happened.
retrieveRouter.delete('/logins/:id', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const rows = load();
  const at = rows.findIndex((l) => l.id === req.params.id && l.workspaceId === ws && l.orgId === orgId);
  if (at < 0) return res.status(404).json({ error: 'not_found' });
  rows.splice(at, 1);
  persist(rows);
  res.json({ ok: true });
});

// Ask n8n for this login's invoices. Never throws: a failure is a note.
async function askN8n(
  ws: string,
  login: PortalLogin,
  runId: string
): Promise<{ documents: FetchedDocument[]; note: string; failed: boolean }> {
  const url = String(env.N8N_RETRIEVE_URL || '').trim();
  if (!url) return { documents: [], note: 'No n8n retrieval webhook is configured (N8N_RETRIEVE_URL).', failed: true };
  const password = openSecret(login.password, SEAL_PURPOSE);
  if (!password) {
    return {
      documents: [],
      note: 'The saved password can no longer be read (the server’s secret changed). Enter it again.',
      failed: true,
    };
  }
  await loadRules();
  const portal = portalById(login.portal);
  const org = getOrganisation(ws, login.orgId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/pdf;q=0.9, */*;q=0.8',
  };
  const key = String(env.N8N_API_KEY || '').trim();
  if (key) headers['X-API-Key'] = key;
  const fields: Record<string, string> = {
    portal: login.portal,
    portal_name: portal?.name || login.portal,
    login_url: login.loginUrl,
    username: login.username,
    password,
    account_ref: login.accountRef,
    login_id: login.id,
    run_id: runId,
    last_retrieved_at: login.lastRetrievedAt || '',
    // Fetch only invoices dated after this one; '' on the first run.
    last_invoice_date: latestInvoiceDate(login),
    xero_name: org?.tenantName || org?.name || '',
    tenant_id: org?.tenantId || '',
  };
  // Both spellings, as the link fetch sends them: snake_case for a Python
  // sidecar, camelCase for a hand-written node.
  const body: Record<string, unknown> = { ...fields, known_references: login.filed.map((f) => f.reference).filter(Boolean) };
  for (const [k, v] of Object.entries(fields)) body[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  body.knownReferences = body.known_references;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.N8N_RETRIEVE_TIMEOUT_MS) || 300000),
    });
  } catch (err) {
    return { documents: [], note: `n8n could not be reached (${err instanceof Error ? err.message : String(err)})`, failed: true };
  }
  const out = await readDocumentsReply(res, login.loginUrl || 'https://portal.invalid/');
  // "n8n returned no document" is a run that WORKED and found nothing new —
  // the ordinary answer on most days. Only a refusal is a failure.
  return { documents: out.documents, note: out.note, failed: !res.ok };
}

const writeRun = (id: string, patch: Partial<PortalLogin>) => {
  const rows = load();
  const row = rows.find((l) => l.id === id);
  if (!row) return null; // deleted while it ran — the documents still stand
  Object.assign(row, patch);
  persist(rows);
  return row;
};

/**
 * One retrieval, start to finish. Exported for the test; the route runs it in
 * the background and answers at once.
 */
export async function runRetrieval(
  req: Request,
  loginId: string,
  by: string,
  opts: { scheduled?: boolean } = {}
): Promise<RunRecord | null> {
  const ws = workspaceId(req);
  const start = load().find((l) => l.id === loginId);
  if (!start) return null;
  const run: RunRecord = {
    id: `run_${Date.now().toString(36)}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    by,
    note: '',
    filed: [],
    skipped: 0,
    ...(opts.scheduled ? { scheduled: true } : {}),
  };
  writeRun(loginId, { run });

  const asked = await askN8n(ws, start, run.id);
  const login = load().find((l) => l.id === loginId);
  if (!login) return null;

  const scope = login.scope;
  const owner = login.owner || generalUserFor(ws, login.orgId)?.email || by;
  const portal = portalById(login.portal);
  const hashesHere = new Set(listBills(scope).map((b) => b.fileHash).filter(Boolean));
  const ledger = [...login.filed];
  const reads: Array<{ id: string; bytes: Buffer; mediaType: string; fileName: string }> = [];

  for (const doc of asked.documents) {
    const hash = createHash('sha256').update(doc.bytes).digest('hex');
    const ref = (doc.reference || '').trim();
    const seen =
      ledger.some((f) => f.hash === hash || (ref && f.reference.toLowerCase() === ref.toLowerCase())) ||
      hashesHere.has(hash);
    if (seen) {
      run.skipped += 1;
      continue;
    }
    let storageKey = '';
    let contentType = doc.mediaType as string;
    try {
      const stored = await putBillFile(scope, hash, doc.mediaType, doc.bytes);
      storageKey = stored.storageKey;
      contentType = stored.contentType || contentType;
    } catch (err) {
      // Kept as a record even so, as every other road does: a document with no
      // retrievable file is still a document, and dropping it would hide a cost.
      console.error('[retrieve] could not store a retrieved file', err);
    }
    const bill = insertBill({
      orgId: scope,
      fileHash: hash,
      fileName: doc.fileName,
      supplier: '',
      invoiceNumber: '',
      documentType: '',
      currency: '',
      total: 0,
      tax: 0,
      date: '',
      category: '',
      createdBy: owner,
      owner,
      storageKey,
      contentType,
      status: 'processing',
      kind: 'cost',
      retrieved: {
        loginId: login.id,
        portal: login.portal,
        portalName: portal?.name || login.portal,
        username: login.username,
        reference: ref,
        at: new Date().toISOString(),
      },
    });
    hashesHere.add(hash);
    const date = isoDate(doc.date);
    ledger.push({ hash, reference: ref, billId: bill.id, at: bill.createdAt, ...(date ? { date } : {}) });
    run.filed.push({ billId: bill.id, displayId: bill.displayId, fileName: doc.fileName });
    reads.push({ id: bill.id, bytes: doc.bytes, mediaType: doc.mediaType, fileName: doc.fileName });
  }

  run.status = asked.failed ? 'failed' : 'done';
  run.endedAt = new Date().toISOString();
  run.note = asked.failed
    ? asked.note
    : run.filed.length
      ? `Filed ${run.filed.length} new document${run.filed.length === 1 ? '' : 's'}${run.skipped ? ` · ${run.skipped} already retrieved` : ''}.`
      : run.skipped
        ? `Nothing new — ${run.skipped} document${run.skipped === 1 ? ' was' : 's were'} already retrieved.`
        : `Nothing new (${asked.note}).`;
  writeRun(loginId, {
    run,
    filed: ledger.slice(-MAX_LEDGER),
    ...(asked.failed ? {} : { lastRetrievedAt: run.startedAt }),
  });

  // Read each the way an upload is read, under the name the portal gave it.
  const settings = readSetting<{ readerProvider?: string }>(ws, 'cybills.extraction-settings.v1', login.orgId);
  const provider = resolveProvider(settings?.readerProvider);
  // Every document in the batch says it is being read for as long as it WAITS
  // to be as well — the stuck-processing sweep counts from the last thing it
  // heard, and the fifth of five would otherwise be filed out of Processing
  // while it sat in this queue (the Drive road's rule, for the same reason).
  const waiting = new Set(reads.map((r) => r.id));
  const beat = setInterval(() => {
    for (const id of waiting) noteReading(scope, id);
  }, 20_000);
  beat.unref?.();
  for (const id of waiting) noteReading(scope, id);
  for (const r of reads) {
    waiting.delete(r.id);
    try {
      await autoRead(req, scope, login.orgId, provider, r.id, r.bytes.toString('base64'), r.mediaType, {
        via: 'upload',
        fileName: r.fileName,
      });
    } catch (err) {
      console.error('[retrieve] read failed', err);
    }
  }
  clearInterval(beat);
  return run;
}

const isRunning = (l: PortalLogin) => runOf(l)?.status === 'running' || runOf(l)?.status === 'queued';

// A run that threw rather than settling, recorded as the reason it failed.
function failRun(id: string, by: string, err: unknown, scheduled = false) {
  console.error('[retrieve] run failed', err);
  const at = new Date().toISOString();
  writeRun(id, {
    run: {
      id: `run_${Date.now().toString(36)}`,
      status: 'failed',
      startedAt: at,
      endedAt: at,
      by,
      ...(scheduled ? { scheduled: true } : {}),
      note: `The retrieval stopped unexpectedly (${err instanceof Error ? err.message : String(err)}).`,
      filed: [],
      skipped: 0,
    },
  });
}

// POST /api/retrieve/logins/:id/run — retrieve now. Answers at once; the page
// polls the login until its run settles.
retrieveRouter.post('/logins/:id/run', async (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  const login = loginsHere(ws, orgId).find((l) => l.id === req.params.id);
  if (!login) return res.status(404).json({ error: 'not_found' });
  if (isRunning(login)) return res.status(409).json({ error: 'already_running', login: view(ws, login, await loadRules()) });
  if (!retrieveEnabled()) {
    return res.status(503).json({ error: 'not_configured', message: 'No n8n retrieval webhook is configured (N8N_RETRIEVE_URL).' });
  }
  const by = memberForSession(req)?.email || '';
  const r = await loadRules();
  void runRetrieval(req, login.id, by).catch((err) => failRun(login.id, by, err));
  const now = load().find((l) => l.id === login.id)!;
  res.status(202).json({ login: view(ws, now, r) });
});

// POST /api/retrieve/run-all — every login of this entity, one after another
// (each is a browser session at n8n's end, and they share its one machine).
retrieveRouter.post('/run-all', (req, res) => {
  const ws = workspaceId(req);
  const orgId = orgIdFor(req);
  if (!mayManage(req, orgId)) return res.status(403).json({ error: 'no_client_access' });
  if (!retrieveEnabled()) {
    return res.status(503).json({ error: 'not_configured', message: 'No n8n retrieval webhook is configured (N8N_RETRIEVE_URL).' });
  }
  const by = memberForSession(req)?.email || '';
  const ids = loginsHere(ws, orgId).filter((l) => !isRunning(l) && l.password).map((l) => l.id);
  const at = new Date().toISOString();
  for (const id of ids) {
    writeRun(id, {
      run: { id: `run_${Date.now().toString(36)}`, status: 'queued', startedAt: at, by, note: '', filed: [], skipped: 0 },
    });
  }
  void (async () => {
    for (const id of ids) {
      try {
        await runRetrieval(req, id, by);
      } catch (err) {
        console.error('[retrieve] run failed', err);
      }
    }
  })();
  res.status(202).json({ started: ids.length });
});

// --- The clock ------------------------------------------------------------------

// Every few minutes, every login whose schedule is due retrieves — ONE at a
// time across every entity, since each run is a browser session on n8n's one
// machine, and a person's own Retrieve now is left to finish first. Due is
// decided by the practice's DAY (retrieveSchedule.js): the day is written
// BEFORE the run, so a slow portal and the next tick cannot both start it, a
// restart cannot run it twice, and a failure is recorded on the login's `run`
// and waits for the next slot rather than being retried into a portal all day
// (three wrong passwords in an hour is how an account gets locked).
let clockBusy = false;
export async function runDueRetrievals(now = new Date()): Promise<number> {
  if (clockBusy || !retrieveEnabled()) return 0;
  clockBusy = true;
  let ran = 0;
  try {
    const r = await loadRules();
    const today = practiceDayKey(now);
    const hour = practiceHour(now);
    const dueIds = load()
      .filter((l) => l.password && r.scheduleDue(l.schedule, { lastDay: l.lastScheduledDay, from: l.scheduleFrom }, today, hour))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((l) => l.id);
    for (const id of dueIds) {
      // Somebody pressed Retrieve somewhere meanwhile: n8n's browser is theirs
      // until it settles. What is still due is picked up by the next tick.
      if (load().some(isRunning)) break;
      const login = load().find((l) => l.id === id);
      if (!login || !login.password) continue;
      // Asked again: the schedule may have been switched off while the one
      // before it ran.
      if (!r.scheduleDue(login.schedule, { lastDay: login.lastScheduledDay, from: login.scheduleFrom }, today, hour)) continue;
      writeRun(id, { lastScheduledDay: today });
      ran += 1;
      try {
        await runRetrieval(robotRequest(login.orgId, '/api/retrieve/schedule'), id, '', { scheduled: true });
      } catch (err) {
        failRun(id, '', err, true);
      }
    }
  } finally {
    clockBusy = false;
  }
  return ran;
}

export function startRetrieveClock(): void {
  const tick = () => void runDueRetrievals().catch((err) => console.error('[retrieve] schedule failed', err));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
