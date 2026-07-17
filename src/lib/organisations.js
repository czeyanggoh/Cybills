import { useQuery, useQueryClient } from '@tanstack/react-query';

// Client helpers for organisations (client entities linked to a Xero tenant in
// cyworkspace) and the Xero endpoints that publish bills through the relay.

const ACTIVE_KEY = 'cybills:active-organisation';

export function getActiveOrganisationId() {
  try {
    return localStorage.getItem(ACTIVE_KEY) || '';
  } catch {
    return '';
  }
}

export function setActiveOrganisationId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // localStorage unavailable — selection just won't persist
  }
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.message || body.error || `Request failed (${res.status})`));
    err.code = body.error || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return body;
}

export function useOrganisations() {
  return useQuery({
    queryKey: ['organisations'],
    queryFn: async () => (await getJson('/api/organisations')).organisations ?? [],
  });
}

export function useInvalidateOrganisations() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['organisations'] });
}

// Xero tenants connected in cyworkspace, for the add-organisation picker.
// Throws with code 'xero_not_configured' (503) until the relay key is set.
export function fetchXeroTenants() {
  return getJson('/api/xero/tenants').then((b) => b.tenants ?? []);
}

export async function createOrganisation({ name, tenantId, tenantName }) {
  const res = await fetch('/api/organisations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tenantId, tenantName }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(
      body.error === 'already_linked'
        ? `"${body.organisation?.name}" is already linked to that Xero organisation.`
        : body.message || 'Could not add the organisation.'
    ));
    err.code = body.error;
    throw err;
  }
  return body.organisation;
}

export async function deleteOrganisation(id) {
  const res = await fetch(`/api/organisations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete_failed');
}

// Reference data for the publish dialog, scoped to one linked organisation.
export function fetchXeroAccounts(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/accounts`).then((b) => b.accounts ?? []);
}

// The linked organisation's Xero chart of accounts (account codes), fetched
// live through the cyworkspace relay. Only runs once an organisation is picked.
export function useXeroAccounts(organisationId) {
  return useQuery({
    queryKey: ['xero-accounts', organisationId],
    queryFn: () => fetchXeroAccounts(organisationId),
    enabled: Boolean(organisationId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function fetchXeroTaxRates(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/taxrates`).then((b) => b.taxRates ?? []);
}

// Publish a stored bill to Xero as an ACCPAY supplier bill. Resolves with
// { invoice, bill }; rejects with a message (422 carries Xero's validation
// messages, joined for display).
export async function publishBillToXero(organisationId, payload) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/publish-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(
      Array.isArray(body.messages) ? body.messages.join(' ') : body.message || 'Publish failed.'
    ));
    err.code = body.error;
    throw err;
  }
  return body;
}
