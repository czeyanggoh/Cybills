// A motor vehicle expense incurred in Singapore is No Tax, in every client's
// book. Tested against the account names the practice's clients actually use —
// "449 - Motor Vehicle Expenses" defaulting to NONE in most charts and to
// INPUTY24 in four — and the receipt that showed it was being broken: an SPC
// petrol receipt printing "TOTAL GST 8.56" on 103.66, coded Standard-Rated.
import { isMotorVehicleCategory, isMotorVehicleExpense, motorVehicleReason } from '../src/lib/motorVehicle.js';
import { taxRateOutcome } from '../src/lib/taxRateRules.js';

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

// --- Which accounts are motor vehicle accounts ------------------------------
// Off the real charts: every one of these is in a client's Xero.
for (const label of [
  '449 - Motor Vehicle Expenses',
  '4601 - T&E Motor Vehicle Expenses',
  '8609 - Motor Vehicle - Petrol',
  '8608 - MAINTENANCE MOTOR VEHICLE',
  '8609 - MAINTENANCE PETROL',
  '450 - Motor Vehicles Maintenance',
  '93509/000 - CAR MAINT',
  '350 - Rental - Car/Space',
  'Parking', // a bridge entity's plain category
  'Transport - Fuel',
  'Road Tax',
]) {
  check(`a motor vehicle account: ${label}`, isMotorVehicleCategory(label), true);
}
for (const label of [
  'Transport - Taxi', // paying somebody else to carry you
  '425 - Freight & Courier',
  '404 - Bank Fees',
  'Credit Card Charges', // "card" is not "car"
  '420 - Entertainment',
  '485 - Subscriptions',
  '318 - Outlet repair & maintenance',
  'Travel - Airfare',
  '',
]) {
  check(`not a motor vehicle account: ${label || '(blank)'}`, isMotorVehicleCategory(label), false);
}

// Either signal is enough; a sale is never an expense.
check('the reader alone decides it', isMotorVehicleExpense({ category: '429 - General Expenses', motorVehicle: true }), true);
check('the account alone decides it', isMotorVehicleExpense({ category: '449 - Motor Vehicle Expenses' }), true);
check('neither, and it is not one', isMotorVehicleExpense({ category: 'Transport - Taxi' }), false);
check('a sales document is never one', isMotorVehicleExpense({ category: '449 - Motor Vehicle Expenses', kind: 'sales' }), false);

// --- The tax decision --------------------------------------------------------
const SG = [
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'Disallowed Expenses', code: 'BLINPUT3Y24', rate: 9 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
];
// The SPC receipt: Singapore GST, a registration number, 9% — everything the
// evidence gate asks for — on a motor vehicle account.
const SPC = { total: 103.66, tax: 8.56, rates: SG, currency: 'SGD', kind: 'cost', gstRegNo: 'M2-0009896-0', taxLabel: 'TOTAL GST' };

const byAccount = taxRateOutcome({ ...SPC, category: '449 - Motor Vehicle Expenses', accountTaxType: 'INPUTY24', accountLabel: '449' });
check('a petrol receipt on a motor vehicle account is No Tax', [byAccount.name, byAccount.claimsTax], ['No Tax', false]);
check('…flagged as decided by the motor vehicle rule', byAccount.motorVehicle, true);
has('…and the reason names the account', byAccount.reason, '449 - Motor Vehicle Expenses');
has('…and how to make the exception', byAccount.reason, 'goods vehicle');

const byPaper = taxRateOutcome({ ...SPC, category: '429 - General Expenses', motorVehicle: true });
check('the reader flagging it beats a non-motor account', [byPaper.name, byPaper.claimsTax], ['No Tax', false]);
has('…and the reason says the document is one', byPaper.reason, 'The document is a motor vehicle expense');

// It beats a code the org's own "when to use" rule matched through the reader.
check('it beats a code the reader matched from an org rule',
  taxRateOutcome({ ...SPC, category: '449 - Motor Vehicle Expenses', suggested: 'Standard-Rated Purchases' }).name, 'No Tax');

// The drawer and the re-read pass only the account CODE as accountLabel; the
// server passes the whole label. Both must work.
check('the whole label arriving as accountLabel is enough',
  taxRateOutcome({ ...SPC, accountLabel: '449 - Motor Vehicle Expenses' }).name, 'No Tax');

// Nothing else moves.
const taxi = taxRateOutcome({ ...SPC, category: 'Transport - Taxi' });
check('a taxi is still ordinary Singapore GST', [taxi.name, taxi.claimsTax], ['Standard-Rated Purchases', true]);
const notRegistered = taxRateOutcome({ ...SPC, category: '449 - Motor Vehicle Expenses', gstRegistered: false });
check("a company that isn't GST-registered keeps its own silent No Tax", [notRegistered.name, notRegistered.reason], ['No Tax', '']);
check('with no rate list at all it is still named No Tax',
  taxRateOutcome({ ...SPC, rates: [], category: '449 - Motor Vehicle Expenses' }).name, 'No Tax');

check('the reason for the paper does not name an account', motorVehicleReason({ motorVehicle: true }).includes('Coded to'), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
