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
import { memberForSession, canAccessOrg, canManagePractice } from './users.js';

// Organisations = the client entities bills are published for. Each one is
// linked to a Xero organisation (tenant) that cyworkspace holds a connection
// for; CYBills stores only the tenant's id + name and routes every Xero call
// through the relay (see xero.ts). Same dependency-free JSON-store pattern as
// store.ts — swapping to a real DB later is mechanical.

export type Organisation = {
  id: string;
  orgId: string; // workspace scope (signed-in email domain — see bills.ts orgIdFor)
  name: string; // display name in CYBills (defaults to the Xero org name)
  tenantId: string; // Xero tenant UUID, resolved by the cyworkspace relay
  tenantName: string; // Xero organisation name at link time (display only)
  createdAt: string; // ISO timestamp
  createdBy: string; // signed-in email, or '' in mock mode
};

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
  const me = memberForSession(req);
  const wantsAll = req.query.all === '1' && (!me || canManagePractice(me));
  const organisations = listOrganisations(workspaceId(req))
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
  if (!tenantId) return res.status(400).json({ error: 'tenant_required' });

  const orgId = workspaceId(req);
  const organisations = load();
  const dup = organisations.find((o) => o.orgId === orgId && o.tenantId === tenantId);
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
    tenantId,
    tenantName,
    createdAt: new Date().toISOString(),
    createdBy: me?.email ?? '',
  };
  organisations.push(organisation);
  persist(organisations);
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
