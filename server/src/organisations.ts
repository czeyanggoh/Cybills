import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { env } from './env.js';
import { readSession } from './auth.js';
import { WORKSPACE_ID, workspaceId } from './workspace.js';
// Who may open which client entity is a fact about the roster, so it is decided
// in users.ts next to the rows it reads. (users.ts imports this module back for
// the org lookups — neither one calls the other while loading, so the cycle is
// inert.)
import { memberForSession, canAccessOrg, canManagePractice, ensureGeneralUser, grantClientAccess } from './users.js';

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
  const organisations = listOrganisations(ws)
    .filter((o) => wantsAll || canAccessOrg(me, o.id))
    .map((o) => ({ ...o, isPrimary: o.id === primary }));
  res.json({ organisations });
});

// POST /api/organisations — link a new organisation to a Xero tenant.
// Body: { name?, tenantId, tenantName }. The tenant comes from the picker
// backed by GET /api/xero/tenants, so tenantId is a relay-resolvable UUID.
organisationsRouter.post('/', (req, res) => {
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
  const orgId = workspaceId(req);
  const organisations = load();
  const idx = organisations.findIndex((o) => o.orgId === orgId && o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  organisations.splice(idx, 1);
  persist(organisations);
  res.json({ ok: true });
});
