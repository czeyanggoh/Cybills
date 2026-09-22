// WHICH COUNTRY'S GST RULES a client entity's documents are read under.
//
// CYBills was written for Singapore and said so in a dozen places: the shape of
// a supplier's registration number, the standard-rated codes and their
// vintages, what the zero-tax code is called, and the practice's rule that a
// motor vehicle expense is never claimable. None of that is wrong — it is just
// Singapore's, and the practice now keeps books for Australian entities too.
//
// Run unchanged against an Australian book the damage is silent and total: an
// ABN is not a UEN, so the evidence gate in taxRateRules.js refuses every
// document, codes it No Tax and folds the GST into the cost. The client loses
// 10% on its whole book and nothing on any screen says a rule was applied that
// does not belong to it.
//
// So the country-specific half is gathered HERE, one pack per jurisdiction, and
// taxRateRules.js asks the pack instead of knowing the answer. Pure and
// dependency-free like the module it serves, because this decides what tax a
// client claims: tested directly (test/gst-jurisdiction.test.mjs), and loaded
// server-side by path the way motorVehicle.js and mileage.js are, so the page,
// the background read and the stored document cannot disagree about which
// country's rules were applied.
//
// Singapore is the default everywhere, deliberately. Every existing book is a
// Singapore one, and a jurisdiction nobody has answered for must behave exactly
// as it did before this module existed.

// --- Registration numbers ---------------------------------------------------
// The identifier that says the supplier is registered for the tax it charged.
// It is the load-bearing evidence in both countries, and it is the thing that
// cannot be a trading name, an abbreviation or a misread.

// Singapore: a UEN, or an M-number for a GST-only / overseas-vendor
// registration.
//   53012345M      business (8 digits + letter)
//   201614382R     local company (9 digits + letter, year-prefixed)
//   T08LL1234A     other entities (T/S/R + 2 digits + 2 letters + 4 digits + letter)
//   M90370287L     GST registration / OVR (M + 8 digits + letter)
//   M2-0009302-4   the older GST-only registration, still printed by some
const SG_UEN = [
  /^\d{8}[A-Z]$/,
  /^(19|20)\d{7}[A-Z]$/,
  /^[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]$/,
  // IRAS issues these to entities with no UEN and they are printed two ways:
  // the OVR form M90370287L, and the older M2-0009302-4 / MR-8500071-4 (M, one
  // letter or digit, 7 digits, a check character). Separators are stripped
  // before matching, so one pattern covers both — and it has to, because an
  // overseas vendor billing in foreign currency is exactly where the older form
  // still turns up.
  /^M[A-Z0-9]\d{7}[A-Z0-9]$/,
];

const compact = (value) =>
  String(value || '').toUpperCase().replace(/[\s.\-/]/g, '');

export function isSingaporeGstRegNo(value) {
  const v = compact(value);
  if (!v) return false;
  return SG_UEN.some((re) => re.test(v));
}

// Australia: an ABN — eleven digits with a checksum, printed on every tax
// invoice by law. The checksum is the point of preferring it to a bare digit
// count: "51 824 753 556" and "51 824 753 565" look equally plausible on a
// receipt photographed at an angle, and only one of them is a registration.
//
// Subtract one from the first digit, weight the eleven digits by
// 10,1,3,5,7,9,11,13,15,17,19, and the sum is divisible by 89.
//
// Deliberately NOT an ACN (nine digits): a company number says a company
// exists, not that it is registered for GST, and it is the ABN that a tax
// invoice has to carry.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export function isAbn(value) {
  // The reader is asked for the number and often brings its label with it
  // ("ABN 51 824 753 556"), which is not a misread and should not be refused.
  const v = compact(value).replace(/^ABN/, '');
  if (!/^\d{11}$/.test(v)) return false;
  const sum = v
    .split('')
    .reduce((t, d, i) => t + (Number(d) - (i === 0 ? 1 : 0)) * ABN_WEIGHTS[i], 0);
  return sum % 89 === 0;
}

// --- The packs --------------------------------------------------------------
//
// `auto` is the ONLY set of codes CYBills may reach for from arithmetic alone:
// standard-rated purchases and supplies, plus the zero code. Everything else a
// chart holds — imports, reverse charge, partial exemption, input-taxed,
// capital acquisitions — is a judgement about the underlying transaction that a
// percentage cannot settle, so a percentage never reaches for it.
//
// Matched on the Xero TaxType, which is stable, falling back to the NAME for a
// manually-added rate that carries no code. Anchored, so near-misses in the
// same chart never slip through: BLINPUT2 (Disallowed Expenses), EPINPUT and
// ZERORATEDINPUT in a Singapore chart, and — the one that would actually cost
// money — INPUTTAXED in an Australian one, which is the code for a supply
// carrying NO credit at all and sits one character away from INPUT.
const SINGAPORE = {
  key: 'SG',
  country: 'Singapore',
  // The adjective, for the sentences that say whose tax this is. "Singapore
  // input tax" reads correctly and "Australia input tax" does not, so the pack
  // carries both forms rather than letting a reason line be assembled wrong.
  demonym: 'Singapore',
  taxName: 'GST',
  currency: 'SGD',
  // What the evidence is called where a reason sentence has to name it. The
  // country is part of the label rather than bolted on: "no Singapore GST
  // registration number" reads correctly and "no Australian ABN" does not.
  regNoLabel: 'Singapore GST registration number',
  regNoArticle: 'a Singapore one',
  isRegNo: isSingaporeGstRegNo,
  // What the READER is told to look for and why it matters. The prompt is
  // assembled from the pack rather than written twice, so a book read under
  // these rules is also read by a reader that was told about them — the
  // alternative is a reader hunting for a UEN on an Australian invoice and a
  // decision refusing the ABN it did not ask for.
  regNoDescription:
    'a Singapore UEN or GST registration number — 201614382R, 53012345M, T08LL1234A or M90370287L — ' +
    'usually printed as "GST Reg No", "GST Registration No" or "UEN"',
  confusable: 'a Thai invoice at 7% VAT and a Singapore one at 7% GST look identical in the numbers alone',
  // And the supplier-rule dialog's, which refuses a number the gate would
  // silently ignore. Here rather than in the component for the same reason the
  // reader's wording is: a dialog that described a different number from the
  // one the decision accepts would refuse the right answer.
  regNoField: 'GST registration no.',
  regNoPlaceholder: 'e.g. M8-8001588-5 or 201526186C',
  regNoRefusal:
    'That isn’t a Singapore GST registration number (a UEN like 201526186C, or an M-number like ' +
    'M8-8001588-5). A foreign registration number isn’t Singapore GST, so there is nothing to claim.',
  // What the reader may assume when a document prints a symbol and no code.
  currencyHint:
    'Answer SGD only when nothing on the document — code, symbol, tax rate, registration number or address — says otherwise',
  // A motor vehicle expense incurred here is never claimable (the practice's
  // rule, and IRAS's blocked input tax on motor cars) — see motorVehicle.js.
  blocksMotorVehicle: true,
  auto: {
    cost: { code: /^INPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated purchases$/i },
    sales: { code: /^OUTPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated supplies$/i },
    noTax: { code: /^NONE$/i, name: /^no tax$/i },
  },
  // Xero's own standard-rated codes, by rate. These are the same in every
  // Singapore Xero — INPUTY24 IS 9% standard-rated purchases — so when an
  // organisation has written no rule of its own, this is the answer rather than
  // a guess. Three vintages, because a document dated 2022 is still filed.
  standardCodes: {
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
  },
  // What the decision codes a document to when it declines to claim. One code
  // serves both sides here.
  noTaxCodes: {
    cost: [{ code: 'NONE', name: 'No Tax' }],
    sales: [{ code: 'NONE', name: 'No Tax' }],
  },
  note:
    'Documents here are read under Singapore’s GST rules: the supplier’s UEN or GST registration number is ' +
    'what lets the input tax be claimed, standard-rated purchases at 9% / 8% / 7%, and a motor vehicle ' +
    'expense is always coded No Tax.',
};

const AUSTRALIA = {
  key: 'AU',
  country: 'Australia',
  demonym: 'Australian',
  taxName: 'GST',
  currency: 'AUD',
  regNoLabel: 'ABN',
  regNoArticle: 'a valid ABN',
  isRegNo: isAbn,
  regNoDescription:
    'an Australian Business Number — eleven digits, printed as "ABN", e.g. "ABN 51 824 753 556". ' +
    'An ACN (nine digits) is a company number, not a tax registration, so do not report one as the ABN',
  confusable: 'a New Zealand invoice at 15% GST and an Australian one at 10% are both called GST',
  regNoField: 'ABN',
  regNoPlaceholder: 'e.g. 51 824 753 556',
  regNoRefusal:
    'That isn’t a valid ABN. An ABN is eleven digits whose check digits have to add up (51 824 753 556); ' +
    'an ACN is nine and is a company number, not a tax registration. A number the check refuses would be ' +
    'ignored, so there would be nothing to claim.',
  currencyHint:
    'Answer AUD only when nothing on the document — code, symbol, tax rate, registration number or address — says otherwise',
  // GST on a car, on fuel and on running costs IS claimable in Australia (the
  // car limit caps the credit on buying a car, which is a judgement about one
  // purchase and not a rule about an account). Singapore's blanket rule applied
  // here would quietly strip the credit off every fuel receipt in the book.
  blocksMotorVehicle: false,
  auto: {
    cost: { code: /^INPUT$/i, name: /^gst on expenses$/i },
    sales: { code: /^OUTPUT$/i, name: /^gst on income$/i },
    // GST Free is the ordinary landing place for a purchase carrying no GST;
    // BAS Excluded is for what is outside the return altogether. Both are zero,
    // and both are recognised — which one is PREFERRED is noTaxCodes below.
    noTax: { code: /^(EXEMPTEXPENSES|EXEMPTOUTPUT|BASEXCLUDED)$/i, name: /^(gst free (expenses|income)|bas excluded)$/i },
  },
  // One rate, one vintage: 10% since 2000.
  standardCodes: {
    cost: [{ pct: 10, code: 'INPUT', name: 'GST on Expenses' }],
    sales: [{ pct: 10, code: 'OUTPUT', name: 'GST on Income' }],
  },
  // GST Free Expenses rather than BAS Excluded: a supplier invoice that carries
  // no claimable GST is still a purchase the business reports at G11, where
  // BAS Excluded says the money is outside the return entirely (wages,
  // drawings, a transfer between the entity's own accounts). Declining to claim
  // is not a claim that the spending never happened.
  noTaxCodes: {
    cost: [
      { code: 'EXEMPTEXPENSES', name: 'GST Free Expenses' },
      { code: 'BASEXCLUDED', name: 'BAS Excluded' },
    ],
    sales: [
      { code: 'EXEMPTOUTPUT', name: 'GST Free Income' },
      { code: 'BASEXCLUDED', name: 'BAS Excluded' },
    ],
  },
  note:
    'Documents here are read under Australian GST rules: the supplier’s ABN is what lets the input tax be ' +
    'claimed, GST on Expenses at 10%, nothing claimable is coded GST Free Expenses, and the GST on fuel, ' +
    'parking and running costs is claimed like any other expense.',
};

export const JURISDICTIONS = [SINGAPORE, AUSTRALIA];
export const DEFAULT_JURISDICTION = SINGAPORE;

// The countries the Business profile offers, against the pack each one gets.
// Malaysia and the United Kingdom are in that dropdown and have no pack of
// their own: they fall to Singapore, which is what they did before this module
// existed, and adding a pack is where their rules would go.
const BY_NAME = new Map([
  ['singapore', SINGAPORE],
  ['sg', SINGAPORE],
  ['sgp', SINGAPORE],
  ['australia', AUSTRALIA],
  ['au', AUSTRALIA],
  ['aus', AUSTRALIA],
]);

/**
 * The rules pack for a country, named however the Business profile or Xero
 * spells it ("Australia", "AU"). Singapore for anything unrecognised, empty or
 * absent — every existing book is a Singapore one, and a jurisdiction nobody
 * has answered for has to behave exactly as it did before.
 */
export function jurisdictionFor(country) {
  const key = String(country || '').trim().toLowerCase();
  return BY_NAME.get(key) || DEFAULT_JURISDICTION;
}

/** Is this a country CYBills has rules of its own for? */
export function hasJurisdiction(country) {
  return BY_NAME.has(String(country || '').trim().toLowerCase());
}

/**
 * Does a registration number pass the shape test for this country? The one
 * question `claimableInputTax` and the supplier-rule dialog both ask, so what
 * counts as a number cannot differ between where it is typed and where it is
 * believed.
 */
export function isTaxRegNo(value, country) {
  return jurisdictionFor(country).isRegNo(value);
}

/**
 * What choosing this country actually does, for the settings page to print
 * under the dropdown. A country with no pack of its own is SAID so rather than
 * quietly given Singapore's — that fallback is correct (it is what every book
 * did before there were two) and it is exactly the kind of thing that must not
 * be silent, since it decides whether a client claims its input tax.
 */
export function jurisdictionNote(country) {
  const named = String(country || '').trim();
  if (hasJurisdiction(named)) return jurisdictionFor(named).note;
  return (
    `CYBills has no GST rules of its own for ${named || 'this country'} yet, so documents here are read ` +
    'under Singapore’s. Ask for them to be added before coding a real book this way.'
  );
}
