import { readSetting } from './settings.js';
import { accountsForOrg, taxRatesForOrg } from './xero.js';

// The tax-code decision, server-side.
//
// The decision itself lives in ONE place: src/lib/taxRateRules.js, the pure,
// dependency-free module every client entry point (upload, re-read, merge)
// already calls, tested by `npm test` at the repo root. It is loaded here at
// runtime by path rather than re-implemented in TypeScript, because a second
// copy of the arithmetic that decides what GST a client claims is exactly the
// drift that must not happen.
//
// What this file adds is the CONTEXT that decision needs — the org's tax rates,
// its chart of accounts and whether it is GST-registered — which a browser has
// to hand and a background read does not.

export type TaxOutcome = { name: string; reason: string; claimsTax: boolean };
type TaxRules = { taxRateOutcome: (args: Record<string, unknown>) => TaxOutcome };

let cache: TaxRules | null = null;
let tried = false;

// Guarded and cached. If the module can't be loaded the caller leaves the tax
// code for the reviewer — the behaviour before any of this existed, so the
// failure mode is "no answer", never a wrong one.
export async function loadTaxRules(): Promise<TaxRules | null> {
  if (tried) return cache;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/taxRateRules.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<TaxRules>;
    cache = typeof mod?.taxRateOutcome === 'function' ? (mod as TaxRules) : null;
  } catch (e) {
    console.error('[taxRules] rules module unavailable', e);
    cache = null;
  }
  return cache;
}

export type TaxContext = {
  visibleRates: Array<{ name: string; code: string; rate: number }>;
  allRates: Array<{ name: string; code: string; rate: number }>;
  gstRegistered: boolean;
  accountTaxTypes: Map<string, string>;
  defaultTaxRateCosts: string;
};

const asStrArray = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
type ListsBlob = { hidden?: Record<string, unknown>; added?: Record<string, unknown> };

export const EMPTY_TAX_CONTEXT: TaxContext = {
  visibleRates: [],
  allRates: [],
  gstRegistered: true,
  accountTaxTypes: new Map(),
  defaultTaxRateCosts: '',
};

// Everything the decision needs for one organisation, merged the way the
// client's managed list merges it: live Xero rates plus any manually-added row,
// minus anything switched off in Lists. `allRates` keeps the unfiltered set, so
// a hidden code can still be NAMED the way this organisation names it.
export async function taxContextFor(ws: string, orgId: string): Promise<TaxContext> {
  const lists = (readSetting<ListsBlob>(ws, 'cybills.lists.v1', orgId) || {}) as ListsBlob;

  const liveRates = await taxRatesForOrg(ws, orgId);
  const addedRates = (Array.isArray(lists?.added?.taxRates) ? (lists.added!.taxRates as unknown[]) : [])
    .map((r) => r as { name?: unknown; code?: unknown; rate?: unknown })
    .map((r) => ({ name: String(r?.name ?? ''), code: String(r?.code ?? ''), rate: Number(r?.rate) || 0 }))
    .filter((r) => r.name);
  const hidden = new Set(asStrArray(lists?.hidden?.taxRates));
  const seen = new Set<string>();
  const allRates = [...liveRates, ...addedRates].filter((r) => !seen.has(r.name) && seen.add(r.name));

  // The account's own default tax code in Xero, keyed by the "<code> - <name>"
  // label the app stores as a document's category. The decision follows the
  // account the way Xero's own UI does.
  const accounts = await accountsForOrg(ws, orgId);
  const accountTaxTypes = new Map(accounts.map((a) => [`${a.code} - ${a.name}`, a.taxType || '']));

  // Anything other than an explicit 'No' counts as registered, matching
  // isGstRegistered() — a profile saved before the field existed keeps its
  // current behaviour.
  const profile = readSetting<{ gstRegistered?: string }>(ws, 'cybills.business-profile.v1', orgId);
  const settings = readSetting<{ defaultTaxRateCosts?: string }>(ws, 'cybills.extraction-settings.v1', orgId);

  return {
    visibleRates: allRates.filter((r) => !hidden.has(r.name)),
    allRates,
    gstRegistered: String(profile?.gstRegistered || 'Yes').toLowerCase() !== 'no',
    accountTaxTypes,
    defaultTaxRateCosts: String(settings?.defaultTaxRateCosts || ''),
  };
}

// The tax code for one document's figures. `suggested` is a code the READER
// picked because one of the org's own "when to use" rules plainly matched; it
// wins, and everything else is settled by the arithmetic. Null when the rules
// module couldn't be loaded, so the caller can leave the field alone.
export async function decideTaxRate(
  ctx: TaxContext,
  doc: {
    total?: unknown;
    tax?: unknown;
    currency?: unknown;
    category?: unknown;
    taxRate?: unknown;
    supplierGstRegNo?: unknown;
    taxLabel?: unknown;
  }
): Promise<TaxOutcome | null> {
  const rules = await loadTaxRules();
  if (!rules) return null;
  const category = String(doc.category ?? '');
  try {
    return rules.taxRateOutcome({
      total: doc.total,
      tax: doc.tax,
      rates: ctx.visibleRates,
      allRates: ctx.allRates,
      suggested: String(doc.taxRate ?? ''),
      gstRegistered: ctx.gstRegistered,
      defaultName: ctx.defaultTaxRateCosts,
      currency: String(doc.currency ?? ''),
      kind: 'cost',
      accountTaxType: ctx.accountTaxTypes.get(category) || '',
      accountLabel: category,
      gstRegNo: String(doc.supplierGstRegNo ?? ''),
      taxLabel: String(doc.taxLabel ?? ''),
    });
  } catch (e) {
    console.error('[taxRules] decision failed', e);
    return null;
  }
}
