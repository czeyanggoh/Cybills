import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { env } from './env.js';
import { readSession } from './auth.js';
import { orgIdFor } from './bills.js';

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

export const organisationsRouter = Router();

// GET /api/organisations — the caller's linked organisations, A→Z.
organisationsRouter.get('/', (req, res) => {
  res.json({ organisations: listOrganisations(orgIdFor(req)) });
});

// POST /api/organisations — link a new organisation to a Xero tenant.
// Body: { name?, tenantId, tenantName }. The tenant comes from the picker
// backed by GET /api/xero/tenants, so tenantId is a relay-resolvable UUID.
organisationsRouter.post('/', (req, res) => {
  const b = req.body ?? {};
  const tenantId = String(b.tenantId ?? '').trim();
  const tenantName = String(b.tenantName ?? '').trim();
  if (!tenantId) return res.status(400).json({ error: 'tenant_required' });

  const orgId = orgIdFor(req);
  const organisations = load();
  const dup = organisations.find((o) => o.orgId === orgId && o.tenantId === tenantId);
  if (dup) return res.status(409).json({ error: 'already_linked', organisation: dup });

  const me = readSession(req);
  const organisation: Organisation = {
    id: `org_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    orgId,
    name: String(b.name ?? '').trim() || tenantName || 'Untitled organisation',
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
  const orgId = orgIdFor(req);
  const organisations = load();
  const idx = organisations.findIndex((o) => o.orgId === orgId && o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  organisations.splice(idx, 1);
  persist(organisations);
  res.json({ ok: true });
});
