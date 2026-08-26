import { readSetting } from './settings.js';
import { getOrganisation, isStandalone } from './organisations.js';

// The plain-name category list for a bridge entity, server-side.
//
// Same arrangement as taxRules.ts: the list and the add/hide rules live in one
// pure module the browser already uses (src/lib/categoryList.js), loaded here
// at runtime by path rather than re-typed in TypeScript. A second copy would
// drift, and the drift would show up as the reader classifying an emailed
// document into a category the dropdown doesn't offer.

type CategoryList = { visibleCategoryNamesFrom: (blob: unknown) => string[] };

let cache: CategoryList | null = null;
let tried = false;

export async function loadCategoryList(): Promise<CategoryList | null> {
  if (tried) return cache;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/categoryList.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<CategoryList>;
    cache = typeof mod?.visibleCategoryNamesFrom === 'function' ? (mod as CategoryList) : null;
  } catch (e) {
    console.error('[categories] category list unavailable', e);
    cache = null;
  }
  return cache;
}

// The categories an entity offers, or [] when it has a Xero chart of its own —
// a linked entity classifies into ACCOUNTS, and offering both would let a
// document be coded to something that can never reach the ledger.
export async function categoriesForOrg(ws: string, orgId: string): Promise<string[]> {
  if (!orgId || !isStandalone(getOrganisation(ws, orgId))) return [];
  const mod = await loadCategoryList();
  if (!mod) return [];
  try {
    return mod.visibleCategoryNamesFrom(readSetting(ws, 'cybills.lists.v1', orgId));
  } catch (e) {
    console.error('[categories] could not read the list', e);
    return [];
  }
}
