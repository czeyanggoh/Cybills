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

// The Singapore GST number a supplier has been READ with before, in the form
// it was printed; '' when there is none, or its documents disagree about it
// evenly. A re-read counts the document's OWN earlier read like any other: that
// number was printed on this very paper, which is the best evidence there is.
export async function rememberedGstRegNo(supplier: unknown): Promise<string> {
  const rules = await loadRules();
  if (!rules) return '';
  const key = rules.normaliseSupplier(supplier);
  if (!key) return '';
  // Per number: how many documents carry it, and the latest printed spelling.
  const seen = new Map<string, { n: number; at: string; printed: string }>();
  for (const b of listBillsAcrossScopes()) {
    if (b.status === 'deleted' || b.supplierGstRegNoRemembered) continue;
    const reg = String(b.supplierGstRegNo || '').trim();
    if (!reg || !rules.isSingaporeGstRegNo(reg)) continue;
    if (rules.normaliseSupplier(b.supplier) !== key) continue;
    const k = compact(reg);
    const at = String(b.createdAt || '');
    const cur = seen.get(k);
    if (!cur) seen.set(k, { n: 1, at, printed: reg });
    else {
      cur.n += 1;
      if (at > cur.at) { cur.at = at; cur.printed = reg; }
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.n - a.n || (a.at < b.at ? 1 : -1));
  if (!ranked.length) return '';
  // Two numbers read equally often is a disagreement, not an answer.
  if (ranked.length > 1 && ranked[0].n === ranked[1].n) return '';
  return ranked[0].printed;
}

// A read's answer with the supplier's remembered number filled in, where the
// read found none that counts. Returns the read untouched otherwise — including
// when it found a number of its own, valid or not: a foreign registration read
// off the paper is evidence AGAINST claiming, and must not be papered over.
export async function withRememberedGstRegNo<T extends { supplier?: unknown; supplierGstRegNo?: unknown }>(
  data: T
): Promise<T & { supplierGstRegNoRemembered?: boolean }> {
  if (String(data.supplierGstRegNo ?? '').trim()) return { ...data, supplierGstRegNoRemembered: false };
  const reg = await rememberedGstRegNo(data.supplier);
  return reg
    ? { ...data, supplierGstRegNo: reg, supplierGstRegNoRemembered: true }
    : { ...data, supplierGstRegNoRemembered: false };
}
