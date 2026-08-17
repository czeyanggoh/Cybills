import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// How cost categories are shown in the dropdowns — configured in
// Business settings → Automation → Categorisation → "Category display".
// Only the DISPLAY changes; the stored value stays the full "412 - Consulting &
// Accounting" label (so the Xero code and GL derivation keep working).

const KEY = 'cybills.category-display.v1';
export const CATEGORY_DISPLAY_EVENT = 'cybills:category-display-changed';
export const DEFAULT_CATEGORY_DISPLAY = { mode: 'codeName' }; // 'codeName' | 'code' | 'name'

const emit = () => window.dispatchEvent(new Event(CATEGORY_DISPLAY_EVENT));
const store = blobStore(KEY, DEFAULT_CATEGORY_DISPLAY, emit);

export function getCategoryDisplayMode() {
  const v = store.get();
  return (v && v.mode) || DEFAULT_CATEGORY_DISPLAY.mode;
}

export function setCategoryDisplayMode(mode) {
  store.set({ mode });
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
