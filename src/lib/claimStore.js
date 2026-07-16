import { useState, useEffect } from 'react';
import { CLAIMS as BASE } from '@/data/claims';

// Client-side persistence for expense claims. The seeded claims live in
// src/data/claims.js; this layer adds (a) cost items the user attaches to a
// claim via "Add to expense claim", and (b) claims created on the fly. Both are
// kept in localStorage and merged on top of the seed data so the claim views
// and PDF reflect them. Real claim persistence would move server-side later.

const ITEMS_KEY = 'cybills.claims.items.v1';
const CREATED_KEY = 'cybills.claims.created.v1';
export const CLAIMS_EVENT = 'cybills:claims-changed';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(CLAIMS_EVENT));
}

// itemId -> claimId links, stored as { [claimId]: [txn, …] }.
export function getAddedItems() {
  return read(ITEMS_KEY) || {};
}
export function getCreatedClaims() {
  return read(CREATED_KEY) || [];
}

function rollups(txns) {
  const sum = (k) => txns.reduce((n, t) => n + Number(t[k] || 0), 0).toFixed(2);
  return { net: sum('net'), tax: sum('tax'), total: sum('total') };
}

// Fold any attached items into a claim, recompute its net/tax/total, and add a
// history entry per attached item so the History tab + PDF stay accurate.
function withItems(claim, itemsMap) {
  const extra = itemsMap[claim.id] || [];
  const seen = new Set(claim.transactions.map((t) => t.itemId));
  const fresh = extra.filter((t) => !seen.has(t.itemId));
  const transactions = [...claim.transactions, ...fresh];
  const addedEvents = fresh.map((t) => ({
    text: `Item ${t.itemId} was added to the expense claim`,
    by: t.addedBy || 'Astrid Yang',
    at: 'Just now',
  }));
  return {
    ...claim,
    transactions,
    history: [...addedEvents, ...(claim.history || [])],
    ...rollups(transactions),
  };
}

export function getAllClaims() {
  const itemsMap = getAddedItems();
  return [...BASE, ...getCreatedClaims()].map((c) => withItems(c, itemsMap));
}

export function getClaimById(id) {
  return getAllClaims().find((c) => String(c.id) === String(id)) || null;
}

// Attach a cost item (transaction shape) to a claim. Idempotent per itemId.
export function addItemToClaim(claimId, txn) {
  const map = getAddedItems();
  const list = map[claimId] || [];
  if (!list.some((t) => t.itemId === txn.itemId)) {
    map[claimId] = [...list, txn];
    write(ITEMS_KEY, map);
  }
}

// Create a new (empty) claim and return it.
export function createClaim({ claimFor, name, endDate }) {
  const created = getCreatedClaims();
  const id = String(Date.now());
  const owner = claimFor || 'Astrid Yang';
  const claim = {
    id,
    claimFor: owner,
    type: 'Regular',
    name: name || 'Expense claim',
    claimDate: endDate || '',
    endDate: endDate || '',
    currency: 'SGD',
    net: '0.00',
    tax: '0.00',
    total: '0.00',
    transactions: [],
    history: [{ text: 'This expense claim was created', by: owner, at: 'Just now' }],
  };
  write(CREATED_KEY, [...created, claim]);
  return claim;
}

// Build a claim transaction row from a cost document's edited fields.
export function docToClaimTxn(doc, data) {
  const total = Number(data.total) || 0;
  const tax = Number(data.tax) || 0;
  return {
    itemId: doc.id,
    date: data.date || '—',
    supplier: data.supplier || 'Unknown supplier',
    category: data.category || 'Uncategorised',
    project: '',
    net: (total - tax).toFixed(2),
    tax: tax.toFixed(2),
    total: total.toFixed(2),
    status: 'ready',
    addedBy: data.user || 'Astrid Yang',
  };
}

// Reactive read of all claims (re-renders on any claim mutation).
export function useClaims() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(CLAIMS_EVENT, sync);
    return () => window.removeEventListener(CLAIMS_EVENT, sync);
  }, []);
  return getAllClaims();
}
