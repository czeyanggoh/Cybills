import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor, WORKSPACE_ID } from './workspace.js';
import { orgIdFor } from './bills.js';
import { directManagerFor, appOrigin, emailForName, memberForSession, isAdminRole, isGeneralPerson, canAccessOrg, canonicalPersonName, personNameForEmail } from './users.js';
import { sendMail, approvalRequestEmail, claimDecisionEmail, claimShareEmail } from './mailer.js';
import { getBillById, getBillByIdAny, billOrgId, markBillsClaimed, unmarkBillsClaimed, deleteBillsHard, parseAmount } from './store.js';
import { deleteBillFile } from './storage.js';
import { listOrganisations } from './organisations.js';

// Server-backed expense claims, scoped per CLIENT ENTITY (same JSON-store and
// X-Org-Id scoping as bills). Replaces the old per-browser localStorage claim
// store, so a claim one person creates/approves is visible to their colleagues
// — but only inside the entity it belongs to.
//
// Claims were built when CYBills served one company, so they were scoped by the
// constant workspace id and every entity saw the same list. `orgId` is the real
// scope now; `workspaceId` stays on the record as the tenant it was created
// under.

type Txn = {
  itemId: string;
  date: string;
  supplier: string;
  category: string;
  description?: string; // the item's own description (for the Xero bill line)
  displayId?: string; // numeric display id (Dext-style "#…")
  hasFile?: boolean; // the document has a stored receipt (the PDF links to it)
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
  // The client entity whose book this claim belongs to. Matches a bill's orgId:
  // the legacy WORKSPACE_ID scope for the primary org, 'org_…' for every other.
  orgId: string;
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
  description?: string; // the claimant's own note about what this claim is for
  decisionReason?: string; // the manager's reason when a claim is rejected
  archived: boolean;
  deleted: boolean;
  createdBy: string;
  createdAt: string;
  // Auto expense claims: set on a claim the schedule created (Manage Auto
  // Expense claims), with the period end it was filed for. Only an OPEN auto
  // claim for that exact period is topped up again, so re-running is idempotent.
  auto?: boolean;
  autoPeriodEnd?: string;
  // Xero handoff: set once the approved claim is posted as an ACCPAY bill.
  xeroInvoiceId?: string;
  xeroTenantName?: string;
  xeroPostedAt?: string;
  // What Xero says has happened to that bill since — the same three fields a
  // cost document keeps, read back on the invoice webhook (xeroWebhook.ts) and
  // never edited here. On a claim they answer the question its claimant
  // actually has: not "was this approved" but "have I been paid".
  xeroStatus?: string; // PAID | AUTHORISED | VOIDED | …
  xeroPaidDate?: string; // ISO YYYY-MM-DD, only ever set on PAID
  xeroPaymentRef?: string; // the payment's own reference in Xero
};

// Exported so the Xero publish endpoint can load/persist a claim without
// duplicating the collection name.
export function getClaimForXero(org: string, id: string): Claim | null {
  return load().find((c) => c.id === id && c.orgId === org && !c.deleted) ?? null;
}
export function saveClaimXero(org: string, id: string, patch: Partial<Pick<Claim, 'xeroInvoiceId' | 'xeroTenantName' | 'xeroPostedAt' | 'archived'>>): Claim | null {
  const items = load();
  const claim = items.find((c) => c.id === id && c.orgId === org && !c.deleted);
  if (!claim) return null;
  Object.assign(claim, patch);
  saveCollection(COLLECTION, items);
  return claim;
}

// Every claim published as this Xero invoice, across every entity. The mirror
// of billsByXeroInvoiceId: a webhook event names an invoice, and the thing it
// names may be a cost document OR a claim — one bill in Xero, two kinds of
// paperwork behind it here.
export function claimsByXeroInvoiceId(invoiceId: string): Claim[] {
  const want = String(invoiceId ?? '').trim().toLowerCase();
  if (!want) return [];
  return load().filter((c) => !c.deleted && String(c.xeroInvoiceId ?? '').toLowerCase() === want);
}

// Record what Xero last said about the bill a claim was posted as. Writes only
// when something differs, for the same reason the bills version does: a burst
// of events about one invoice must not rewrite the store each time.
export function markClaimXeroPayment(
  id: string,
  info: { xeroStatus: string; xeroPaidDate: string; xeroPaymentRef: string }
): boolean {
  const items = load();
  const claim = items.find((c) => c.id === id && !c.deleted);
  if (!claim) return false;
  const same =
    (claim.xeroStatus ?? '') === info.xeroStatus &&
    (claim.xeroPaidDate ?? '') === info.xeroPaidDate &&
    (claim.xeroPaymentRef ?? '') === info.xeroPaymentRef;
  if (same) return false;
  claim.xeroStatus = info.xeroStatus;
  claim.xeroPaidDate = info.xeroPaidDate;
  claim.xeroPaymentRef = info.xeroPaymentRef;
  save(items);
  return true;
}

// Every published claim in one entity's book, for the payment backfill.
export function publishedClaims(org: string): Claim[] {
  return load().filter((c) => !c.deleted && c.orgId === org && c.xeroInvoiceId);
}

const COLLECTION = 'claims';
const save = (items: Claim[]) => saveCollection(COLLECTION, items);

// Claims written before per-entity scoping carry no orgId. Read it off their own
// items — a claim's transactions are bills, and a bill already knows its entity
// — and fall back to the legacy scope for an empty claim or an item whose bill
// is gone. Runs once: the backfilled ids are written straight back.
let migrated = false;
function load(): Claim[] {
  const items = loadCollection<Claim>(COLLECTION);
  let changed = false;
  if (!migrated) {
    migrated = true;
    for (const c of items) {
      if (c.orgId) continue;
      const fromItems = c.transactions.map((t) => billOrgId(String(t.itemId))).filter(Boolean);
      c.orgId = fromItems[0] || WORKSPACE_ID;
      changed = true;
    }
  }
  if (repairClaimNames(items)) changed = true;
  if (changed) save(items);
  return items;
}

// A claim is made out to a NAME, written when it was raised, so it goes on
// saying whatever the roster said that day — including a name that has since
// been folded into the one person it always was. That is not only cosmetic:
// the claimant's own address is resolved back FROM this name, so a claim naming
// nobody on the roster has nowhere to send its approval.
//
// Only ever renamed to the SAME human: the old name resolves to the row that
// was folded away, its address to the row that absorbed it. A name that
// resolves to nobody is left exactly as it is.
//
// On EVERY read, which is the whole point. This began life inside the one-shot
// orgId backfill above, so it got a single attempt per server boot — and it
// spent that attempt on the first claims read after the process started, which
// is before anybody has folded a duplicate away. Every read afterwards was
// skipped, so a claim went on naming somebody who had been merged away hours
// earlier, and the only thing that ever looked again was a deploy. Reported as
// the name "coming back": it had never actually been repaired.
//
// It costs nothing once the two agree, which after the first pass is every
// time: names are resolved once each rather than once per claim, and a name
// matching a live roster row answers itself without looking further.
// Who a claim is for, read off its own paperwork, for the case where its name
// resolves to nobody at all. The trail a FOLD leaves — the losing row, still
// there, soft-removed, holding the old name — is what canonicalPersonName reads;
// a row DELETED outright leaves none, so a claim raised under that name has
// nothing on the roster left to match and would keep saying it forever.
//
// A document is stored against an ADDRESS, which is the one thing that never
// goes stale, so the items on a claim still know whose they are. That is
// evidence, not a guess — but it is only allowed to speak when it speaks with
// one voice: every item owned by the SAME address, that address belonging to
// one live person who is not the entity's General account. A claim with no
// items, or with items belonging to different people, is left exactly as it is.
//
// Only ever reached for a name that resolves to nobody — which is a claim that
// is already broken, since its claimant's address is looked up FROM that name
// and an approval has nowhere to go. Naming the person its receipts belong to
// can only improve that.
function fromOwnItems(c: Claim): string {
  const txns = c.transactions || [];
  if (!txns.length) return '';
  let owner = '';
  for (const t of txns) {
    const at = String(getBillByIdAny(String(t.itemId))?.owner || '').trim().toLowerCase();
    if (!at) return '';
    if (!owner) owner = at;
    else if (owner !== at) return '';
  }
  const name = personNameForEmail(c.workspaceId || WORKSPACE_ID, c.orgId || WORKSPACE_ID, owner);
  return name && name !== c.claimFor ? name : '';
}

function repairClaimNames(items: Claim[]): boolean {
  const resolved = new Map<string, string>();
  let changed = false;
  for (const c of items) {
    const ws = c.workspaceId || WORKSPACE_ID;
    const canonical = (was: string) => {
      const key = `${ws}\u0000${was}`;
      let now = resolved.get(key);
      if (now === undefined) {
        now = canonicalPersonName(ws, was);
        resolved.set(key, now);
      }
      return now && now !== was ? now : '';
    };
    if (c.claimFor) {
      const now = canonical(c.claimFor) || fromOwnItems(c);
      if (now) {
        console.log(`[claims] claim ${c.id} was made out to "${c.claimFor}" — now "${now}"`);
        c.claimFor = now;
        changed = true;
      }
    }
    // The approver is a name on the claim too, and goes stale the same way — it
    // is who the Approver column names and who the claim says it is waiting on.
    if (c.approver) {
      const now = canonical(c.approver);
      if (now) {
        c.approver = now;
        changed = true;
      }
    }
  }
  return changed;
}

const nowIso = () => new Date().toISOString();

// The claim (if any) carrying this cost document. A document on a claim can't
// also be published as a bill in its own right — the claim posts it — so the
// Xero route asks here before publishing.
export function claimForBill(org: string, billId: string): { id: string; name: string } | null {
  const key = String(billId);
  const claim = load().find(
    (c) => c.orgId === org && !c.deleted && c.transactions.some((t) => String(t.itemId) === key)
  );
  return claim ? { id: claim.id, name: claim.name } : null;
}

// Every bill id that already sits on a claim in this workspace. The auto-claim
// runner asks once per sweep rather than per document, and it catches an item
// whose bill status drifted out of 'expenseclaim' but which is still on a claim.
export function claimedBillIds(org: string): Set<string> {
  const out = new Set<string>();
  for (const c of load()) {
    if (c.orgId !== org || c.deleted) continue;
    for (const t of c.transactions) out.add(String(t.itemId));
  }
  return out;
}

// File a set of items onto the auto claim for one person and one period,
// creating that claim on first use. Called only by the auto-claim runner
// (autoClaims.ts), which owns the schedule; this owns the claim shape, the
// history line and finishing the documents, exactly as the manual add does.
//
// "Open" means: this person, this period end, still a draft (not submitted,
// approved, archived or deleted). A claim that has moved on is never reopened —
// a late item files onto a fresh claim for the same period instead.
export function fileAutoClaim(
  ws: string,
  org: string,
  f: { claimFor: string; periodEnd: string; periodLabel: string; name: string; txns: Txn[]; by: string }
): { claimId: string; created: boolean; added: number } {
  const items = load();
  const key = f.claimFor.trim().toLowerCase();
  let claim =
    items.find(
      (c) =>
        c.orgId === org &&
        !c.deleted &&
        !c.archived &&
        c.auto === true &&
        c.autoPeriodEnd === f.periodEnd &&
        c.approvalStatus === '' &&
        c.claimFor.trim().toLowerCase() === key
    ) ?? null;
  const created = !claim;
  if (!claim) {
    claim = {
      id: randomUUID(),
      workspaceId: ws,
      orgId: org,
      claimFor: f.claimFor,
      type: 'Regular',
      name: f.name,
      claimDate: f.periodEnd,
      endDate: f.periodEnd,
      currency: 'SGD',
      transactions: [],
      history: [{ text: `This expense claim was created automatically for the period ending ${f.periodLabel}`, by: f.by, at: nowIso() }],
      approvalStatus: '',
      approver: '',
      approverEmail: '',
      decidedBy: '',
      decidedAt: '',
      archived: false,
      deleted: false,
      createdBy: '',
      createdAt: nowIso(),
      auto: true,
      autoPeriodEnd: f.periodEnd,
    };
    items.push(claim);
  }
  const seen = new Set(claim.transactions.map((t) => String(t.itemId)));
  const filed: string[] = [];
  for (const t of f.txns) {
    if (!t || seen.has(String(t.itemId))) continue;
    claim.transactions.push({ ...t, addedBy: f.by });
    seen.add(String(t.itemId));
    filed.push(String(t.itemId));
  }
  // One history line for the batch: an auto claim can arrive with dozens of
  // items, and a line each would bury the claim's real events.
  if (filed.length) {
    claim.history.unshift({ text: `${filed.length} item(s) added automatically`, by: f.by, at: nowIso() });
  }
  if (created || filed.length) save(items);
  // Claiming finishes a document the same way the manual add does: out of the
  // inbox, into Archive.
  markBillsClaimed(filed);
  return { claimId: claim.id, created, added: filed.length };
}

export const claimsRouter = Router();

// GET /api/claims — every non-deleted claim in the workspace.
//
// A claim's items are a SNAPSHOT of the documents taken when they were added,
// and only the description was ever refreshed — so correcting a receipt left the
// claim showing the old values for good. Give a document its missing date and
// the claim row still read "—", and still said "Needs: Date", while the document
// itself read Ready. Two screens, one document, two answers.
//
// So the live document answers for the fields it owns. The money is included:
// the claim's total is what gets published, and a claim that adds up to
// something the receipts don't is the one thing worth never showing.
//
// Frozen once the claim is APPROVED. Up to that point the claim is a request
// being assembled and should track its documents; after it, it is a decision
// somebody made about a specific sum, and that sum must not move underneath
// them. Non-destructive either way — nothing here is written back.
function liveTxns(c: Claim): Txn[] {
  return c.transactions.map((t) => {
    const bill = getBillById(c.orgId, String(t.itemId));
    if (!bill) return t; // a sample/demo row with no document behind it
    return {
      ...t,
      supplier: bill.supplier ?? t.supplier,
      date: bill.date ?? t.date,
      category: bill.category ?? t.category,
      description: bill.description || t.description,
      project: bill.project ?? t.project,
      net: String(bill.total != null ? Number(bill.total) - Number(bill.tax || 0) : t.net),
      tax: String(bill.tax ?? t.tax),
      total: String(bill.total ?? t.total),
    };
  });
}

function withLiveItems(c: Claim): Claim {
  if (c.approvalStatus === 'approved') return c;
  return { ...c, transactions: liveTxns(c) };
}

claimsRouter.get('/', (req, res) => {
  const org = orgIdFor(req);
  res.json({ claims: load().filter((c) => c.orgId === org && !c.deleted).map(withLiveItems) });
});

// GET /api/claims/:id/where — which entity a claim belongs to.
//
// The list above is scoped to the entity you are standing in, and the detail
// page finds its claim in that list — so opening a claim's URL while a
// different entity is selected reported "Expense claim not found", which is
// both wrong and unhelpful: the claim exists, it is just in another book. A
// claim URL is exactly the kind of link that gets emailed for approval or
// bookmarked, so arriving at it from the wrong entity is ordinary.
//
// This resolves the id ACROSS entities and says where it lives, so the page can
// offer to switch rather than deny the claim exists. It answers only for an
// entity the caller may open — for anyone else it is a 404, the same answer
// they would get for an id that really doesn't exist, so this can't be used to
// probe another client's claims.
claimsRouter.get('/:id/where', (req, res) => {
  const claim = load().find((c) => c.id === req.params.id && !c.deleted);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const me = memberForSession(req);
  if (!canAccessOrg(me, claim.orgId)) return res.status(404).json({ error: 'not_found' });
  const org = listOrganisations(workspaceId(req)).find((o) => o.id === claim.orgId);
  res.json({
    orgId: claim.orgId,
    orgName: org?.name || '',
    claimFor: claim.claimFor,
    name: claim.name,
  });
});

// POST /api/claims — create a claim.
claimsRouter.post('/', (req, res) => {
  const b = req.body ?? {};
  const me = actor(req);
  const owner = String(b.claimFor || me.name || 'You');
  const claim: Claim = {
    id: randomUUID(),
    workspaceId: workspaceId(req),
    orgId: orgIdFor(req),
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
  const org = orgIdFor(req);
  const items = load();
  const claim = items.find((c) => c.id === req.params.id && c.orgId === org);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const early = fn(claim, actor(req));
  if (early) return early; // handler already responded (e.g. 403)
  save(items);
  return res.json({ claim });
}

// A claim is locked from item edits once APPROVED — its total must not drift
// after it has been approved and is on its way to being paid. While it's merely awaiting approval it
// stays editable: items can be added, removed or recategorised, and the
// approver is told the total changed and re-reviews. (Adding always worked this
// way; removing and recategorising now match it, so a claimant who submitted a
// wrong receipt can take it back out instead of deleting the whole claim.)
const isLocked = (c: Claim) => c.approvalStatus === 'approved';

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

// Record that a submitted claim changed under its approver, and email them to
// re-review. It stays in their queue (still awaiting) — no re-submission needed.
function noteChangeAfterSubmit(req: Request, claim: Claim, by: string, what: string): void {
  if (claim.approvalStatus !== 'awaiting_approval' || !claim.approver) return;
  claim.history.unshift({
    text: `${what} after submission — ${claim.approver} to re-review the updated total`,
    by,
    at: nowIso(),
  });
  notifyApprover(req, claim, true);
}

// POST /api/claims/:id/items — attach cost items (idempotent per itemId).
// Allowed until the claim is APPROVED — you can still add to a claim that's
// awaiting approval (the total changes, so the approver re-reviews). Only an
// approved claim is locked, to keep its total stable for payment.
claimsRouter.post('/:id/items', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (claim.approvalStatus === 'approved') return res.status(409).json({ error: 'claim_locked' });
    const incoming: Txn[] = Array.isArray(req.body?.items) ? req.body.items : [];
    // A document lives in one entity's book. Putting another entity's bill on
    // this claim would carry its cost — and its supplier and description — into
    // the wrong company's ledger. An item with no bill behind it at all (a
    // sample/demo doc, which never reaches the store) is left alone.
    const foreign = incoming.filter((t) => {
      const org = billOrgId(String(t?.itemId ?? ''));
      return org !== '' && org !== claim.orgId;
    });
    if (foreign.length) {
      return res.status(409).json({
        error: 'foreign_item',
        message:
          foreign.length === 1
            ? 'That document belongs to another client entity, so it can’t go on this expense claim.'
            : `${foreign.length} of those documents belong to another client entity, so they can’t go on this expense claim.`,
      });
    }
    // A document already published to Xero is in the ledger as a bill; putting
    // it on a claim would pay the same cost twice. Refuse the request rather
    // than quietly dropping the item — the person adding it needs to know.
    const published = incoming
      .map((t) => getBillById(claim.orgId, String(t?.itemId ?? '')))
      .filter((b) => Boolean(b?.xeroInvoiceId));
    if (published.length) {
      return res.status(409).json({
        error: 'published_to_xero',
        message:
          published.length === 1
            ? 'That document is already published to Xero, so it can’t also go on an expense claim.'
            : `${published.length} of those documents are already published to Xero, so they can’t also go on an expense claim.`,
      });
    }
    const seen = new Set(claim.transactions.map((t) => t.itemId));
    let added = 0;
    const claimed: string[] = [];
    for (const t of incoming) {
      if (!t || seen.has(t.itemId)) continue;
      claim.transactions.push({ ...t, addedBy: t.addedBy || me.name });
      // Name the document the way every other surface does — its Item ID, the
      // number on the row, the export and the claim PDF. `itemId` is whatever
      // the caller addressed it by, which for most callers is the internal
      // `bill_…` id nobody has ever seen.
      const shown = String(t.displayId || t.itemId || '');
      claim.history.unshift({ text: `Item ${shown} was added to the expense claim`, by: t.addedBy || me.name, at: nowIso() });
      seen.add(t.itemId);
      claimed.push(String(t.itemId));
      added += 1;
    }
    // Claiming finishes a document the same way publishing does: out of the
    // inbox, into Archive. Done here rather than left to the caller so it holds
    // however the item arrived (Costs list, document page, moved from another
    // claim) and can't be lost to a half-finished round of requests.
    markBillsClaimed(claimed);
    if (added) noteChangeAfterSubmit(req, claim, me.name, `${added} item(s) added`);
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
    if (removed) {
      // The documents come off the claim too. Without this they kept the
      // 'expenseclaim' status with no claim to belong to — invisible in the
      // inbox, invisible in Archive, and unclaimable by anybody else.
      unmarkBillsClaimed([...ids].map(String));
      claim.history.unshift({ text: `${removed} item(s) removed from the expense claim`, by: me.name, at: nowIso() });
      noteChangeAfterSubmit(req, claim, me.name, `${removed} item(s) removed`);
    }
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
    // Who is being reimbursed. It was accepted by the form and dropped here, so
    // the field looked editable and reverted on the next load. It is also not
    // decoration: the name is matched to a person to find the approver this
    // claim routes to, so it changes where the claim goes — which is why the
    // change is recorded, and why it is refused once the claim is already out
    // for approval rather than rerouted under the person deciding it.
    if (typeof b.claimFor === 'string' && b.claimFor.trim() && b.claimFor.trim() !== claim.claimFor) {
      if (claim.approvalStatus === 'awaiting_approval') {
        return res.status(409).json({
          error: 'claim_submitted',
          message: 'This claim is out for approval. Recall it before changing who it is for.',
        });
      }
      const from = claim.claimFor;
      claim.claimFor = b.claimFor.trim();
      claim.history.unshift({ text: `Claim for changed from ${from || '—'} to ${claim.claimFor}`, by: me.name, at: nowIso() });
    }
    if (typeof b.description === 'string') claim.description = b.description;
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
// What an item on a claim is still missing, in the words the inbox uses — the
// same four fields as costComplete / readiness.js, so a document that reads
// "Needs: Date" in one place reads the same here.
//
// Read off the LIVE document, not the claim's snapshot. A claim stores the
// item's fields as they were when it was added and refreshes only the
// description, so judging completeness by the snapshot would trap the claim:
// the fix happens on the DOCUMENT — which is what the refusal tells you to do —
// and the snapshot would never catch up. The snapshot answers only for an item
// with no bill behind it (a sample/demo row).
function missingOnItem(orgId: string, t: Txn): string[] {
  const bill = getBillById(orgId, String(t.itemId));
  const supplier = bill ? bill.supplier : t.supplier;
  const date = bill ? bill.date : t.date;
  const category = bill ? bill.category : t.category;
  const total = bill ? bill.total : t.total;
  const named = (v: unknown, placeholder: string) => {
    const x = String(v ?? '').trim().toLowerCase();
    return Boolean(x) && x !== placeholder;
  };
  const out: string[] = [];
  if (!named(supplier, 'unknown supplier')) out.push('Supplier');
  if (!String(date ?? '').trim()) out.push('Date');
  if (!named(category, 'uncategorised')) out.push('Category');
  if (!(parseAmount(total) > 0)) out.push('Total');
  return out;
}

claimsRouter.post('/:id/submit', (req, res) =>
  mutate(req, res, (claim, me) => {
    // Submitting asks a person to approve a specific sum, and they approve what
    // the claim SAYS. An item with no date gave them nothing to check it
    // against — was it this period, was it already claimed — while the row wore
    // a "Ready" badge. Every other route to the ledger already refuses an
    // incomplete document; this is the same standard at the point a human is
    // asked to sign off.
    const incomplete = (claim.transactions ?? [])
      .map((t) => ({ t, missing: missingOnItem(claim.orgId, t) }))
      .filter((x) => x.missing.length);
    if (incomplete.length) {
      return res.status(422).json({
        error: 'incomplete_items',
        count: incomplete.length,
        items: incomplete.slice(0, 10).map((x) => ({
          itemId: x.t.displayId || x.t.itemId,
          supplier: x.t.supplier || 'Unknown supplier',
          missing: x.missing,
        })),
        message:
          `${incomplete.length} item${incomplete.length === 1 ? '' : 's'} on this claim ${incomplete.length === 1 ? 'is' : 'are'} incomplete — ` +
          `${incomplete[0].t.supplier || 'one'} needs ${incomplete[0].missing.join(', ')}. ` +
          'Fill those in before asking somebody to approve the claim.',
      });
    }
    // A claim is money paid back to a PERSON. The general account is what owns
    // the documents nobody claimed — the company's own paperwork — so a claim
    // made out to it has nobody to reimburse and nobody whose manager could
    // approve it. Most often it means the documents were uploaded by a
    // colleague from outside the entity and never attributed to anyone.
    if (isGeneralPerson(workspaceId(req), claim.orgId, claim.claimFor)) {
      return res.status(422).json({
        error: 'claim_for_general',
        message:
          'This claim is made out to the general account, which is not a person — there is nobody to pay it back to. ' +
          'Set "Claim for" to whoever paid, adding them under Users first if they are not on the roster yet.',
      });
    }
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
function ensureApprover(
  req: Request,
  claim: Claim,
  me: { email: string; name: string },
  res: Response
): Response | void {
  const norm = (s: string) => s.trim().toLowerCase();
  // Open claim (no assigned approver — e.g. a legacy claim, or the claimant has
  // no direct manager). Only a non-claimant ADMIN may decide it: never the
  // claimant on their own claim, never a random Standard user. A session-less
  // mock/dev context (no resolvable member) stays permissive so the demo works.
  if (!claim.approverEmail && !claim.approver) {
    const member = memberForSession(req);
    if (!member) return; // mock/dev — no real auth to gate on
    const isClaimant = Boolean(me.name && claim.claimFor && norm(me.name) === norm(claim.claimFor));
    if (isAdminRole(member.role) && !isClaimant) return;
    return res.status(403).json({ error: 'not_approver', approver: claim.approver });
  }
  const emailMatch = Boolean(me.email && claim.approverEmail && norm(me.email) === norm(claim.approverEmail));
  const nameMatch = Boolean(me.name && claim.approver && norm(me.name) === norm(claim.approver));
  if (emailMatch || nameMatch) return;
  return res.status(403).json({ error: 'not_approver', approver: claim.approver });
}

claimsRouter.post('/:id/approve', (req, res) =>
  mutate(req, res, (claim, me) => {
    const blocked = ensureApprover(req, claim, me, res);
    if (blocked) return blocked;
    // Record the figures being approved, rather than leaving the snapshot taken
    // when the items were ADDED to resurface. Freezing without this froze the
    // wrong thing: a receipt whose date was fixed after it was claimed showed
    // the date right up until approval, then reverted to "—" and "Needs: Date"
    // — the approver signed off one set of numbers and the claim kept another.
    claim.transactions = liveTxns(claim);
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
    const blocked = ensureApprover(req, claim, me, res);
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

// POST /api/claims/:id/email — email a copy of the claim, with the CSV + PDF
// attached, to any recipient. The client generates the files (reusing the same
// export code as the download button), so the server just composes the message,
// sends it, and records the send on the claim's history.
claimsRouter.post('/:id/email', async (req, res) => {
  const org = orgIdFor(req);
  const me = actor(req);
  const claim = load().find((c) => c.id === req.params.id && c.orgId === org && !c.deleted);
  if (!claim) return res.status(404).json({ error: 'not_found' });

  const toEmail = String(req.body?.toEmail || '').trim();
  const toName = String(req.body?.toName || '').trim() || toEmail;
  const fromName = String(req.body?.fromName || '').trim() || me.name || 'CYBills';
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  if (!/.+@.+\..+/.test(toEmail)) return res.status(400).json({ error: 'bad_recipient' });

  // Validate attachments (base64 bytes). Cap count + total size so a bad client
  // can't hand the mail server something enormous.
  const raw: unknown[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const attachments = raw
    .filter((a: unknown): a is { filename: string; content: string; contentType?: string } => {
      const x = a as { filename?: unknown; content?: unknown };
      return typeof x?.filename === 'string' && typeof x?.content === 'string' && x.content.length > 0;
    })
    .slice(0, 5)
    .map((a) => ({ filename: String(a.filename).slice(0, 200), content: a.content, contentType: a.contentType ? String(a.contentType) : undefined }));
  const totalBytes = attachments.reduce((n, a) => n + Math.ceil((a.content.length * 3) / 4), 0);
  if (totalBytes > 20 * 1024 * 1024) return res.status(413).json({ error: 'too_large' });

  const mail = claimShareEmail({
    fromName,
    toName,
    claimName: claim.name || '',
    claimFor: claim.claimFor || '',
    currency: claim.currency || 'SGD',
    total: String(req.body?.total ?? ''),
    message,
  });
  const result = await sendMail({ to: { email: toEmail, name: toName }, ...mail, attachments });
  if (!result.sent) return res.status(502).json({ error: result.error || 'send_failed' });

  // Audit trail: who mailed the claim, to whom.
  const items = load();
  const stored = items.find((c) => c.id === claim.id && c.orgId === org);
  if (stored) {
    stored.history = stored.history || [];
    stored.history.unshift({ text: `This claim was emailed to ${toName} (${toEmail})`, by: me.name, at: nowIso() });
    save(items);
  }
  return res.json({ sent: true });
});

// POST /api/claims/:id/archive  { archived }
claimsRouter.post('/:id/archive', (req, res) =>
  mutate(req, res, (claim) => {
    claim.archived = req.body?.archived !== false;
  })
);

// DELETE /api/claims/:id — soft delete the claim, and PERMANENTLY remove the
// receipts that were on it.
//
// The practice's call, and the destructive one: a claim thrown away takes its
// paperwork with it, files included, rather than seeding the inbox with work
// somebody has to clear again. The reasoning is that these documents exist here
// to be claimed — captured for that claim — so there is nothing left for them to
// be once it is gone.
//
// Removing a single ITEM is a different act and stays non-destructive: that says
// "this doesn't belong on this claim", and the document goes to Archive.
//
// The claim itself is only soft-deleted, so the record of what was claimed, by
// whom and for how much outlives the receipts.
claimsRouter.delete('/:id', (req, res) =>
  mutate(req, res, (claim) => {
    claim.deleted = true;
    const ids = claim.transactions.map((t) => String(t.itemId));
    const { removed, freedKeys } = deleteBillsHard(ids);
    if (removed) console.log(`[claims] claim ${claim.id} deleted — ${removed} receipt(s) went with it`);
    // Files last, and best-effort: the records are already gone, and a storage
    // hiccup must not turn a finished delete into an error.
    for (const key of freedKeys) void deleteBillFile(key);
  })
);
