import { useState, useEffect, useCallback } from 'react';
import { useClaims } from '@/lib/claimStore';
import { fetchBills, billToDoc, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { USERS_EVENT } from '@/lib/userStore';

// The fields a cost document needs before it's "ready" (moves out of the inbox).
// Surfaced in the UI so users know exactly why something is still in the inbox.
export const READY_FIELDS = ['Supplier', 'Date', 'Category', 'Total'];

// A cost is "complete" (→ Ready) when it carries those fields: a real supplier
// (not "Unknown supplier"), a date, a real category (not "Uncategorised"), and a
// total above 0. Mirrors the server's costComplete so both follow one rule.
export function isComplete(d) {
  const has = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '—';
  const supplier = has(d.supplier) && String(d.supplier).trim().toLowerCase() !== 'unknown supplier';
  const category = has(d.category) && String(d.category).trim().toLowerCase() !== 'uncategorised';
  const total = Number(String(d.total ?? '').replace(/[^0-9.-]/g, '')) > 0;
  return supplier && has(d.date) && category && total;
}

// The specific fields still missing on a document (for a per-row explanation).
export function missingFields(d) {
  const has = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '—';
  const out = [];
  if (!(has(d.supplier) && String(d.supplier).trim().toLowerCase() !== 'unknown supplier')) out.push('Supplier');
  if (!has(d.date)) out.push('Date');
  if (!(has(d.category) && String(d.category).trim().toLowerCase() !== 'uncategorised')) out.push('Category');
  if (!(Number(String(d.total ?? '').replace(/[^0-9.-]/g, '')) > 0)) out.push('Total');
  return out;
}

export function rowsFor(docs, key) {
  // Dext-style: the Inbox is the whole "not ready for export" pool, and
  // "To review" is a FILTER within it (items flagged for a human) — not a
  // separate bucket. So review items stay counted/shown in the Inbox.
  if (key === 'processing') return docs.filter((d) => d.status === 'processing');
  // Dext-style: the Inbox is the master list of everything not archived — it's
  // the sum of the other tabs (Ready, To review, new/viewed). A Ready item shows
  // here too, just carrying its "Ready" status tag; the Ready tab is a filter.
  if (key === 'inbox') return docs.filter((d) => ['new', 'viewed', 'review', 'ready'].includes(d.status));
  if (key === 'review') return docs.filter((d) => d.status === 'review');
  if (key === 'ready') return docs.filter((d) => d.status === 'ready');
  if (key === 'archive') return docs.filter((d) => d.status === 'expenseclaim' || d.status === 'archived' || d.status === 'merged');
  return [];
}

// Loads the real Costs document set (persisted bills) and keeps it in sync with
// upload / edit events. (Seed/demo sample rows were removed — the list shows
// only real uploaded documents.)
export function useCostsDocs() {
  const [uploaded, setUploaded] = useState([]);

  const reload = useCallback(async () => {
    // Only cost-workspace bills belong in Costs; sales uploads have kind==='sales'.
    setUploaded((await fetchBills()).map(billToDoc).filter((d) => d.kind !== 'sales'));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(BILLS_CHANGED_EVENT, reload);
    // Re-map when the users roster loads/changes, so createdBy emails resolve to
    // real names ("Astrid Yang" rather than "astridy2004").
    window.addEventListener(USERS_EVENT, reload);
    return () => {
      window.removeEventListener(BILLS_CHANGED_EVENT, reload);
      window.removeEventListener(USERS_EVENT, reload);
    };
  }, [reload]);

  return { allDocs: uploaded, sampleDocs: [], uploaded, reload };
}

// Live counts for every Costs tab + the subnav badges, derived from real rows.
export function useCostsCounts() {
  const { allDocs } = useCostsDocs();
  const claims = useClaims();
  return {
    inbox: rowsFor(allDocs, 'inbox').length,
    review: rowsFor(allDocs, 'review').length,
    ready: rowsFor(allDocs, 'ready').length,
    archive: rowsFor(allDocs, 'archive').length,
    expenseClaims: claims.length,
  };
}
