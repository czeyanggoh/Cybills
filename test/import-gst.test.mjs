// Import GST: which account and which label it is, what code it takes, and that
// the account is offered only once switched on.
import { isImportGstCategory, isImportGstDocument, codeImportGstRows, importGstRateName } from '../src/lib/importGst.js';
import { accountsForSide, isAssetAccount, readerDescription } from '../src/lib/accountSides.js';
import { taxRateOutcome } from '../src/lib/taxRateRules.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const gst = { code: '820', name: 'GST', type: 'CURRLIAB', systemAccount: 'GST', description: 'owing to your tax authority' };
const freight = { code: '425', name: 'Freight Inwards Charges', type: 'EXPENSE', description: 'courier & freight' };
const payable = { code: '800', name: 'Accounts Payable', type: 'CURRLIAB', systemAccount: 'CREDITORS' };
const chart = [freight, gst, payable];
const codes = (list) => list.map((a) => a.code);

check('the GST account is not offered until switched on', codes(accountsForSide(chart, 'cost')), ['425']);
check('switched on, it joins the cost side', codes(accountsForSide(chart, 'cost', new Set(['820']))), ['425', '820']);
check('another system account never does', codes(accountsForSide(chart, 'cost', new Set(['800']))), ['425']);
const accrued = { code: '802', name: 'Accrued Expenses', type: 'CURRLIAB', description: '' };
check('a liability is off until switched on', codes(accountsForSide([...chart, accrued], 'cost')), ['425']);
check('then offered for a cost', codes(accountsForSide([...chart, accrued], 'cost', new Set(['802', '800']))), ['425', '802']);
check('and never for a sale', codes(accountsForSide([accrued], 'sales', new Set(['802']))), []);
check('the reader may not infer an accrual', readerDescription(accrued).includes('use ONLY where'), true);
check('nor is it a sales category', codes(accountsForSide(chart, 'sales', new Set(['820']))), []);
check('it is not an asset', isAssetAccount(gst), false);
check('the reader is told what it is for', readerDescription(gst).startsWith('Import GST ONLY'), true);
check('every other account keeps its own description', readerDescription(freight), 'courier & freight');

check('the stored label names it', isImportGstCategory('820 - GST'), true);
check('a plain bridge category called GST does not', isImportGstCategory('GST'), false);
check('nor an expense account about GST', isImportGstCategory('461 - GST Expense'), false);

const rates = [
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
  { name: 'GST on Imports', code: 'TAX002', rate: 0 },
];
check('the rate is found by name', importGstRateName(rates), 'GST on Imports');
check('or by Xero’s own type', importGstRateName([{ name: 'Import GST', code: 'GSTONIMPORTS' }]), 'Import GST');

const outcome = taxRateOutcome({ total: 2297.85, tax: 0, rates, category: '820 - GST', gstRegistered: true });
check('a read onto the GST account takes the import code', [outcome.name, outcome.claimsTax], ['GST on Imports', false]);
check(
  'even where it is switched off in Lists',
  taxRateOutcome({ total: 100, tax: 100, rates: [], allRates: rates, category: '820 - GST' }).name,
  'GST on Imports'
);
check(
  'not for a company that is not registered',
  taxRateOutcome({ total: 100, tax: 0, rates, category: '820 - GST', gstRegistered: false }).name,
  'No Tax'
);

check('one total on the account is an import GST document', isImportGstDocument({ category: '820 - GST' }), true);
check(
  'a bill with a freight row beside it is not',
  isImportGstDocument({ category: '820 - GST', lineItems: [{ category: '425 - Freight Inwards Charges' }] }),
  false
);
check(
  'its GST row alone takes the code',
  codeImportGstRows([{ category: '425 - Freight Inwards Charges', taxRate: '' }, { category: '820 - GST', tax: 0 }]).map((r) => r.taxRate || ''),
  ['', 'GST on Imports']
);
check('a row carrying tax is left for a person', codeImportGstRows([{ category: '820 - GST', tax: '9.00' }]), null);

if (failures) process.exit(1);
