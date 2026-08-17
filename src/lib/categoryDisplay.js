import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// How cost categories are shown AND ordered in the dropdowns — configured in
// Business settings → Automation → Categorisation ("Category display" +
// "Category sort"). Only the DISPLAY/ORDER changes; the stored value stays the
// full "412 - Consulting & Accounting" label (so the Xero code and GL
// derivation keep working).

const KEY = 'cybills.category-display.v1';
export const CATEGORY_DISPLAY_EVENT = 'cybills:category-display-changed';
// mode: 'codeName' | 'code' | 'name'   sort: 'code' | 'name'
export const DEFAULT_CATEGORY_DISPLAY = { mode: 'codeName', sort: 'code' };

const emit = () => window.dispatchEvent(new Event(CATEGORY_DISPLAY_EVENT));
const store = blobStore(KEY, DEFAULT_CATEGORY_DISPLAY, emit);

function settings() {
  const v = store.get() || {};
  return { ...DEFAULT_CATEGORY_DISPLAY, ...v };
}

export function getCategoryDisplayMode() {
  return settings().mode;
}

export function setCategoryDisplayMode(mode) {
  store.set({ ...settings(), mode });
  emit();
}

export function getCategorySortMode() {
  return settings().sort;
}

export function setCategorySortMode(sort) {
  store.set({ ...settings(), sort });
  emit();
}

// Transform a "412 - Consulting & Accounting" label for display. Free-text
// categories with no " - " (e.g. "Uncategorised") pass through unchanged.
export function formatCategory(label, mode = getCategoryDisplayMode()) {
  const s = String(label ?? '');
  const idx = s.indexOf(' - ');
  if (idx === -1) return s;
  if (mode === 'code') return s.slice(0, idx);
  if (mode === 'name') return s.slice(idx + 3);
  return s;
}

const codeOf = (s) => { const i = s.indexOf(' - '); return i === -1 ? '' : s.slice(0, i); };
const nameOf = (s) => { const i = s.indexOf(' - '); return i === -1 ? s : s.slice(i + 3); };

// Order category labels by code (numeric-aware, blanks last) or by name.
// Free-text categories with no code sort to the end under "Code".
export function sortCategories(labels, sort = getCategorySortMode()) {
  const arr = [...labels];
  if (sort === 'name') {
    return arr.sort((a, b) => nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()));
  }
  return arr.sort((a, b) => {
    const ca = codeOf(a);
    const cb = codeOf(b);
    if (!ca && !cb) return a.toLowerCase().localeCompare(b.toLowerCase());
    if (!ca) return 1;
    if (!cb) return -1;
    return ca.localeCompare(cb, undefined, { numeric: true });
  });
}

// Reactive read of the current display mode (re-renders on change).
export function useCategoryDisplayMode() {
  const [mode, setMode] = useState(getCategoryDisplayMode);
  useEffect(() => {
    const sync = () => setMode(getCategoryDisplayMode());
    window.addEventListener(CATEGORY_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(CATEGORY_DISPLAY_EVENT, sync);
  }, []);
  return mode;
}

// Reactive read of the current sort mode (re-renders on change).
export function useCategorySortMode() {
  const [sort, setSort] = useState(getCategorySortMode);
  useEffect(() => {
    const sync = () => setSort(getCategorySortMode());
    window.addEventListener(CATEGORY_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(CATEGORY_DISPLAY_EVENT, sync);
  }, []);
  return sort;
}
