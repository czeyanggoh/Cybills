// Per-supplier defaults set on the Suppliers list — Category, Customer and
// Project. Keyed by the supplier's name (the Suppliers list uses the Xero
// contact name as its id), so a document's read supplier resolves straight to
// its rule. Applied when a document is read: a rule here is an instruction, so
// it outranks anything the reader worked out for itself.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

const KEY = 'cybills.supplier.rules.v1';
export const SUPPLIER_RULES_EVENT = 'cybills:supplier-rules-changed';
const emit = () => window.dispatchEvent(new Event(SUPPLIER_RULES_EVENT));
const store = blobStore(KEY, {}, emit, { perOrg: true });

function read() {
  return store.get() || {};
}
function write(map) {
  store.set(map);
  emit();
}

export function getSupplierRule(id) {
  return read()[id] || {};
}

// The rule for a supplier NAME as read off a document — matched without regard
// to case or surrounding space, since the reader's spelling won't always be
// byte-identical to the Xero contact it was stored under.
export function matchSupplierRule(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return {};
  const map = read();
  if (map[name]) return map[name];
  const hit = Object.keys(map).find((k) => String(k).trim().toLowerCase() === key);
  return hit ? map[hit] : {};
}
export function setSupplierRule(id, patch) {
  const map = read();
  map[id] = { ...(map[id] || {}), ...patch };
  write(map);
}

export function useSupplierRules() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(SUPPLIER_RULES_EVENT, sync);
    return () => window.removeEventListener(SUPPLIER_RULES_EVENT, sync);
  }, []);
}
