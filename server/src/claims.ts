import { Router, type Request, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { putBillFile, getBillFile, deleteBillFile } from './storage.js';
import { workspaceId, actor, WORKSPACE_ID } from './workspace.js';
import { orgIdFor } from './bills.js';
import { directManagerFor, appOrigin, emailForName, memberForSession, isAdminRole, isGeneralPerson, addressIn, canAccessOrg, canCreateClaims, canonicalPersonName, effectiveRoleFor, normaliseAddress, orgScope, personNameForEmail, visibleOwnersFor } from './users.js';
import { sendMail, approvalRequestEmail, claimDecisionEmail, claimShareEmail } from './mailer.js';
import {
  getBillById,
  getBillByIdAny,
  displayIdOf,
  billOrgId,
  markBillsClaimed,
  unmarkBillsClaimed,
  returnBillsToInbox,
  parseAmount,
} from './store.js';
import { listOrganisations, primaryOrgId } from './organisations.js';
import { endOfThisMonth, isoClaimDate } from './claimDates.js';
import { referenceFor, numberFor } from './claimRef.js';
import { claimPdfBytes } from './claimPdfDoc.js';
import { shareToken, verifyShareToken } from './shareLinks.js';
import { readSetting } from './settings.js';
import { readSession } from './auth.js';

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
  // A mileage item's working — "13 km × 0.60/km" — so the claim, its PDF and
  // its approver can see how the total was arrived at. The total itself is
  // the document's, derived from these (src/lib/mileage.js).
  distanceKm?: string;
  mileageRate?: string;
  net: string;
  tax: string;
  total: string;
  status?: string;
  addedBy?: string;
};
type Event = { text: string; by: string; at: string };
// A supporting document on the claim itself — the internal approval email
// chain, a quote, an HR form — as opposed to a receipt, which belongs to a cost
// document. Stored the way a receipt is (storage.ts) and printed at the back of
// the claim PDF after the approval history, so an approver reading the PDF sees
// it without coming here.
type Attachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
  addedBy: string;
  addedAt: string;
};
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
  // Set when the decision was made by somebody OTHER than the named approver —
  // a practice colleague deciding on that person's behalf. `decidedBy` is
  // always the person who actually pressed the button.
  decidedFor?: string;
  description?: string; // the claimant's own note about what this claim is for
  attachments?: Attachment[]; // supporting documents, printed at the back of the PDF
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

// One approved claim, as the RECHARGE seam describes it (deploy/RECHARGE.md).
//
// A bridge entity's claims post into its parent's ledger as ACCPAY bills
// against a clearing account, and the practice then invoices the client that
// seconded those people. CYWorkspace runs that half, so it needs the claims in
// a shape it can group and bill from — which is deliberately NOT the Claim
// record: a machine caller has no business with the approval history, the
// per-item breakdown or the attachments.
export type RechargeClaim = {
  id: string;
  /** "ST Eng Exp Claim 20-Aug-2026 21324972410" — what the Xero bill is named. */
  reference: string;
  claimant: string;
  /** The claimant's own address, resolved back through the roster the way the
   *  approval emails resolve it. A PO assigns PEOPLE, and a name is what a
   *  claim stores — so the stable identity has to be handed over with it, or
   *  the far end matches on a display name that the roster can rename. */
  claimant_email: string;
  /** The date coverage is decided by: the period the claim closes. */
  period_end: string;
  currency: string;
  total: string;
  items: number;
  /** The claim's own lines — one per receipt — for the BREAKDOWN a recharge
   *  report carries beside its one-row-per-claim summary. The client's manager
   *  checks the header against the PO and the lines against what their people
   *  said they spent, and those are two different reads of the same money. Only
   *  what that sheet prints: no item ids, no files, no tax split. */
  lines: Array<{
    date: string;
    category: string;
    supplier: string;
    description: string;
    total: string;
    /** The document's own number — the Item ID on its page, on the claim PDF
     *  and in every export. */
    item_no: string;
    /** A signed, expiring link to THAT receipt's file, so the breakdown's Item
     *  No opens the one receipt a line is about rather than the whole claim.
     *  The manager reading it has no login, so this is the same capability a
     *  receipt link inside the claim PDF carries. '' where there is no stored
     *  file, or where the entity has Image sharing off — the file route would
     *  refuse the link, and a number that opens nothing beats one that opens an
     *  error. */
    file_url: string;
  }>;
  /** A signed, expiring link to this claim's own PDF — its report, approval
   *  history, supporting documents and receipts. The recharge report the
   *  practice sends a client's manager prints the Claim No as a link to it, and
   *  that person has no CYBills login, so a link to the claim PAGE would be a
   *  sign-in screen. Expires with the token (30 days). */
  pdf_url: string;
  /** The bare numeric claim id — the "Claim No" a recharge report prints, as
   *  opposed to `reference`, which is that number inside the whole string the
   *  Xero bill is named with. */
  claim_no: string;
  /** Who actually decided it, and who it was routed to. They differ when a
   *  practice colleague decides on the named approver's behalf, and a report
   *  naming the wrong one is a report that says somebody approved their own
   *  claim. */
  approved_by: string;
  approver: string;
  /** The ROUTED approver's address — the claimant's direct manager, which is
   *  what a Reporting Officer IS here. A name is a display string the roster
   *  can rewrite, so anything keying on the approver (the recharge tool fills
   *  a recharge's Reporting Officers from it) has to have the address. '' for
   *  a claim approved before the address was stored and whose approver has
   *  since left the roster. */
  approver_email: string;
  decided_at: string;
  /** The ACCPAY bill this claim posted as, and what Xero says of it since. */
  xero_invoice_id: string;
  xero_status: string;
  xero_paid_date: string;
};

// The approved claims in one entity's book. APPROVED only, and that is the
// whole filter: an unapproved claim is not yet a cost anybody has agreed to,
// so recharging it would invoice a client for money the practice has not
// accepted it owes. A claim not yet published is still listed — it is a real
// approved cost, and whether its bill has reached Xero is a separate question
// the row answers for itself.
export async function rechargeClaims(org: string, origin = ''): Promise<RechargeClaim[]> {
  const rows: RechargeClaim[] = [];
  // The entity's Image sharing toggle (Business settings -> Exports), read once
  // for the whole book. The receipt file route reads it again on every request,
  // so a link minted past it would open nothing but a refusal.
  const settingsOrg = org === WORKSPACE_ID ? primaryOrgId() : org;
  const sharing =
    readSetting<{ imageSharing?: boolean }>(WORKSPACE_ID, 'cybills.export-settings.v1', settingsOrg)?.imageSharing !== false;
  for (const c of load()) {
    if (c.deleted || c.orgId !== org || c.approvalStatus !== 'approved') continue;
    rows.push({
      id: c.id,
      reference: await referenceFor(c),
      claimant: c.claimFor,
      claimant_email: emailForName(WORKSPACE_ID, c.claimFor),
      period_end: c.endDate || c.claimDate || '',
      currency: c.currency || 'SGD',
      total: claimTotal(c),
      items: c.transactions.length,
      lines: c.transactions.map((t) => {
        const bill = getBillByIdAny(String(t.itemId ?? ''));
        // Addressed by the INTERNAL id, which is unambiguous; the token is bound
        // to exactly the string in the path, so the two must be the same one.
        const fileId = bill?.id || '';
        return {
          date: String(t.date || ''),
          category: String(t.category || ''),
          supplier: String(t.supplier || ''),
          description: String(t.description || ''),
          // To the cent, the way claimTotal sums them, so a breakdown always
          // adds up to the header row it sits beside.
          total: Number(t.total || 0).toFixed(2),
          item_no: (fileId && displayIdOf(fileId)) || String(t.displayId || '') || displayIdOf(String(t.itemId ?? '')),
          file_url:
            origin && sharing && fileId && bill?.storageKey
              ? `${origin}/api/costs/bills/${encodeURIComponent(fileId)}/file?s=${encodeURIComponent(shareToken(fileId))}`
              : '',
        };
      }),
      claim_no: await numberFor(c),
      pdf_url: origin ? `${origin}/api/claims/${encodeURIComponent(c.id)}/pdf?s=${encodeURIComponent(shareToken(c.id))}` : '',
      // decidedBy is who pressed the button; approver is who it was routed to.
      // A practice colleague deciding on somebody's behalf makes those two
      // different people, and the report wants the one who actually decided.
      approved_by: c.decidedBy || c.approver || '',
      approver: c.approver || '',
      // Stored on the claim when it was submitted; resolved from the name for
      // the claims raised before that field existed.
      approver_email: c.approverEmail || emailForName(WORKSPACE_ID, c.approver) || '',
      decided_at: c.decidedAt || '',
      xero_invoice_id: c.xeroInvoiceId || '',
      xero_status: c.xeroStatus || '',
      xero_paid_date: c.xeroPaidDate || '',
    });
  }
  return rows;
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
      distanceKm: bill.distanceKm != null ? String(bill.distanceKm) : t.distanceKm,
      mileageRate: bill.mileageRate != null ? String(bill.mileageRate) : t.mileageRate,
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

// The entity a claim's scope belongs to — the same fold bills.ts applies to a
// document: the primary entity's data scope is the legacy WORKSPACE_ID.
const entityIdForClaim = (c: Claim): string => (!c.orgId || c.orgId === WORKSPACE_ID ? primaryOrgId() : c.orgId);

// Whose claims a Standard user sees: their own, and their direct reports' — the
// same line their documents follow (visibleOwnersFor, users.ts), and the line a
// claim's approval already travels up.
//
// Three ways a claim can be theirs, because a claim names people three ways. It
// was CREATED by them, which is an address and is never rewritten; or it is MADE
// OUT to them, and `claimFor` is a NAME, so it is resolved back to the one
// address exactly the way the approval emails resolve it. Either of those counts
// for a direct report as well as for the caller.
//
// The third is the caller's ALONE: a claim routed to them for a DECISION, which
// they must be able to open whoever raised it, or the approval request arrives
// by email and leads to an empty list. Not widened to their reports — a claim
// somebody who reports to me has to decide is theirs to decide, and the person
// who raised it may be nothing to do with me.
function claimVisibleTo(ws: string, owners: Set<string> | null, me: string, c: Claim): boolean {
  if (!owners) return true;
  if (me && normaliseAddress(c.approverEmail) === me) return true;
  if (addressIn(owners, c.createdBy)) return true;
  return addressIn(owners, emailForName(ws, c.claimFor));
}

claimsRouter.get('/', (req, res) => {
  const org = orgIdFor(req);
  const ws = workspaceId(req);
  // With reports: a claim routed to somebody for a decision has to reach them.
  const owners = visibleOwnersFor(req, orgScope(req), true);
  const me = normaliseAddress(memberForSession(req)?.email);
  res.json({
    claims: load()
      .filter((c) => c.orgId === org && !c.deleted && claimVisibleTo(ws, owners, me, c))
      .map(withLiveItems),
  });
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
  // And the same 404 for a claim in this entity that this caller may not see:
  // it names its claimant, which is the very thing being kept from them.
  const owners = visibleOwnersFor(req, entityIdForClaim(claim), true);
  if (!claimVisibleTo(workspaceId(req), owners, normaliseAddress(me?.email), claim)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const org = listOrganisations(workspaceId(req)).find((o) => o.id === claim.orgId);
  res.json({
    orgId: claim.orgId,
    orgName: org?.name || '',
    claimFor: claim.claimFor,
    name: claim.name,
  });
});

// A caller who may not raise a claim is refused before one exists. Both halves
// of the act ask it — opening the claim and putting items on it — because a
// claim is assembled from its items and refusing only one would leave somebody
// holding an empty claim they could not fill, or filling one they could not
// have made.
function mayCreateClaims(req: Request, res: Response): boolean {
  if (canCreateClaims(memberForSession(req), orgScope(req))) return true;
  res.status(403).json({
    error: 'claims_not_allowed',
    message:
      'Your account is not set up to create expense claims. ' +
      'Ask a Business Admin to turn on "Create expense claims" under Users -> Edit privileges.',
  });
  return false;
}

// A claim covers a MONTH, and for a STANDARD user it is the month it was raised
// in: the end date is filled in rather than asked for, and is not theirs to
// move afterwards. Somebody claiming on the 27th means "August", and a claim
// free to run to any date at all is one whose period no reporting month covers.
//
// An admin still chooses, which is why this asks the role rather than removing
// the field: a claim that genuinely closes on another date is a real thing — a
// leaver's last claim, a period corrected after the fact — and somebody has to
// be able to say so. Any admin tier, because the coarse question here is
// whether this person is a Standard user, and a User Admin manages everybody's
// documents by role.
function endDateFixed(req: Request): boolean {
  const me = memberForSession(req);
  if (!me) return false; // the sessionless mock/dev context, open like the rest of the app
  return effectiveRoleFor(me, orgScope(req)) === 'Standard';
}

// POST /api/claims — create a claim.
claimsRouter.post('/', async (req, res) => {
  if (!mayCreateClaims(req, res)) return;
  const b = req.body ?? {};
  const me = actor(req);
  const owner = String(b.claimFor || me.name || 'You');
  // Whatever the request asked for. The dialog shows the date read-only, and
  // this is what makes that a rule rather than a disabled input.
  const asked = String(b.endDate || '');
  const endDate = endDateFixed(req) ? (await endOfThisMonth()) || asked : asked;
  const claim: Claim = {
    id: randomUUID(),
    workspaceId: workspaceId(req),
    orgId: orgIdFor(req),
    claimFor: owner,
    type: 'Regular',
    name: String(b.name || 'Expense claim'),
    claimDate: endDate,
    endDate,
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
function notifyClaimant(req: Request, claim: Claim, decision: 'approved' | 'rejected' | 'reopened', by = claim.decidedBy): void {
  const ws = claim.workspaceId;
  const email = emailForName(ws, claim.claimFor) || claim.createdBy || '';
  if (!email) return;
  const mail = claimDecisionEmail({
    claimantName: claim.claimFor,
    claimName: claim.name,
    decision,
    deciderName: by,
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
claimsRouter.post('/:id/items', (req, res) => {
  // Building a claim is the other half of raising one, so it asks the same
  // privilege. Removing and recategorising do NOT: taking a receipt back off a
  // claim is undoing, and somebody who should not have added it must still be
  // able to.
  if (!mayCreateClaims(req, res)) return;
  return mutate(req, res, (claim, me) => {
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
  });
});

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
// stored verbatim (the client sends canonical ISO YYYY-MM-DD), and is refused
// outright for a Standard user, whose claim closes at the end of the month it
// was raised in.
claimsRouter.post('/:id/update', async (req, res) => {
  // Resolved before the mutation, because the comparison inside it is
  // synchronous and a stored end date may have been typed in any of the shapes
  // parseDateParts reads — compared as raw strings, '31/08/2026' and
  // '2026-08-31' would read as somebody moving the date.
  const iso = await isoClaimDate();
  const sameDate = (a: unknown, b: unknown) =>
    iso ? iso(a) === iso(b) : String(a ?? '').trim() === String(b ?? '').trim();
  return mutate(req, res, (claim, me) => {
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
      // A Standard user's claim closes at the end of the month it was raised
      // in, so the date is not theirs to move. The field is read-only on the
      // page; this is what holds when the request arrives anyway. A resend of
      // the date it already carries is not a change and is let through, so
      // saving some OTHER field on the same dialog can never trip this.
      if (!sameDate(d, claim.endDate) && endDateFixed(req)) {
        return res.status(403).json({
          error: 'end_date_fixed',
          message:
            'A claim ends on the last day of the month it was raised in. ' +
            'Ask a Business Admin if this one has to close on another date.',
        });
      }
      claim.endDate = d;
      claim.claimDate = d; // keep the two in sync (claimDate mirrors endDate)
      claim.history.unshift({ text: `End date set to ${d || '—'}`, by: me.name, at: nowIso() });
    }
  });
});

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
    // An APPROVED claim is a decision somebody made about a specific sum, and
    // submitting it again quietly undid that decision: the status went back to
    // awaiting approval, decidedBy / decidedAt / decidedFor were cleared, and
    // the approver was asked for it a second time with nothing in the history
    // to say the first answer had been thrown away. That is exactly what
    // Unapprove does, minus the trail Unapprove writes — so a claim that has to
    // change goes back through Unapprove, which records who reopened it and
    // why. Rejected is not refused: fixing a rejected claim and sending it
    // again is the whole point of rejecting one.
    if (claim.approvalStatus === 'approved') {
      return res.status(409).json({
        error: 'already_approved',
        message:
          'This claim has already been approved. Unapprove it first if it has to change, ' +
          'so the approval that is being undone is recorded.',
      });
    }
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
    claim.decidedFor = '';
    claim.history.unshift({ text: `This claim was submitted for approval to ${manager.name}`, by: me.name, at: nowIso() });
    notifyApprover(req, claim, false);
  })
);

// Only the assigned approver may decide — or the practice, on their behalf.
//
// Match on email OR name (mirroring the client's own check): the approver is
// picked from the team roster, and a person's roster email can differ from
// their login email (e.g. a gmail login vs a work address) — matching only on
// email would then lock out the real approver. Permissive when no approver is
// assigned, or in a session-less mock/dev context.
//
// The practice runs the book this claim posts into, and its people are a
// Business Admin inside every client entity they can open — so a CYBM colleague
// may decide a client's claim when the named approver is away, or when the
// approver is a client manager who never signs in here. The one thing a
// colleague may never do is approve their OWN claim, named approver or not:
// that is the rule the open-claim branch already holds, and a proxy must not
// be a way round it. The decision is recorded as made ON BEHALF OF the named
// approver (`decidedFor`), so the trail says who actually pressed the button.
const norm = (s: string) => s.trim().toLowerCase();
const isNamedApprover = (claim: Claim, me: { email: string; name: string }): boolean =>
  Boolean(me.email && claim.approverEmail && norm(me.email) === norm(claim.approverEmail)) ||
  Boolean(me.name && claim.approver && norm(me.name) === norm(claim.approver));
const isClaimantOf = (claim: Claim, me: { email: string; name: string }): boolean =>
  Boolean(me.name && claim.claimFor && norm(me.name) === norm(claim.claimFor));

function ensureApprover(
  req: Request,
  claim: Claim,
  me: { email: string; name: string },
  res: Response
): Response | void {
  // Open claim (no assigned approver — e.g. a legacy claim, or the claimant has
  // no direct manager). Only a non-claimant ADMIN may decide it: never the
  // claimant on their own claim, never a random Standard user. A session-less
  // mock/dev context (no resolvable member) stays permissive so the demo works.
  if (!claim.approverEmail && !claim.approver) {
    const member = memberForSession(req);
    if (!member) return; // mock/dev — no real auth to gate on
    if (isAdminRole(member.role) && !isClaimantOf(claim, me)) return;
    return res.status(403).json({ error: 'not_approver', approver: claim.approver });
  }
  if (isNamedApprover(claim, me)) return;
  // The practice, on the approver's behalf. Entity access was already checked
  // by the X-Org-Id guard, so being on the team is the whole of the question.
  const member = memberForSession(req);
  if (member && member.practice && !member.deactivated && !isClaimantOf(claim, me)) return;
  return res.status(403).json({ error: 'not_approver', approver: claim.approver });
}

// Who the decision was made for, when the person deciding is not the approver
// the claim names — empty when they are, or when nobody is named.
const decidedFor = (claim: Claim, me: { email: string; name: string }): string =>
  claim.approver && !isNamedApprover(claim, me) ? claim.approver : '';
const byLine = (claim: Claim, me: { email: string; name: string }): string =>
  decidedFor(claim, me) ? `${me.name} on behalf of ${decidedFor(claim, me)}` : me.name;

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
    claim.decidedFor = decidedFor(claim, me);
    claim.decidedAt = nowIso();
    claim.decisionReason = '';
    claim.history.unshift({ text: `This claim was approved by ${byLine(claim, me)}`, by: me.name, at: nowIso() });
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
    claim.decidedFor = decidedFor(claim, me);
    claim.decidedAt = nowIso();
    claim.decisionReason = reason;
    claim.history.unshift({
      text: reason ? `This claim was rejected by ${byLine(claim, me)}: ${reason}` : `This claim was rejected by ${byLine(claim, me)}`,
      by: me.name,
      at: nowIso(),
    });
    notifyClaimant(req, claim, 'rejected');
  })
);

// POST /api/claims/:id/reopen — take an APPROVED claim back to awaiting
// approval, because a mistake was found after the fact. Approval locks the
// claim (its total must not drift once it is on its way to payment), so this is
// the only way to correct one: the items are fixed and it is approved again,
// by the same approver, without being re-submitted.
//
// A PUBLISHED claim may be reopened too, the way a published cost document
// may be edited: the bill in Xero keeps the first answer until the corrected
// claim is approved again and **Update in Xero** restates it — the page says
// so while the two disagree. Decided by the same people who may approve: the
// named approver, or the practice on their behalf. The claimant is told,
// because they were told it was approved and would otherwise be waiting on
// money that has stopped moving.
claimsRouter.post('/:id/reopen', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (claim.approvalStatus !== 'approved') return res.status(409).json({ error: 'not_approved', status: claim.approvalStatus });
    const blocked = ensureApprover(req, claim, me, res);
    if (blocked) return blocked;
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const by = byLine(claim, me);
    claim.approvalStatus = 'awaiting_approval';
    claim.decidedBy = '';
    claim.decidedFor = '';
    claim.decidedAt = '';
    claim.decisionReason = reason;
    claim.history.unshift({
      text: reason ? `This claim was reopened for review by ${by}: ${reason}` : `This claim was reopened for review by ${by}`,
      by: me.name,
      at: nowIso(),
    });
    notifyClaimant(req, claim, 'reopened', me.name);
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

// --- Supporting documents ------------------------------------------------------
// A claim's own paperwork, as opposed to its items' receipts: the internal
// approval email chain the claimant got before spending, a quote, an HR form —
// whatever the approver needs beside the receipts to decide. Kept on the CLAIM,
// stored like a receipt, and printed at the back of the claim PDF after the
// approval history (src/lib/claimPdf.js), so it travels with the claim wherever
// the PDF goes: the approver's email, the Xero bill.
//
// Only what the PDF can carry is accepted. A .docx or .msg would sit on the
// claim and silently not be in the document everyone actually reads — the
// approver would be told there is an email chain and not see it. An email chain
// is saved to PDF or screenshotted in one step, so the restriction costs little
// and the PDF stays whole.
const ATTACHMENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENTS_MAX = 10;

// POST /api/claims/:id/attachments  { fileName, fileBase64, mediaType }
// Allowed until the claim is APPROVED, like its items: an approved claim is a
// decision about a specific set of paper, and the PDF that records it must not
// grow afterwards.
claimsRouter.post('/:id/attachments', async (req, res) => {
  const org = orgIdFor(req);
  const me = actor(req);
  const items = load();
  const claim = items.find((c) => c.id === req.params.id && c.orgId === org && !c.deleted);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  if (isLocked(claim)) return res.status(409).json({ error: 'claim_locked' });
  const b = req.body ?? {};
  const mediaType = String(b.mediaType ?? '').trim().toLowerCase();
  const fileName = String(b.fileName ?? '').trim().slice(0, 200) || 'document';
  const base64 = typeof b.fileBase64 === 'string' ? b.fileBase64 : '';
  if (!ATTACHMENT_TYPES.has(mediaType)) {
    return res.status(415).json({
      error: 'unsupported_type',
      message: 'Only a PDF, PNG or JPG can be attached — those are what the claim PDF can carry. Save an email chain as PDF first.',
    });
  }
  if (!base64) return res.status(400).json({ error: 'no_file' });
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'no_file' });
  if (bytes.length > ATTACHMENT_MAX_BYTES) return res.status(413).json({ error: 'too_large', message: 'That file is over 10 MB.' });
  const existing = Array.isArray(claim.attachments) ? claim.attachments : [];
  if (existing.length >= ATTACHMENTS_MAX) {
    return res.status(409).json({ error: 'too_many', message: `A claim carries at most ${ATTACHMENTS_MAX} supporting documents.` });
  }
  // Keyed by the CLAIM and the bytes, never by the bytes alone: a receipt's
  // storage is content-addressed so identical uploads share one object, and
  // removing this attachment reclaims its file — which must never be a file
  // another claim is still pointing at.
  const hash = createHash('sha256').update(bytes).digest('hex');
  const stored = await putBillFile(claim.orgId, `claim_${claim.id}_${hash.slice(0, 16)}`, mediaType, bytes);
  const att: Attachment = {
    id: randomUUID(),
    fileName,
    contentType: stored.contentType,
    size: bytes.length,
    storageKey: stored.storageKey,
    addedBy: me.name,
    addedAt: nowIso(),
  };
  claim.attachments = [...existing, att];
  claim.history = claim.history || [];
  // Phrased so it is NOT an approval event (approvalHistory.js): attaching
  // paper is editing the claim, and belongs on the History tab, not on the
  // signed approval page.
  claim.history.unshift({ text: `Supporting document "${fileName}" was attached`, by: me.name, at: nowIso() });
  save(items);
  return res.json({ claim, attachment: att });
});

// GET /api/claims/:id/attachments/:attId/file — the bytes, for the page and for
// the PDF assembler. Like a receipt's file route it carries no X-Org-Id (the
// PDF assembler fetches it bare), so the claim is found by id across every
// entity's claims and its entity is checked against the caller. 404 on a
// refusal: whether the claim exists is not the caller's to learn.
claimsRouter.get('/:id/attachments/:attId/file', async (req, res) => {
  const claim = load().find((c) => c.id === req.params.id && !c.deleted);
  const att = claim?.attachments?.find((a) => a.id === req.params.attId);
  if (!claim || !att) return res.status(404).json({ error: 'no_file' });
  const me = memberForSession(req);
  if (me && !canAccessOrg(me, entityIdForClaim(claim))) return res.status(404).json({ error: 'no_file' });
  const obj = await getBillFile(att.storageKey, att.contentType);
  if (!obj) return res.status(502).json({ error: 'file_unavailable' });
  const type = String(att.contentType || obj.contentType || 'application/octet-stream');
  res.setHeader('Content-Type', /^[\x20-\x7e]+$/.test(type) ? type : 'application/octet-stream');
  const safe = att.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition', `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(att.fileName)}`);
  obj.body.on('error', () => res.destroy());
  obj.body.pipe(res);
});

// GET /api/claims/:id/pdf?s=<token> — the claim's own PDF, for somebody with no
// session at all.
//
// The practice sends a client's manager a recharge report whose Claim No links
// here. That person has no CYBills login and never will, so the link carries a
// signed, expiring capability for this ONE claim (shareLinks.ts, the same
// mechanism a receipt image uses) and the session guard lets it through on the
// strength of that.
//
// A SESSION still works too, checked the ordinary way — the same URL then opens
// for the colleague who sent it, without a token.
claimsRouter.get('/:id/pdf', async (req, res) => {
  const claim = load().find((c) => c.id === req.params.id && !c.deleted);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  const signed = verifyShareToken(claim.id, String(req.query.s ?? ''));
  if (!signed) {
    const me = memberForSession(req);
    // 404, never 403: whether a claim exists is not something an unauthorised
    // caller is entitled to learn, which is the rule every other read here
    // follows.
    if (!readSession(req) || (me && !canAccessOrg(me, entityIdForClaim(claim)))) {
      return res.status(404).json({ error: 'not_found' });
    }
  }
  const org = claim.orgId === WORKSPACE_ID ? primaryOrgId() : claim.orgId;
  const sharing = readSetting<{ imageSharing?: boolean }>(WORKSPACE_ID, 'cybills.export-settings.v1', org)?.imageSharing !== false;
  const bytes = await claimPdfBytes(claim as never, appOrigin(req), { imageSharing: sharing });
  if (!bytes) return res.status(502).json({ error: 'pdf_unavailable' });
  const name = `${String(claim.name || 'expense-claim').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.send(Buffer.from(bytes));
});

// DELETE /api/claims/:id/attachments/:attId — take a supporting document off
// the claim. The file goes with it (it is this claim's alone — see the storage
// key above); the history keeps the fact that it was there.
claimsRouter.delete('/:id/attachments/:attId', (req, res) =>
  mutate(req, res, (claim, me) => {
    if (isLocked(claim)) return res.status(409).json({ error: 'claim_locked' });
    const existing = Array.isArray(claim.attachments) ? claim.attachments : [];
    const att = existing.find((a) => a.id === req.params.attId);
    if (!att) return res.status(404).json({ error: 'not_found' });
    claim.attachments = existing.filter((a) => a.id !== att.id);
    claim.history = claim.history || [];
    claim.history.unshift({ text: `Supporting document "${att.fileName}" was removed`, by: me.name, at: nowIso() });
    void deleteBillFile(att.storageKey);
  })
);

// POST /api/claims/:id/archive  { archived }
claimsRouter.post('/:id/archive', (req, res) =>
  mutate(req, res, (claim) => {
    claim.archived = req.body?.archived !== false;
  })
);

// DELETE /api/claims/:id — soft delete the claim, and hand its documents back
// to the Costs tab.
//
// This used to delete them permanently, files included, on the reasoning that
// they were captured to be claimed and had nothing left to be. That is wrong
// about what they ARE: a receipt is evidence of money somebody spent, and the
// spending happened whether or not the claim survived. Throwing away a client's
// paperwork because a claim was raised badly is not recoverable, and the ordinary
// reason a claim is deleted is that it was raised WRONGLY — the wrong person, the
// wrong period, the wrong items — every one of which ends with those receipts
// needing to go on a different claim.
//
// The inbox rather than Archive, which is where removing a single ITEM sends
// one: taking one line off says "this doesn't belong on this claim", so it is set
// aside; losing the whole claim says the work has to be done again, and work to
// be done lives in the inbox.
//
// Except where the claim reached XERO. Then its documents are already accounted
// for — as lines of the claim's own bill — and putting them back in the inbox
// offers somebody the chance to publish the same money a second time. Those are
// archived instead: kept, findable, not presented as work.
//
// The claim itself is only soft-deleted, so the record of what was claimed, by
// whom and for how much outlives it either way.
claimsRouter.delete('/:id', (req, res) =>
  mutate(req, res, (claim) => {
    claim.deleted = true;
    const ids = claim.transactions.map((t) => String(t.itemId));
    const freed = claim.xeroInvoiceId ? unmarkBillsClaimed(ids) : returnBillsToInbox(ids);
    if (freed) {
      const where = claim.xeroInvoiceId ? 'Archive (the claim was published)' : 'the Costs tab';
      console.log(`[claims] claim ${claim.id} deleted — ${freed} document(s) went back to ${where}`);
    }
  })
);
