import { useEffect, useState } from 'react';
import { DOCS } from '@/data/docs';

// Bank reconciliation against a (simulated) live bank feed. A real feed needs a
// bank aggregation API; this seeds a feed from actual cost documents plus a few
// bank-only lines, then lets you match each bank transaction to the cost it
// pays — the core reconciliation workflow. Feed + matches persist in
// localStorage. Swap `seedFeed` for a real feed puller without touching the UI.

const FEED_KEY = 'cybills.bank-recon.v1';
export const BANK_RECON_EVENT = 'cybills:bank-recon';

// The company's bank accounts (from the CYHR company profile).
export const RECON_ACCOUNTS = [
  { id: 'dbs', bank: 'DBS/POSB', number: '0720265734' },
  { id: 'uob', bank: 'UOB', number: '3803237466' },
  { id: 'ocbc', bank: 'OCBC', number: '588133272001' },
];

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Build the initial feed: a debit per real cost (so it has a cost to match),
// plus a few bank-only lines that won't match anything.
function seedFeed() {
  const accts = RECON_ACCOUNTS.map((a) => a.id);
  const costs = DOCS.filter((d) => num(d.total) > 0).slice(0, 6);
  const matched = costs.map((d, i) => ({
    id: `bt_${d.id}`,
    accountId: accts[i % accts.length],
    date: d.date,
    description: d.supplier || 'Card payment',
    amount: num(d.total),
    type: 'debit',
    suggestedCostId: String(d.id),
    suggestedSupplier: d.supplier || '',
    reconciled: false,
    matchedCostId: null,
  }));
  const base = costs[0]?.date || '';
  const bankOnly = [
    { id: 'bt_fee', accountId: 'dbs', date: base, description: 'Monthly account fee', amount: 5.0, type: 'debit', suggestedCostId: null, suggestedSupplier: '', reconciled: false, matchedCostId: null },
    { id: 'bt_int', accountId: 'uob', date: base, description: 'Interest earned', amount: 1.2, type: 'credit', suggestedCostId: null, suggestedSupplier: '', reconciled: false, matchedCostId: null },
    { id: 'bt_xfer', accountId: 'ocbc', date: base, description: 'Transfer to payroll', amount: 3200.0, type: 'debit', suggestedCostId: null, suggestedSupplier: '', reconciled: false, matchedCostId: null },
  ];
  return [...matched, ...bankOnly];
}

export function getFeed() {
  try {
    const raw = localStorage.getItem(FEED_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to seed
  }
  const seeded = seedFeed();
  try {
    localStorage.setItem(FEED_KEY, JSON.stringify(seeded));
  } catch {
    // localStorage unavailable — feed just won't persist
  }
  return seeded;
}

function writeFeed(next) {
  localStorage.setItem(FEED_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(BANK_RECON_EVENT));
}

export function useBankFeed() {
  const [feed, setFeed] = useState(getFeed);
  useEffect(() => {
    const sync = () => setFeed(getFeed());
    window.addEventListener(BANK_RECON_EVENT, sync);
    return () => window.removeEventListener(BANK_RECON_EVENT, sync);
  }, []);
  return feed;
}

// Match (reconcile) or unmatch a single bank transaction to its suggested cost.
export function reconcile(id, on = true) {
  const feed = getFeed();
  writeFeed(
    feed.map((t) => (t.id === id ? { ...t, reconciled: on, matchedCostId: on ? t.suggestedCostId || null : null } : t))
  );
}

// Reconcile every transaction that has a suggested cost match.
export function reconcileAll() {
  const feed = getFeed();
  writeFeed(feed.map((t) => (t.suggestedCostId ? { ...t, reconciled: true, matchedCostId: t.suggestedCostId } : t)));
}
