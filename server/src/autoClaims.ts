import { Router, type Request, type Response } from 'express';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
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
import { dataScopeForOrg } from './organisations.js';
import { listBills, parseAmount, type Bill } from './store.js';
import { claimedBillIds, fileAutoClaim } from './claims.js';

// Auto Expense claims — the schedule that bundles a person's finished cost
// documents into an expense claim for them, so nobody has to remember to.
// Follows Dext's "Manage Auto Expense claims": one claims-end date for the whole
// account, a frequency it rolls forward by, an option to sweep in items still
// sitting in the inbox, and a per-user switch saying who is on the schedule.
//
// A claim is filed when a period ENDS, not while it is running: until the
// claims-end date has passed, the current period's documents stay in the Costs
// inbox where they can still be corrected. The day after it passes, each
// enabled person's eligible documents (dated on or before that end date) become
// their claim, and the end date rolls on to the next period.
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
  includeInbox: boolean; // sweep in items still in the inbox, not just Ready ones
  userIds: string[]; // roster users the schedule files claims for
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
// Which documents a period can claim. Ready items always; inbox items (still
// being worked on) only when the account asked for them. Everything else is
// deliberately out: a document already claimed or archived, one published to
// Xero (the ledger has it — claiming it would pay the cost twice), a sales
// document, and anything still being read.
const READY_ONLY = ['ready'];
const WITH_INBOX = ['new', 'review', 'ready'];

// The day a document counts against — its own date when the reader determined
// one, else the day it was uploaded. Keeps an undated receipt out of limbo.
function billDay(b: Bill): string {
  return isIsoDay(b.date) ? b.date : String(b.createdAt || '').slice(0, 10);
}

// Who a document belongs to. `createdBy` holds the uploader's email, or the name
// an editor picked in Document owner — so a person is matched on either.
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
  const statuses = new Set(s.includeInbox ? WITH_INBOX : READY_ONLY);
  const claimed = claimedBillIds(s.orgId);
  const eligible = listBills(s.orgId).filter(
    (b) =>
      (b.kind || 'cost') === 'cost' &&
      statuses.has(b.status) &&
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
    const mine = eligible.filter((b) => keys.has(norm(b.createdBy)));
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
// giant claim), then leaves the end date on the period now running.
export function runAutoClaims(ws: string, orgId: string): AutoRunResult {
  const s = getSettings(ws, orgId);
  if (!s || !isIsoDay(s.endDate) || !s.userIds.length) {
    return { claims: 0, items: 0, periods: 0, endDate: s?.endDate || '' };
  }
  // Nothing to do until a period has actually ended. Checked before any roster
  // or bills work, because this runs on every bills fetch the app makes.
  const today = todayIso();
  if (s.endDate >= today) return { claims: 0, items: 0, periods: 0, endDate: s.endDate };
  const wanted = new Set(s.userIds);
  const roster = ensureUsers(ws).filter(
    (u) => u.workspaceId === ws && !u.removed && !u.deactivated && wanted.has(u.id)
  );
  if (!roster.length) return { claims: 0, items: 0, periods: 0, endDate: s.endDate };

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
  if (periodEnd !== s.endDate) putSettings(ws, orgId, { endDate: periodEnd, lastRunAt: nowIso() });
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
// everyone who can have documents in this entity's book. That's the entity's own
// employees (the Users page list) PLUS the practice colleagues with access to it
// — they upload and claim here too, and leaving them out would empty the dialog
// in the practice's own entity, where every submitter is a colleague.
autoClaimsRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  const org = orgScope(req);
  const s = getSettings(ws, autoScope(req));
  const users = ensureUsers(ws)
    .filter(
      (u) =>
        u.workspaceId === ws &&
        !u.removed &&
        !u.deactivated &&
        (u.practice ? canAccessOrg(u, org) : (u.organisationId || '') === org)
    )
    .map(publicUser);
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
  const known = new Set(ensureUsers(ws).filter((u) => u.workspaceId === ws && !u.removed).map((u) => u.id));
  const userIds: string[] = (Array.isArray(b.userIds) ? b.userIds : [])
    .map((id: unknown) => String(id))
    .filter((id: string) => known.has(id));
  const saved = putSettings(ws, autoScope(req), {
    // On End of month the stored date IS the month end, so what the dialog shows
    // and what the schedule fires on can never drift apart.
    endDate: endDate && endOfMonth ? endOfMonthFor(endDate) : endDate,
    endOfMonth,
    frequency,
    includeInbox: Boolean(b.includeInbox),
    userIds: [...new Set(userIds)],
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
