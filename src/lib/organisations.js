import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { XERO_ACCOUNTS, accountLabel } from '@/data/xeroAccounts';
import { getHiddenSet, getAddedRows, getMeta, useHiddenSet, LISTS_EVENT, SEED_TAX_RATES } from '@/lib/listsStore';
import { useCustomCategories } from '@/lib/customCategories';
import { useCategorySortMode, sortCategories } from '@/lib/categoryDisplay';
import { useBankAccounts } from '@/lib/bankAccounts';
import { BANK_ACCOUNTS, usePaymentMethods } from '@/lib/paymentMethods';

// Client helpers for organisations (client entities linked to a Xero tenant in
// cyworkspace) and the Xero endpoints that publish bills through the relay.

const ACTIVE_KEY = 'cybills:active-organisation';

// Supplier bills post to expense-type accounts, so those drive categorisation.
const isExpenseType = (t) => ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(String(t || '').toUpperCase());

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
  // Costs/Sales books are per-org, so switching orgs must reload the lists —
  // and so must every per-org settings blob (business profile, lists, coding
  // rules). Dispatch by literal name to avoid importing bills.js / blobStore.js
  // (would cycle).
  try {
    window.dispatchEvent(new Event('cybills:bills-changed'));
    window.dispatchEvent(new Event('cybills:organisation-changed'));
  } catch {
    // no window (SSR/tests) — nothing to refresh
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

export function fetchXeroPaymentMethods(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/payment-methods`).then((b) => b.paymentMethods ?? []);
}

export function fetchXeroCustomers(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/customers`).then((b) => b.customers ?? []);
}

export function fetchXeroSuppliers(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/suppliers`).then((b) => b.suppliers ?? []);
}

// Supplier list: the active org's (CYBM) live Xero supplier contacts.
export function useXeroSuppliers() {
  const orgId = useActiveOrgId();
  const { data } = useQuery({
    queryKey: ['xero-suppliers', orgId],
    queryFn: () => fetchXeroSuppliers(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return (data ?? []).map((s) => s.name).filter(Boolean);
}

// The active org (CYBM by default) — the one whose Xero chart drives the
// document dropdowns. Falls back to the first linked org.
function useActiveOrgId() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  return organisations.find((o) => o.id === active)?.id || organisations[0]?.id || '';
}

// Customer-allocation options: the active org's Xero customer contacts, live via
// the relay. Empty until an org is linked (the field stays free-text).
export function useXeroCustomers() {
  const orgId = useActiveOrgId();
  const { data } = useQuery({
    queryKey: ['xero-customers', orgId],
    queryFn: () => fetchXeroCustomers(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return (data ?? []).map((c) => c.name).filter(Boolean);
}

// Purchase tax-rate options straight from the active org's Xero, with each rate's
// %. Returns { options: string[], rateFor: (name) => number }. Falls back to the
// caller's list when Xero isn't connected.
export function useXeroPurchaseTaxRates() {
  const orgId = useActiveOrgId();
  const { data } = useQuery({
    queryKey: ['xero-taxrates', orgId],
    queryFn: () => fetchXeroTaxRates(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data ?? [];
}

// The ONE managed tax-rate list, shared by Business settings → Lists → Tax rates
// AND every cost/sales tax-rate picker. Source = the linked org's LIVE Xero
// purchase tax rates (fallback: the bundled Singapore seed when Xero isn't
// connected), plus any manually-added rates. Each row is annotated `visible`
// from the managed hidden-set, keyed by NAME — so switching a rate off in the
// list removes it from every picker. (Previously the list showed the seed while
// the pickers showed the fuller Xero set, so visibility toggles never matched.)
export function useManagedTaxRates() {
  const xero = useXeroPurchaseTaxRates();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sync = () => setTick((t) => t + 1);
    window.addEventListener(LISTS_EVENT, sync);
    return () => window.removeEventListener(LISTS_EVENT, sync);
  }, []);
  return useMemo(() => {
    void tick; // re-run when the managed list changes
    return mergeManagedTaxRates(xero);
  }, [xero, tick]);
}

// The merge itself, free of React so the upload path (getExtractionTaxRates) and
// the hook can't drift apart. `xero` is the live relay list ([{name, taxType,
// rate}]); empty falls back to the bundled seed.
function mergeManagedTaxRates(xero) {
  const hidden = getHiddenSet('taxRates');
  const meta = getMeta('taxRates'); // per-rate "when to use" rules, keyed by name
  const base = xero.length
    ? xero.map((t) => ({ name: t.name, code: t.taxType || '', rate: Number(t.rate) || 0 }))
    : SEED_TAX_RATES.map((t) => ({ name: t.name, code: t.code, rate: Number(t.rate) || 0 }));
  const added = getAddedRows('taxRates').map((a) => ({ name: a.name, code: a.code || '', rate: Number(a.rate) || 0 }));
  const seen = new Set();
  return [...base, ...added]
    .filter((t) => t.name && !seen.has(t.name) && seen.add(t.name))
    .map((t) => ({ ...t, id: t.name, visible: !hidden.has(t.name), rules: meta[t.name]?.rules || '' }));
}

// Just the visible rates (what the pickers offer). Each carries its `rules`
// string — the org's own note on when that code applies, which rides along to
// the extractor so it can pick codes arithmetic can't reach.
export function useVisibleTaxRates() {
  return useManagedTaxRates().filter((t) => t.visible);
}

// Payment-method dropdown options: the linked org's Xero accounts a payment can
// be applied to — bank accounts + accounts with EnablePaymentsToAccount — live
// via the relay. Any manually-added methods are appended, and are used alone
// when Xero isn't connected. Returns [{ label }] to match the dropdowns.
export function useXeroPaymentMethods() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  const orgId = organisations.find((o) => o.id === active)?.id || organisations[0]?.id || '';
  const { data } = useQuery({
    queryKey: ['xero-payment-methods', orgId],
    queryFn: () => fetchXeroPaymentMethods(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const manual = usePaymentMethods(); // reactive to manual "Add payment method"
  const seen = new Set();
  return [...(data ?? []), ...manual]
    .map((m) => ({ label: m.label }))
    .filter((m) => m.label && !seen.has(m.label) && seen.add(m.label));
}

// The linked organisation's registration details, straight from Xero's
// Organisation endpoint through the relay. Used to sync the Business profile.
export function fetchXeroProfile(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/profile`).then((b) => b.profile ?? null);
}

// The linked organisation's Xero tracking categories (up to two) + their active
// options. Category 0 → Projects, category 1 → Projects 2.
export function fetchXeroTracking(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/tracking`).then((b) => b.categories ?? []);
}

export function useXeroTracking(organisationId) {
  return useQuery({
    queryKey: ['xero-tracking', organisationId],
    queryFn: () => fetchXeroTracking(organisationId),
    enabled: Boolean(organisationId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

// Project (Xero tracking-category) option NAMES for the active org — `index` 0 =
// Projects, 1 = Projects 2. The cost/sales Project pickers use these live Xero
// options (Business settings → Lists → Projects manages them) instead of the
// bundled seed list. Empty until an org is linked.
export function useXeroProjectOptions(index = 0) {
  const orgId = useActiveOrgId();
  const { data: categories = [] } = useXeroTracking(orgId);
  return (categories[index]?.options ?? []).map((o) => o.name).filter(Boolean);
}

// The org's Xero expense accounts (with AccountID + Description) — the editable
// Categories list. Category = a Xero account; its Description syncs to Xero.
export function fetchXeroCategories(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/categories`).then((b) => b.categories ?? []);
}

export function useXeroCategories(organisationId) {
  return useQuery({
    queryKey: ['xero-categories', organisationId],
    queryFn: () => fetchXeroCategories(organisationId),
    enabled: Boolean(organisationId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

// Push a category's edited Description back to Xero (Name + Code re-sent
// unchanged so only the Description moves). Resolves with the updated category.
export async function updateXeroCategoryDescription(organisationId, accountId, { name, code, description }) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/categories/${accountId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code, description }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.message || (body.messages && body.messages[0]) || 'Could not update Xero.'));
    err.code = body.error;
    throw err;
  }
  return body.category;
}

// The org whose chart drives categorisation: the active org, else the first
// linked one. Returns '' when none are linked / Xero isn't configured.
export async function resolveCategorisationOrgId() {
  try {
    const orgs = (await getJson('/api/organisations')).organisations ?? [];
    if (!orgs.length) return '';
    const active = getActiveOrganisationId();
    return (orgs.find((o) => o.id === active) || orgs[0]).id;
  } catch {
    return '';
  }
}

// Accounts to classify OCR'd expenses into: the connected org's LIVE Xero
// expense accounts (code/name/description, pulled through the relay), falling
// back to the bundled standard chart when Xero isn't connected. Used at upload
// time, so it must never throw — any failure yields the fallback.
export async function getExtractionAccounts() {
  const orgId = await resolveCategorisationOrgId();
  if (!orgId) return XERO_ACCOUNTS;
  try {
    const accounts = await fetchXeroAccounts(orgId);
    // A category hidden in Lists is off-limits to the extractor too, so it can't
    // classify a document into an account the user has retired.
    const hidden = getHiddenSet('categories');
    const shown = accounts.filter((a) => !hidden.has(a.code || a.name));
    const expense = shown.filter((a) => isExpenseType(a.type));
    const list = (expense.length ? expense : shown).map((a) => ({
      code: a.code,
      name: a.name,
      description: a.description || '',
    }));
    return list.length ? list : XERO_ACCOUNTS;
  } catch {
    return XERO_ACCOUNTS;
  }
}

// The visible tax rates for the upload path (fetchExtract), where hooks aren't
// available. Same list the pickers show, each carrying its "when to use" rules.
// Must never throw — any failure yields the seed-backed list.
export async function getExtractionTaxRates() {
  const orgId = await resolveCategorisationOrgId();
  let live = [];
  if (orgId) {
    try {
      live = await fetchXeroTaxRates(orgId);
    } catch {
      live = [];
    }
  }
  return mergeManagedTaxRates(live).filter((t) => t.visible);
}

// Category-dropdown options for the active org's live chart (expense accounts),
// with the bundled standard chart as fallback. 'Uncategorised' is always first.
export function useCategoryOptions() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  const orgId = organisations.find((o) => o.id === active)?.id || organisations[0]?.id || '';
  const { data } = useQuery({
    queryKey: ['xero-accounts', orgId],
    queryFn: () => fetchXeroAccounts(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // Categories switched off in Business settings → Lists → Categories are keyed
  // by account code, and drop out of the picker entirely.
  const hidden = useHiddenSet('categories');
  const shown = (data ?? []).filter((a) => !hidden.has(a.code || a.name));
  const expense = shown.filter((a) => isExpenseType(a.type));
  const labels = expense.length ? expense.map(accountLabel) : XERO_ACCOUNTS.map(accountLabel);
  // The category dropdown always follows the Xero chart of accounts. Only
  // categories the user explicitly adds via "Add category" are appended; the
  // Business-settings Lists categories no longer feed this dropdown.
  const custom = useCustomCategories().map((c) => c.label);
  const sort = useCategorySortMode();
  // 'Uncategorised' is pinned first; everything else follows the chosen order.
  const rest = sortCategories(
    Array.from(new Set([...labels, ...custom])).filter((c) => c !== 'Uncategorised'),
    sort,
  );
  return ['Uncategorised', ...rest];
}

// Bank-account dropdown options: the linked org's Xero BANK accounts (live via
// the relay) plus any manually-added accounts, falling back to the built-in
// list when Xero isn't connected.
export function useXeroBankAccounts() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  const orgId = organisations.find((o) => o.id === active)?.id || organisations[0]?.id || '';
  const { data } = useQuery({
    queryKey: ['xero-accounts', orgId],
    queryFn: () => fetchXeroAccounts(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const manual = useBankAccounts().map((a) => a.name).filter(Boolean);
  const xero = (data ?? [])
    .filter((a) => String(a.type).toUpperCase() === 'BANK')
    .map((a) => a.name || a.code)
    .filter(Boolean);
  const merged = Array.from(new Set([...xero, ...manual]));
  return merged.length ? merged : BANK_ACCOUNTS;
}

// Publish a stored bill to Xero as an ACCPAY supplier bill. Resolves with
// { invoice, bill }; rejects with a message (422 carries Xero's validation
// messages, joined for display).
// Post an approved expense claim to Xero as a DRAFT ACCPAY bill payable to the
// employee. Resolves with { ok, invoice, claim }; throws with a message on error.
export async function publishClaimToXero(organisationId, payload) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/publish-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(
      Array.isArray(body.messages) ? body.messages.join(' ') : body.message || 'Publish to Xero failed.'
    ));
    err.code = body.error;
    throw err;
  }
  return body;
}

// Put a published document's original file on the Xero bill it was posted as.
// For bills published before attachments were sent, or when that upload failed.
export async function attachBillFileToXero(organisationId, billId) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/attach-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.message || 'Could not attach the file.'));
    err.code = body.error;
    throw err;
  }
  return body;
}

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
