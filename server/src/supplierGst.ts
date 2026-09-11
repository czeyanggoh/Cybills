import { listBillsAcrossScopes } from './store.js';

// A supplier's GST registration number, remembered.
//
// Input tax is claimed only on evidence (see claimableSgGst in
// src/lib/taxRateRules.js): the SUPPLIER's Singapore GST registration number,
// read off the paper. It is the right gate — Thailand's VAT is 7% and
// Malaysia's SST 8%, so the percentage alone proves nothing — but it hangs the
// whole of a client's input tax on the reader spotting one line of small print,
// and it misses it: "GST No: M8-8001588-5" set in 6pt under a hardware shop's
// address, or the header of an HR Easily invoice whose totals block says "GST @
// 9%" in plain sight. Missed, the document is coded No Tax and the GST is folded
// into the cost — money the client paid and is entitled to claim back, gone.
//
// And where the reader keeps missing it, a PERSON can type it on the supplier's
// rule (Supplier rules -> GST registration no.), which is the strongest source
// of all short of the paper itself — see withRememberedGstRegNo for the order.
//
// A registration number is a fact about the SUPPLIER, not about one page of its
// paperwork, and it is public (IRAS publishes the register). So once any
// document from a supplier has been read with a valid Singapore number, a later
// read of that supplier that came back without one is given it. Across every
// entity's book: the number is the same whoever the supplier bills, and a
// hardware shop seen once by one client is as much evidence as one seen by the
// client in hand.
//
// What keeps it honest:
//   - only a number READ off a document counts. One carried over is marked
//     `supplierGstRegNoRemembered` and is never itself a source, so a number
//     can only ever travel one step from the paper it was printed on;
//   - only a number that passes isSingaporeGstRegNo — a foreign registration is
//     the very thing the gate exists to decline, and remembering it would make a
//     Malaysian supplier's SST claimable by association;
//   - the supplier is matched by NAME, normalised the way supplier duplicates
//     are (case, punctuation, "& Co.", "Pte Ltd"), and matched exactly — a
//     near-miss must remember nothing rather than hand one company's
//     registration to another;
//   - a read that found a number of its own keeps it: this fills a blank, never
//     overrules the paper;
//   - and the tax reason says the number was remembered rather than read, since
//     it is the one piece of evidence nobody can check against the page in hand.
//
// The pure rules (the number's shape, the name's normal form) live in the two
// browser modules and are loaded by path, the way taxRules.ts loads the tax
// decision, so what counts as a Singapore number cannot differ between here
// and the gate it feeds.

type Rules = {
  isSingaporeGstRegNo: (v: unknown) => boolean;
  normaliseSupplier: (v: unknown) => string;
};
let cache: Rules | null = null;
let tried = false;

async function loadRules(): Promise<Rules | null> {
  if (tried) return cache;
  tried = true;
  try {
    const tax = await import(new URL('../../src/lib/taxRateRules.js', import.meta.url).href);
    const sup = await import(new URL('../../src/lib/supplierDuplicates.js', import.meta.url).href);
    cache =
      typeof tax?.isSingaporeGstRegNo === 'function' && typeof sup?.normaliseSupplier === 'function'
        ? { isSingaporeGstRegNo: tax.isSingaporeGstRegNo, normaliseSupplier: sup.normaliseSupplier }
        : null;
  } catch (e) {
    console.error('[supplierGst] rules unavailable', e);
    cache = null;
  }
  return cache;
}

const compact = (v: string) => v.toUpperCase().replace(/[\s.-]/g, '');

// Where a number that was not read off the document came from — stored as
// `supplierGstRegNoFrom`, and what the tax reason names:
//   'rule'      this entity's supplier rule — somebody typed it, for this book;
//   'ruleOther' another entity's supplier rule for the same supplier;
//   'document'  an earlier document of the supplier's that was READ with it.
export type GstRegNoSource = 'rule' | 'ruleOther' | 'document';

type Vote = { n: number; at: string; printed: string };
// The one number a set of sightings agrees on; '' when there is none, or two
// numbers are seen equally often — a disagreement, not an answer.
function winner(seen: Map<string, Vote>): string {
  const ranked = [...seen.values()].sort((a, b) => b.n - a.n || (a.at < b.at ? 1 : -1));
  if (!ranked.length) return '';
  if (ranked.length > 1 && ranked[0].n === ranked[1].n) return '';
  return ranked[0].printed;
}
function sight(seen: Map<string, Vote>, reg: string, at = '') {
  const k = compact(reg);
  const cur = seen.get(k);
  if (!cur) seen.set(k, { n: 1, at, printed: reg });
  else {
    cur.n += 1;
    if (at > cur.at) { cur.at = at; cur.printed = reg; }
  }
}

type RuleMap = Record<string, { gstRegNo?: unknown } | undefined>;

// The number a supplier rule names for this supplier, in one rules blob; ''
// when the rule names none, or one that isn't a Singapore number.
function ruleNumber(rules: Rules, map: RuleMap | null, key: string): string {
  for (const [name, rule] of Object.entries(map || {})) {
    if (rules.normaliseSupplier(name) !== key) continue;
    const reg = String(rule?.gstRegNo ?? '').trim();
    if (reg && rules.isSingaporeGstRegNo(reg)) return reg;
  }
  return '';
}

// Where the rule blobs come from. Only the settings store has them, and it is
// optional here so the memory still works for a caller with no entity at hand.
export type RuleContext = { ws: string; orgId: string } | null;

// The Singapore GST number known for a supplier from somewhere other than the
// document in hand, and where it came from. A re-read counts the document's
// OWN earlier read like any other: that number was printed on this very paper,
// which is the best evidence there is.
export async function knownGstRegNo(
  supplier: unknown,
  ctx: RuleContext = null
): Promise<{ reg: string; from: GstRegNoSource } | null> {
  const rules = await loadRules();
  if (!rules) return null;
  const key = rules.normaliseSupplier(supplier);
  if (!key) return null;

  if (ctx) {
    const { readSetting, readSettingAcrossOrgs } = await import('./settings.js');
    // This entity's rule: a person's instruction for this book, so it decides.
    const own = ruleNumber(rules, readSetting<RuleMap>(ctx.ws, 'cybills.supplier.rules.v1', ctx.orgId), key);
    if (own) return { reg: own, from: 'rule' };
    // Another entity's: the same supplier's registration, typed deliberately by
    // somebody who looked it up — better evidence than any read, as long as the
    // rules that name one agree.
    const typed = new Map<string, Vote>();
    for (const map of readSettingAcrossOrgs<RuleMap>(ctx.ws, 'cybills.supplier.rules.v1')) {
      const reg = ruleNumber(rules, map, key);
      if (reg) sight(typed, reg);
    }
    const other = winner(typed);
    if (other) return { reg: other, from: 'ruleOther' };
  }

  const seen = new Map<string, Vote>();
  for (const b of listBillsAcrossScopes()) {
    if (b.status === 'deleted' || b.supplierGstRegNoRemembered) continue;
    const reg = String(b.supplierGstRegNo || '').trim();
    if (!reg || !rules.isSingaporeGstRegNo(reg)) continue;
    if (rules.normaliseSupplier(b.supplier) !== key) continue;
    sight(seen, reg, String(b.createdAt || ''));
  }
  const read = winner(seen);
  return read ? { reg: read, from: 'document' } : null;
}

// The number remembered from documents alone — what the memory knew before
// supplier rules could name one.
export async function rememberedGstRegNo(supplier: unknown): Promise<string> {
  const hit = await knownGstRegNo(supplier);
  return hit?.reg ?? '';
}

// A read's answer with the supplier's known number filled in where the read
// found none that counts.
//
// A valid Singapore number read off the paper always stands. Otherwise:
//   - THIS entity's supplier rule fills it even over a number the read found
//     that isn't a Singapore one. Somebody typed that rule for this supplier,
//     which makes a misread the likelier story, and a rule is an instruction —
//     it outranks the reader on every field it sets;
//   - anything weaker (another entity's rule, an earlier document) fills only
//     a BLANK. A foreign registration read off the paper is evidence AGAINST
//     claiming, and must not be papered over by a memory.
export async function withRememberedGstRegNo<T extends { supplier?: unknown; supplierGstRegNo?: unknown }>(
  data: T,
  ctx: RuleContext = null
): Promise<T & { supplierGstRegNoRemembered?: boolean; supplierGstRegNoFrom?: GstRegNoSource | '' }> {
  const rules = await loadRules();
  const read = String(data.supplierGstRegNo ?? '').trim();
  const asRead = { ...data, supplierGstRegNoRemembered: false, supplierGstRegNoFrom: '' as const };
  if (read && rules?.isSingaporeGstRegNo(read)) return asRead;
  const hit = await knownGstRegNo(data.supplier, ctx);
  if (!hit || (read && hit.from !== 'rule')) return asRead;
  return { ...data, supplierGstRegNo: hit.reg, supplierGstRegNoRemembered: true, supplierGstRegNoFrom: hit.from };
}
