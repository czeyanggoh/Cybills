import { useState, useEffect, useCallback } from 'react';
import { displayItemId, updateBill, notifyBillsChanged } from '@/lib/bills';
import { getActiveOrganisationId, ORGANISATION_EVENT } from '@/lib/organisations';
import { cleanHistoryText } from '@/lib/exportFormat';
import { toIsoClaimDate } from '@/lib/claimDate';

// Server-backed expense claims, shared by everyone working in one client entity.
// Talks to /api/claims; mirrors the bills client pattern — fetch + a change
// event that mounted views subscribe to. The old per-browser localStorage store
// is gone, so a claim one person creates/approves is visible to their
// colleagues.

// Every claims request names the selected entity, exactly as the bills client
// does, so the server serves that entity's own claims. Without it the server
// falls back to the primary org and one entity sees another's claims.
function orgHeaders() {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
}

export const CLAIMS_EVENT = 'cybills:claims-changed';
export function notifyClaimsChanged() {
  window.dispatchEvent(new Event(CLAIMS_EVENT));
}

// Format an ISO history timestamp for display; pass through legacy strings.
function fmtAt(at) {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Shape a server claim into what the views/PDF expect: display ids on rows,
// recomputed net/tax/total, friendly history timestamps.
function shape(c) {
  // A line records the document's number when it is added, so the claim keeps
  // showing the right one even after the document itself is gone.
  const transactions = (c.transactions || []).map((t) => ({ ...t, displayId: t.displayId || displayItemId(t.itemId) }));
  const sum = (k) => transactions.reduce((n, t) => n + Number(t[k] || 0), 0).toFixed(2);
  const history = (c.history || []).map((e) => ({ ...e, text: cleanHistoryText(e.text), at: fmtAt(e.at) }));
  return { ...c, transactions, history, net: sum('net'), tax: sum('tax'), total: sum('total') };
}

async function fetchClaims() {
  try {
    const res = await fetch('/api/claims', { headers: orgHeaders() });
    if (!res.ok) return [];
    const { claims } = await res.json();
    return Array.isArray(claims) ? claims.map(shape) : [];
  } catch {
    return [];
  }
}

async function post(path, body) {
  const res = await fetch(`/api/claims${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = /** @type {any} */ (new Error(b.error || `Request failed (${res.status})`));
    err.code = b.error;
    err.approver = b.approver;
    err.claimant = b.claimant;
    throw err;
  }
  return res.json();
}

// --- Date normalisation ----------------------------------------------------
// The rules live in their own pure module so `npm test` can hold them to
// account, and are re-exported here because everything that shows a claim date
// already reaches for them through this store.
export { CLAIM_MON, parseDateParts, formatClaimDate, formatClaimStamp, toIsoClaimDate } from '@/lib/claimDate';

// Create a new claim; resolves with the created (shaped) claim. endDate is
// stored canonically as ISO YYYY-MM-DD.
export async function createClaim({ claimFor, name, endDate }) {
  const { claim } = await post('/', { claimFor, name, endDate: toIsoClaimDate(endDate) || endDate });
  notifyClaimsChanged();
  return shape(claim);
}

// Update editable claim fields (end date / name). Persists ISO for endDate.
export async function updateClaim(claimId, patch) {
  const body = { ...patch };
  if ('endDate' in body) body.endDate = toIsoClaimDate(body.endDate) || body.endDate;
  const { claim } = await post(`/${claimId}/update`, body);
  notifyClaimsChanged();
  return shape(claim);
}

// Attach a cost item (transaction shape) to a claim. Idempotent per itemId.
export async function addItemToClaim(claimId, txn) {
  await post(`/${claimId}/items`, { items: [txn] });
  notifyClaimsChanged();
}

// Remove items (by itemId) from a claim. Following Dext, the underlying cost
// documents return to the Costs inbox (status 'new') rather than staying under
// Archive — the itemId is the bill id. Failures (e.g. demo docs that aren't
// persisted server-side) are ignored.
export async function removeItemsFromClaim(claimId, itemIds) {
  await post(`/${claimId}/items/remove`, { itemIds });
  await Promise.all(itemIds.map((id) => updateBill(id, { status: 'new' }).catch(() => {})));
  notifyClaimsChanged();
  notifyBillsChanged();
}

// Bulk-edit fields (e.g. category) on selected claim items.
export async function updateClaimItems(claimId, itemIds, patch) {
  await post(`/${claimId}/items/update`, { itemIds, patch });
  notifyClaimsChanged();
}

// Move items from one claim to another: add to the target, then remove from the
// source. `txns` are the full transaction rows (so the target keeps their data).
export async function moveItemsToClaim(fromClaimId, toClaimId, txns) {
  for (const t of txns) {
    // eslint-disable-next-line no-await-in-loop
    await post(`/${toClaimId}/items`, { items: [t] });
  }
  await post(`/${fromClaimId}/items/remove`, { itemIds: txns.map((t) => t.itemId) });
  notifyClaimsChanged();
}

// Submit a claim for approval. The approver is derived server-side from the
// claimant's direct manager (set in Users) — nothing to pick. Throws with code
// 'no_manager' when the claimant has no direct manager assigned.
export async function submitForApproval(claimId) {
  await post(`/${claimId}/submit`, {});
  notifyClaimsChanged();
}

// Approve / reject. The server stamps the acting (signed-in) user and enforces
// that they are the assigned approver. Throws with code 'not_approver' if not.
export async function approveClaim(claimId) {
  await post(`/${claimId}/approve`);
  notifyClaimsChanged();
}
export async function rejectClaim(claimId, reason = '') {
  await post(`/${claimId}/reject`, { reason });
  notifyClaimsChanged();
}

// Email a copy of the claim (CSV + PDF attached) to a recipient. `payload` is
// { fromName, toName, toEmail, message, total, attachments:[{filename,content,contentType}] }.
// Throws (err.code carries the server reason) when the mail server refuses it.
export async function emailClaim(claimId, payload) {
  const res = await post(`/${claimId}/email`, payload);
  notifyClaimsChanged(); // the send is recorded on the claim's history
  return res;
}

export async function archiveClaims(ids, archived = true) {
  await Promise.all(ids.map((id) => post(`/${id}/archive`, { archived }).catch(() => {})));
  notifyClaimsChanged();
}
export async function deleteClaims(ids) {
  await Promise.all(
    ids.map((id) => fetch(`/api/claims/${id}`, { method: 'DELETE', headers: orgHeaders() }).catch(() => {}))
  );
  notifyClaimsChanged();
  notifyBillsChanged(); // deleted claims return their items to the Costs inbox
}

// Build a claim transaction row from a cost document's edited fields (pure).
export function docToClaimTxn(doc, data, actor) {
  const total = Number(data.total) || 0;
  const tax = Number(data.tax) || 0;
  return {
    itemId: String(doc.id),
    // The document's number, kept on the line: a claim exported months later
    // must show what the document showed, not re-derive it.
    displayId: doc.displayId || '',
    // Whether the document has a receipt behind it, so an export can link
    // straight to the paper rather than to a page that has none.
    hasFile: Boolean(doc.hasFile),
    date: data.date || '—',
    supplier: data.supplier || 'Unknown supplier',
    category: data.category || 'Uncategorised',
    // The item's own description (same field the Costs inbox shows) so the Xero
    // bill line reads like Dext: "<Supplier> #<ItemID> - <Description>".
    description: data.description || doc.description || '',
    project: '',
    net: (total - tax).toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
    status: 'ready',
    addedBy: actor || '',
  };
}

// Claims awaiting a given user's approval — matched by name OR email (the same
// rule the approve action uses), so a roster email mismatch can't hide a pending
// approval from the approver. Powers the reminder banner + the nav badge.
const norm = (s) => String(s ?? '').trim().toLowerCase();

// The approver a claim routes to = the claimant's direct manager (set in Users).
// Returns the manager user, or null when none is assigned.
export function directManagerFor(users, claimantName) {
  const claimant = (users || []).find((u) => norm(u.name) === norm(claimantName));
  if (!claimant?.managerId) return null;
  return (users || []).find((u) => u.id === claimant.managerId) || null;
}

// Claims a user is allowed to see: their own (they're the claimant or created
// it) plus ones awaiting/decided by them as approver. Gatekeeps the list so a
// submitted claim is visible only to the claimant and their direct manager.
// A claim is out of the inbox once it's archived — or published to Xero, which
// archives it implicitly (true for claims published before auto-archiving
// existed). Shared by the Expense claims tabs and the subnav badge so the number
// and the list can't disagree.
export function isClaimArchived(c) {
  return Boolean(c?.archived) || Boolean(c?.xeroInvoiceId);
}

// The claims that belong in the Expense claims inbox for this user: what they're
// allowed to see (admins see everything), minus the archived ones.
export function inboxClaimsFor(claims, user, isAdmin = false) {
  const visible = isAdmin ? claims || [] : visibleClaimsFor(claims, user);
  return visible.filter((c) => !isClaimArchived(c));
}

// The working half — what the Expense claims page opens on. Publishing is what
// settles a claim, so a claim archived by hand and never published is still in
// here; it is work somebody may have to finish. Shared with the subnav badge so
// the number beside the tab counts the list the tab actually opens.
export function unpublishedClaimsFor(claims, user, isAdmin = false) {
  const visible = isAdmin ? claims || [] : visibleClaimsFor(claims, user);
  return visible.filter((c) => !c?.xeroInvoiceId);
}

export function visibleClaimsFor(claims, user) {
  const email = norm(user?.email);
  const name = norm(user?.name);
  if (!email && !name) return claims || [];
  return (claims || []).filter((c) => {
    const mine = (name && norm(c.claimFor) === name) || (email && norm(c.createdBy) === email);
    const iApprove = (email && norm(c.approverEmail) === email) || (name && norm(c.approver) === name);
    return mine || iApprove;
  });
}

export function pendingApprovalsFor(claims, user) {
  const email = (user?.email || '').trim().toLowerCase();
  const name = (user?.name || '').trim().toLowerCase();
  if (!email && !name) return [];
  return (claims || []).filter((c) => {
    if (c.approvalStatus !== 'awaiting_approval') return false;
    const byEmail = email && String(c.approverEmail || '').trim().toLowerCase() === email;
    const byName = name && String(c.approver || '').trim().toLowerCase() === name;
    return byEmail || byName;
  });
}

// Reactive read of the selected entity's claims: fetches on mount, refetches on
// any mutation — and on an entity switch, which changes which claims these are.
// The active entity's claims, plus whether the first fetch has come back.
// A page that looks a claim up by id needs the difference: an empty list
// because nothing has loaded yet is not the same as a claim that isn't there,
// and treating them alike is how a valid claim flashed "not found" on its way
// in.
export function useClaimsState() {
  const [claims, setClaims] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(() => {
    fetchClaims().then((rows) => {
      setClaims(rows);
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener(CLAIMS_EVENT, reload);
    window.addEventListener(ORGANISATION_EVENT, reload);
    return () => {
      window.removeEventListener(CLAIMS_EVENT, reload);
      window.removeEventListener(ORGANISATION_EVENT, reload);
    };
  }, [reload]);
  return { claims, loaded };
}

export function useClaims() {
  return useClaimsState().claims;
}

// Which entity a claim belongs to, asked of the server across entities. Returns
// null when there is no such claim, or it is one this person may not open —
// the two are deliberately the same answer. Used only when a claim is absent
// from the active entity's list, so the page can offer to switch rather than
// say a claim that exists does not.
export async function whereIsClaim(id) {
  try {
    const res = await fetch(`/api/claims/${encodeURIComponent(id)}/where`, { headers: orgHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
