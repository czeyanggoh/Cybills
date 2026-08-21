// Per-customer rules for Sales, persisted in localStorage. A rule captures the
// defaults Dext applies whenever a new document arrives from that customer
// (currency, category, due-date terms, project, line-item handling, smart-split
// line rules). Keyed by the normalised customer name.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

const KEY = 'cybills.customer.rules.v1';
export const CUSTOMER_RULES_EVENT = 'cybills:customer-rules-changed';
const emit = () => window.dispatchEvent(new Event(CUSTOMER_RULES_EVENT));
const store = blobStore(KEY, {}, emit, { perOrg: true });

function normName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function readAll() {
  return store.get() || {};
}
function writeAll(map) {
  store.set(map);
  emit();
}

// Re-render a component when rules change / hydrate (for render-time readers
// like the Customers list). Sync getters still work off the in-memory cache.
export function useCustomerRulesVersion() {
  const [v, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(CUSTOMER_RULES_EVENT, sync);
    return () => window.removeEventListener(CUSTOMER_RULES_EVENT, sync);
  }, []);
  return v;
}

// A blank rule — the shape every consumer can rely on.
export function emptyRule() {
  return {
    currency: '',
    category: '',
    dueMode: '',
    dueDays: '',
    project: '',
    extractLineItems: false,
    groupBy: 'Do not group',
    autoBalancing: false,
    description: '',
    smartSplit: { fixed: [], percentage: [] },
  };
}

export function getCustomerRule(name) {
  const key = normName(name);
  if (!key) return null;
  return readAll()[key] || null;
}

export function saveCustomerRule(name, rule) {
  const key = normName(name);
  if (!key) return;
  const map = readAll();
  map[key] = { ...emptyRule(), ...rule };
  writeAll(map);
}

export function hasCustomerRule(name) {
  return Boolean(getCustomerRule(name));
}

// Currencies offered in the rule editor (code + friendly label).
export const CURRENCIES = [
  { code: 'SGD', label: 'SGD — Singapore, Dollars' },
  { code: 'USD', label: 'USD — US Dollars' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'MYR', label: 'MYR — Malaysian Ringgit' },
  { code: 'AUD', label: 'AUD — Australian Dollars' },
];
export function currencyLabel(code) {
  return CURRENCIES.find((c) => c.code === code)?.label || code || '';
}

// Due-date term options (mirrors Dext). The `days` ones take a number.
export const DUE_DATE_OPTIONS = [
  { value: '', label: '— None —', needsDays: false },
  { value: 'current_month', label: 'of current month', needsDays: false },
  { value: 'following_month', label: 'of following month', needsDays: false },
  { value: 'days_after_invoice', label: 'days after invoice date', needsDays: true },
  { value: 'days_after_month_end', label: 'days after the end of the invoice month', needsDays: true },
];

export const GROUP_BY_OPTIONS = ['Do not group', 'Category', 'Tax rate'];

// Sample project list (matches the ST Eng workspace in the reference).
export const PROJECTS = ['ASTP 01', 'ASTP 02', 'ASTP 03', 'ASTP 04', 'ASTP 05', 'ASTP 06', 'ASTP 07', 'ASTP 08'];
