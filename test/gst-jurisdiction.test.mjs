// WHICH country's GST rules a book is read under.
//
// Two things are tested here and they are not the same. First, that Australia's
// rules are Australia's: an ABN passes where a UEN does not, 10% lands on GST
// on Expenses, nothing claimable lands on GST Free Expenses rather than a "No
// Tax" no Australian chart has, and a petrol receipt keeps its credit. And
// second — the half that matters more, because it is every book the practice
// already has — that nothing moved for Singapore: every Singapore assertion in
// test/tax-rate-rules.test.mjs still holds with no country named at all, and
// the ones repeated below are the ones an Australian pack could plausibly have
// broken.
import {
  jurisdictionFor,
  jurisdictionNote,
  hasJurisdiction,
  isAbn,
  isSingaporeGstRegNo,
  isTaxRegNo,
} from '../src/lib/gstJurisdiction.js';
import { taxRateOutcome, noTaxRateName, claimableInputTax, zeroTaxRate } from '../src/lib/taxRateRules.js';

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
const hasNot = (name, text, needle) => {
  const ok = !String(text || '').includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL ${JSON.stringify(text)} contains ${JSON.stringify(needle)}`}  ${name}`);
};

// --- Picking the pack -------------------------------------------------------
check('Australia by name', jurisdictionFor('Australia').key, 'AU');
check('…and by the code Xero gives', jurisdictionFor('AU').key, 'AU');
check('Singapore by name', jurisdictionFor('Singapore').key, 'SG');
// The default is the whole safety of this change: every book that exists is a
// Singapore one, and one nobody has answered for must not move.
check('nothing named is Singapore', jurisdictionFor('').key, 'SG');
check('…and so is undefined', jurisdictionFor(undefined).key, 'SG');
check('…and so is a country with no pack', jurisdictionFor('Malaysia').key, 'SG');
check('but that fallback is not claimed as a rule', hasJurisdiction('Malaysia'), false);
has('…and the settings page says so out loud', jurisdictionNote('Malaysia'), 'no GST rules of its own for Malaysia');

// --- ABNs -------------------------------------------------------------------
// The ATO's own example, and the same number with two digits transposed: the
// point of the checksum is that the second one is not a registration, and a
// receipt photographed at an angle produces exactly that.
check('a valid ABN', isAbn('51 824 753 556'), true);
check('…however it is punctuated', isAbn('51824753556'), true);
check('…and with its label read along with it', isAbn('ABN 51 824 753 556'), true);
check('a transposed ABN fails the checksum', isAbn('51 824 753 565'), false);
check('an ACN is not an ABN', isAbn('004085616'), false);
check('nor is a UEN', isAbn('201614382R'), false);
check('nor is nothing', isAbn(''), false);
// The two shapes never answer for each other, which is what keeps one book's
// evidence out of the other's.
check('a UEN is not evidence in Australia', isTaxRegNo('201614382R', 'Australia'), false);
check('an ABN is not evidence in Singapore', isTaxRegNo('51824753556', 'Singapore'), false);
check('an ABN is evidence in Australia', isTaxRegNo('51824753556', 'Australia'), true);
check('a UEN is evidence in Singapore', isTaxRegNo('201614382R', 'Singapore'), true);
check('…and with no country named, Singapore decides', isTaxRegNo('201614382R'), true);

// --- The evidence gate ------------------------------------------------------
check('AU: an ABN and a tax called GST claims',
  claimableInputTax({ gstRegNo: '51824753556', taxLabel: 'GST 10%', country: 'Australia' }), true);
check('AU: no ABN, no claim',
  claimableInputTax({ gstRegNo: '', taxLabel: 'GST 10%', country: 'Australia' }), false);
check('AU: an ABN beside VAT is somebody else’s tax',
  claimableInputTax({ gstRegNo: '51824753556', taxLabel: 'VAT 20%', country: 'Australia' }), false);
// The restatement proof is a requirement in both countries, so it stands alone
// in both: a supplier billing in USD that prints the GST in the local currency
// is registered for the local tax, whatever number the reader missed.
check('AU: a restatement in AUD is proof on its own',
  claimableInputTax({ gstRegNo: '', taxLabel: '', restatedInBase: true, country: 'Australia' }), true);

// --- An Australian chart ----------------------------------------------------
// The codes Xero ships for an Australian organisation. INPUTTAXED is in the
// list on purpose: it is one character from INPUT, it is zero-rated, and
// reaching for it would claim nothing while looking like it had.
const AU = [
  { name: 'GST on Expenses', code: 'INPUT', rate: 10 },
  { name: 'GST on Income', code: 'OUTPUT', rate: 10 },
  { name: 'GST Free Expenses', code: 'EXEMPTEXPENSES', rate: 0 },
  { name: 'GST Free Income', code: 'EXEMPTOUTPUT', rate: 0 },
  { name: 'BAS Excluded', code: 'BASEXCLUDED', rate: 0 },
  { name: 'Input Taxed', code: 'INPUTTAXED', rate: 0 },
  { name: 'GST on Imports', code: 'GSTONIMPORTS', rate: 0 },
];
const au = (o) => taxRateOutcome({
  rates: AU, currency: 'AUD', baseCurrency: 'AUD', kind: 'cost', country: 'Australia',
  gstRegNo: '51 824 753 556', taxLabel: 'GST 10%', ...o,
});

const claimed = au({ total: 110, tax: 10 });
check('10% from an ABN supplier is claimed', claimed.name, 'GST on Expenses');
check('…and it claims the tax', claimed.claimsTax, true);
has('…saying how it got there', claimed.reason, '10.0%');

// Nothing claimable is GST Free Expenses, not "No Tax" (no Australian chart has
// one) and not BAS Excluded (which says the money is outside the return
// altogether — declining to claim is not a claim that nothing was spent).
const noAbn = au({ total: 110, tax: 10, gstRegNo: '' });
check('no ABN -> GST Free Expenses', noAbn.name, 'GST Free Expenses');
check('…and the tax is not recorded', noAbn.claimsTax, false);
has('…and the reason names what is missing', noAbn.reason, 'no ABN');
has('…and whose tax it would have been', noAbn.reason, 'Australian input tax');
hasNot('…and never mentions Singapore', noAbn.reason, 'Singapore');
check('a UEN is not an ABN', au({ total: 110, tax: 10, gstRegNo: '201614382R' }).name, 'GST Free Expenses');
has('…and says which number it refused', au({ total: 110, tax: 10, gstRegNo: '201614382R' }).reason, '201614382R');

// 15% is New Zealand's GST, called by the same name. The evidence gate cannot
// catch it (a NZ supplier may hold an ABN), so the RATE does: it is not a code
// in this chart, and it is not guessed at.
const nz = { total: 115, tax: 15, taxLabel: 'GST 15%' };
check('15% is not an Australian rate', au(nz).name, '');
has('…and the decline says so', au(nz).reason, '15.0%');
check('…and nothing is claimed', au(nz).claimsTax, false);

// The zero code is the entity's own name for it, everywhere one is printed.
check('the zero code in an Australian chart', noTaxRateName(AU, { country: 'Australia' }), 'GST Free Expenses');
check('…on the sales side', noTaxRateName(AU, { country: 'Australia', kind: 'sales' }), 'GST Free Income');
// And the names an Australian chart uses are recognised as carrying no tax even
// with no rate list to hand, which is the server's case on a write.
check('BAS Excluded carries no tax', zeroTaxRate('BAS Excluded'), true);
check('…and so does GST Free Expenses', zeroTaxRate('GST Free Expenses'), true);
check('…and Input Taxed', zeroTaxRate('Input Taxed'), true);
check('…but GST on Expenses does', zeroTaxRate('GST on Expenses'), false);
// INPUTTAXED is zero-rated and one character from INPUT: reached from a
// percentage it would claim nothing while looking like a claim.
check('a 10% document never reaches for Input Taxed', claimed.name !== 'Input Taxed', true);

// --- The motor vehicle rule is Singapore's ----------------------------------
// The one that costs real money if it travels: an Australian business claims
// the GST on fuel, parking and running costs like any other expense.
const fuelAu = au({ total: 110, tax: 10, category: '449 - Motor Vehicle Expenses' });
check('AU: a petrol receipt keeps its credit', fuelAu.name, 'GST on Expenses');
check('…and claims the tax', fuelAu.claimsTax, true);
check('AU: the reader’s own motor-vehicle flag changes nothing either',
  au({ total: 110, tax: 10, motorVehicle: true }).name, 'GST on Expenses');

// --- And Singapore did not move ---------------------------------------------
const SG = [
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
];
const sg = (o) => taxRateOutcome({
  rates: SG, currency: 'SGD', kind: 'cost',
  gstRegNo: '201614382R', taxLabel: 'GST 9%', ...o,
});
check('SG: 9% from a UEN supplier is still claimed', sg({ total: 109, tax: 9 }).name, 'Standard-Rated Purchases');
check('SG: a petrol receipt is still No Tax',
  sg({ total: 109, tax: 9, category: '449 - Motor Vehicle Expenses' }).name, 'No Tax');
has('SG: …for Singapore’s own reason',
  sg({ total: 109, tax: 9, category: '449 - Motor Vehicle Expenses' }).reason, 'incurred in Singapore');
check('SG: an ABN is not evidence here', sg({ total: 110, tax: 10, gstRegNo: '51824753556' }).name, 'No Tax');
check('SG: the zero code is still No Tax', noTaxRateName(SG), 'No Tax');
// Named explicitly or not at all, Singapore answers the same — which is what
// makes every stored book safe to leave alone.
check('SG: naming Singapore changes nothing',
  JSON.stringify(sg({ total: 109, tax: 9, country: 'Singapore' })),
  JSON.stringify(sg({ total: 109, tax: 9 })));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
