// Client helpers for the Bank tab: the statement lines CYWorkspace's auto bank
// reconciliation left outstanding for this entity, and the settlement of one
// against the document that pays it (server/src/bankMatch.ts).
import { useEffect, useState } from 'react';
import { getActiveOrganisationId, ORGANISATION_EVENT } from '@/lib/organisations';

function orgHeaders() {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
}

async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...orgHeaders(), ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(
      Array.isArray(body.messages) ? body.messages.join(' ') : body.message || `Request failed (${res.status}).`
    ));
    err.code = body.error;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// { ok, lines, records, retrieved_at, reports, tenant } — or, when CYWS could
// not be asked, { ok: false, error, message, lines: [], records } with the
// matches already made still listed, since those are payments in a live ledger.
export function fetchBankOutstanding() {
  return request('/api/bank/outstanding');
}

// Settle one line against one document: publish it if it is not yet in Xero,
// then record the payment. `line` is echoed back as the server handed it out,
// plus `bank_account_code` where a person had to pick the account.
export function matchBankLine(billId, line) {
  return request('/api/bank/match', { method: 'POST', body: JSON.stringify({ billId, line }) });
}

export function undoBankMatch(recordId) {
  return request(`/api/bank/matches/${encodeURIComponent(recordId)}/undo`, { method: 'POST' });
}

export function dismissBankLine(line) {
  return request('/api/bank/lines/dismiss', { method: 'POST', body: JSON.stringify({ line }) });
}

export function restoreBankLine(recordId) {
  return request(`/api/bank/lines/${encodeURIComponent(recordId)}/restore`, { method: 'POST' });
}

// Dext's "Autofill payment", from the inbox's Match column: keep the bank line
// on the document as its pending payment, turn Paid on, name the bank account
// as the payment method. Nothing reaches Xero until the document is published;
// then the payment is recorded from that line. A document already in Xero and
// awaiting payment is settled on the spot instead (`settled: true`).
export function autofillBankPayment(billId, line) {
  return request('/api/bank/autofill', { method: 'POST', body: JSON.stringify({ billId, line }) });
}

export function clearBankPayment(billId) {
  return request('/api/bank/autofill/clear', { method: 'POST', body: JSON.stringify({ billId }) });
}

// --- the outstanding lines, held once for every page that draws them ----------
// The Costs inbox and the Bank tab both read the same lines; one fetch per
// entity, refreshed every few minutes or on demand, so a reviewer scrolling the
// inbox does not ask CYWorkspace on every render.

const LINES_EVENT = 'cybills:bank-lines';
const TTL_MS = 5 * 60 * 1000;
let cache = { orgId: '', at: 0, lines: [], records: [], error: '', code: '', loading: false, promise: null };

function currentOrg() {
  return getActiveOrganisationId() || '';
}

export function refreshBankLines() {
  const orgId = currentOrg();
  if (cache.promise && cache.orgId === orgId) return cache.promise;
  cache = { ...cache, orgId, loading: true };
  window.dispatchEvent(new Event(LINES_EVENT));
  const promise = fetchBankOutstanding()
    .then((out) => {
      cache = {
        orgId, at: Date.now(), loading: false, promise: null,
        lines: out.lines || [], records: out.records || [],
        error: out.ok ? '' : out.message || '', code: out.ok ? '' : out.error || '',
      };
    })
    .catch((err) => {
      // A refusal is not news on the inbox: a Standard user, an entity with no
      // Xero, an unconfigured deploy — the column simply has nothing to show.
      cache = { orgId, at: Date.now(), loading: false, promise: null, lines: [], records: [], error: err.message || '', code: err.code || '' };
    })
    .finally(() => window.dispatchEvent(new Event(LINES_EVENT)));
  cache.promise = promise;
  return promise;
}

/** The outstanding statement lines for the open entity, and what has been done
 * to each. `{ lines, records, loading, error, code, refresh }`. */
export function useBankLines({ enabled = true } = {}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const sync = () => tick((n) => n + 1);
    window.addEventListener(LINES_EVENT, sync);
    window.addEventListener(ORGANISATION_EVENT, sync);
    return () => {
      window.removeEventListener(LINES_EVENT, sync);
      window.removeEventListener(ORGANISATION_EVENT, sync);
    };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const orgId = currentOrg();
    const stale = cache.orgId !== orgId || Date.now() - cache.at > TTL_MS;
    if (stale && !cache.loading) refreshBankLines();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refreshBankLines();
    }, TTL_MS);
    return () => clearInterval(t);
  }, [enabled]);
  const mine = cache.orgId === currentOrg();
  return {
    lines: mine ? cache.lines : [],
    records: mine ? cache.records : [],
    loading: mine ? cache.loading : true,
    error: mine ? cache.error : '',
    code: mine ? cache.code : '',
    refresh: refreshBankLines,
  };
}

// A settlement or an autofill made elsewhere changes what is outstanding: let
// the next reader see it.
export function invalidateBankLines() {
  cache = { ...cache, at: 0 };
}
