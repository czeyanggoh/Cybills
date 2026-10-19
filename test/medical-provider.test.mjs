// A bill from a hospital or clinic is No Tax, in every client's book. Tested
// against the invoice that showed it was being missed: Novena Heart Centre,
// "GST and Co Reg No: 201807754R", "GST 9%" 20.65 on 250.05 — everything the
// evidence gate asks for — coded Standard-Rated.
import { isMedicalProviderName, isMedicalProviderExpense, medicalProviderReason } from '../src/lib/medicalProvider.js';
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

// --- Which names are a hospital or clinic -----------------------------------
for (const name of [
  'Mount Elizabeth Hospital',
  'Raffles Medical Clinic Pte Ltd',
  'Bedok Polyclinic',
  'Q&M Dental Centre',
  'Novena Heart Centre',
  'Singapore Medical Center',
  'Parkway Shenton Specialist Centre',
  'MINMED HEALTH SCREENING CLINIC',
]) {
  check(`a hospital or clinic: ${name}`, isMedicalProviderName(name), true);
}
for (const name of [
  'Hospitality Partners Pte Ltd', // whole words only
  'Clinical Supplies Pte Ltd',
  'Guardian Health & Beauty', // a pharmacy, not a clinic
  'Innoquest Diagnostics',
  'Suntec City Centre', // a shopping centre
  'Mount Pleasant Veterinary Clinic', // an animal's clinic
  'Grab',
  '',
]) {
  check(`not a hospital or clinic: ${name || '(blank)'}`, isMedicalProviderName(name), false);
}

check('the reader alone decides it', isMedicalProviderExpense({ supplier: 'TCI Cardiology Pte Ltd', medicalProvider: true }), true);
check('the name alone decides it', isMedicalProviderExpense({ supplier: 'Mount Elizabeth Hospital' }), true);
check('neither, and it is not one', isMedicalProviderExpense({ supplier: 'Grab' }), false);
check('a sales document is never one', isMedicalProviderExpense({ supplier: 'Mount Elizabeth Hospital', kind: 'sales' }), false);

// --- The tax decision --------------------------------------------------------
const SG = [
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
];
const NOVENA = { total: 250.05, tax: 20.65, rates: SG, currency: 'SGD', kind: 'cost', gstRegNo: '201807754R', taxLabel: 'GST 9%', printedRate: 9 };

const byName = taxRateOutcome({ ...NOVENA, supplier: 'Novena Heart Centre', category: '8007 - STAFF MEDICAL' });
check('the Novena invoice is No Tax', [byName.name, byName.claimsTax], ['No Tax', false]);
check('…flagged as decided by the medical rule', byName.medicalProvider, true);
has('…and the reason names the supplier', byName.reason, 'Novena Heart Centre is a hospital or clinic');

const byPaper = taxRateOutcome({ ...NOVENA, supplier: 'TCI Cardiology Pte Ltd', medicalProvider: true, category: '420 - Entertainment' });
check('the reader flagging it is enough, whatever the account', [byPaper.name, byPaper.claimsTax], ['No Tax', false]);

check('it beats a code the reader matched from an org rule',
  taxRateOutcome({ ...NOVENA, supplier: 'Novena Heart Centre', suggested: 'Standard-Rated Purchases' }).name, 'No Tax');

const ordinary = taxRateOutcome({ ...NOVENA, supplier: 'Challenger Technologies' });
check('any other registered supplier still claims GST', [ordinary.name, ordinary.claimsTax], ['Standard-Rated Purchases', true]);
const notRegistered = taxRateOutcome({ ...NOVENA, supplier: 'Novena Heart Centre', gstRegistered: false });
check("a company that isn't GST-registered keeps its own silent No Tax", [notRegistered.name, notRegistered.reason], ['No Tax', '']);

has('the reason without a name still says why', medicalProviderReason({}), 'The supplier is a hospital or clinic');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
