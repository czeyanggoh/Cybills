import { Router } from 'express';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';

// Generic per-workspace settings blobs (shared). Backs the small "settings-like"
// client stores — Lists (categories/tax rates/projects), custom categories, and
// customer/supplier rules — each of which persists a single JSON value keyed by
// a stable name. GET returns the value (or null); PUT replaces it.

type Setting = { workspaceId: string; key: string; value: unknown };
const COLLECTION = 'settings';

export const settingsRouter = Router();

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
