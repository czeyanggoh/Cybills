import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor } from './workspace.js';
import { sendMail, EmailNotConfiguredError } from './email.js';
import { approvalRequestSubject, buildApprovalRequestHtml } from './claimEmail.js';

// Server-backed expense claims, shared across the workspace (same JSON-store
// pattern as bills). Replaces the old per-browser localStorage claim store, so
// a claim one person creates/approves is visible to everyone.

export type Txn = {
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
export type Claim = {
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

// Read one claim in a workspace. Exported so the email routes can render a
// summary from the STORED claim rather than trusting rows sent by the client.
export function getClaimById(ws: string, id: string): Claim | undefined {
  return load().find((c) => c.id === id && c.workspaceId === ws && !c.deleted);
}

// Append a history event to a stored claim. Re-reads the collection so it never
// clobbers a concurrent write (used after an awaited email send).
function appendHistory(ws: string, id: string, text: string, by: string): void {
  const items = load();
  const claim = items.find((c) => c.id === id && c.workspaceId === ws);
  if (!claim) return;
  claim.history.unshift({ text, by, at: nowIso() });
  save(items);
}

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

// Best-effort notification to the assigned approver (call-site convention A:
// mail is a convenience, submitting succeeds either way). Never throws — the
// caller gets a boolean plus a short reason so the UI can show a fallback.
async function notifyApprover(
  claim: Claim,
  submittedBy: string
): Promise<{ sent: boolean; error?: string }> {
  if (!claim.approverEmail) return { sent: false, error: 'no approver email on file' };
  try {
    await sendMail({
      to: claim.approverEmail,
      subject: approvalRequestSubject(claim),
      // Rendered server-side from the stored claim, every value escaped.
      htmlBody: buildApprovalRequestHtml(claim, submittedBy),
    });
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Not-configured is the expected state in dev — log it quietly.
    if (err instanceof EmailNotConfiguredError) {
      console.warn('[cybills/claims] approver notification skipped:', msg);
    } else {
      console.error('[cybills/claims] approver notification failed:', msg);
    }
    return { sent: false, error: msg.slice(0, 300) };
  }
}

// POST /api/claims/:id/submit — submit for approval to a chosen approver, then
// email them (best effort). The claim is saved before the send so a mail
// failure can never lose the submission.
claimsRouter.post('/:id/submit', async (req, res) => {
  const ws = workspaceId(req);
  const items = load();
  const claim = items.find((c) => c.id === req.params.id && c.workspaceId === ws);
  if (!claim) return res.status(404).json({ error: 'not_found' });

  const me = actor(req);
  claim.approvalStatus = 'awaiting_approval';
  claim.approver = String(req.body?.approver || '');
  claim.approverEmail = String(req.body?.approverEmail || '');
  claim.decidedBy = '';
  claim.decidedAt = '';
  claim.history.unshift({
    text: `This claim was submitted for approval to ${claim.approver}`,
    by: me.name,
    at: nowIso(),
  });
  save(items);

  const notified = await notifyApprover(claim, me.name);
  if (notified.sent) {
    // Visible in-app confirmation that the approver was actually emailed —
    // when mail is off, the history simply doesn't gain this line.
    appendHistory(ws, claim.id, `Approval request emailed to ${claim.approverEmail}`, me.name);
  }

  // Re-read so the response carries any history line we just appended.
  return res.json({ claim: getClaimById(ws, claim.id) ?? claim, notified });
});

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
