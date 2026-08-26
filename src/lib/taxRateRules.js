// Which Xero tax code a read document gets, and WHY.
//
// Dependency-free on purpose: this is the arithmetic that decides what GST a
// client claims, so it is tested directly (test/tax-rate-rules.test.mjs) rather
// than only through the pages that call it. `extractionSettings.js` re-exports
// it for those callers.

// --- Auto-pickable tax codes ------------------------------------------------
// The ONLY codes CYBills is allowed to choose from arithmetic alone:
// standard-rated purchases and supplies at 7% / 8% / 9% (the 2022 / 2023 /
// current vintages), plus No Tax. Everything else the org has in Xero —
// imports, IGDS, partially exempt traders, reverse charge, bad debt relief,
// customer accounting — is a judgement call about the underlying transaction
// that a percentage can't settle, so a percentage never reaches for it.
//
// Matched on the Xero TaxType (stable: INPUT / INPUTY23 / INPUTY24, OUTPUT /
// OUTPUTY23 / OUTPUTY24, NONE), falling back to the name for manually-added
// rates that carry no code. The regexes are anchored so near-misses in the same
// chart — BLINPUT2 (Disallowed Expenses), EPINPUT, ZERORATEDINPUT — never slip
// through.
const AUTO_PURCHASE = { code: /^INPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated purchases$/i };
const AUTO_SUPPLY = { code: /^OUTPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated supplies$/i };
const AUTO_NO_TAX = { code: /^NONE$/i, name: /^no tax$/i };

const autoMatches = (rule, row) => {
  const code = String(row?.code || '').trim();
  return code ? rule.code.test(code) : rule.name.test(String(row?.name || '').trim());
};

// Xero's own standard-rated codes for Singapore GST, by rate. These are the
// same in every Singapore Xero — INPUTY24 IS 9% standard-rated purchases — so
// when an organisation has written no rule of its own, this is the answer, not
// a guess. It is the fallback when the org's VISIBLE list can't supply it:
// switched off in Lists → Tax rates, or the list hadn't loaded. The names are
// Xero's defaults, used only when the organisation's own row can't be found.
const STANDARD_CODES = {
  cost: [
    { pct: 9, code: 'INPUTY24', name: 'Standard-Rated Purchases' },
    { pct: 8, code: 'INPUTY23', name: '2023 Standard-Rated Purchases' },
    { pct: 7, code: 'INPUT', name: '2022 Standard-Rated Purchases' },
  ],
  sales: [
    { pct: 9, code: 'OUTPUTY24', name: 'Standard-Rated Supplies' },
    { pct: 8, code: 'OUTPUTY23', name: '2023 Standard-Rated Supplies' },
    { pct: 7, code: 'OUTPUT', name: '2022 Standard-Rated Supplies' },
  ],
};

// --- Is this Singapore GST at all? ------------------------------------------
// Input tax is claimable only against a Singapore GST-registered supplier who
// charged GST — IRAS requires the supplier's GST registration number on a tax
// invoice, simplified ones included. Foreign tax is not claimable; it is part of
// the cost. The numbers alone cannot tell them apart — Thailand's VAT is 7% and
// Malaysia's SST 8%, exactly Singapore's 2022 and 2023 rates — so the evidence
// has to be the registration number and what the document calls the tax.
//
// Singapore registration numbers are UENs, or an M-number for a GST-only /
// overseas-vendor registration:
//   53012345M      business (8 digits + letter)
//   201614382R     local company (9 digits + letter, year-prefixed)
//   T08LL1234A     other entities (T/S/R + 2 digits + 2 letters + 4 digits + letter)
//   M90370287L     GST registration / OVR (M + 8 digits + letter)
const SG_UEN = [
  /^\d{8}[A-Z]$/,
  /^(19|20)\d{7}[A-Z]$/,
  /^[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]$/,
  /^M\d{8}[A-Z]$/,
];
export function isSingaporeGstRegNo(value) {
  const v = String(value || '').toUpperCase().replace(/[\s.-]/g, '');
  if (!v) return false;
  return SG_UEN.some((re) => re.test(v));
}

// A tax the document itself calls GST. "VAT", "SST", "Sales Tax" and
// "Consumption Tax" are somebody else's tax, whatever the rate.
const NOT_GST = /\b(vat|tva|iva|btw|mwst|sst|consumption tax|sales tax|service tax|use tax)\b/i;
export function looksLikeGst(taxLabel) {
  const label = String(taxLabel || '').trim();
  if (!label) return true; // nothing said either way — the reg number decides
  if (NOT_GST.test(label)) return false;
  return true;
}

// Whether the tax on this document is Singapore GST, and so claimable.
export function claimableSgGst({ gstRegNo = '', taxLabel = '' } = {}) {
  return isSingaporeGstRegNo(gstRegNo) && looksLikeGst(taxLabel);
}

const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
// A rate matches the printed percentage when it is within half a point of it —
// tight, so a 10% AU invoice never snaps to a 9% SG rate and 7 / 8 / 9 each land
// on their own vintage.
const TOLERANCE = 0.6;
const pctOf = (n) => `${Number(n).toFixed(1)}%`;

// A tax code that carries NO tax — so a document coded to it must record a tax
// amount of 0, whoever chose the code.
//
// This is an invariant, not a preference: "No Tax" with 65.25 of tax beside it
// is not a document anybody can act on. Either the tax is claimable input tax,
// in which case the code says which, or it isn't, in which case it stays inside
// the cost and the tax field is 0. The TOTAL never changes either way — the
// money is the same, only the split moves.
//
// Decided from the org's own rates when they're to hand, since that is the
// authority on what a rate is worth. Where they aren't — a server-side write
// that has no Xero list — the names Xero itself ships for zero-tax codes are
// recognised, so the check still holds at the point the document is stored.
const ZERO_TAX_NAMES = /^(no tax|tax exempt(ed)?|exempt( \(?(input|output)s?\)?)?|zero[- ]?rated|no gst|gst free|out of scope)$/i;

export function zeroTaxRate(name, rates) {
  const wanted = String(name || '').trim();
  if (!wanted) return false; // undecided is not a decision — leave the amount alone
  const row = (Array.isArray(rates) ? rates : []).find(
    (r) => String(r?.name || '').trim().toLowerCase() === wanted.toLowerCase()
  );
  if (row) return Number(row.rate) === 0;
  return ZERO_TAX_NAMES.test(wanted);
}

// The org's zero-rated "No Tax" code, by name — '' when the list doesn't have
// one (it's hidden, or Xero isn't connected yet). The single answer for a
// company that isn't GST-registered, so every screen agrees on it.
export function noTaxRateName(rates) {
  const row = (Array.isArray(rates) ? rates : []).find(
    (r) => Number(r.rate) === 0 && autoMatches(AUTO_NO_TAX, r),
  );
  return row ? row.name : '';
}

// Which tax code this document gets, and the sentence that says why — including
// when the answer is "none", which used to be a silent blank field with nothing
// to act on.
//
// In order:
//   1. The ACCOUNT's own default tax code in Xero, when the printed GST matches
//      its rate. This is what Xero itself does when you pick an account, and it
//      is the only route that can reach a code arithmetic must not guess at: an
//      entertainment account defaulting to Disallowed Expenses at 9% is right,
//      where "9% therefore Standard-Rated Purchases" would wrongly claim it.
//   2. The standard-rated vintage whose % matches — the ordinary case.
//   3. Foreign-currency document whose rate isn't in the chart → No Tax,
//      because foreign GST isn't Singapore input tax.
//   4. Xero's own standard-rated code for that percentage (9% purchases are
//      INPUTY24 in every Singapore Xero). Reached when the visible list can't
//      supply it — switched off in Lists, or not loaded — because "the standard
//      code for the rate printed on the document" is the right answer for an
//      organisation that has written no rule of its own.
//   5. Nothing, and only then. Import GST, reverse charge and partial exemption
//      print as percentages too, but none of them at a standard rate.
//
// `rates` is the org's VISIBLE list ([{name, code, rate}]); `allRates` the
// unfiltered one, so a switched-off code can still be named as the org names it.
// `accountTaxType` / `accountLabel` describe the account it was categorised to.
export function taxRateOutcome({
  total,
  tax,
  rates,
  allRates = null,
  suggested = '',
  gstRegistered = true,
  defaultName = '',
  currency = '',
  baseCurrency = 'SGD',
  kind = 'cost',
  accountTaxType = '',
  accountLabel = '',
  // The evidence that the tax charged is Singapore GST: the supplier's SG GST
  // registration number, and what the document calls the tax.
  gstRegNo = '',
  taxLabel = '',
} = {}) {
  const list = Array.isArray(rates) ? rates : [];
  const everything = Array.isArray(allRates) && allRates.length ? allRates : list;
  const noTax = list.find((r) => Number(r.rate) === 0 && autoMatches(AUTO_NO_TAX, r));

  // 0. Not GST-registered: nothing to claim, nothing to analyse. The screens
  //    say so themselves, so no reason is needed here.
  if (!gstRegistered) return { name: noTax ? noTax.name : '', reason: '', claimsTax: false };

  // 0b. A code the org's own "when to use" rule matched, via the reader. The
  //     reader writes its own reason, so don't overwrite it.
  const picked = String(suggested || '').trim();
  if (picked && list.some((r) => r.name === picked)) return { name: picked, reason: '', claimsTax: true };

  const t = num(total);
  const x = num(tax);
  const net = t - x;
  const cur = String(currency || '').toUpperCase().slice(0, 3);
  const base = String(baseCurrency || 'SGD').toUpperCase().slice(0, 3);
  const isForeign = Boolean(cur) && Boolean(base) && cur !== base;
  const wanted = kind === 'sales' ? AUTO_SUPPLY : AUTO_PURCHASE;

  if (!(x > 0 && net > 0)) {
    // No tax charged: the configured default, else No Tax.
    const useDefault = defaultName && list.some((r) => r.name === defaultName) ? defaultName : '';
    return { name: useDefault || (noTax ? noTax.name : ''), reason: '', claimsTax: false };
  }

  const pct = (x / net) * 100;

  // Tax IS charged — but only Singapore GST from a registered supplier can be
  // claimed. Without that evidence the tax is part of the cost, not input tax:
  // No Tax, and the amount is not recorded as GST.
  if (kind !== 'sales' && !claimableSgGst({ gstRegNo, taxLabel })) {
    const label = String(taxLabel || '').trim();
    const why = !isSingaporeGstRegNo(gstRegNo)
      ? String(gstRegNo || '').trim()
        ? `the supplier's registration number (${String(gstRegNo).trim()}) isn't a Singapore one`
        : 'the document shows no Singapore GST registration number for the supplier'
      : `the document calls it ${label}, not GST`;
    return {
      name: noTax ? noTax.name : '',
      reason:
        `Tax of ${x.toFixed(2)} (${pctOf(pct)}) is on the document, but ${why} — so it isn't Singapore input tax to claim. ` +
        'Coded No Tax, with the tax left in the cost. If the supplier IS Singapore GST-registered, set the code by hand.',
      claimsTax: false,
    };
  }

  // 1. The account's own tax code, when the document agrees with it.
  const own = String(accountTaxType || '').trim().toUpperCase();
  if (own) {
    const row = list.find((r) => String(r.code || '').trim().toUpperCase() === own);
    if (row && Math.abs(Number(row.rate) - pct) <= TOLERANCE) {
      return {
        name: row.name,
        reason: `${accountLabel ? `The ${accountLabel} account's` : "The account's"} own tax code in Xero, and the ${pctOf(pct)} GST on this document matches it.`,
        claimsTax: true,
      };
    }
  }

  // 2. The standard-rated code at that percentage.
  let best = '';
  let bestDiff = Infinity;
  for (const r of list) {
    const rate = Number(r.rate);
    if (!(rate > 0) || !autoMatches(wanted, r)) continue;
    const d = Math.abs(rate - pct);
    if (d < bestDiff) { bestDiff = d; best = r.name; }
  }
  if (best && bestDiff <= TOLERANCE) {
    return {
      name: best,
      reason: `GST of ${x.toFixed(2)} on ${net.toFixed(2)} is ${pctOf(pct)} — matched ${best}.`,
      claimsTax: true,
    };
  }

  // 3. Foreign-currency invoice whose rate isn't in our chart.
  if (isForeign && noTax) {
    return {
      name: noTax.name,
      reason: `A ${cur} document taxed at ${pctOf(pct)}, which isn't a rate in this chart — foreign GST isn't Singapore input tax, so nothing is claimed.`,
      claimsTax: false,
    };
  }

  // 4. Xero's standard code for that rate. The organisation wrote no rule and
  //    its visible list didn't answer, but 9% purchases are INPUTY24 everywhere
  //    — leaving that blank helps nobody.
  const std = (STANDARD_CODES[kind === 'sales' ? 'sales' : 'cost'] ?? []).find(
    (c) => Math.abs(c.pct - pct) <= TOLERANCE
  );
  if (std) {
    // Prefer what this organisation calls it; fall back to Xero's own name.
    const own = everything.find((r) => String(r.code || '').trim().toUpperCase() === std.code);
    const hiddenHere = !list.some((r) => String(r.code || '').trim().toUpperCase() === std.code);
    return {
      name: own?.name || std.name,
      reason:
        `${pctOf(pct)} GST — Xero's standard code for ${kind === 'sales' ? 'supplies' : 'purchases'} at that rate (${std.code}). ` +
        (hiddenHere
          ? "It isn't switched on in Business settings → Lists → Tax rates, so the picker won't offer it until it is."
          : 'No rule of this organisation\'s own covered the document.'),
      claimsTax: true,
    };
  }

  // 5. Left for a human, with what was looked for and where to look.
  if (!list.length) {
    return {
      name: '',
      reason: 'Left blank: no tax rates are visible for this organisation, so nothing could be matched. Check Business settings → Lists → Tax rates.',
      claimsTax: false,
    };
  }
  const side = kind === 'sales' ? 'supplies' : 'purchases';
  const sameRate = list
    .filter((r) => Math.abs(Number(r.rate) - pct) <= TOLERANCE)
    .map((r) => r.name)
    .slice(0, 3);
  const alsoAt = sameRate.length
    ? ` The visible codes at ${pctOf(pct)} are ${sameRate.join(', ')} — none of them standard-rated ${side}.`
    : ' No visible code sits at that rate at all.';
  return {
    name: '',
    reason:
      `Left blank: this document is taxed at ${pctOf(pct)}, and no standard-rated ${side} code at that rate is visible in ` +
      `Business settings → Lists → Tax rates.${alsoAt} At that percentage it could also be import GST or reverse charge, so it isn't guessed.`,
    claimsTax: false,
  };
}

// The name alone, for callers that don't show a reason.
export function inferTaxRateName(total, tax, rates, opts = {}) {
  return taxRateOutcome({ total, tax, rates, ...opts }).name;
}

// The one place a document's tax rate is decided, so every entry point (upload,
// re-read, merge) applies the same precedence. See taxRateOutcome.
export function resolveTaxRate(args) {
  return taxRateOutcome(args).name;
}
