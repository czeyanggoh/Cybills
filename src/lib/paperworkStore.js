// Client side of Paperwork match (server/src/paperworkMatch.ts): the Xero
// transactions — Spend Money off a card feed, bills keyed in by hand — that the
// documents in this entity's Costs list could be the paper for, and sending a
// document to one. Held once per entity for every page that reads it (the Costs
// list's Match column and the document page), the way bankStore holds the
// outstanding statement lines, so scrolling the list does not ask Xero again.
import { useEffect, useState } from 'react';
import { getActiveOrganisationId, ORGANISATION_EVENT } from '@/lib/organisations';

const EVENT = 'cybills:paperwork-matches';
const TTL_MS = 5 * 60 * 1000;
let cache = { orgId: '', at: 0, matches: {}, trackingCategories: [], error: '', loading: false, promise: null };

async function call(path, init) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.message || `Request failed (${res.status}).`));
    err.code = body.error;
    err.status = res.status;
    throw err;
  }
  return body;
}

// The ENTITY open now, never a fallback to another one: a bridge entity has no
// Xero of its own and is refused, which is the right answer — its costs reach
// the ledger as lines of a claim.
const orgNow = () => getActiveOrganisationId() || '';

export function refreshPaperworkMatches({ force = false } = {}) {
  const orgId = orgNow();
  if (!orgId) return Promise.resolve();
  if (cache.promise && cache.orgId === orgId) return cache.promise;
  cache = { ...cache, orgId, loading: true };
  window.dispatchEvent(new Event(EVENT));
  const promise = call(`/api/xero/organisations/${encodeURIComponent(orgId)}/paperwork-matches${force ? '?refresh=1' : ''}`)
    .then((out) => {
      cache = {
        orgId, at: Date.now(), loading: false, promise: null,
        matches: out.matches || {}, trackingCategories: out.trackingCategories || [], error: out.error || '',
      };
    })
    .catch((err) => {
      // A refusal is not news on the list: no Xero, an unconfigured deploy, a
      // bridge entity — the column simply has nothing to show.
      cache = { orgId, at: Date.now(), loading: false, promise: null, matches: {}, trackingCategories: [], error: err.message || '' };
    })
    .finally(() => window.dispatchEvent(new Event(EVENT)));
  cache.promise = promise;
  return promise;
}

export function invalidatePaperworkMatches() {
  cache = { ...cache, at: 0 };
}

/** `{ matches: { [docId]: candidates }, trackingCategories, loading, error, refresh }` */
export function usePaperworkMatches({ enabled = true } = {}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const sync = () => tick((n) => n + 1);
    window.addEventListener(EVENT, sync);
    window.addEventListener(ORGANISATION_EVENT, sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener(ORGANISATION_EVENT, sync);
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const stale = cache.orgId !== orgNow() || Date.now() - cache.at > TTL_MS;
    if (stale && !cache.loading) refreshPaperworkMatches();
  }, [enabled]);
  const mine = cache.orgId === orgNow();
  return {
    matches: mine ? cache.matches : {},
    trackingCategories: mine ? cache.trackingCategories : [],
    loading: mine ? cache.loading : true,
    error: mine ? cache.error : '',
    refresh: refreshPaperworkMatches,
  };
}

// Send a document to a Xero transaction: attach its file there and, with
// `recode`, rewrite the transaction's lines to the document's coding.
// { ok, match, attachment, recode, bill }
export function sendToXeroTransaction(billId, txn, recode) {
  return call(`/api/xero/organisations/${encodeURIComponent(orgNow())}/paperwork-match`, {
    method: 'POST',
    body: JSON.stringify({ billId, kind: txn.kind, transactionId: txn.id, recode: Boolean(recode) }),
  });
}

export function unlinkXeroTransaction(billId) {
  return call(`/api/xero/organisations/${encodeURIComponent(orgNow())}/paperwork-unlink`, {
    method: 'POST',
    body: JSON.stringify({ billId }),
  });
}

// Where the transaction is in Xero. A Spend Money is a bank transaction; a bill
// is the Accounts Payable page every published document already links to.
export function xeroTxnUrl(txn, shortCode = '') {
  const id = encodeURIComponent(String(txn?.id || ''));
  if (!id) return '';
  const target = txn.kind === 'bill' ? `/AccountsPayable/Edit.aspx?InvoiceID=${id}` : `/Bank/ViewTransaction.aspx?bankTransactionID=${id}`;
  const code = String(shortCode || '').trim();
  return code
    ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(code)}&redirecturl=${target}`
    : `https://go.xero.com${target}`;
}

// Recode a transaction this document was already sent to, to its coding now.
export function recodeXeroTransaction(billId) {
  return call(`/api/xero/organisations/${encodeURIComponent(orgNow())}/paperwork-recode`, {
    method: 'POST',
    body: JSON.stringify({ billId }),
  });
}
