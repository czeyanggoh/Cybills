import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor } from './workspace.js';
import { directManagerFor, appOrigin, emailForName } from './users.js';
import { sendMail, approvalRequestEmail, claimDecisionEmail } from './mailer.js';
import { getBillByIdAny } from './store.js';

// Server-backed expense claims, shared across the workspace (same JSON-store
// pattern as bills). Replaces the old per-browser localStorage claim store, so
// a claim one person creates/approves is visible to everyone.

type Txn = {
  itemId: string;
  date: string;
  supplier: string;
  category: string;
  description?: string; // the item's own description (for the Xero bill line)
  displayId?: string; // numeric display id (Dext-style "#…")
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
  decisionReason?: string; // the manager's reason when a claim is rejected
  archived: boolean;
  deleted: boolean;
  createdBy: string;
  createdAt: string;
  // CYHR handoff (Model B): when the approved payable was last sent to CYHR, the
  // amount sent, and by whom. Re-sending updates the same CYHR payable by claimId.
  // hrRevision is the monotonic counter CYHR uses to reject stale re-sends.
  hrSentAt: string;
  hrSentAmount: string;
  hrSentBy: string;
  hrRevision: number;
  // Xero handoff: set once the approved claim is posted as an ACCPAY bill.
  xeroInvoiceId?: string;
  xeroTenantName?: string;
  xeroPostedAt?: string;
};

// Exported so the Xero publish endpoint can load/persist a claim without
// duplicating the collection name.
export function getClaimForXero(ws: string, id: string): Claim | null {
  return loadCollection<Claim>(COLLECTION).find((c) => c.id === id && c.workspaceId === ws && !c.deleted) ?? null;
}
export function saveClaimXero(ws: string, id: string, patch: Partial<Pick<Claim, 'xeroInvoiceId' | 'xeroTenantName' | 'xeroPostedAt' | 'archived'>>): Claim | null {
  const items = loadCollection<Claim>(COLLECTION);
  const claim = items.find((c) => c.id === id && c.workspaceId === ws && !c.deleted);
  if (!claim) return null;
  Object.assign(claim, patch);
  saveCollection(COLLECTION, items);
  return claim;
}

const COLLECTION = 'claims';
const load = () => loadCollection<Claim>(COLLECTION);
const save = (items: Claim[]) => saveCollection(COLLECTION, items);
const nowIso = () => new Date().toISOString();

export const claimsRouter = Router();

// GET /api/claims — every non-deleted claim in the workspace.
// Enrich a claim's transactions with the source bill's current description (and
// supplier) when the stored snapshot lacks one — so items claimed before the
// description was captured still show it in the UI / PDF / Xero. Non-destructive.
function withDescriptions(c: Claim): Claim {
  return {
    ...c,
    transactions: c.transactions.map((t) => {
      if (t.description) return t;
      const bill = getBillByIdAny(String(t.itemId));
      return bill?.description ? { ...t, description: bill.description } : t;
    }),
  };
}

claimsRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  res.json({ claims: load().filter((c) => c.workspaceId === ws && !c.deleted).map(withDescriptions) });
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
    hrSentAt: '',
    hrSentAmount: '',
    hrSentBy: '',
    hrRevision: 0,
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

// A claim that's been submitted for approval or approved is locked from item
// edits — its total must not drift after approval / handoff to CYHR for payment.
const isLocked = (c: Claim) => c.approvalStatus === 'awaiting_approval' || c.approvalStatus === 'approved';

const claimTotal = (c: Claim): string => c.transactions.reduce((n, t) => n + Number(t.total || 0), 0).toFixed(2);

// Email the assigned approver (the claimant's direct manager) that a claim needs
// their review — on submit, or when a new item changes an already-submitted
// claim. Best-effort: silently no-ops when mail isn't configured.
function notifyApprover(req: Request, claim: Claim, updated: boolean): void {
  if (!claim.approverEmail) return;
  const mail = approvalRequestEmail({
    approverName: claim.approver,
    claimantName: claim.claimFor,
    claimName: claim.name,
    total: claimTotal(claim),
    currency: claim.currency || 'SGD',
    url: `${appOrigin(req)}/expense-claims/${claim.id}`,
    updated,
  });
  void sendMail({ to: { email: claim.approverEmail, name: claim.approver }, ...mail }).catch(() => {});
}

// Email the claimant that their claim was approved or rejected (with the reason,
// when rejected). Best-effort — no-ops when mail isn't configured or no email is
// on file. Resolves the claimant's address from their roster row (by claimFor
// name), falling back to whoever created the claim.
function notifyClaimant(req: Request, claim: Claim, decision: 'approved' | 'rejected'): void {
  const ws = claim.workspaceId;
  const email = emailForName(ws, claim.claimFor) || claim.createdBy || '';
  if (!email) return;
  const mail = claimDecisionEmail({
    claimantName: claim.claimFor,
    claimName: claim.name,
    decision,
    deciderName: claim.decidedBy,
    reason: claim.decisionReason,
    url: `${appOrigin(req)}/expense-claims/${claim.id}`,
  });
  void sendMail({ to: { email, name: claim.claimFor }, ...mail }).catch(() => {});
}

// POST /api/claims/:id/items — attach cost items (idempotent per itemId).
// Allowed until the claim is APPROVED — you can still add to a claim that's
// awaiting approval (the total changes, so the approver re-reviews). Only an
// approved claim is locked, to keep its total stable for the CYHR payment.
claimsRouter.post('/:id/items', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (claim.approvalStatus === 'approved') return res.status(409).json({ error: 'claim_locked' });
    const incoming: Txn[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const seen = new Set(claim.transactions.map((t) => t.itemId));
    let added = 0;
    for (const t of incoming) {
      if (!t || seen.has(t.itemId)) continue;
      claim.transactions.push({ ...t, addedBy: t.addedBy || me.name });
      claim.history.unshift({ text: `Item ${t.itemId} was added to the expense claim`, by: t.addedBy || me.name, at: nowIso() });
      seen.add(t.itemId);
      added += 1;
    }
    // Adding to a submitted claim changes its total — flag it so the assigned
    // approver re-reviews. It stays in their approval queue (still awaiting).
    if (added && claim.approvalStatus === 'awaiting_approval' && claim.approver) {
      claim.history.unshift({
        text: `${added} item(s) added after submission — ${claim.approver} to re-review the updated total`,
        by: me.name,
        at: nowIso(),
      });
      notifyApprover(req, claim, true);
    }
  })
);

// POST /api/claims/:id/items/remove — remove items (by itemId) from the claim.
claimsRouter.post('/:id/items/remove', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (isLocked(claim)) return res.status(409).json({ error: 'claim_locked' });
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
    if (isLocked(claim)) return res.status(409).json({ error: 'claim_locked' });
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

// POST /api/claims/:id/update — edit top-level claim fields (name, end date).
// Locked once approved so a finalized claim's details can't drift. End date is
// stored verbatim (the client sends canonical ISO YYYY-MM-DD).
claimsRouter.post('/:id/update', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (claim.approvalStatus === 'approved') return res.status(409).json({ error: 'claim_locked' });
    const b = req.body ?? {};
    if (typeof b.name === 'string' && b.name.trim()) claim.name = b.name.trim();
    if (typeof b.endDate === 'string') {
      const d = b.endDate.trim();
      claim.endDate = d;
      claim.claimDate = d; // keep the two in sync (claimDate mirrors endDate)
      claim.history.unshift({ text: `End date set to ${d || '—'}`, by: me.name, at: nowIso() });
    }
  })
);

// POST /api/claims/:id/submit — submit for approval. The approver is derived
// automatically from the claimant's direct manager (set in Users), so there's no
// approver to pick. Fails with 'no_manager' when the claimant has none assigned.
claimsRouter.post('/:id/submit', (req, res) =>
  mutate(req, res, (claim, me) => {
    const manager = directManagerFor(workspaceId(req), claim.claimFor);
    if (!manager) {
      return res.status(400).json({ error: 'no_manager', claimant: claim.claimFor });
    }
    claim.approvalStatus = 'awaiting_approval';
    claim.approver = manager.name;
    claim.approverEmail = manager.email;
    claim.decidedBy = '';
    claim.decidedAt = '';
    claim.history.unshift({ text: `This claim was submitted for approval to ${manager.name}`, by: me.name, at: nowIso() });
    notifyApprover(req, claim, false);
  })
);

// Only the assigned approver may decide. Match on email OR name (mirroring the
// client's own check): the approver is picked from the team roster, and a
// person's roster email can differ from their login email (e.g. a gmail login
// vs a work address) — matching only on email would then lock out the real
// approver. Permissive when no approver is assigned, or in a session-less
// mock/dev context.
function ensureApprover(claim: Claim, me: { email: string; name: string }, res: Response): Response | void {
  if (!claim.approverEmail && !claim.approver) return; // open claim — anyone may decide
  const norm = (s: string) => s.trim().toLowerCase();
  const emailMatch = Boolean(me.email && claim.approverEmail && norm(me.email) === norm(claim.approverEmail));
  const nameMatch = Boolean(me.name && claim.approver && norm(me.name) === norm(claim.approver));
  if (emailMatch || nameMatch) return;
  return res.status(403).json({ error: 'not_approver', approver: claim.approver });
}

claimsRouter.post('/:id/approve', (req, res) =>
  mutate(req, res, (claim, me) => {
    const blocked = ensureApprover(claim, me, res);
    if (blocked) return blocked;
    claim.approvalStatus = 'approved';
    claim.decidedBy = me.name;
    claim.decidedAt = nowIso();
    claim.decisionReason = '';
    claim.history.unshift({ text: `This claim was approved by ${me.name}`, by: me.name, at: nowIso() });
    notifyClaimant(req, claim, 'approved');
  })
);

claimsRouter.post('/:id/reject', (req, res) =>
  mutate(req, res, (claim, me) => {
    const blocked = ensureApprover(claim, me, res);
    if (blocked) return blocked;
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    claim.approvalStatus = 'rejected';
    claim.decidedBy = me.name;
    claim.decidedAt = nowIso();
    claim.decisionReason = reason;
    claim.history.unshift({
      text: reason ? `This claim was rejected by ${me.name}: ${reason}` : `This claim was rejected by ${me.name}`,
      by: me.name,
      at: nowIso(),
    });
    notifyClaimant(req, claim, 'rejected');
  })
);

// POST /api/claims/:id/mark-hr-sent  { amount } — record that the approved
// payable was handed to CYHR. Re-callable: CYHR upserts by claimId, so
// re-sending updates the existing payable (and its amount) rather than
// creating a duplicate. Only meaningful once the claim is approved.
claimsRouter.post('/:id/mark-hr-sent', (req, res) =>
  mutate(req, res, (claim, me) => {
    const wasSent = Boolean(claim.hrSentAt);
    claim.hrSentAt = nowIso();
    claim.hrSentAmount = String(req.body?.amount ?? '');
    claim.hrSentBy = me.name;
    // Monotonic revision so CYHR can reject a stale/replayed re-send.
    const revision = Number(req.body?.revision);
    claim.hrRevision = Number.isFinite(revision) && revision > claim.hrRevision ? revision : claim.hrRevision + 1;
    const amt = claim.hrSentAmount ? ` (${claim.currency} ${claim.hrSentAmount})` : '';
    claim.history.unshift({
      text: `Payable ${wasSent ? 're-sent' : 'sent'} to HR for payment${amt}`,
      by: me.name,
      at: nowIso(),
    });
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
