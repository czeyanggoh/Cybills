import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor } from './workspace.js';

// Server-backed expense claims, shared across the workspace (same JSON-store
// pattern as bills). Replaces the old per-browser localStorage claim store, so
// a claim one person creates/approves is visible to everyone.

type Txn = {
  itemId: string;
  date: string;
  supplier: string;
  category: string;
  project?: string;
  net: string;
  tax: string;
  total: string;
  status?: string;
  addedBy?: string;
};
type Event = { text: string; by: string; at: string };
type Claim = {
  id: string;
  workspaceId: string;
  claimFor: string;
  type: string;
  name: string;
  claimDate: string;
  endDate: string;
  currency: string;
  transactions: Txn[];
  history: Event[];
  approvalStatus: '' | 'awaiting_approval' | 'approved' | 'rejected';
  approver: string;
  approverEmail: string;
  decidedBy: string;
  decidedAt: string;
  archived: boolean;
  deleted: boolean;
  createdBy: string;
  createdAt: string;
};

const COLLECTION = 'claims';
const load = () => loadCollection<Claim>(COLLECTION);
const save = (items: Claim[]) => saveCollection(COLLECTION, items);
const nowIso = () => new Date().toISOString();

export const claimsRouter = Router();

// GET /api/claims — every non-deleted claim in the workspace.
claimsRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  res.json({ claims: load().filter((c) => c.workspaceId === ws && !c.deleted) });
});

// POST /api/claims — create a claim.
claimsRouter.post('/', (req, res) => {
  const b = req.body ?? {};
  const me = actor(req);
  const owner = String(b.claimFor || me.name || 'You');
  const claim: Claim = {
    id: randomUUID(),
    workspaceId: workspaceId(req),
    claimFor: owner,
    type: 'Regular',
    name: String(b.name || 'Expense claim'),
    claimDate: String(b.endDate || ''),
    endDate: String(b.endDate || ''),
    currency: 'SGD',
    transactions: [],
    history: [{ text: 'This expense claim was created', by: me.name || owner, at: nowIso() }],
    approvalStatus: '',
    approver: '',
    approverEmail: '',
    decidedBy: '',
    decidedAt: '',
    archived: false,
    deleted: false,
    createdBy: me.email,
    createdAt: nowIso(),
  };
  const items = load();
  items.push(claim);
  save(items);
  res.json({ claim });
});

// Find + mutate one claim in the caller's workspace, then persist + return it.
function mutate(req: Request, res: Response, fn: (claim: Claim, me: { email: string; name: string }) => Response | void) {
  const ws = workspaceId(req);
  const items = load();
  const claim = items.find((c) => c.id === req.params.id && c.workspaceId === ws);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const early = fn(claim, actor(req));
  if (early) return early; // handler already responded (e.g. 403)
  save(items);
  return res.json({ claim });
}

// POST /api/claims/:id/items — attach cost items (idempotent per itemId).
claimsRouter.post('/:id/items', (req, res) =>
  mutate(req, res, (claim, me) => {
    const incoming: Txn[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const seen = new Set(claim.transactions.map((t) => t.itemId));
    for (const t of incoming) {
      if (!t || seen.has(t.itemId)) continue;
      claim.transactions.push({ ...t, addedBy: t.addedBy || me.name });
      claim.history.unshift({ text: `Item ${t.itemId} was added to the expense claim`, by: t.addedBy || me.name, at: nowIso() });
      seen.add(t.itemId);
    }
  })
);

// POST /api/claims/:id/items/remove — remove items (by itemId) from the claim.
claimsRouter.post('/:id/items/remove', (req, res) =>
  mutate(req, res, (claim, me) => {
    const ids = new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(String));
    const before = claim.transactions.length;
    claim.transactions = claim.transactions.filter((t) => !ids.has(String(t.itemId)));
    const removed = before - claim.transactions.length;
    if (removed) claim.history.unshift({ text: `${removed} item(s) removed from the expense claim`, by: me.name, at: nowIso() });
  })
);

// POST /api/claims/:id/items/update — bulk-edit fields (e.g. category) on items.
claimsRouter.post('/:id/items/update', (req, res) =>
  mutate(req, res, (claim, me) => {
    const ids = new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(String));
    const patch = (req.body?.patch ?? {}) as Partial<Txn>;
    let n = 0;
    for (const t of claim.transactions) {
      if (!ids.has(String(t.itemId))) continue;
      if (typeof patch.category === 'string') t.category = patch.category;
      n += 1;
    }
    if (n) claim.history.unshift({ text: `${n} item(s) bulk-edited`, by: me.name, at: nowIso() });
  })
);

// POST /api/claims/:id/submit — submit for approval to a chosen approver.
claimsRouter.post('/:id/submit', (req, res) =>
  mutate(req, res, (claim, me) => {
    claim.approvalStatus = 'awaiting_approval';
    claim.approver = String(req.body?.approver || '');
    claim.approverEmail = String(req.body?.approverEmail || '');
    claim.decidedBy = '';
    claim.decidedAt = '';
    claim.history.unshift({ text: `This claim was submitted for approval to ${claim.approver}`, by: me.name, at: nowIso() });
  })
);

// Only the assigned approver may decide — enforced when we know both the
// approver's email and the caller's (signed-in) email. Permissive when there's
// no session (mock/dev) so local testing isn't bricked.
function ensureApprover(claim: Claim, me: { email: string; name: string }, res: Response): Response | void {
  if (me.email && claim.approverEmail && me.email.toLowerCase() !== claim.approverEmail.toLowerCase()) {
    return res.status(403).json({ error: 'not_approver', approver: claim.approver });
  }
}

claimsRouter.post('/:id/approve', (req, res) =>
  mutate(req, res, (claim, me) => {
    const blocked = ensureApprover(claim, me, res);
    if (blocked) return blocked;
    claim.approvalStatus = 'approved';
    claim.decidedBy = me.name;
    claim.decidedAt = nowIso();
    claim.history.unshift({ text: `This claim was approved by ${me.name}`, by: me.name, at: nowIso() });
  })
);

claimsRouter.post('/:id/reject', (req, res) =>
  mutate(req, res, (claim, me) => {
    const blocked = ensureApprover(claim, me, res);
    if (blocked) return blocked;
    claim.approvalStatus = 'rejected';
    claim.decidedBy = me.name;
    claim.decidedAt = nowIso();
    claim.history.unshift({ text: `This claim was rejected by ${me.name}`, by: me.name, at: nowIso() });
  })
);

// POST /api/claims/:id/archive  { archived }
claimsRouter.post('/:id/archive', (req, res) =>
  mutate(req, res, (claim) => {
    claim.archived = req.body?.archived !== false;
  })
);

// DELETE /api/claims/:id — soft delete.
claimsRouter.delete('/:id', (req, res) =>
  mutate(req, res, (claim) => {
    claim.deleted = true;
  })
);
