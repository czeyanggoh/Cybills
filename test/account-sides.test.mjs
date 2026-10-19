// Which accounts a document may be coded to: a cost's expense accounts, plus
// the asset accounts somebody switched on — never one nobody did, never a
// system account Xero refuses on a bill line, never a bank account.
import { accountsForSide, isAssetAccount, shownAssetKeys } from '../src/lib/accountSides.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const chart = [
  { code: '429', name: 'General Expenses', type: 'EXPENSE' },
  { code: '310', name: 'Cost of Goods Sold', type: 'DIRECTCOSTS' },
  { code: '200', name: 'Sales', type: 'REVENUE' },
  { code: '710', name: 'Office Equipment', type: 'FIXED' },
  { code: '711', name: 'Less Accumulated Depreciation', type: 'FIXED' },
  { code: '620', name: 'Prepayments', type: 'PREPAYMENT' },
  { code: '610', name: 'Accounts Receivable', type: 'CURRENT', systemAccount: 'DEBTORS' },
  { code: '090', name: 'Business Bank Account', type: 'BANK' },
];
const codes = (list) => list.map((a) => a.code);

check('a cost with nothing switched on is its expense accounts', codes(accountsForSide(chart, 'cost')), ['429', '310']);
check('an asset switched on joins the cost side', codes(accountsForSide(chart, 'cost', new Set(['710']))), ['429', '310', '710']);
check('…and only that one', codes(accountsForSide(chart, 'cost', new Set(['710', '620']))), ['429', '310', '710', '620']);
check('a system account is never offered, even switched on', codes(accountsForSide(chart, 'cost', new Set(['610']))), ['429', '310']);
check('a bank account is never offered, even switched on', codes(accountsForSide(chart, 'cost', new Set(['090']))), ['429', '310']);
check('a sale is its revenue accounts, assets or not', codes(accountsForSide(chart, 'sales', new Set(['710']))), ['200']);
check('a fixed asset is an asset', isAssetAccount(chart[3]), true);
check('an expense is not', isAssetAccount(chart[0]), false);

check('the switched-on set is read off the Lists blob', [...shownAssetKeys({ shown: { categories: ['710'] } })], ['710']);
check('junk reads as nothing switched on', [...shownAssetKeys({ shown: 'x' })], []);
check('no blob reads as nothing switched on', [...shownAssetKeys(null)], []);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
