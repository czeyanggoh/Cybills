// Which tax code a read document gets. This decides what GST a client claims,
// and — just as importantly — says why when it declines, because a blank tax
// rate with no explanation is indistinguishable from a bug.
import { taxRateOutcome, inferTaxRateName, noTaxRateName } from '../src/lib/taxRateRules.js';

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

// Red Alpha's real Singapore chart, as the relay hands it over (ACTIVE +
// expense-applicable rates only).
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

// 1) The Apple/LinkedIn invoice that started this: 69.98 total, 5.78 GST.
let r = taxRateOutcome({ total: 69.98, tax: 5.78, rates: SG, currency: 'SGD', kind: 'cost' });
check('9% invoice codes to standard-rated purchases', r.name, 'Standard-Rated Purchases');
has('and says how it got there', r.reason, '9.0%');

// 2) The same invoice when that code isn't in the org's visible list. It is
//    still not guessed — but the blank now explains itself.
const hidden = SG.filter((t) => t.code !== 'INPUTY24');
r = taxRateOutcome({ total: 69.98, tax: 5.78, rates: hidden, currency: 'SGD', kind: 'cost' });
check('no standard-rated code at that rate -> blank', r.name, '');
has('reason names the rate', r.reason, '9.0%');
has('reason points at the list', r.reason, 'Business settings');
has('reason names what IS at that rate', r.reason, 'Disallowed Expenses');

// 3) …unless the ACCOUNT itself carries that code. 4016 T&E Subscriptions
//    defaults to INPUTY24 in Xero, so the document follows the account — the
//    same thing Xero's own UI does when you pick an account.
r = taxRateOutcome({ total: 69.98, tax: 5.78, rates: SG, currency: 'SGD', kind: 'cost', accountTaxType: 'INPUTY24', accountLabel: '4016' });
check('account code wins when the GST agrees', r.name, 'Standard-Rated Purchases');
has('and says it was the account', r.reason, "4016 account's own tax code");

// 4) The case arithmetic alone gets WRONG: an account whose Xero default is
//    Disallowed Expenses at 9%. "9%, therefore claimable" would wrongly claim
//    input tax the org has decided isn't claimable.
r = taxRateOutcome({ total: 109, tax: 9, rates: SG, currency: 'SGD', kind: 'cost', accountTaxType: 'BLINPUT3Y24', accountLabel: '4200' });
check('a disallowed-expense account keeps its own code', r.name, 'Disallowed Expenses');

// 5) An account default that DISAGREES with the printed GST is ignored — the
//    document is the evidence, not the account.
r = taxRateOutcome({ total: 107, tax: 7, rates: SG, currency: 'SGD', kind: 'cost', accountTaxType: 'INPUTY24', accountLabel: '4016' });
check('7% document does not take a 9% account code', r.name, '2022 Standard-Rated Purchases');

// 6) Vintages stay apart, and a foreign rate never snaps to a local one.
check('8% lands on 2023', inferTaxRateName(108, 8, SG, { currency: 'SGD' }), '2023 Standard-Rated Purchases');
check('10% AU invoice is not forced onto 9%', taxRateOutcome({ total: 110, tax: 10, rates: SG, currency: 'SGD' }).name, '');
r = taxRateOutcome({ total: 110, tax: 10, rates: SG, currency: 'AUD' });
check('foreign document with a foreign rate -> No Tax', r.name, 'No Tax');
has('and says why nothing is claimed', r.reason, "isn't Singapore input tax");

// 7) Sales documents code to supplies, not purchases.
check('sales side', taxRateOutcome({ total: 109, tax: 9, rates: SG, currency: 'SGD', kind: 'sales' }).name, 'Standard-Rated Supplies');

// 8) Nothing visible at all — the reason has to send someone somewhere.
r = taxRateOutcome({ total: 109, tax: 9, rates: [], currency: 'SGD' });
check('empty list -> blank', r.name, '');
has('empty list reason', r.reason, 'no tax rates are visible');

// 9) Not GST-registered: No Tax, always; the screens explain that themselves.
r = taxRateOutcome({ total: 109, tax: 9, rates: SG, gstRegistered: false });
check('not registered -> No Tax', [r.name, r.reason], ['No Tax', '']);

// 10) A code the org's own written rule matched keeps the reader's reason.
r = taxRateOutcome({ total: 109, tax: 9, rates: SG, suggested: 'Bad Debt Relief' });
check('a matched rule wins, silently', [r.name, r.reason], ['Bad Debt Relief', '']);
check('a suggestion the org does not have is ignored', taxRateOutcome({ total: 109, tax: 9, rates: SG, suggested: 'Nonsense' }).name, 'Standard-Rated Purchases');

// 11) No tax charged: the configured default, else No Tax.
check('no tax -> configured default', taxRateOutcome({ total: 100, tax: 0, rates: SG, defaultName: 'Zero-Rated Purchases' }).name, 'Zero-Rated Purchases');
check('no tax, no default -> No Tax', taxRateOutcome({ total: 100, tax: 0, rates: SG }).name, 'No Tax');

// 12) The No Tax lookup every screen shares.
check('noTaxRateName', [noTaxRateName(SG), noTaxRateName([]), noTaxRateName(hidden.filter((t) => t.code !== 'NONE'))], ['No Tax', '', '']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
