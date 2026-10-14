// Paperwork match: which Xero transaction a receipt is the paper for, and what
// differs between their coding. src/lib/paperworkMatch.js.
import {
  paperworkEligible,
  paperworkCandidatesFor,
  paperworkMatches,
  paperworkSuggestion,
  paperworkReason,
  codingDifferences,
  recodeLocked,
  recodeInstructions,
} from '../src/lib/paperworkMatch.js';
import { isPublished, isUnpublished } from '../src/lib/readiness.js';
import { matchable } from '../src/lib/bankMatch.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// The Lalamove receipt and the Amex Spend Money Xero already has for it.
const doc = {
  id: 'd1', kind: 'cost', status: 'ready', type: 'Receipt', supplier: 'Lalamove', date: '2026-09-24',
  total: '73.80', currency: 'SGD', invoiceNumber: '3591407579064128444',
  category: '425 - Freight & Courier', taxRate: 'No Tax', project: 'Tangs', project2: '',
};
const spend = {
  kind: 'spend', id: 'bt-1', date: '2026-09-25', total: 73.8, currency: 'SGD', contact: 'Lalamove',
  reference: 'AT262680002000010006526', number: '', bankAccount: { name: 'Amex', code: '' }, reconciled: true,
  lines: [{ description: 'CKO*LALAMOVE 624784 SINGAPORE (1005)', accountCode: '425', accountName: 'Freight & Courier', taxType: 'NONE', taxName: 'No Tax', amount: 73.8, tax: 0, tracking: [{ category: 'Outlets', option: 'HQ' }] }],
};

// --- who is eligible ---------------------------------------------------------------
check('a ready receipt', paperworkEligible(doc), true);
check('not one already published', paperworkEligible({ ...doc, xeroInvoiceId: 'x' }), false);
check('not one already sent', paperworkEligible({ ...doc, paperworkMatch: { id: 'bt-1' } }), false);
check('not one archived by hand', paperworkEligible({ ...doc, status: 'archived' }), false);
check('not one on a claim', paperworkEligible({ ...doc, status: 'expenseclaim' }), false);
check('not a payment proof', paperworkEligible({ ...doc, type: 'Payment proof' }), false);
check('not a sales document', paperworkEligible({ ...doc, kind: 'sales' }), false);

// --- the pairing -------------------------------------------------------------------
let c = paperworkCandidatesFor(doc, [spend]);
check('the Spend Money is found, firm, by name', [c.length, c[0]?.confidence, c[0]?.reasons], [1, 'firm', ['amount', 'name']]);
check('…said in words', paperworkReason(c[0], doc), 'Xero names the supplier (LALAMOVE)');
check('a cent out is no match', paperworkCandidatesFor(doc, [{ ...spend, total: 73.81 }]).length, 0);
check('a month later than the window is no match', paperworkCandidatesFor(doc, [{ ...spend, date: '2027-01-30' }]).length, 0);
check('a transaction already linked elsewhere is not offered', paperworkCandidatesFor(doc, [spend], { linkedIds: ['bt-1'] }).length, 0);
const unnamed = { ...spend, id: 'bt-2', contact: '', lines: [{ ...spend.lines[0], description: 'CARD SPEND' }], reference: '' };
c = paperworkCandidatesFor(doc, [unnamed]);
check('unnamed but the only one within a week: firm', [c[0]?.confidence, c[0]?.reasons.includes('only')], ['firm', true]);
c = paperworkCandidatesFor(doc, [unnamed, { ...unnamed, id: 'bt-3', date: '2026-09-26' }]);
check('two unnamed at the figure: neither is firm', c.map((x) => x.confidence), ['possible', 'possible']);
check('…and nothing is suggested', paperworkSuggestion(c), null);

// One Spend Money, two identical receipts a month apart: the nearer gets it.
const later = { ...doc, id: 'd2', date: '2026-08-25' };
const m = paperworkMatches([doc, later], [spend]);
check('the nearer document is firm', m.get('d1')?.[0]?.confidence, 'firm');
check('the other only possible', [m.get('d2')?.[0]?.confidence, m.get('d2')?.[0]?.reasons.includes('elsewhere')], ['possible', true]);

// --- the coding, side by side ---------------------------------------------------------
check('the outlet differs, and only the outlet', codingDifferences(doc, spend, ['Outlets', 'Staff']), [
  { key: 'project', label: 'Outlets', document: 'Tangs', xero: 'HQ' },
]);
check('same coding: nothing differs', codingDifferences({ ...doc, project: 'HQ' }, spend, ['Outlets', 'Staff']), []);
check('account compared by code, named both sides',
  codingDifferences({ ...doc, category: '429 - General Expenses', project: 'HQ' }, spend, ['Outlets']),
  [{ key: 'account', label: 'Account', document: '429 - General Expenses', xero: '425 - Freight & Courier' }]);
check('a tax rate said blank as Not set',
  codingDifferences({ ...doc, taxRate: '', project: 'HQ' }, spend, ['Outlets']),
  [{ key: 'tax', label: 'Tax rate', document: 'Not set', xero: 'No Tax' }]);
check('taking a tag OFF is a difference too',
  codingDifferences({ ...doc, project: '' }, spend, ['Outlets']),
  [{ key: 'project', label: 'Outlets', document: 'Not set', xero: 'HQ' }]);

// --- what Xero will let an app change ---------------------------------------------------
check('a reconciled Spend Money cannot be recoded by an app', recodeLocked(spend), true);
check('an unreconciled one can', recodeLocked({ ...spend, reconciled: false }), false);
check('a paid bill cannot', recodeLocked({ kind: 'bill', status: 'PAID' }), true);
check('an approved, unpaid bill can', recodeLocked({ kind: 'bill', status: 'AUTHORISED' }), false);
check('what to change by hand, field by field', recodeInstructions(codingDifferences(doc, spend, ['Outlets'])), ['Outlets: HQ → Tangs']);

// --- what being sent means elsewhere ----------------------------------------------------
const sent = { ...doc, status: 'archived', paperworkMatch: { id: 'bt-1' } };
check('a sent document counts as published', isPublished(sent), true);
check('…so it is not unpublished work', isUnpublished(sent), false);
check('…and Bank match leaves it alone', matchable(sent), false);

if (failures) {
  console.error(`${failures} paperwork-match check(s) failed`);
  process.exit(1);
}
