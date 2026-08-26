import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Where a bridge entity's plain categories land in a real chart of accounts.
//
// "Red Alpha - ST Engineering" has no ledger of its own: a claim raised there is
// posted into Red Alpha's Xero. Its people pick "Transport - Taxi", and Xero
// needs an account code — so the translation is written down ONCE, here, by
// whoever knows both sides, instead of being guessed per claim at publish time.
//
// Stored per entity (`cybills.category-accounts.v1::<orgId>`) as
// { "Transport - Taxi": "493" }. A category with no entry simply can't be
// published: the publish path refuses the claim and names it, rather than
// posting a bill for less than the claim is worth.

const KEY = 'cybills.category-accounts.v1';
export const CATEGORY_ACCOUNTS_EVENT = 'cybills:category-accounts-changed';

const emit = () => window.dispatchEvent(new Event(CATEGORY_ACCOUNTS_EVENT));
// Never inherits the workspace-wide blob: a mapping belongs to ONE bridge
// entity, and borrowing another's would post to codes from the wrong chart.
const store = blobStore(KEY, {}, emit, { perOrg: true, inheritLegacy: false });

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function getCategoryAccounts() {
  return asMap(store.get());
}

// '' removes the mapping rather than storing a blank.
export function setCategoryAccount(category, code) {
  const next = { ...getCategoryAccounts() };
  const name = String(category ?? '').trim();
  if (!name) return;
  const value = String(code ?? '').trim();
  if (value) next[name] = value;
  else delete next[name];
  store.set(next);
  emit();
}

export function useCategoryAccounts() {
  const [map, setMap] = useState(getCategoryAccounts);
  useEffect(() => {
    const sync = () => setMap(getCategoryAccounts());
    window.addEventListener(CATEGORY_ACCOUNTS_EVENT, sync);
    return () => window.removeEventListener(CATEGORY_ACCOUNTS_EVENT, sync);
  }, []);
  return map;
}
