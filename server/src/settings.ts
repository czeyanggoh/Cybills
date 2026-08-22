import { Router } from 'express';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, WORKSPACE_ID } from './workspace.js';
import { primaryOrgId } from './organisations.js';

// Generic per-workspace settings blobs (shared). Backs the small "settings-like"
// client stores — Lists (categories/tax rates/projects), custom categories, and
// customer/supplier rules — each of which persists a single JSON value keyed by
// a stable name. GET returns the value (or null); PUT replaces it.

type Setting = { workspaceId: string; key: string; value: unknown };
const COLLECTION = 'settings';

export const settingsRouter = Router();

// Read one settings blob server-side. The client's per-entity stores key on
// `<key>::<orgId>` and fall back to the workspace-wide blob they used to share
// (see blobStore.js), so this follows the same two steps — otherwise a setting
// the user changed before entities existed would read as unset here.
export function readSetting<T = unknown>(ws: string, key: string, org = ''): T | null {
  const items = loadCollection<Setting>(COLLECTION);
  const at = (k: string) => items.find((s) => s.workspaceId === ws && s.key === k)?.value;
  const own = at(`${key}::${org || 'default'}`);
  const value = own ?? at(key);
  return (value ?? null) as T | null;
}

settingsRouter.get('/:key', (req, res) => {
  const ws = workspaceId(req);
  const rec = loadCollection<Setting>(COLLECTION).find((s) => s.workspaceId === ws && s.key === req.params.key);
  res.json({ value: rec ? rec.value : null });
});

settingsRouter.put('/:key', (req, res) => {
  const ws = workspaceId(req);
  const items = loadCollection<Setting>(COLLECTION);
  const value = req.body?.value ?? null;
  const rec = items.find((s) => s.workspaceId === ws && s.key === req.params.key);
  if (rec) rec.value = value;
  else items.push({ workspaceId: ws, key: req.params.key, value });
  saveCollection(COLLECTION, items);
  res.json({ ok: true });
});

// One-off migration. These blobs were workspace-wide before they became
// per-entity (`<key>::<orgId>`), and that one saved copy is the PRIMARY entity's
// — the practice's own books, where all of this was filled in. Hand it to that
// entity explicitly, so the client no longer has to fall back to it: a
// registration number, a GST number and a company name identify ONE company,
// and inheriting them showed the practice's details under every client that
// hadn't filled its own profile in yet.
//
// Never overwrites an entity that already has its own value, and leaves the
// legacy key in place for the stores that still (rightly) fall back to it —
// category lists and coding rules, where starting from the practice's is a
// convenience rather than a wrong answer. Idempotent: no-ops on every boot
// after the first.
const ADOPTED_BY_PRIMARY = ['cybills.business-profile.v1'];

export function adoptLegacySettings(): number {
  const primary = primaryOrgId();
  if (!primary) return 0; // nothing linked yet — nothing to adopt
  const ws = WORKSPACE_ID;
  const items = loadCollection<Setting>(COLLECTION);
  let adopted = 0;
  for (const key of ADOPTED_BY_PRIMARY) {
    const legacy = items.find((s) => s.workspaceId === ws && s.key === key);
    if (!legacy || legacy.value == null) continue;
    const owned = `${key}::${primary}`;
    if (items.some((s) => s.workspaceId === ws && s.key === owned)) continue;
    items.push({ workspaceId: ws, key: owned, value: legacy.value });
    adopted += 1;
  }
  if (adopted) saveCollection(COLLECTION, items);
  return adopted;
}
