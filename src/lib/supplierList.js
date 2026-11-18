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
    added: Array.isArray(v.added) ? v.added.map(String) : [],
    notDuplicates: Array.isArray(v.notDuplicates) ? v.notDuplicates.map(String) : [],
    merged: v.merged && typeof v.merged === 'object' && !Array.isArray(v.merged) ? { ...v.merged } : {},
  };
}

// --- Suppliers this entity added itself --------------------------------------
// A CSV import is how a supplier list arrives when there is no Xero to read one
// from — which is every bridge entity. Without this the import could set each
// supplier's standing rules and yet leave the list empty, because the names had
// nowhere to live: a rule for a supplier the page never shows.

export function addedSuppliers() {
  return read().added;
}

export function addSuppliers(names) {
  const wanted = (Array.isArray(names) ? names : [names]).map(String).filter((n) => n.trim());
  if (!wanted.length) return 0;
  const state = read();
  const seen = new Set(state.added.map(norm));
  const next = [...state.added];
  let added = 0;
  for (const n of wanted) {
    if (seen.has(norm(n))) continue;
    seen.add(norm(n));
    next.push(n.trim());
    added += 1;
  }
  if (!added) return 0;
  store.set({ ...state, added: next });
  emit();
  return added;
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

// --- Where a merged name went ------------------------------------------------
// A merge removes the spellings it folded away, and also remembers which name
// they were folded INTO, keyed by the lower-cased spelling: { "xero (nz) ltd":
// "Xero (NZ) Limited" }. That is what lets the next document read as "Xero
// (NZ) Ltd" be filed under the kept name instead of bringing the merged-away
// spelling back (supplierCanonical.js, applied server-side to every read).
// A name merged into one that is itself merged later follows it there.
export function mergedSuppliers() {
  return read().merged;
}

export function recordSupplierMerge(names, keep) {
  const target = String(keep || '').trim();
  const gone = (Array.isArray(names) ? names : [names]).map(String).filter((n) => n.trim());
  if (!target || !gone.length) return;
  const state = read();
  const goneKeys = new Set(gone.map(norm));
  const merged = {};
  // Anything already pointing at a name merged away now points at the keeper.
  for (const [from, to] of Object.entries(state.merged)) {
    if (norm(from) === norm(target)) continue; // the keeper is live again
    merged[from] = goneKeys.has(norm(to)) ? target : to;
  }
  for (const k of goneKeys) if (k !== norm(target)) merged[k] = target;
  store.set({ ...state, merged });
  emit();
}

// The names a supplier PICKER offers: everything but what was removed or merged
// away on the Suppliers page. The page hides them; without this every other
// picker went on offering the spellings somebody had just merged.
export function withoutRemovedSuppliers(names) {
  const removed = removedSupplierSet();
  return (names || []).filter((n) => !removed.has(norm(n)));
}

// Put names back on the list. No argument restores every removed supplier.
// A restored name is no longer merged into anything either.
export function restoreSuppliers(names) {
  const state = read();
  if (names === undefined) {
    store.set({ ...state, removed: [], merged: {} });
    emit();
    return;
  }
  const drop = new Set((Array.isArray(names) ? names : [names]).map(norm));
  const merged = Object.fromEntries(Object.entries(state.merged).filter(([from]) => !drop.has(norm(from))));
  store.set({ ...state, removed: state.removed.filter((n) => !drop.has(norm(n))), merged });
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
