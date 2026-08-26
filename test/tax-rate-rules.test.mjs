// Which tax code a read document gets. This decides what GST a client claims,
// so the two questions it answers are tested directly: is the tax on this
// document Singapore GST at all, and if so which code — and it must say why
// either way, because a blank tax rate with no explanation is indistinguishable
// from a bug.
import {
  taxRateOutcome,
  inferTaxRateName,
  noTaxRateName,
  isSingaporeGstRegNo,
  claimableSgGst,
  zeroTaxRate,
} from '../src/lib/taxRateRules.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const has = (name, text, needle) => {
  const ok = String(text || '').includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL ${JSON.stringify(text)} does not contain ${JSON.stringify(needle)}`}  ${name}`);
};

// Red Alpha's real Singapore chart, as the relay hands it over.
const SG = [
  { name: '2022 Standard-Rated Purchases', code: 'INPUT', rate: 7 },
  { name: '2023 Standard-Rated Purchases', code: 'INPUTY23', rate: 8 },
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'Standard-Rated Supplies', code: 'OUTPUTY24', rate: 9 },
  { name: 'Disallowed Expenses', code: 'BLINPUT3Y24', rate: 9 },
  { name: 'Bad Debt Relief', code: 'BADDEBTRELIEFY24', rate: 9 },
  { name: 'Zero-Rated Purchases', code: 'ZERORATEDINPUT', rate: 0 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
];
// A Singapore supplier's evidence: its GST registration number, and a document
// that calls the tax GST.
const SGGST = { gstRegNo: '201614382R', taxLabel: 'GST 9%' };
const ask = (o) => taxRateOutcome({ rates: SG, currency: 'SGD', kind: 'cost', ...SGGST, ...o });

// --- Is it Singapore GST at all? --------------------------------------------
check('UEN shapes IRAS issues', [
  isSingaporeGstRegNo('201614382R'), // local company
  isSingaporeGstRegNo('53012345M'), // business
  isSingaporeGstRegNo('T08LL1234A'), // other entity
  isSingaporeGstRegNo('M90370287L'), // GST-only / overseas vendor
  isSingaporeGstRegNo('M9-0370287-L'), // punctuation as printed
], [true, true, true, true, true]);
check('and what is not one', [
  isSingaporeGstRegNo(''),
  isSingaporeGstRegNo('51 824 753 556'), // an Australian ABN
  isSingaporeGstRegNo('GB123456789'), // a UK VAT number
  isSingaporeGstRegNo('0105558012345'), // a Thai tax id
], [false, false, false, false]);
check('a tax the document calls something else is not GST', [
  claimableSgGst({ gstRegNo: '201614382R', taxLabel: 'GST' }),
  claimableSgGst({ gstRegNo: '201614382R', taxLabel: 'VAT 7%' }),
  claimableSgGst({ gstRegNo: '201614382R', taxLabel: 'Sales Tax' }),
  claimableSgGst({ gstRegNo: '201614382R', taxLabel: '' }), // silent: the number decides
], [true, false, false, true]);

// --- The claim -------------------------------------------------------------
// 1) The invoice that started this: 69.98 total, 5.78 GST, SG supplier.
let r = ask({ total: 69.98, tax: 5.78 });
check('9% from a registered SG supplier is claimed', [r.name, r.claimsTax], ['Standard-Rated Purchases', true]);
has('and says how it got there', r.reason, '9.0%');

// 2) A THAI invoice at 7% VAT, billed in SGD. The numbers are indistinguishable
//    from Singapore's 2022 rate — only the wording and the registration number
//    tell them apart, and neither says Singapore.
r = ask({ total: 107, tax: 7, gstRegNo: '0105558012345', taxLabel: 'VAT 7%' });
check('foreign VAT at a Singapore-looking rate is not claimed', [r.name, r.claimsTax], ['No Tax', false]);
has('and says the registration is not Singapore', r.reason, "isn't a Singapore one");

// 3) An Australian invoice at 10% with an ABN.
r = ask({ total: 110, tax: 10, currency: 'AUD', gstRegNo: '51 824 753 556', taxLabel: 'GST' });
check('Australian GST is not Singapore input tax', [r.name, r.claimsTax], ['No Tax', false]);

// 3b) …even when it is billed in SGD and its rate is a Singapore one. This is
//     the case a percentage alone gets wrong.
r = ask({ total: 108, tax: 8, gstRegNo: '51 824 753 556', taxLabel: 'GST 8%' });
check('a foreign supplier at 8% in SGD is still not claimed', [r.name, r.claimsTax], ['No Tax', false]);

// 4) No registration number at all. IRAS requires it on a tax invoice — a
//    simplified one included — so there is nothing to support a claim.
r = ask({ total: 109, tax: 9, gstRegNo: '', taxLabel: 'GST' });
check('no registration number -> not claimed', [r.name, r.claimsTax], ['No Tax', false]);
has('reason says what is missing', r.reason, 'no Singapore GST registration number');
has('reason says what to do about it', r.reason, 'set the code by hand');

// 5) An overseas-vendor (OVR) registration IS a Singapore registration.
r = ask({ total: 69.98, tax: 5.78, gstRegNo: 'M90370287L', taxLabel: 'GST charged at 9%' });
check('an OVR-registered supplier is claimed', [r.name, r.claimsTax], ['Standard-Rated Purchases', true]);

// 6) Sales documents are our own output tax — the supplier evidence is about
//    what we are charged, so it does not gate the supplies side.
check('sales side unaffected', taxRateOutcome({ total: 109, tax: 9, rates: SG, currency: 'SGD', kind: 'sales' }).name, 'Standard-Rated Supplies');

// --- Which code, once it IS Singapore GST ------------------------------------
// 7) The account's own Xero code wins when the GST agrees with it.
r = ask({ total: 69.98, tax: 5.78, accountTaxType: 'INPUTY24', accountLabel: '4016' });
check('account code wins when the GST agrees', r.name, 'Standard-Rated Purchases');
has('and says it was the account', r.reason, "4016 account's own tax code");

// 8) The case arithmetic alone gets wrong: an account defaulting to Disallowed
//    Expenses at 9%. "9%, therefore claimable" would wrongly claim it.
check('a disallowed-expense account keeps its own code',
  ask({ total: 109, tax: 9, accountTaxType: 'BLINPUT3Y24', accountLabel: '4200' }).name, 'Disallowed Expenses');

// 9) An account default that disagrees with the printed GST is ignored.
check('7% document does not take a 9% account code',
  ask({ total: 107, tax: 7, accountTaxType: 'INPUTY24', accountLabel: '4016' }).name, '2022 Standard-Rated Purchases');

// 10) Vintages stay apart.
check('8% lands on 2023', ask({ total: 108, tax: 8 }).name, '2023 Standard-Rated Purchases');

// 11) INPUTY24 is 9% purchases in every Singapore Xero, so a code switched off
//     in Lists is still the answer — named as this organisation names it when
//     the unfiltered list can say.
const hidden = SG.filter((t) => t.code !== 'INPUTY24');
r = ask({ total: 69.98, tax: 5.78, rates: hidden });
check("switched off -> Xero's standard code anyway", r.name, 'Standard-Rated Purchases');
has('reason names the code', r.reason, 'INPUTY24');
has('reason says it is not switched on', r.reason, 'Business settings');
check("the org's own name wins over Xero's default one",
  ask({ total: 69.98, tax: 5.78, rates: hidden, allRates: [...hidden, { name: 'GST 9% (purchases)', code: 'INPUTY24', rate: 9 }] }).name,
  'GST 9% (purchases)');
check('no list at all -> the standard code', ask({ total: 109, tax: 9, rates: [] }).name, 'Standard-Rated Purchases');

// 12) A rate that isn't a standard one is still left for a human: import,
//     reverse-charge and partially-exempt codes print as percentages too.
r = ask({ total: 112, tax: 12, rates: [...SG, { name: 'Some 12% code', code: 'WEIRD12', rate: 12 }] });
check('a non-standard rate is not guessed', [r.name, r.claimsTax], ['', false]);
has('reason names the rate', r.reason, '12.0%');
has('reason names what IS at that rate', r.reason, 'Some 12% code');

// 13) Not GST-registered ourselves: No Tax, always.
r = taxRateOutcome({ total: 109, tax: 9, rates: SG, gstRegistered: false, ...SGGST });
check('not registered -> No Tax', [r.name, r.reason, r.claimsTax], ['No Tax', '', false]);

// 14) A code the org's own written rule matched keeps the reader's reason.
r = ask({ total: 109, tax: 9, suggested: 'Bad Debt Relief' });
check('a matched rule wins, silently', [r.name, r.reason], ['Bad Debt Relief', '']);
check('a suggestion the org does not have is ignored', ask({ total: 109, tax: 9, suggested: 'Nonsense' }).name, 'Standard-Rated Purchases');

// 15) No tax charged: the configured default, else No Tax.
check('no tax -> configured default', ask({ total: 100, tax: 0, defaultName: 'Zero-Rated Purchases' }).name, 'Zero-Rated Purchases');
check('no tax, no default -> No Tax', ask({ total: 100, tax: 0 }).name, 'No Tax');
check('8% lands on 2023 (name-only helper)', inferTaxRateName(108, 8, SG, { currency: 'SGD', ...SGGST }), '2023 Standard-Rated Purchases');

// 16) The No Tax lookup every screen shares.
check('noTaxRateName', [noTaxRateName(SG), noTaxRateName([]), noTaxRateName(hidden.filter((t) => t.code !== 'NONE'))], ['No Tax', '', '']);


// --- No Tax means no tax -----------------------------------------------------
// The invariant, not a preference: "No Tax" with 65.25 of GST beside it is not
// a document anybody can act on. The total never moves — only the split does.
{
  const RATES = [
    { name: 'No Tax', code: 'NONE', rate: 0 },
    { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
    { name: 'Zero Rated Purchases', code: 'ZERORATEDINPUT', rate: 0 },
  ];
  check('the org\'s own zero rate carries no tax', zeroTaxRate('No Tax', RATES), true);
  check('a zero-rated code carries none either', zeroTaxRate('Zero Rated Purchases', RATES), true);
  check('a standard rate does carry tax', zeroTaxRate('Standard-Rated Purchases', RATES), false);

  // Undecided is not a decision. A blank tax rate is what a reader leaves when
  // it has no code to offer, and zeroing the amount there would destroy a
  // figure nobody has ruled on.
  check('a blank rate decides nothing', zeroTaxRate('', RATES), false);
  check('...nor does a missing one', zeroTaxRate(null, RATES), false);

  // Server-side there is no Xero list to consult, so the names Xero ships for
  // zero-tax codes have to answer on their own.
  check('No Tax is recognised without a list', zeroTaxRate('No Tax'), true);
  check('Tax Exempt is recognised without a list', zeroTaxRate('Tax Exempt'), true);
  check('GST Free is recognised without a list', zeroTaxRate('gst free'), true);
  check('a standard rate is not, without a list', zeroTaxRate('Standard-Rated Purchases'), false);

  // The list wins over the name where both are to hand: an org that has renamed
  // its 9% code "No Tax" would otherwise have its GST silently zeroed.
  check('the org\'s own list beats the name', zeroTaxRate('No Tax', [{ name: 'No Tax', code: 'INPUTY24', rate: 9 }]), false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
