// A cost coded to a recharge account, with a customer named, is Rebillable —
// the case that showed it: a Tiong Bahru chicken rice receipt read for MERIDIAN
// GROUP HOLDINGS, coded "1354 - RECOVERABLE EXPENSES - PREPAYMENT", with the
// Rebillable switch left off.
import { isRechargeAccount, rebillableFor } from '../src/lib/recharge.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

for (const label of [
  '1354 - RECOVERABLE EXPENSES - PREPAYMENT',
  '261 - Recharge to clients',
  'Disbursements recoverable',
  '480 - Reimbursable Expenses',
  '262 - Costs incurred on behalf of clients',
]) {
  check(`a recharge account: ${label}`, isRechargeAccount(label), true);
}
for (const label of [
  '2200 - Reimbursements - ST Engineering', // staff paid back, not a client billed
  '489 - Telephone & Internet',
  '420 - Entertainment',
  'Transport - Taxi',
  '',
]) {
  check(`not a recharge account: ${label || '(blank)'}`, isRechargeAccount(label), false);
}
check('a description saying so is enough',
  isRechargeAccount('261 - Client costs', 'Costs incurred on behalf of client, which we will recharge back to them'), true);
check('a prepaid mobile "recharge" is not',
  isRechargeAccount('489 - Telephone', 'Mobile plans and prepaid card recharge'), false);

const accounts = [
  { code: '1354', name: 'RECOVERABLE EXPENSES - PREPAYMENT', description: '' },
  { code: '261', name: 'Client costs', description: 'Costs incurred on behalf of client, which we will recharge back to them' },
  { code: '420', name: 'Entertainment', description: '' },
];
const MGH = 'MERIDIAN GROUP HOLDINGS PTE LTD';
check('the chicken rice receipt is Rebillable',
  rebillableFor({ customer: MGH, rebillable: false, category: '1354 - RECOVERABLE EXPENSES - PREPAYMENT', accounts }), true);
check('…by the account description where the name says nothing',
  rebillableFor({ customer: MGH, category: '261 - Client costs', accounts }), true);
check('an ordinary account stays as the reader said', rebillableFor({ customer: MGH, category: '420 - Entertainment', accounts }), false);
check('…and the reader saying so is still enough', rebillableFor({ customer: MGH, rebillable: true, category: '420 - Entertainment', accounts }), true);
check('never without a customer, whatever the account',
  rebillableFor({ customer: '', rebillable: true, category: '1354 - RECOVERABLE EXPENSES - PREPAYMENT', accounts }), false);

// The reason the reader gave is enough on its own — the case that showed it:
// "The sender marked this as MGH, so it was coded for recharge to MERIDIAN".
const NOTE = 'The sender marked this as MGH, so it was coded for recharge to MERIDIAN GROUP HOLDINGS PTE LTD.';
check('a note saying to recharge is enough on an ordinary account',
  rebillableFor({ customer: MGH, category: '420 - Entertainment', accounts, reasons: [NOTE, ''] }), true);
check('…and "bill back" says the same', rebillableFor({ customer: MGH, category: '420 - Entertainment', accounts, reasons: ['Please bill back to MGH'] }), true);
check('…but never without a customer', rebillableFor({ customer: '', category: '420 - Entertainment', accounts, reasons: [NOTE] }), false);
check('a reason that says nothing of it changes nothing',
  rebillableFor({ customer: MGH, category: '420 - Entertainment', accounts, reasons: ['Client lunch at a restaurant'] }), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
