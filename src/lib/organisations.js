import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { XERO_ACCOUNTS, accountLabel } from '@/data/xeroAccounts';
import { getHiddenSet, getAddedRows, getMeta, useHiddenSet, useCategoryListOptions, getVisibleCategoryNames, LISTS_EVENT, SEED_TAX_RATES } from '@/lib/listsStore';
import { useCustomCategories } from '@/lib/customCategories';
import { useCategorySortMode, sortCategories } from '@/lib/categoryDisplay';
import { useBankAccounts } from '@/lib/bankAccounts';
import { BANK_ACCOUNTS, usePaymentMethods } from '@/lib/paymentMethods';

// Client helpers for organisations (client entities linked to a Xero tenant in
// cyworkspace) and the Xero endpoints that publish bills through the relay.

const ACTIVE_KEY = 'cybills:active-organisation';

// Fired when the selected organisation changes. Per-org data (books, settings,
// and the user roster) refetches on it.
export const ORGANISATION_EVENT = 'cybills:organisation-changed';

// Supplier bills post to expense-type accounts, so those drive categorisation.
const isExpenseType = (t) => ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(String(t || '').toUpperCase());

// Which entity a Xero-backed lookup should use.
//
// The explicit selection always wins. What changes is the FALLBACK: the list is
// sorted A→Z, so "Red Alpha - ST Engineering" comes before "Red Alpha
// Cybersecurity" — and a bridge entity has no chart, no tax rates and no
// contacts. Without `xeroOnly` it would silently become the default source for
// anyone who has never picked an entity, and their category dropdown would come
// back empty for no visible reason.
export function pickOrgId(organisations, active, { xeroOnly = false } = {}) {
  const list = Array.isArray(organisations) ? organisations : [];
  const chosen = list.find((o) => o.id === active);
  if (chosen) return chosen.id;
  const usable = xeroOnly ? list.filter((o) => o.tenantId) : list;
  return usable[0]?.id || '';
}

// A bridge entity: not a real company, no Xero of its own, its claims posting
// into the entity named as its parent. Mirrors isStandalone in
// server/src/organisations.ts, which is the authority.
export function isStandaloneOrg(o) {
  return o?.kind === 'standalone';
}

// The active entity's own record, for the paths where hooks aren't available
// (the upload path assembles the reader's inputs outside React). Null when
// nothing is selected, the list can't be fetched, or the selection is stale.
async function activeOrganisationRow() {
  try {
    const orgs = (await getJson('/api/organisations')).organisations ?? [];
    const active = getActiveOrganisationId();
    return orgs.find((o) => o.id === active) ?? null;
  } catch {
    return null;
  }
}

// An inbound link that names the entity it belongs to (`?org=`, or `?tenant=`).
//
// A link from OUTSIDE the app — the "Go to CYBills" button on a Xero bill, a
// URL pasted into chat — lands in whichever entity this browser last had open.
// For a claim that lives somewhere else that reads as "Expense claim not
// found", which is both wrong and alarming: the claim is right there, in the
// entity nobody switched to.
//
// So the entity is switched first and the page loaded fresh, once, with the
// parameter stripped — a reload rather than a re-render because every store,
// query and header in flight is scoped to the OLD entity, and half-switching is
// how a page ends up showing one entity's data under another's name.
//
// `?tenant=` is the same instruction said the other way round: it names the
// XERO tenant, which is what a link from cyworkspace can say — that app knows
// the Xero organisation it has open and nothing about this one's entity ids.
// Resolved here against the entities on offer, so a tenant nobody has linked
// (or that this person can't open) is simply ignored, like an unknown `?org=`.
//
// Ignored when it names an entity this person can't open (the page then says
// what it would have said anyway) or the one already open.
export function adoptOrgFromUrl(organisations) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const wantedOrg = url.searchParams.get('org');
  const wantedTenant = url.searchParams.get('tenant');
  if (!wantedOrg && !wantedTenant) return;
  const list = organisations || [];
  const match = wantedOrg
    ? list.find((o) => o.id === wantedOrg)
    : list.find((o) => o.tenantId && o.tenantId === wantedTenant);
  const already = match ? getActiveOrganisationId() === match.id : false;
  url.searchParams.delete('org');
  url.searchParams.delete('tenant');
  const clean = `${url.pathname}${url.search}${url.hash}`;
  if (!match || already) {
    // Nothing to switch, but the parameter should not survive: a later manual
    // switch would be undone by a refresh.
    window.history.replaceState(null, '', clean);
    return;
  }
  setActiveOrganisationId(match.id);
  window.location.replace(clean);
}

// Switch entity and land on `path` in it, from inside the app.
//
// A reload rather than a re-render, for the same reason adoptOrgFromUrl does
// one: every store, query and header in flight is scoped to the OLD entity.
// Half-switching is how a page ends up showing one entity's data under
// another's name — which is exactly what happened when the expense-claim
// prompt set the entity and re-rendered: the claim opened, and the header
// carried on naming the entity it had just left.
export function switchOrganisationTo(id, path) {
  if (!id) return;
  setActiveOrganisationId(id);
  if (typeof window === 'undefined') return;
  window.location.assign(path || `${window.location.pathname}${window.location.search}${window.location.hash}`);
}

// Is the entity currently open a bridge — no Xero of its own, claims posting
// into another entity's? Several surfaces need the answer to hide things that
// cannot mean anything here.
export function useBridgeEntity() {
  return isStandaloneOrg(useActiveOrganisation());
}

// Reactive form: the active entity's record, or null.
export function useActiveOrganisation() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  return organisations.find((o) => o.id === active) ?? null;
}

// Xero's short code for the ledger the open entity's bills actually land in —
// its own, or its PARENT's for a bridge entity, whose claims become bills over
// there. Resolved server-side (see the organisations list route) because that
// parent is very often an entity the caller cannot open, so its row is not in
// the list they were served.
//
// '' until the first Xero call for that tenant has recorded it, which makes a
// link fall back to its bare form rather than break.
export function useXeroShortCode() {
  return useActiveOrganisation()?.xeroShortCode || '';
}

// Whether the entity currently open is the practice's own — the primary one
// (CY Business Management), which owns the account's legacy data and is where a
// DEPLOYMENT-wide setting belongs.
//
// The sending mailbox is one mailbox for the whole account: every client's
// invitations and password resets leave from it, and there is nothing per-entity
// about it. Listed under each client's Business settings it read as that
// client's own — and handed their admin a disconnect button for everybody's
// mail.
//
// False while the list is still loading, so a section that is about to be
// hidden doesn't flash. True when nothing is linked yet: there is no other
// entity for it to belong to, and a fresh deployment still has to be able to
// check its mail works.
export function useIsPrimaryOrganisation() {
  const { data: organisations, isLoading } = useOrganisations();
  if (isLoading) return false;
  const list = organisations ?? [];
  if (!list.length) return true;
  // Matches the header's own fallback (pickOrgId): the A→Z first entity is what
  // is open when nobody has chosen one.
  const active = list.find((o) => o.id === getActiveOrganisationId()) || list[0];
  return Boolean(active?.isPrimary);
}

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
  // rules) and the user roster. The bills event is dispatched by literal name to
  // avoid importing bills.js / blobStore.js (would cycle).
  try {
    window.dispatchEvent(new Event('cybills:bills-changed'));
    window.dispatchEvent(new Event(ORGANISATION_EVENT));
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

// Every linked client entity, not just the ones the signed-in user can open —
// for the practice's client-access picker, where you assign entities you may not
// work in yourself. Practice managers only; anyone else gets their own list back.
export function useAllOrganisations() {
  return useQuery({
    queryKey: ['organisations', 'all'],
    queryFn: async () => (await getJson('/api/organisations?all=1')).organisations ?? [],
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

// `kind: 'standalone'` creates an entity with no Xero of its own — a bridge
// whose claims post into `parentOrgId`'s ledger instead.
export async function createOrganisation({ name, tenantId, tenantName, kind, parentOrgId }) {
  const res = await fetch('/api/organisations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tenantId, tenantName, kind, parentOrgId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = {
      already_linked: `"${body.organisation?.name}" is already linked to that Xero organisation.`,
      name_required: 'Give the entity a name.',
      parent_required: 'Choose the entity whose Xero its claims should post into.',
      parent_not_found: 'That entity no longer exists — pick another.',
    }[body.error];
    const err = /** @type {any} */ (new Error(
      said || body.message || 'Could not add the organisation.'
    ));
    err.code = body.error;
    throw err;
  }
  return body.organisation;
}

// The short form this entity's inbound addresses carry
// (`martin.redalpha@cybills.sg`). '' clears it, putting its people back on the
// bare handle. The server has the last word on what is usable and on whether
// another client already holds it — its reasons are carried through on `code`,
// so the card can name the entity or the person in the way rather than showing
// a status number.
export async function setEmailSuffix(id, suffix) {
  const res = await fetch(`/api/organisations/${id}/email-suffix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suffix }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = {
      invalid_suffix: 'Use letters and numbers, optionally separated by hyphens.',
      suffix_taken: `“${body.takenBy || 'Another entity'}” already uses that short form.`,
      address_taken: `${body.address || 'That address'} is already used by ${body.takenBy || 'someone else'}.`,
      not_an_admin: 'Only an admin of this entity can change its short form.',
    }[body.error];
    const err = /** @type {any} */ (new Error(said || body.message || 'Could not save the short form.'));
    err.code = body.error;
    throw err;
  }
  return body;
}

export async function deleteOrganisation(id) {
  const res = await fetch(`/api/organisations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete_failed');
}

// Reference data for the publish dialog, scoped to one linked organisation.
export function fetchXeroAccounts(organisationId) {
  return getJson(`/api/xero/organisations/${organisationId}/accounts`).then((b) => b.accounts ?? []);
}

// The expense accounts this entity's claims post INTO — its own chart when it is
// linked to Xero, its PARENT's when it is a bridge entity. Used by the category
// mapping, which is a choice from the ledger that receives the money.
export function useTargetAccounts(organisationId) {
  return useQuery({
    queryKey: ['xero-target-accounts', organisationId],
    queryFn: () => getJson(`/api/xero/organisations/${organisationId}/target-accounts`),
    enabled: Boolean(organisationId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
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
  return pickOrgId(organisations, getActiveOrganisationId(), { xeroOnly: true });
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
  const orgId = pickOrgId(organisations, active, { xeroOnly: true });
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
    return pickOrgId(orgs, getActiveOrganisationId(), { xeroOnly: true });
  } catch {
    return '';
  }
}

// Accounts to classify OCR'd expenses into: the connected org's LIVE Xero
// expense accounts (code/name/description, pulled through the relay), falling
// back to the bundled standard chart when Xero isn't connected. Used at upload
// time, so it must never throw — any failure yields the fallback.
export async function getExtractionAccounts() {
  // A bridge entity has no chart at all — not even the bundled fallback, which
  // would have the reader coding an ST Eng taxi fare to "429 - General
  // Expenses", a code that means nothing to the people reviewing it. Its
  // categories go up instead (getExtractionCategories).
  if (isStandaloneOrg(await activeOrganisationRow())) return [];
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
      // The account's own default tax code in Xero. Not sent to the reader (the
      // server ignores it) — it's for the tax-rate decision afterwards, which
      // follows the account the same way Xero's own UI does.
      taxType: a.taxType || '',
    }));
    return list.length ? list : XERO_ACCOUNTS;
  } catch {
    return XERO_ACCOUNTS;
  }
}

// The plain category names to classify into, for an entity with no chart of
// accounts. Empty for a linked entity — its accounts are the list, and offering
// both would let a document be coded to something that can't reach the ledger.
// Must never throw: any failure yields an empty list and the reader falls back
// to its own defaults.
export async function getExtractionCategories() {
  try {
    if (!isStandaloneOrg(await activeOrganisationRow())) return [];
    return getVisibleCategoryNames();
  } catch {
    return [];
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

// The customers a cost can be recharged to, for the upload path (fetchExtract),
// where hooks aren't available. Capped for the same reason the server caps it: a
// long-lived Xero holds thousands of contacts, and a list that size in the
// prompt costs more than the field is worth. Must never throw — any failure
// yields no options and the Customer field stays for a person to set.
const EXTRACTION_CUSTOMER_LIMIT = 300;

export async function getExtractionCustomers() {
  try {
    const orgId = await resolveCategorisationOrgId();
    if (!orgId) return [];
    const rows = await fetchXeroCustomers(orgId);
    const names = rows.map((c) => String(c?.name || '').trim()).filter(Boolean);
    return names.length > EXTRACTION_CUSTOMER_LIMIT ? [] : names;
  } catch {
    return [];
  }
}

// The project (Xero tracking) options a document can be allocated to, for the
// upload path — EVERY option, each carrying whatever "when to use" rule the org
// has written for it (Lists → Projects). The reader is given the whole list so
// it can allocate a bill the document plainly identifies, and the rules sharpen
// that rather than gate it.
//
// Only the FIRST tracking category is offered, because that is the only one the
// publish path tags a bill with — offering options from the second would let a
// document be allocated to something that never reaches Xero.
export async function getExtractionProjects() {
  const orgId = await resolveCategorisationOrgId();
  if (!orgId) return [];
  let categories = [];
  try {
    categories = await fetchXeroTracking(orgId);
  } catch {
    return [];
  }
  const meta = getMeta('projects');
  const seen = new Set();
  const out = [];
  for (const o of categories[0]?.options ?? []) {
    const name = String(o?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, rules: String(meta[name]?.rules || '').trim() });
  }
  return out;
}

// Category-dropdown options for the active org's live chart (expense accounts),
// with the bundled standard chart as fallback. 'Uncategorised' is always first.
//
// A bridge entity is the exception: it has no chart, so its dropdown is the
// plain list its people maintain in Business settings → Lists → Categories.
export function useCategoryOptions() {
  const { data: organisations = [] } = useOrganisations();
  const active = getActiveOrganisationId();
  const standalone = isStandaloneOrg(organisations.find((o) => o.id === active));
  const orgId = standalone ? '' : pickOrgId(organisations, active, { xeroOnly: true });
  const listNames = useCategoryListOptions();
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
  const labels = standalone
    ? listNames
    : expense.length
      ? expense.map(accountLabel)
      : XERO_ACCOUNTS.map(accountLabel);
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
  const orgId = pickOrgId(organisations, active, { xeroOnly: true });
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

// Send a published document's CURRENT figures to the bill it already created in
// Xero. Same shape as publishing, plus the fact that a bill already exists: the
// server adds the InvoiceID that makes Xero update rather than create.
export async function updateBillInXero(organisationId, payload) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/update-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(
      Array.isArray(body.messages) ? body.messages.join(' ') : body.message || 'Update failed.'
    ));
    err.code = body.error;
    throw err;
  }
  return body;
}

// Ask Xero about every bill this entity has published, and record what it says
// (status, paid date, payment reference). The webhook only hears about what
// changes after it was configured, so this is what catches up the bills paid
// before it existed — and the repair for any delivery Xero dropped.
export async function syncXeroPayments(organisationId) {
  const res = await fetch(`/api/xero/organisations/${organisationId}/sync-payments`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(body.message || 'Could not check payment status in Xero.'));
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
