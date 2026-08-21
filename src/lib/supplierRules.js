// Per-supplier Category/Customer defaults set on the Suppliers list, persisted
// in localStorage. Keyed by supplier id.

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
