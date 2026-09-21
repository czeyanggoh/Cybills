import { Router, type Request, type Response } from 'express';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, WORKSPACE_ID } from './workspace.js';
import {
  ensure as ensureUsers,
  publicUser,
  memberForSession,
  orgScope,
  effectiveRoleFor,
  isBusinessAdminRole,
  canAccessOrg,
  type User,
} from './users.js';
import { dataScopeForOrg, primaryOrgId } from './organisations.js';
import { listBills, parseAmount, type Bill } from './store.js';
import { claimedBillIds, fileAutoClaim } from './claims.js';

// Auto Expense claims — the schedule that bundles a person's finished cost
// documents into an expense claim for them, so nobody has to remember to.
// Follows Dext's "Manage Auto Expense claims": one claims-end date for the whole
// account, a frequency it rolls forward by, an option to sweep in items still
// sitting in the inbox, and a per-user switch saying who is on the schedule.
//
// A document goes onto its period's claim as soon as it is eligible, not when
// the period ends. Holding the current month's receipts in the inbox until the
// 1st made the switch look broken — somebody enrolled, uploaded a receipt and
// watched nothing happen for three weeks. The running period's claim is a DRAFT,
// and a draft claim tracks its live documents (claims.ts), so a correction made
// on the document afterwards still reaches it. When the claims-end date passes,
// that period's claim is topped up one last time (late arrivals dated inside it)
// and the end date rolls on to the next period. A document dated AFTER the
// running period's end waits for its own period.
//
// There is no background worker: the sweep runs on the bills fetch every list
// in the app already makes (the same self-healing pattern as
// sweepStuckProcessing), so a period that ended while nobody was looking is
// filed the moment someone opens the app. Re-running is idempotent — an item
// already on a claim is never filed twice.

export const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type AutoClaimSettings = {
  workspaceId: string;
  orgId: string; // the bills scope these claims are filed from
  endDate: string; // ISO YYYY-MM-DD — when the CURRENT claims period ends
  endOfMonth: boolean; // keep the end date pinned to the last day of the month
  frequency: Frequency;
  includeInbox: boolean; // Dext's "Include existing inbox items": what was already there when a person was switched on
  userIds: string[]; // roster users the schedule files claims for
  // When each person was switched on. Everything they submit from then on is
  // claimed; what was already sitting in their inbox only with includeInbox.
  enrolledAt?: Record<string, string>;
  lastRunAt: string;
};

const COLLECTION = 'autoClaims';
const load = () => loadCollection<AutoClaimSettings>(COLLECTION);
const nowIso = () => new Date().toISOString();
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// The scope an auto-claim schedule belongs to: the BILLS book, not the
// organisation id. Two organisations that share a book (the primary entity and
// "no selection") must share one schedule, or the same documents would be filed
// onto two claims.
export function autoScope(req: Request): string {
  return dataScopeForOrg(orgScope(req));
}

// Whose claims a schedule can file: the entity's OWN employees — the same list
// the Users page shows. Practice colleagues are out of a CLIENT entity, and
// deliberately so: a colleague holds client access, they are not one of its
// people, and a claim filed for them under a client would be the practice
// claiming an expense from its own customer. They upload documents there, and
// those documents belong to the client, so the way to include one is the
// document's owner field, not a claim in the colleague's name.
//
// The practice's OWN entity is the other side of that same line. There a
// colleague IS one of its people — it is the practice's books, and their own
// expenses are exactly what belongs on them. Excluding them everywhere left the
// practice's team as the only people in CYBills who could never be put on a
// schedule, in the one entity where their claims belong.
//
// The general account is never eligible in either: a claim is money paid back to
// a person, and it is a place for unassigned paperwork to land, not somebody who
// can be reimbursed.
//
// The roster is keyed off the same scope as the settings and the sweep, so the
// dialog's list and what actually gets filed can never disagree: the primary
// entity shares the legacy bills scope, so map that back to its real org id.
function rosterOrgFor(scope: string): string {
  return scope === WORKSPACE_ID ? primaryOrgId() : scope;
}

export function eligibleUsers(ws: string, scope: string): User[] {
  const org = rosterOrgFor(scope);
  const ownEntity = Boolean(org) && org === primaryOrgId();
  return ensureUsers(ws).filter((u) => {
    if (u.workspaceId !== ws || u.removed || u.deactivated || u.general) return false;
    return u.practice ? ownEntity && canAccessOrg(u, org) : (u.organisationId || '') === org;
  });
}

export function getSettings(ws: string, orgId: string): AutoClaimSettings | null {
  return load().find((s) => s.workspaceId === ws && s.orgId === orgId) ?? null;
}

function putSettings(ws: string, orgId: string, patch: Partial<AutoClaimSettings>): AutoClaimSettings {
  const items = load();
  let rec = items.find((s) => s.workspaceId === ws && s.orgId === orgId);
  if (!rec) {
    rec = {
      workspaceId: ws,
      orgId,
      endDate: '',
      endOfMonth: false,
      frequency: 'monthly',
      includeInbox: false,
      userIds: [],
      enrolledAt: {},
      lastRunAt: '',
    };
    items.push(rec);
  }
  Object.assign(rec, patch);
  saveCollection(COLLECTION, items);
  return rec;
}

// --- Dates ------------------------------------------------------------------
// Everything here is a plain ISO day (YYYY-MM-DD) compared as a string, so no
// timezone drifts a period end by a day. "Today" is read in Singapore time —
// the practice's own day, and the same convention item ids use.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
export function todayIso(): string {
  return new Date(Date.now() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}
const isIsoDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmtIso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function shiftDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

// The last day of the month an ISO day falls in — what "End of month" pins to.
export function endOfMonthFor(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return fmtIso(y, m, daysInMonth(y, m));
}

// The next claims-end date after this one. Weekly/fortnightly step by days;
// monthly steps a calendar month, keeping the same day of the month (clamped to
// a short month) — or the last day of it when the account is on End of month.
export function nextPeriodEnd(iso: string, frequency: Frequency, endOfMonth: boolean): string {
  if (frequency === 'weekly') return shiftDays(iso, 7);
  if (frequency === 'fortnightly') return shiftDays(iso, 14);
  const [y, m, d] = iso.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = daysInMonth(ny, nm);
  return fmtIso(ny, nm, endOfMonth ? last : Math.min(d, last));
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-08-26" → "26 Aug 2026", for the claim name a person actually reads.
function prettyDay(iso: string): string {
  if (!isIsoDay(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MON[m - 1]} ${y}`;
}

// --- The sweep --------------------------------------------------------------
// Which documents a period can claim — Dext's rule: "any new items submitted by
// users with Auto Expense claims are automatically added to their open claim",
// whatever state they are in, and the documents that were ALREADY in somebody's
// inbox when they were switched on only when "Include existing inbox items" says
// so. Everything else is deliberately out: a document already claimed or
// archived, one published to Xero (the ledger has it — claiming it would pay
// the cost twice), a sales document, and anything still being read (it is
// claimed the moment the read settles, with the fields the read found).
const CLAIMABLE = new Set(['new', 'review', 'ready']);

// The day a document counts against — its own date when the reader determined
// one, else the day it was uploaded. Keeps an undated receipt out of limbo.
function billDay(b: Bill): string {
  return isIsoDay(b.date) ? b.date : String(b.createdAt || '').slice(0, 10);
}

// Who a document belongs to. `owner` is the answer where one was set (an
// email), and the uploader otherwise; a person is matched on their email or
// their name, since documents written before `owner` existed can still carry a
// display name the backfill couldn't place.
function ownerKeys(u: User): string[] {
  return [norm(u.email), norm(u.name)].filter(Boolean);
}

function txnFor(b: Bill, by: string) {
  const total = parseAmount(b.total);
  const tax = parseAmount(b.tax);
  return {
    itemId: b.id,
    date: b.date || '—',
    supplier: b.supplier || 'Unknown supplier',
    category: b.category || 'Uncategorised',
    description: b.description || '',
    project: b.project || '',
    net: (total - tax).toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
    status: 'ready',
    addedBy: by,
  };
}

export const AUTO_ACTOR = 'Auto expense claims';

export type AutoRunResult = { claims: number; items: number; periods: number; endDate: string };

// File one ended period: every enabled person's eligible documents dated on or
// before `periodEnd` become their claim for it.
function filePeriod(ws: string, s: AutoClaimSettings, roster: User[], periodEnd: string): { claims: number; items: number } {
  const claimed = claimedBillIds(s.orgId);
  const eligible = listBills(s.orgId).filter(
    (b) =>
      (b.kind || 'cost') === 'cost' &&
      CLAIMABLE.has(b.status) &&
      !b.xeroInvoiceId &&
      !claimed.has(b.id) &&
      billDay(b) <= periodEnd
  );
  if (!eligible.length) return { claims: 0, items: 0 };

  let claims = 0;
  let items = 0;
  for (const user of roster) {
    const keys = new Set(ownerKeys(user));
    if (!keys.size) continue;
    const since = s.includeInbox ? '' : s.enrolledAt?.[user.id] || '';
    const mine = eligible.filter(
      (b) => keys.has(norm(b.owner || b.createdBy)) && (!since || String(b.createdAt || '') >= since)
    );
    if (!mine.length) continue; // never file an empty claim
    const filed = fileAutoClaim(ws, s.orgId, {
      claimFor: user.name || user.email,
      periodEnd,
      periodLabel: prettyDay(periodEnd),
      name: `Auto claim — ${prettyDay(periodEnd)}`,
      txns: mine.map((b) => txnFor(b, AUTO_ACTOR)),
      by: AUTO_ACTOR,
    });
    if (filed.created) claims += 1;
    items += filed.added;
  }
  return { claims, items };
}

// Run the schedule for one bills scope. Files every period that has ended since
// the last run (a gap of months still produces one claim per period, not one
// giant claim), leaves the end date on the period now running, and files that
// period's eligible documents onto its draft claim straight away.
export function runAutoClaims(ws: string, orgId: string): AutoRunResult {
  const s = getSettings(ws, orgId);
  if (!s || !isIsoDay(s.endDate) || !s.userIds.length) {
    return { claims: 0, items: 0, periods: 0, endDate: s?.endDate || '' };
  }
  const today = todayIso();
  const wanted = new Set(s.userIds);
  // Re-checked here, not just at save time: someone enrolled before they moved
  // entity (or joined the practice) must stop filing, not keep going quietly.
  const roster = eligibleUsers(ws, orgId).filter((u) => wanted.has(u.id));
  if (!roster.length) return { claims: 0, items: 0, periods: 0, endDate: s.endDate };
  // Enrolled before enrolment dates were kept: count them as enrolled now, so
  // an inbox they already had is not swept in unasked (Dext's default).
  const missing = roster.filter((u) => !s.enrolledAt?.[u.id]);
  if (missing.length) {
    const enrolledAt = { ...(s.enrolledAt || {}) };
    for (const u of missing) enrolledAt[u.id] = nowIso();
    Object.assign(s, putSettings(ws, orgId, { enrolledAt }));
  }

  let periodEnd = s.endDate;
  let claims = 0;
  let items = 0;
  let periods = 0;
  // A period ending today is still running — it is filed tomorrow. The guard
  // bounds a wildly stale end date (or a corrupted one) to a sane number of
  // steps rather than looping forever.
  for (let guard = 0; periodEnd < today && guard < 500; guard += 1) {
    const r = filePeriod(ws, s, roster, periodEnd);
    claims += r.claims;
    items += r.items;
    periods += 1;
    periodEnd = nextPeriodEnd(periodEnd, s.frequency, s.endOfMonth);
  }
  // The period still running files too — onto its own draft claim, the same
  // one it will be topped up on when it ends. Not counted as a period: nothing
  // rolled over.
  const running = filePeriod(ws, s, roster, periodEnd);
  claims += running.claims;
  items += running.items;
  if (periodEnd !== s.endDate || running.items) {
    putSettings(ws, orgId, { endDate: periodEnd, lastRunAt: nowIso() });
  }
  return { claims, items, periods, endDate: periodEnd };
}

// --- Router -----------------------------------------------------------------
// Account-wide settings, so Business Admins only (a practice colleague is one
// inside a client they have access to). Left open when there is no roster to
// check against — mock/dev mode, exactly like the rest of the admin surfaces.
function requireAdmin(req: Request, res: Response): boolean {
  const me = memberForSession(req);
  if (me && !isBusinessAdminRole(effectiveRoleFor(me, orgScope(req)))) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

export const autoClaimsRouter = Router();

// GET /api/auto-claims — the schedule plus the people it can be turned on for:
// this entity's own employees, exactly the list the Users page shows.
autoClaimsRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  const s = getSettings(ws, autoScope(req));
  const users = eligibleUsers(ws, autoScope(req)).map(publicUser);
  res.json({
    settings: {
      endDate: s?.endDate || '',
      endOfMonth: Boolean(s?.endOfMonth),
      frequency: s?.frequency || 'monthly',
      includeInbox: Boolean(s?.includeInbox),
      userIds: s?.userIds || [],
      lastRunAt: s?.lastRunAt || '',
    },
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    today: todayIso(),
  });
});

// PUT /api/auto-claims — replace the schedule. The end date is the only field
// that can strand the feature, so it is validated hard: an unparseable one is
// rejected rather than silently stored and never fired.
autoClaimsRouter.put('/', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ws = workspaceId(req);
  const b = req.body ?? {};
  const endDate = String(b.endDate || '').trim();
  if (endDate && !isIsoDay(endDate)) return res.status(400).json({ error: 'bad_end_date' });
  const frequency = (FREQUENCIES as readonly string[]).includes(String(b.frequency))
    ? (String(b.frequency) as Frequency)
    : 'monthly';
  const endOfMonth = Boolean(b.endOfMonth);
  // Only this entity's own people can be enrolled — anything else in the request
  // is dropped rather than stored to be ignored (or worse, honoured) later.
  const known = new Set(eligibleUsers(ws, autoScope(req)).map((u) => u.id));
  const userIds: string[] = (Array.isArray(b.userIds) ? b.userIds : [])
    .map((id: unknown) => String(id))
    .filter((id: string) => known.has(id));
  // A person switched on now is enrolled now; one already on keeps their date,
  // so re-saving the dialog never pulls in an inbox they had before.
  const prev = getSettings(ws, autoScope(req));
  const enrolledAt: Record<string, string> = {};
  for (const id of new Set(userIds)) enrolledAt[id] = prev?.enrolledAt?.[id] || nowIso();
  const saved = putSettings(ws, autoScope(req), {
    // On End of month the stored date IS the month end, so what the dialog shows
    // and what the schedule fires on can never drift apart.
    endDate: endDate && endOfMonth ? endOfMonthFor(endDate) : endDate,
    endOfMonth,
    frequency,
    includeInbox: Boolean(b.includeInbox),
    userIds: [...new Set(userIds)],
    enrolledAt,
  });
  // Saving a date that is already in the past should take effect now, not on the
  // next bills fetch.
  const run = runAutoClaims(ws, autoScope(req));
  res.json({ settings: { ...saved, endDate: run.endDate }, run });
});

// POST /api/auto-claims/run — file anything due right now. The sweep also rides
// on every bills fetch; this is the explicit "do it now" for an admin.
autoClaimsRouter.post('/run', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ run: runAutoClaims(workspaceId(req), autoScope(req)) });
});
