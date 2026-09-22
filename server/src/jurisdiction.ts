import { readSetting, writeSetting } from './settings.js';
import { getOrganisation, publishTargetFor } from './organisations.js';

// WHICH COUNTRY'S GST RULES this client entity's book is read under.
//
// The rules themselves are not here: they are the packs in
// src/lib/gstJurisdiction.js, the pure module the browser already decides with,
// loaded by path the way taxRules.ts loads the tax decision and motorVehicle.ts
// its own. What this file answers is the one question a background read cannot
// ask a browser — which country — for every road a document arrives by.
//
// The answer is the entity's own Business profile Country, which is where a
// person can see it and change it. That field is populated from the linked Xero
// organisation's CountryCode, but only when somebody OPENS Business settings →
// Business profile in a browser (the page's first-open sync). An entity nobody
// has opened that page for therefore sits on the form's Singapore default with
// nothing to say whether anyone ever answered — indistinguishable from a
// deliberate Singapore, and an Australian book read under Singapore's rules
// loses the GST on every document in it without a word anywhere.
//
// So the resolution is:
//   1. The profile's Country, whenever it is SET. Somebody chose it, or the
//      page synced it; either way it is an answer and it is visible.
//   2. Otherwise the linked Xero organisation's CountryCode — and it is written
//      BACK to the profile, so the answer appears on the page it belongs on
//      rather than living in this process. A standalone (bridge) entity has no
//      Xero of its own, so it asks the parent whose ledger its claims post into.
//   3. Otherwise Singapore. Every book that exists today is a Singapore one,
//      and a jurisdiction nobody has answered for must behave exactly as it did
//      before there were two.

const PROFILE_KEY = 'cybills.business-profile.v1';

export type JurisdictionPack = {
  key: string;
  country: string;
  demonym: string;
  taxName: string;
  currency: string;
  regNoLabel: string;
  blocksMotorVehicle: boolean;
  noTaxCodes: { cost: Array<{ code: string; name: string }>; sales: Array<{ code: string; name: string }> };
  isRegNo: (v: unknown) => boolean;
};
type Rules = {
  jurisdictionFor: (country: unknown) => JurisdictionPack;
  hasJurisdiction: (country: unknown) => boolean;
};

let rules: Rules | null = null;
let tried = false;

// Guarded and cached, like every other by-path load here. Without the module
// there is no second jurisdiction to speak of, so the failure mode is
// Singapore — which is what the whole deployment did before it existed.
async function loadRules(): Promise<Rules | null> {
  if (tried) return rules;
  tried = true;
  try {
    const url = new URL('../../src/lib/gstJurisdiction.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<Rules>;
    rules =
      typeof mod?.jurisdictionFor === 'function' && typeof mod?.hasJurisdiction === 'function'
        ? (mod as Rules)
        : null;
  } catch (e) {
    console.error('[jurisdiction] rules module unavailable', e);
    rules = null;
  }
  return rules;
}

// The Xero lookup, remembered per entity for the life of the process. It is a
// relay call against a rate limit that the read of every emailed document would
// otherwise spend, and an organisation's country does not change. A miss is
// remembered too ('' for "asked, no answer"), so an unlinked or unreachable
// entity is not asked again on every document.
const fromXero = new Map<string, string>();

async function countryFromXero(ws: string, orgId: string): Promise<string> {
  const cached = fromXero.get(`${ws}::${orgId}`);
  if (cached !== undefined) return cached;
  let answer = '';
  try {
    const organisation = getOrganisation(ws, orgId);
    // A bridge entity holds no Xero of its own; its claims post into the
    // parent's ledger, so the parent's country is the one its coding is read
    // under. publishTargetFor is the same resolution the publish path makes.
    const { publishTargetFor } = await import('./organisations.js');
    const target = publishTargetFor(ws, organisation);
    if (target?.tenantId) {
      const { relay } = await import('./xero.js');
      const result = await relay('Organisation', { tenantId: target.tenantId });
      if (result.ok) answer = String(result.data?.Organisations?.[0]?.CountryCode ?? '').trim();
    }
  } catch (e) {
    console.error('[jurisdiction] could not read the organisation country from Xero', e);
  }
  fromXero.set(`${ws}::${orgId}`, answer);
  return answer;
}

/**
 * The country this entity's documents are read under, as the Business profile
 * spells it ("Singapore", "Australia"). Never throws and never blocks on a
 * failure: anything it cannot establish is Singapore.
 */
export async function countryForOrg(ws: string, orgId: string): Promise<string> {
  const profile = readSetting<{ country?: string }>(ws, PROFILE_KEY, orgId);
  const stored = String(profile?.country || '').trim();
  if (stored) return stored;

  const code = await countryFromXero(ws, orgId);
  if (!code) return 'Singapore';
  const mod = await loadRules();
  // Only a country CYBills has rules of its own for is written back. Xero
  // answering "MY" is true and means nothing here yet, and writing it would put
  // a country on the profile that no pack reads — the page's own "Update from
  // Xero", which has the wider map, is where that belongs.
  if (!mod?.hasJurisdiction(code)) return 'Singapore';
  const country = mod.jurisdictionFor(code).country;
  try {
    writeSetting(ws, PROFILE_KEY, orgId, { ...(profile || {}), country });
  } catch (e) {
    console.error('[jurisdiction] could not record the country on the profile', e);
  }
  return country;
}

/** The whole pack for an entity — the rules, not just the name. */
export async function packForOrg(ws: string, orgId: string): Promise<JurisdictionPack | null> {
  const mod = await loadRules();
  if (!mod) return null;
  return mod.jurisdictionFor(await countryForOrg(ws, orgId));
}

/**
 * What this entity calls the code that carries NO tax — "No Tax" in a Singapore
 * chart, "GST Free Expenses" in an Australian one. The name Xero ships for the
 * country, not a lookup in the org's own list: the callers are the write paths
 * (a payment proof, a quotation), which have no rate list to hand and would
 * otherwise spend a relay call each to learn a name that is the same in every
 * chart of that country. Singapore's answer is the literal these paths used
 * before, so nothing moves for an existing book.
 */
export async function zeroCodeName(ws: string, orgId: string, kind: 'cost' | 'sales' = 'cost'): Promise<string> {
  const pack = await packForOrg(ws, orgId);
  return pack?.noTaxCodes?.[kind]?.[0]?.name || 'No Tax';
}

/** The pack for a country already in hand, without touching settings or Xero. */
export async function packFor(country: unknown): Promise<JurisdictionPack | null> {
  const mod = await loadRules();
  return mod ? mod.jurisdictionFor(country) : null;
}
