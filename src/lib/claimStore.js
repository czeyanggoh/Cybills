import { useState, useEffect, useCallback } from 'react';
import { displayItemId, updateBill, notifyBillsChanged } from '@/lib/bills';
import { cleanHistoryText } from '@/lib/exportFormat';

// Server-backed expense claims (shared across the workspace). Talks to
// /api/claims; mirrors the bills client pattern — fetch + a change event that
// mounted views subscribe to. The old per-browser localStorage store is gone,
// so a claim one person creates/approves is visible to everyone.

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
  const transactions = (c.transactions || []).map((t) => ({ ...t, displayId: displayItemId(t.itemId) }));
  const sum = (k) => transactions.reduce((n, t) => n + Number(t[k] || 0), 0).toFixed(2);
  const history = (c.history || []).map((e) => ({ ...e, text: cleanHistoryText(e.text), at: fmtAt(e.at) }));
  return { ...c, transactions, history, net: sum('net'), tax: sum('tax'), total: sum('total') };
}

async function fetchClaims() {
  try {
    const res = await fetch('/api/claims');
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = /** @type {any} */ (new Error(b.error || `Request failed (${res.status})`));
    err.code = b.error;
    err.approver = b.approver;
    throw err;
  }
  return res.json();
}

// Create a new claim; resolves with the created (shaped) claim.
export async function createClaim({ claimFor, name, endDate }) {
  const { claim } = await post('/', { claimFor, name, endDate });
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

// Record that an approved claim's payable was sent to CYHR (re-callable — CYHR
// updates the same payable by claimId). `revision` is the monotonic counter sent
// on the link so CYHR can reject a stale re-send.
export async function markClaimSentToHr(claimId, amount, revision) {
  await post(`/${claimId}/mark-hr-sent`, { amount, revision });
  notifyClaimsChanged();
}

// Submit a claim for approval to a chosen approver (name + email so the server
// can enforce that only that person decides).
export async function submitForApproval(claimId, approver, _actor, approverEmail = '') {
  await post(`/${claimId}/submit`, { approver, approverEmail });
  notifyClaimsChanged();
}

// Approve / reject. The server stamps the acting (signed-in) user and enforces
// that they are the assigned approver. Throws with code 'not_approver' if not.
export async function approveClaim(claimId) {
  await post(`/${claimId}/approve`);
  notifyClaimsChanged();
}
export async function rejectClaim(claimId) {
  await post(`/${claimId}/reject`);
  notifyClaimsChanged();
}

export async function archiveClaims(ids, archived = true) {
  await Promise.all(ids.map((id) => post(`/${id}/archive`, { archived }).catch(() => {})));
  notifyClaimsChanged();
}
export async function deleteClaims(ids) {
  await Promise.all(
    ids.map((id) => fetch(`/api/claims/${id}`, { method: 'DELETE' }).catch(() => {}))
  );
  notifyClaimsChanged();
}

// Build a claim transaction row from a cost document's edited fields (pure).
export function docToClaimTxn(doc, data, actor) {
  const total = Number(data.total) || 0;
  const tax = Number(data.tax) || 0;
  return {
    itemId: String(doc.id),
    date: data.date || '—',
    supplier: data.supplier || 'Unknown supplier',
    category: data.category || 'Uncategorised',
    project: '',
    net: (total - tax).toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
    status: 'ready',
    addedBy: actor || 'Astrid Yang',
  };
}

// Reactive read of all claims: fetches on mount and refetches on any mutation.
export function useClaims() {
  const [claims, setClaims] = useState([]);
  const reload = useCallback(() => {
    fetchClaims().then(setClaims);
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener(CLAIMS_EVENT, reload);
    return () => window.removeEventListener(CLAIMS_EVENT, reload);
  }, [reload]);
  return claims;
}
