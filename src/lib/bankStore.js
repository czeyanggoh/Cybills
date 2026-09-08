// Client helpers for the Bank tab: the statement lines CYWorkspace's auto bank
// reconciliation left outstanding for this entity, and the settlement of one
// against the document that pays it (server/src/bankMatch.ts).
import { getActiveOrganisationId } from '@/lib/organisations';

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
