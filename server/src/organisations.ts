import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { env, googleEnabled } from './env.js';
import { readSession } from './auth.js';
import { WORKSPACE_ID, workspaceId } from './workspace.js';
// Who may open which client entity is a fact about the roster, so it is decided
// in users.ts next to the rows it reads. (users.ts imports this module back for
// the org lookups — neither one calls the other while loading, so the cycle is
// inert.)
import {
  memberForSession,
  canAccessOrg,
  canManagePractice,
  ensureGeneralUser,
  grantClientAccess,
  effectiveRoleFor,
  isBusinessAdminRole,
  normaliseSuffix,
  localPart,
  suffixForUser,
  orgIdForUser,
  groupSubjectFor,
  ensure as ensureUsers,
  INBOUND_MAIL_DOMAIN,
} from './users.js';
import { renameChannelsForUsers } from './waRename.js';

// Organisations = the client entities bills are published for. Each one is
// linked to a Xero organisation (tenant) that cyworkspace holds a connection
// for; CYBills stores only the tenant's id + name and routes every Xero call
// through the relay (see xero.ts). Same dependency-free JSON-store pattern as
// store.ts — swapping to a real DB later is mechanical.

export type Organisation = {
  id: string;
  orgId: string; // workspace scope (signed-in email domain — see bills.ts orgIdFor)
  name: string; // display name in CYBills (defaults to the Xero org name)
  // Xero tenant UUID, resolved by the cyworkspace relay. EMPTY for a standalone
  // entity — kept a required string rather than made optional so the dozens of
  // `.tenantId` reads across xero.ts don't each need a null check; every one of
  // them already guards on falsiness.
  tenantId: string;
  tenantName: string; // Xero organisation name at link time (display only)
  // An entity that is not a real company and has no books of its own: a bridge
  // between the people who submit costs and the company whose ledger receives
  // them. Absent (or '') reads as 'xero', so nothing needs migrating.
  kind?: 'xero' | 'standalone';
  // For a standalone entity, the linked entity whose Xero its claims post into.
  parentOrgId?: string;
  // This entity's short form in an inbound email address:
  // `martin.redalpha@cybills.sg`. Empty (the default) leaves its people on the
  // bare `martin@cybills.sg` they have always had. See normaliseSuffix in
  // users.ts, which owns the rules — an address is a fact about the roster.
  emailSuffix?: string;
  createdAt: string; // ISO timestamp
  createdBy: string; // signed-in email, or '' in mock mode
};

export const isStandalone = (o: Organisation | null | undefined): boolean =>
  o?.kind === 'standalone';

// The entity whose Xero tenant actually receives this one's postings: itself
// when it has a tenant, otherwise its parent. Null when there is nowhere to
// post — no parent, a parent that has since been unlinked, or a parent that is
// itself standalone (bridges never chain, or "where does this post?" stops
// having one answer).
export function publishTargetFor(ws: string, o: Organisation | null): Organisation | null {
  if (!o) return null;
  if (o.tenantId) return o;
  const parent = o.parentOrgId ? getOrganisation(ws, o.parentOrgId) : null;
  return parent && parent.tenantId ? parent : null;
}

// Same location strategy as the bills store: server/.data survives the
// deploy's `git reset --hard`; BILLS_DATA_DIR overrides for both stores.
const DATA_DIR = env.BILLS_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url));
const DATA_FILE = `${DATA_DIR}/organisations.json`;

let cache: Organisation[] | null = null;

function load(): Organisation[] {
  if (cache) return cache;
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      cache = Array.isArray(parsed?.organisations) ? (parsed.organisations as Organisation[]) : [];
    } else {
      cache = [];
    }
  } catch (err) {
    console.error('[organisations] could not read store; starting empty', err);
    cache = [];
  }
  // Tenancy migration: fold legacy domain-scoped orgs into the shared workspace.
  let migrated = false;
  for (const o of cache) {
    if (o.orgId !== WORKSPACE_ID) {
      o.orgId = WORKSPACE_ID;
      migrated = true;
    }
  }
  if (migrated) persist(cache);
  return cache;
}

function persist(organisations: Organisation[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ organisations }, null, 2));
  renameSync(tmp, DATA_FILE);
}

export function listOrganisations(orgId: string): Organisation[] {
  return load()
    .filter((o) => o.orgId === orgId)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export function getOrganisation(orgId: string, id: string): Organisation | null {
  return load().find((o) => o.orgId === orgId && o.id === id) ?? null;
}

// The "primary" organisation owns the legacy data (bills created before books
// were split per-org). Prefer the CY Business Management entity by name, else
// the oldest org. Empty string when no orgs are linked yet.
export function primaryOrgId(): string {
  const orgs = load().filter((o) => o.orgId === WORKSPACE_ID);
  if (!orgs.length) return '';
  const byAge = (a: Organisation, b: Organisation) => a.createdAt.localeCompare(b.createdAt);
  const cybm = orgs.filter((o) => /cy business management/i.test(o.name)).sort(byAge);
  return (cybm[0] ?? [...orgs].sort(byAge)[0]).id;
}

// Which bills-store scope a requested organisation maps to. The primary org (and
// no selection) resolves to the legacy WORKSPACE_ID scope, so existing data
// stays under CY Business Management; every other org gets an isolated scope
// keyed on its own id — separate Costs/Sales books per organisation.
export function dataScopeForOrg(requestedOrgId: string): string {
  if (!requestedOrgId) return WORKSPACE_ID;
  return requestedOrgId === primaryOrgId() ? WORKSPACE_ID : requestedOrgId;
}

export const organisationsRouter = Router();

// Linking a client entity is the PRACTICE's job. A client's own admin runs
// their staff and their books; they do not add companies to the firm's list —
// and the picker that does it is a list of every Xero organisation CYBM has
// connected, which is the firm's client list. Mock/dev (no auth) stays open.
function requirePracticeTeam(req: Request, res: Response): boolean {
  if (!googleEnabled) return true;
  const me = memberForSession(req);
  if (me?.practice && !me.deactivated) return true;
  res.status(403).json({
    error: 'not_practice_team',
    message: 'Only the practice team can add or remove client entities.',
  });
  return false;
}

// GET /api/organisations — the linked organisations the CALLER may open, A→Z.
// A client entity's own staff see only their entity; a practice colleague sees
// the clients they've been given access to. Flags the primary org so the client
// can keep the legacy demo/sample docs there only.
//
// `?all=1` returns every linked entity regardless of access, for whoever runs
// the practice — assigning client access means choosing from the full list,
// which is not the same as being able to work in all of them.
organisationsRouter.get('/', (req, res) => {
  const primary = primaryOrgId();
  const ws = workspaceId(req);
  let me = memberForSession(req);
  // Somebody signed in who is on nobody's roster is a member of NOTHING — a
  // person mid-signup, or one whose Google address isn't the one an admin
  // entered. The access predicate answers "true" for a caller it can't place
  // (so that sessionless mock/dev behaves as it always has), and that read as
  // "every client" here: the whole client list, names and all, to anyone who
  // could sign in. They get an empty list and the app sends them to /join,
  // which is where they actually belong.
  if (googleEnabled && readSession(req) && !me) return res.json({ organisations: [] });
  // Repair the entities created before creating one granted its creator access
  // (see grantClientAccess): they exist, they belong to this person, and they
  // are invisible to them. Re-read the row when anything changed, so THIS
  // response already includes them rather than the next one.
  if (me?.email && !me.allClients) {
    const mine = String(me.email).trim().toLowerCase();
    const repaired = listOrganisations(ws)
      .filter((o) => String(o.createdBy || '').trim().toLowerCase() === mine)
      .map((o) => grantClientAccess(ws, mine, o.id))
      .some(Boolean);
    if (repaired) me = memberForSession(req) ?? me;
  }
  const wantsAll = req.query.all === '1' && (!me || canManagePractice(me));
  const all = listOrganisations(ws);
  const organisations = all
    .filter((o) => wantsAll || canAccessOrg(me, o.id))
    // A bridge entity's parent is very often one the caller CANNOT open — an ST
    // Engineering admin works in the bridge and nowhere else. Resolving the
    // name here rather than leaving the client to find it in a list it was
    // never given is the difference between "posts into Red Alpha" and the
    // Categories tab announcing that no parent is set.
    .map((o) => ({
      ...o,
      isPrimary: o.id === primary,
      parentName: o.parentOrgId ? all.find((p) => p.id === o.parentOrgId)?.name || '' : '',
    }));
  res.json({ organisations });
});

// POST /api/organisations — link a new organisation to a Xero tenant.
// Body: { name?, tenantId, tenantName }. The tenant comes from the picker
// backed by GET /api/xero/tenants, so tenantId is a relay-resolvable UUID.
organisationsRouter.post('/', (req, res) => {
  if (!requirePracticeTeam(req, res)) return;
  const b = req.body ?? {};
  const tenantId = String(b.tenantId ?? '').trim();
  const tenantName = String(b.tenantName ?? '').trim();
  const standalone = String(b.kind ?? '') === 'standalone';
  const parentOrgId = String(b.parentOrgId ?? '').trim();
  const orgId = workspaceId(req);
  const organisations = load();

  // A standalone entity has no Xero of its own, so it needs a name of its own
  // (there is no tenant name to fall back on) and somewhere for its claims to
  // go. A parent that is itself standalone is refused: bridges must not chain,
  // or "where does this post?" stops having one answer.
  if (standalone) {
    if (!String(b.name ?? '').trim()) return res.status(400).json({ error: 'name_required' });
    if (!parentOrgId) return res.status(400).json({ error: 'parent_required' });
    const parent = organisations.find((o) => o.orgId === orgId && o.id === parentOrgId);
    if (!parent) return res.status(400).json({ error: 'parent_not_found' });
    if (!parent.tenantId) {
      return res.status(400).json({
        error: 'parent_not_connected',
        message: `"${parent.name}" isn't connected to Xero, so it can't receive another entity's claims.`,
      });
    }
  } else if (!tenantId) {
    return res.status(400).json({ error: 'tenant_required' });
  }

  // Only meaningful for a Xero-linked entity: every standalone one stores '',
  // so an unguarded check would 409 the SECOND one against the first.
  const dup = tenantId ? organisations.find((o) => o.orgId === orgId && o.tenantId === tenantId) : null;
  if (dup) return res.status(409).json({ error: 'already_linked', organisation: dup });

  // Also block a second organisation with the same display name — the earlier
  // guard only caught an identical Xero tenant, so the same company linked under
  // a different tenant slipped through as a confusing duplicate.
  const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const desiredName = String(b.name ?? '').trim() || tenantName || 'Untitled organisation';
  const nameDup = organisations.find((o) => o.orgId === orgId && normName(o.name) === normName(desiredName));
  if (nameDup) {
    return res.status(409).json({
      error: 'name_exists',
      message: `An organisation named "${nameDup.name}" is already linked. Remove or rename it before adding another with the same name.`,
      organisation: nameDup,
    });
  }

  const me = readSession(req);
  const organisation: Organisation = {
    id: `org_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    orgId,
    name: desiredName,
    tenantId: standalone ? '' : tenantId,
    tenantName: standalone ? '' : tenantName,
    ...(standalone ? { kind: 'standalone' as const, parentOrgId } : {}),
    createdAt: new Date().toISOString(),
    createdBy: me?.email ?? '',
  };
  organisations.push(organisation);
  persist(organisations);
  // Client access is an explicit list, so a brand-new entity is in nobody's —
  // including the list of the person who just created it. Without this the
  // dialog closes on a successful create and the switcher shows nothing new,
  // which is indistinguishable from the create having failed.
  if (me?.email) grantClientAccess(orgId, String(me.email).trim().toLowerCase(), organisation.id);
  // A linked client entity starts with one user: its general account, which
  // owns everything nobody claimed — every document a practice colleague adds
  // here lands on it unless they name one of the client's own people. Created
  // with the entity so the Users list is never empty, and so there is always
  // somewhere for unassigned work to go. Never let a roster hiccup fail the
  // link itself: ensure() creates the row on the next read either way.
  try {
    ensureGeneralUser(orgId, organisation.id);
  } catch (err) {
    console.error('[organisations] could not create the general user', err);
  }
  res.json({ ok: true, organisation });
});

// DELETE /api/organisations/:id — unlink. Does not touch cyworkspace or Xero;
// it only removes CYBills' pointer to the tenant.
organisationsRouter.delete('/:id', (req, res) => {
  if (!requirePracticeTeam(req, res)) return;
  const orgId = workspaceId(req);
  const organisations = load();
  const idx = organisations.findIndex((o) => o.orgId === orgId && o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  organisations.splice(idx, 1);
  persist(organisations);
  res.json({ ok: true });
});

// PUT /api/organisations/:id/email-suffix — set (or clear) the short form this
// entity's inbound addresses carry: `martin.redalpha@cybills.sg`.
//
// Its own admin's decision, not the practice's: it is this entity's name in an
// address, and the people who have to be told the address work here. What they
// may NOT do is take a short form another client is already using — two
// entities on one suffix would put two Martins on one address, and every bill
// forwarded to it would file under whichever row was found first.
//
// A route of its own rather than a settings blob, because that is the only
// place both halves of the check can be made: no other entity holds this
// suffix, and no address it produces already reaches somebody else.
organisationsRouter.put('/:id/email-suffix', (req, res) => {
  const ws = workspaceId(req);
  const organisations = load();
  const organisation = organisations.find((o) => o.orgId === ws && o.id === req.params.id);
  if (!organisation) return res.status(404).json({ error: 'not_found' });
  const me = memberForSession(req);
  const mayEdit = !googleEnabled
    ? true
    : me
      ? canManagePractice(me) ||
        (canAccessOrg(me, organisation.id) && isBusinessAdminRole(effectiveRoleFor(me, organisation.id)))
      : false;
  if (!mayEdit) return res.status(403).json({ error: 'not_an_admin' });

  const raw = String(req.body?.suffix ?? '');
  const suffix = normaliseSuffix(raw);
  // Typed something, and nothing usable survived it. Storing '' would quietly
  // read as "no suffix", which is the opposite of what was asked for.
  if (raw.trim() && !suffix) return res.status(400).json({ error: 'invalid_suffix' });
  if (suffix === normaliseSuffix(organisation.emailSuffix || '')) {
    return res.json({ ok: true, organisation, addresses: 0 });
  }

  const clash = organisations.find(
    (o) => o.orgId === ws && o.id !== organisation.id && normaliseSuffix(o.emailSuffix || '') === suffix && suffix
  );
  if (clash) return res.status(409).json({ error: 'suffix_taken', takenBy: clash.name });

  // What the change would actually produce. A suffix is set once and read by
  // every address in the entity, so the collision to look for is not the
  // suffix's but the addresses' — `martin.redalpha` could already be somebody's
  // bare handle, however unlikely, and finding that out afterwards means
  // finding it out as misfiled paperwork.
  const users = ensureUsers(ws).filter((u) => !u.removed && !u.general && u.emailHandle);
  const memo = new Map<string, string>();
  const mine = users.filter((u) => orgIdForUser(u) === organisation.id);
  const others = users.filter((u) => orgIdForUser(u) !== organisation.id);
  const takenElsewhere = new Map(
    others.map((u) => [localPart(String(u.emailHandle).toLowerCase(), suffixForUser(u, memo)), u])
  );
  // The short form standing alone is the ENTITY's own address — mail to it
  // files to the general account — so it has to be free too. Somebody else's
  // bare handle already answering to it means the entity would never receive
  // anything there, and nothing on either page would say why.
  const catchOwner = suffix ? takenElsewhere.get(suffix) : undefined;
  if (catchOwner) {
    return res.status(409).json({
      error: 'address_taken',
      address: `${suffix}@${INBOUND_MAIL_DOMAIN}`,
      person: organisation.name,
      takenBy: catchOwner.name || catchOwner.email,
    });
  }
  for (const u of mine) {
    const owner = takenElsewhere.get(localPart(String(u.emailHandle).toLowerCase(), suffix));
    if (owner) {
      return res.status(409).json({
        error: 'address_taken',
        address: `${localPart(String(u.emailHandle).toLowerCase(), suffix)}@${INBOUND_MAIL_DOMAIN}`,
        person: u.name || u.email,
        takenBy: owner.name || owner.email,
      });
    }
  }

  organisation.emailSuffix = suffix;
  persist(organisations);
  // Every WhatsApp collection group in the entity is NAMED after the address of
  // the person it was opened for, so the addresses moving means those names are
  // now last week's. Renamed here, from the same `groupSubjectFor` they were
  // opened with, and read AFTER the write so each one gets the address it has
  // now. Not awaited: this is CYWS's business and a page is waiting on ours.
  void renameChannelsForUsers(
    ws,
    mine.map((u) => ({ id: u.id, subject: groupSubjectFor(u, organisation.name) }))
  );
  // How many people it just repointed, so the page can say so rather than
  // leaving somebody to open a roster and count.
  res.json({ ok: true, organisation, addresses: mine.length });
});
