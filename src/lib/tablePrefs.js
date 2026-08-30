import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';

// Which columns a document table shows, and how tightly it packs them —
// Dext's table settings (the gear beside the search box). A display
// preference, so it stays workspace-wide rather than per organisation.

const KEY = 'cybills.table-prefs.v1';
export const TABLE_PREFS_EVENT = 'cybills:table-prefs-changed';

export const DENSITIES = ['Wide', 'Medium', 'Narrow'];

// Row padding + type size per density. Applied to every cell in the body.
export const DENSITY_CLASS = {
  Wide: 'px-3 py-4 text-sm',
  Medium: 'px-3 py-3 text-sm',
  Narrow: 'px-3 py-1.5 text-xs',
};

// The Costs/Sales table's columns. `primary` ones are on by default and sit at
// the top of the panel; the rest are opt-in extras. Only fields a document
// actually carries are offered — an empty column nobody can fill is worse than
// no column.
//
// `width` is the column's own share of the row, and it is here rather than left
// to the browser because an auto-layout table hands the space to whatever
// REFUSES to shrink. Almost every cell here is `whitespace-nowrap` — a badge, a
// date, a dropdown — so they each held their full width while Supplier, the one
// column made of ordinary wrapping prose, was squeezed down to its longest
// single word: "Microsoft Regional Sales Pte Ltd" broken over four lines beside
// a Status column with room to spare. The widths are preferences, not a fixed
// layout: a column whose content genuinely needs more still takes it.
export const COST_COLUMNS = [
  // Wide enough for "Published to Xero"; the review badges below it wrap.
  { key: 'status', label: 'Status', primary: true, fixed: true, width: 'w-[150px]' },
  { key: 'user', label: 'User', primary: true, width: 'w-[120px]' },
  { key: 'date', label: 'Date', primary: true, width: 'w-[110px]' },
  // The widest of them, and the one that was starved: a supplier's registered
  // name runs to five or six words and is what the reviewer reads the row by.
  { key: 'supplier', label: 'Supplier', primary: true, width: 'w-[220px]' },
  // The dropdown inside is w-44 (176px) + the cell's own px-3 either side.
  { key: 'category', label: 'Category', primary: true, width: 'w-[200px]' },
  { key: 'total', label: 'Total', primary: true, width: 'w-[110px]' },
  { key: 'tax', label: 'Tax', primary: true, width: 'w-[80px]' },
  // …and this one is w-36 (144px) + px-3 either side.
  { key: 'taxRate', label: 'Tax rate', primary: true, width: 'w-[170px]' },
  { key: 'ref', label: 'Document reference', width: 'w-[170px]' },
  { key: 'description', label: 'Description', width: 'w-[260px]' },
  { key: 'itemId', label: 'Item ID', width: 'w-[130px]' },
  { key: 'type', label: 'Type', width: 'w-[110px]' },
  { key: 'dueDate', label: 'Due date', width: 'w-[110px]' },
  // Xero's answer, on by default: a published bill being settled is the thing
  // the reviewer is waiting to see, and it used to be invisible unless somebody
  // knew to switch a column on. `paid` below stays opt-in — it is the capture
  // flag, not the ledger (src/lib/xeroPaidStatus.js).
  { key: 'xeroPaid', label: 'Paid status', primary: true, width: 'w-[120px]' },
  // The date beside the status, on by default with it: "Paid" answers whether,
  // and the next question is always when — a tooltip made that a hover away.
  { key: 'paidDate', label: 'Paid date', primary: true, width: 'w-[110px]' },
  { key: 'paymentRef', label: 'Payment reference', width: 'w-[180px]' },
  { key: 'paid', label: 'Paid', width: 'w-[90px]' },
  { key: 'paymentMethod', label: 'Payment method', width: 'w-[150px]' },
  { key: 'customer', label: 'Customer', width: 'w-[170px]' },
  { key: 'project', label: 'Project', width: 'w-[150px]' },
  { key: 'cardLast4', label: 'Card', width: 'w-[100px]' },
  { key: 'note', label: 'Note', width: 'w-[200px]' },
  { key: 'uploadDate', label: 'Upload date', width: 'w-[120px]' },
  { key: 'publishDate', label: 'Publish date', width: 'w-[120px]' },
  { key: 'xero', label: 'Xero', width: 'w-[80px]' },
];

// An expense claim's line items. The same idea as the Costs table's gear, over
// the fields a claim transaction actually carries — everything else about the
// document lives on its own page, one click away through the row.
export const CLAIM_COLUMNS = [
  { key: 'status', label: 'Status', primary: true, fixed: true },
  { key: 'supplier', label: 'Supplier', primary: true },
  { key: 'date', label: 'Date', primary: true },
  { key: 'category', label: 'Category', primary: true },
  { key: 'description', label: 'Description', primary: true },
  { key: 'net', label: 'Net', primary: true },
  { key: 'tax', label: 'Tax', primary: true },
  { key: 'total', label: 'Total', primary: true },
  { key: 'itemId', label: 'Item ID' },
  { key: 'user', label: 'User' },
  { key: 'project', label: 'PIC' },
];

const defaultsFor = (columns) =>
  Object.fromEntries(columns.map((c) => [c.key, Boolean(c.primary)]));

export const DEFAULT_TABLE_PREFS = {
  costs: { columns: defaultsFor(COST_COLUMNS), density: 'Medium' },
  claimItems: { columns: defaultsFor(CLAIM_COLUMNS), density: 'Medium' },
};

const emit = () => window.dispatchEvent(new Event(TABLE_PREFS_EVENT));
const store = blobStore(KEY, DEFAULT_TABLE_PREFS, emit);

export function getTablePrefs(table = 'costs') {
  const base = DEFAULT_TABLE_PREFS[table] ?? DEFAULT_TABLE_PREFS.costs;
  const saved = (store.get() || {})[table] || {};
  return {
    density: DENSITIES.includes(saved.density) ? saved.density : base.density,
    // Spread over the defaults so a column added in a later release shows up
    // rather than being treated as switched off.
    columns: { ...base.columns, ...(saved.columns || {}) },
  };
}

export function saveTablePrefs(table, prefs) {
  store.set({ ...(store.get() || {}), [table]: prefs });
  emit();
}

export function resetTablePrefs(table) {
  saveTablePrefs(table, DEFAULT_TABLE_PREFS[table] ?? DEFAULT_TABLE_PREFS.costs);
}

export function useTablePrefs(table = 'costs') {
  const [prefs, setPrefs] = useState(() => getTablePrefs(table));
  useEffect(() => {
    const sync = () => setPrefs(getTablePrefs(table));
    window.addEventListener(TABLE_PREFS_EVENT, sync);
    return () => window.removeEventListener(TABLE_PREFS_EVENT, sync);
  }, [table]);
  return prefs;
}
