// Business-settings "Lists" — Categories, Tax rates, and Projects. Seeded from
// the client's Dext export (see below) and persisted in localStorage. Categories
// and Projects feed the Costs/Sales dropdowns; everything the user adds/edits or
// hides here is layered over the seed.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

const KEY = 'cybills.lists.v1';
export const LISTS_EVENT = 'cybills:lists-changed';
const emit = () => window.dispatchEvent(new Event(LISTS_EVENT));
const store = blobStore(KEY, { added: {}, hidden: {}, meta: {} }, emit);

// --- Seeds (from the client's ST Eng workspace) -----------------------------
export const SEED_CATEGORIES = [
  'Offshore L.H (overnight)', 'Meal Weekday (after 9pm)', 'Transport -Claim by mileage',
  'Standby Allowance', 'Offshore H.S per trip', 'Offshore L.S (overnight)', 'Meal Weekend & PH',
  'Offshore L.H per trip', 'Transport - Taxi', 'Parking', 'Recall Allowance - Weekday',
  'Transport - Train', 'Transport - Bus', 'ERP - Cashcard', 'Recall Allowance - Weekend Crossover',
  'Recall Allowance - Weekend/PH', 'Transport - Ferry', 'Recall Allowance - weekday over cross midnight',
  "Contractor's pass fee", 'PPE Safety', 'Courses/Workshop/Training Fees', 'Transport - Flights', 'Others',
].map((name) => ({ name, code: '' }));

export const SEED_TAX_RATES = [
  ['2023 Bad Debt Recovery', 'BADDEBTRECOVERYY23', 8.0],
  ['Bad Debt Recovery', 'BADDEBTRECOVERYY24', 9.0],
  ['2023 Bad Debt Relief', 'BADDEBTRELIEFY23', 8.0],
  ['Bad Debt Relief', 'BADDEBTRELIEFY24', 9.0],
  ['Disallowed Expenses', 'BLINPUT2', 0.0],
  ['Deemed Supplies', 'DSOUTPUTY24', 9.0],
  ['Exempt Purchases', 'EPINPUT', 0.0],
  ['2022 Standard-Rated Purchases', 'INPUT', 7.0],
  ['2023 Standard-Rated Purchases', 'INPUTY23', 8.0],
  ['Standard-Rated Purchases', 'INPUTY24', 9.0],
  ['No Tax', 'NONE', 0.0],
  ['Out Of Scope Purchases', 'OPINPUT', 0.0],
  ['Out Of Scope Supplies', 'OSOUTPUT2', 0.0],
  ['2022 Standard-Rated Supplies', 'OUTPUT', 7.0],
  ['2023 Standard-Rated Supplies', 'OUTPUTY23', 8.0],
  ['Standard-Rated Supplies', 'OUTPUTY24', 9.0],
  ['2022 Customer Accounting Purchases', 'TXCA', 0.0],
  ['2023 Customer Accounting Purchases', 'TXCAY23', 0.0],
  ['Customer Accounting Purchases', 'TXCAY24', 0.0],
  ['Zero-Rated Purchases', 'ZERORATEDINPUT', 0.0],
  ['Zero-Rated Supplies', 'ZERORATEDOUTPUT', 0.0],
].map(([name, code, rate]) => ({ name, id: code, code, rate }));

export const SEED_PROJECTS = [
  'ASTP 01', 'ASTP 02', 'ASTP 03', 'ASTP 04', 'ASTP 05', 'ASTP 06', 'ASTP 07', 'ASTP 08',
  'Admin', 'ESTP 01', 'ESTP 02', 'ESTP 03', 'Project', 'Red Alpha LLC',
].map((name) => ({ name }));

let seq = 0;
const genId = (p) => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;

function read() {
  return { added: {}, hidden: {}, meta: {}, ...(store.get() || {}) };
}
function write(state) {
  store.set(state);
  emit();
}

// Generic list access: `kind` is 'categories' | 'taxRates' | 'projects'.
const SEEDS = { categories: SEED_CATEGORIES, taxRates: SEED_TAX_RATES, projects: SEED_PROJECTS };

// Stable id for a seed row (seeds have no stored id): "<kind>:<name>".
const seedId = (kind, row) => `${kind}:${row.name}`;

export function getList(kind) {
  const { added, hidden } = read();
  const hiddenSet = new Set(hidden[kind] || []);
  const seed = SEEDS[kind].map((row) => ({ ...row, id: row.id || seedId(kind, row), seed: true }));
  const userAdded = (added[kind] || []).map((row) => ({ ...row, seed: false }));
  return [...seed, ...userAdded].map((row) => ({ ...row, visible: !hiddenSet.has(row.id) }));
}

export function addToList(kind, row) {
  const state = read();
  const added = { ...(state.added || {}) };
  added[kind] = [...(added[kind] || []), { ...row, id: genId(kind) }];
  write({ ...state, added });
}

export function removeFromList(kind, ids) {
  const state = read();
  const set = new Set(ids);
  const added = { ...(state.added || {}) };
  added[kind] = (added[kind] || []).filter((r) => !set.has(r.id));
  // Seed rows can't be deleted outright — hide them instead.
  const hidden = { ...(state.hidden || {}) };
  hidden[kind] = [...new Set([...(hidden[kind] || []), ...ids])];
  write({ ...state, added, hidden });
}

// The hidden-id set for a list kind (ids the user switched off). Used by the
// live-Xero-backed tax-rate list so the picker and Lists page share one source.
export function getHiddenSet(kind) {
  return new Set(read().hidden[kind] || []);
}
// Reactive form of getHiddenSet, for views built on a LIVE Xero list (categories,
// tax rates) rather than on getList().
export function useHiddenSet(kind) {
  const [set, setSet] = useState(() => getHiddenSet(kind));
  useEffect(() => {
    const sync = () => setSet(getHiddenSet(kind));
    window.addEventListener(LISTS_EVENT, sync);
    return () => window.removeEventListener(LISTS_EVENT, sync);
  }, [kind]);
  return set;
}

// User-added rows for a list kind (not from the seed / Xero).
export function getAddedRows(kind) {
  return read().added[kind] || [];
}

// Per-row extras that CYBills owns rather than Xero — today just a tax rate's
// "when to use" rules. Keyed by row id (for tax rates that's the rate NAME, the
// same key the hidden-set uses), so a rule survives the live Xero list being
// refetched and reordered.
export function getMeta(kind) {
  return read().meta?.[kind] || {};
}

export function setMetaField(kind, id, field, value) {
  const state = read();
  const meta = { ...(state.meta || {}) };
  const forKind = { ...(meta[kind] || {}) };
  const row = { ...(forKind[id] || {}), [field]: value };
  // Don't accumulate empty rows — a cleared rule removes the entry entirely.
  if (Object.values(row).every((v) => !String(v ?? '').trim())) delete forKind[id];
  else forKind[id] = row;
  meta[kind] = forKind;
  write({ ...state, meta });
}

export function setListVisible(kind, id, visible) {
  const state = read();
  const hidden = { ...(state.hidden || {}) };
  const set = new Set(hidden[kind] || []);
  if (visible) set.delete(id);
  else set.add(id);
  hidden[kind] = [...set];
  write({ ...state, hidden });
}

export function useList(kind) {
  const [list, setList] = useState(() => getList(kind));
  useEffect(() => {
    const sync = () => setList(getList(kind));
    window.addEventListener(LISTS_EVENT, sync);
    return () => window.removeEventListener(LISTS_EVENT, sync);
  }, [kind]);
  return list;
}

// Visible names for the dropdowns.
export function getVisibleCategoryNames() {
  return getList('categories').filter((c) => c.visible).map((c) => c.name);
}
export function getVisibleProjectNames() {
  return getList('projects').filter((p) => p.visible).map((p) => p.name);
}
export function useProjectOptions() {
  const list = useList('projects');
  return list.filter((p) => p.visible).map((p) => p.name);
}
export function useCategoryListOptions() {
  const list = useList('categories');
  return list.filter((c) => c.visible).map((c) => c.name);
}
