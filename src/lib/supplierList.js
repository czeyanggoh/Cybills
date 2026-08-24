// Which suppliers the Suppliers list shows.
//
// The names themselves come from the linked org's Xero contacts, which CYBills
// reads and never writes — so "Delete" here cannot mean "delete the contact in
// Xero", and merging two spellings cannot rename a Xero contact either. What it
// CAN own is this list: the names removed from view, kept locally per entity.
//
// That is what makes Delete and Merge honest rather than decorative. A contact
// list imported from years of bookkeeping carries the same supplier under three
// spellings ("ACCOUNTING AND CORPORATE REGULATORY AUTHORITY", "Accouting And
// Corporate Regulatory Authority", "ACRA"); the documents are re-pointed at one
// of them and the other spellings stop cluttering every picker. Nothing is
// destroyed: a removed name is restored from the toolbar.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

const KEY = 'cybills.supplier-list.v1';
export const SUPPLIER_LIST_EVENT = 'cybills:supplier-list-changed';
const emit = () => window.dispatchEvent(new Event(SUPPLIER_LIST_EVENT));
const store = blobStore(KEY, { removed: [] }, emit, { perOrg: true });

const norm = (name) => String(name || '').trim().toLowerCase();

// Whatever the stored blob actually holds. A blob written by an older shape (or
// a stored `removed: null`) must read as "nothing removed" rather than throw —
// this list is the whole Suppliers page, so a bad value would white-screen it.
function read() {
  const saved = store.get();
  const v = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return { removed: Array.isArray(v.removed) ? v.removed.map(String) : [] };
}

export function removedSuppliers() {
  return read().removed;
}

// Matched case-insensitively: the name a rule or a document carries won't always
// be byte-identical to the Xero contact it came from.
export function removedSupplierSet() {
  return new Set(read().removed.map(norm));
}

export function removeSuppliers(names) {
  const add = (Array.isArray(names) ? names : [names]).map(String).filter((n) => n.trim());
  if (!add.length) return;
  const seen = new Set(read().removed.map(norm));
  const next = [...read().removed];
  for (const n of add) {
    if (seen.has(norm(n))) continue;
    seen.add(norm(n));
    next.push(n.trim());
  }
  store.set({ removed: next });
  emit();
}

// Put names back on the list. No argument restores every removed supplier.
export function restoreSuppliers(names) {
  if (names === undefined) {
    store.set({ removed: [] });
    emit();
    return;
  }
  const drop = new Set((Array.isArray(names) ? names : [names]).map(norm));
  store.set({ removed: read().removed.filter((n) => !drop.has(norm(n))) });
  emit();
}

// Re-render when the list changes / hydrates. The getters above stay synchronous
// off the in-memory cache, the same way the rules store works.
export function useSupplierList() {
  const [v, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(SUPPLIER_LIST_EVENT, sync);
    return () => window.removeEventListener(SUPPLIER_LIST_EVENT, sync);
  }, []);
  return v;
}
