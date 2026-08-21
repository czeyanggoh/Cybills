// User-added categories, persisted in localStorage. These are merged into every
// category dropdown (Costs, Sales, customer rules) on top of the Xero chart of
// accounts, so a category added on one document is available everywhere.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

const KEY = 'cybills.custom.categories.v1';
export const CUSTOM_CATEGORIES_EVENT = 'cybills:custom-categories-changed';
const emit = () => window.dispatchEvent(new Event(CUSTOM_CATEGORIES_EVENT));
const store = blobStore(KEY, [], emit, { perOrg: true });

function readAll() {
  const v = store.get();
  return Array.isArray(v) ? v : [];
}
function writeAll(list) {
  store.set(list);
  emit();
}

// The display label: "<code> - <name>" when a code is given (matching the Xero
// account label format), else just the name.
export function categoryLabel(name, code) {
  const n = String(name || '').trim();
  const c = String(code || '').trim();
  return c ? `${c} - ${n}` : n;
}

export function getCustomCategories() {
  return readAll();
}

// Add a category. Returns its label, or '' if the name was blank or it already
// exists.
export function addCustomCategory(name, code) {
  const label = categoryLabel(name, code);
  if (!label) return '';
  const list = readAll();
  if (list.some((c) => c.label === label)) return label;
  writeAll([...list, { name: String(name).trim(), code: String(code || '').trim(), label }]);
  return label;
}

// Subscribe a component to the custom-category list.
export function useCustomCategories() {
  const [list, setList] = useState(getCustomCategories);
  useEffect(() => {
    const sync = () => setList(getCustomCategories());
    window.addEventListener(CUSTOM_CATEGORIES_EVENT, sync);
    return () => window.removeEventListener(CUSTOM_CATEGORIES_EVENT, sync);
  }, []);
  return list;
}
