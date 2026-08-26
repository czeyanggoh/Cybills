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
const store = blobStore(KEY, { removed: [], notDuplicates: [] }, emit, { perOrg: true });

const norm = (name) => String(name || '').trim().toLowerCase();

// Whatever the stored blob actually holds. A blob written by an older shape (or
// a stored `removed: null`) must read as "nothing removed" rather than throw —
// this list is the whole Suppliers page, so a bad value would white-screen it.
function read() {
  const saved = store.get();
  const v = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return {
    removed: Array.isArray(v.removed) ? v.removed.map(String) : [],
    notDuplicates: Array.isArray(v.notDuplicates) ? v.notDuplicates.map(String) : [],
  };
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
  const state = read();
  const seen = new Set(state.removed.map(norm));
  const next = [...state.removed];
  for (const n of add) {
    if (seen.has(norm(n))) continue;
    seen.add(norm(n));
    next.push(n.trim());
  }
  store.set({ ...state, removed: next });
  emit();
}

// --- "Not a duplicate" -------------------------------------------------------
// A reviewer's verdict that two names are genuinely different suppliers, kept
// against the PAIR rather than the suggested group: a group is only ever built
// out of pairs, so rejecting the pairs stops a third name quietly re-forming it.

export function dismissedDuplicatePairs() {
  return new Set(read().notDuplicates);
}

export function dismissDuplicatePairs(keys) {
  const add = (Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean);
  if (!add.length) return;
  const state = read();
  const next = [...new Set([...state.notDuplicates, ...add])];
  store.set({ ...state, notDuplicates: next });
  emit();
}

export function dismissedDuplicateCount() {
  return read().notDuplicates.length;
}

// Put every rejected pairing back up for review.
export function restoreDuplicateSuggestions() {
  const state = read();
  store.set({ ...state, notDuplicates: [] });
  emit();
}

// Put names back on the list. No argument restores every removed supplier.
export function restoreSuppliers(names) {
  const state = read();
  if (names === undefined) {
    store.set({ ...state, removed: [] });
    emit();
    return;
  }
  const drop = new Set((Array.isArray(names) ? names : [names]).map(norm));
  store.set({ ...state, removed: state.removed.filter((n) => !drop.has(norm(n))) });
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

// Every supplier this entity can name, A→Z.
//
// The Xero contact list is only half of it — and for a bridge entity it is none
// of it, since there is no Xero to ask. The other half is the merchants its own
// documents already name: Grab, a food court, a carpark. Those are exactly the
// "suppliers" the people claiming here deal with, and they are never contacts
// in anybody's ledger, because the bill that eventually posts is payable to the
// CLAIMANT, not to the merchant.
//
// Case-insensitive, first spelling wins, and anything removed from the list
// stays removed however it got here.
export function mergeSupplierNames(fromXero, fromDocuments) {
  const seen = new Set();
  const out = [];
  for (const name of [...(fromXero || []), ...(fromDocuments || [])]) {
    const clean = String(name || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// The supplier names appearing on a set of documents.
export function supplierNamesFromDocs(docs) {
  return mergeSupplierNames([], (docs || []).map((d) => d?.supplier));
}
