// Which document a bank statement line pays — the rules the Bank page draws
// its suggestions from and the server holds a match to before it records a
// payment. One module, loaded by both sides.
import {
  lineKey,
  isMoneyOut,
  docAmountFor,
  amountsAgree,
  matchable,
  daysAfter,
  inWindow,
  nameTokens,
  nameInBankText,
  numberInBankText,
  candidatesFor,
  bankMatches,
  suggestionFor,
  matchesByDoc,
  payableKind,
  nameMatchIn,
  matchReason,
  feeFor,
  cardFeeRuleFor,
} from '../src/lib/bankMatch.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const line = (fields) => ({ date: '2026-08-20', amount: -109, currency: 'SGD', reference: '', description: '', ...fields });
const doc = (fields) => ({
  id: 'd1', kind: 'cost', status: 'ready', supplier: 'A1 Consultancy Pte Ltd', date: '2026-08-18',
  currency: 'SGD', total: '109.00', invoiceNumber: '', type: 'Invoice', ...fields,
});

// --- the key ------------------------------------------------------------------
check('a key is the day, the cents and the reference', lineKey(line({ reference: ' ICT  PV260625-004P ' })), '2026-08-20|-10900|ICT PV260625-004P');
check('the same line worded differently is the same key', lineKey(line({ description: 'A' })), lineKey(line({ description: 'B' })));
check('a different amount is a different line', lineKey(line({ amount: -109.01 })) === lineKey(line()), false);

// --- direction ---------------------------------------------------------------
check('money out is a payment', isMoneyOut(line()), true);
check('money in is not', isMoneyOut(line({ amount: 250 })), false);
check('nor nothing', isMoneyOut(line({ amount: 0 })), false);

// --- the money ---------------------------------------------------------------
check('same currency: the total', docAmountFor(doc(), line()), 109);
check('a form string total reads', docAmountFor(doc({ total: 'SGD 1,234.50' }), line()), 1234.5);
check('foreign document, bank in its restated currency: the base total', docAmountFor(doc({ currency: 'USD', total: '17.17', baseCurrency: 'SGD', baseTotal: 22.2 }), line()), 22.2);
check('foreign document with no restatement: no comparison', docAmountFor(doc({ currency: 'USD', total: '17.17' }), line()), null);
check('and never a converted guess', amountsAgree(doc({ currency: 'USD', total: '17.17' }), line({ amount: -22.2 })), false);
check('agree to the cent', amountsAgree(doc(), line({ amount: -109 })), true);
check('a cent out is not the same money', amountsAgree(doc(), line({ amount: -109.01 })), false);
check('a line with no currency compares totals as they are', amountsAgree(doc(), line({ currency: '' })), true);

// --- what may be matched -------------------------------------------------------
check('a ready cost document', matchable(doc()), true);
check('a receipt already marked paid — the bank line IS that payment', matchable(doc({ paid: true })), true);
check('a published bill still awaiting payment', matchable(doc({ xeroInvoiceId: 'inv-1', xeroStatus: 'AUTHORISED', status: 'archived' })), true);
check('not one Xero already calls paid', matchable(doc({ xeroInvoiceId: 'inv-1', xeroStatus: 'PAID', status: 'archived' })), false);
check('not a voided one', matchable(doc({ xeroInvoiceId: 'inv-1', xeroStatus: 'VOIDED', status: 'archived' })), false);
check('not a sales document', matchable(doc({ kind: 'sales' })), false);
check('not one on an expense claim', matchable(doc({ status: 'expenseclaim' })), false);
check('not one merged away', matchable(doc({ status: 'merged' })), false);
check('not one still being read', matchable(doc({ status: 'processing' })), false);
check('not a credit note', matchable(doc({ type: 'Credit note/refund', total: '-530' })), false);
check('not a payment proof — the bank’s own record that a line was paid, not a cost the line pays', matchable(doc({ type: 'Payment proof', paid: true })), false);
check('not a mileage record — a journey, reimbursed through a claim', matchable(doc({ type: 'Mileage' })), false);
check('not a statement', matchable(doc({ type: 'Statement/remittance advice' })), false);
check('a document with no type yet is still offered', matchable(doc({ type: '' })), true);
check('and so is "Other" — the reader’s name for a bill it could not place', matchable(doc({ type: 'Other' })), true);
check('the kinds a line can pay', ['Receipt', 'Invoice', 'Tax invoice', 'Payment proof', 'Delivery note', 'ATM withdrawal', 'Expense statement'].map(payableKind), [true, true, true, false, false, false, false]);
check('not a document with no money', matchable(doc({ total: '0' })), false);
check('a document set aside by hand may still be paid', matchable(doc({ status: 'archived' })), true);

// --- the window --------------------------------------------------------------
check('days after the paper', daysAfter(doc(), line()), 2);
check('a card authorisation a day before the receipt', daysAfter(doc({ date: '2026-08-21' }), line()), -1);
check('no date, no answer', Number.isNaN(daysAfter(doc({ date: '—' }), line())), true);
check('two days later is in', inWindow(doc(), line()), true);
check('five days before is in', inWindow(doc({ date: '2026-08-25' }), line()), true);
check('six days before is out', inWindow(doc({ date: '2026-08-26' }), line()), false);
check('ninety days later is in', inWindow(doc({ date: '2026-05-22' }), line()), true);
check('ninety-one days later is out', inWindow(doc({ date: '2026-05-21' }), line()), false);

// --- the name ----------------------------------------------------------------
check('the words that name the company', nameTokens('A1 Consultancy Pte Ltd'), ['CONSULTANCY']);
check('legal forms and fillers dropped', nameTokens('The Grab Singapore Services Pte. Ltd.'), ['GRAB']);
check('a name that is all noise names nobody', nameInBankText('Singapore Pte Ltd', line({ description: 'SINGAPORE PTE LTD' })), false);
check('the name in the narrative', nameInBankText('A1 Consultancy Pte Ltd', line({ description: 'FAST PAYMENT A1 CONSULTANCY' })), true);
check('found at the start of a bank word', nameInBankText('Grab Pte Ltd', line({ description: 'GRABPAY* SINGAPORE' })), true);
check('a three-letter word only whole', nameInBankText('UOB Kay Hian', line({ description: 'UOBKH TRF' })), false);
check('and not in an unrelated narrative', nameInBankText('A1 Consultancy', line({ description: 'MICROSOFT SINGAPORE' })), false);
check('the document number in the reference', numberInBankText(doc({ invoiceNumber: 'INV-2026-091' }), line({ reference: 'PAYMENT INV 2026 091' })), true);
check('a short number is no evidence', numberInBankText(doc({ invoiceNumber: '91' }), line({ reference: 'INV 91' })), false);

// --- candidates ----------------------------------------------------------------
{
  const named = candidatesFor(line({ description: 'FAST A1 CONSULTANCY' }), [doc()]);
  check('named, same money, in window: firm', [named.length, named[0].confidence, named[0].reasons], [1, 'firm', ['amount', 'name']]);
}
{
  const only = candidatesFor(line({ description: 'CARD 4821' }), [doc()]);
  check('unnamed but the only document at that figure within a week: firm', [only[0].confidence, only[0].reasons], ['firm', ['amount', 'only']]);
}
{
  const late = candidatesFor(line({ description: 'CARD 4821', date: '2026-09-10' }), [doc()]);
  check('unnamed and three weeks later: only possible', late[0].confidence, 'possible');
}
{
  const two = candidatesFor(line({ description: 'CARD 4821' }), [doc(), doc({ id: 'd2', supplier: 'Other Co', date: '2026-08-19' })]);
  check('two unnamed documents at one figure: both possible, nearest first', two.map((c) => [c.doc.id, c.confidence]), [['d2', 'possible'], ['d1', 'possible']]);
  check('and nothing is suggested', suggestionFor(two), null);
}
{
  const mixed = candidatesFor(line({ description: 'FAST A1 CONSULTANCY' }), [doc({ id: 'd2', supplier: 'Other Co' }), doc()]);
  check('the named one leads', mixed.map((c) => [c.doc.id, c.confidence]), [['d1', 'firm'], ['d2', 'possible']]);
  check('and is the suggestion', suggestionFor(mixed).doc.id, 'd1');
}
check('money in matches nothing', candidatesFor(line({ amount: 109 }), [doc()]), []);
check('a different amount matches nothing', candidatesFor(line({ amount: -110 }), [doc()]), []);
check('outside the window matches nothing', candidatesFor(line({ date: '2026-12-01' }), [doc()]), []);
check('a foreign document at its restated figure', candidatesFor(line({ amount: -22.2, description: 'MICROSOFT' }), [doc({ currency: 'USD', total: '17.17', baseCurrency: 'SGD', baseTotal: 22.2, supplier: 'Microsoft Regional Sales' })]).map((c) => c.confidence), ['firm']);

// --- across the whole list ---------------------------------------------------
{
  // One receipt, two identical charges a week apart: the nearer line keeps it.
  const l1 = line({ date: '2026-08-19', description: 'GRAB' });
  const l2 = line({ date: '2026-08-26', description: 'GRAB' });
  const grab = doc({ supplier: 'Grab', date: '2026-08-18' });
  const m = bankMatches([l1, l2], [grab]);
  check('the nearer line suggests it', suggestionFor(m.get(lineKey(l1)))?.doc.id, 'd1');
  check('the other line is left to a person', [suggestionFor(m.get(lineKey(l2))), m.get(lineKey(l2))[0].confidence], [null, 'possible']);
}
{
  // Two receipts, two charges: each line to its own.
  const l1 = line({ date: '2026-08-19', description: 'GRAB' });
  const l2 = line({ date: '2026-08-26', description: 'GRAB' });
  const g1 = doc({ id: 'g1', supplier: 'Grab', date: '2026-08-18' });
  const g2 = doc({ id: 'g2', supplier: 'Grab', date: '2026-08-25' });
  const m = bankMatches([l1, l2], [g1, g2]);
  // Both are firm on both lines by name; ownership goes by nearest date, so
  // each line suggests exactly one and it is the right one.
  check('each line suggests its own receipt', [suggestionFor(m.get(lineKey(l1)))?.doc.id, suggestionFor(m.get(lineKey(l2)))?.doc.id], ['g1', 'g2']);
}

// --- from the document's side ------------------------------------------------
{
  const l1 = line({ date: '2026-08-19', description: 'GRAB' });
  const l2 = line({ date: '2026-08-26', description: 'GRAB' });
  const l3 = line({ date: '2026-08-20', description: 'FAST A1 CONSULTANCY', amount: -250 });
  const grab = doc({ id: 'g', supplier: 'Grab', date: '2026-08-18' });
  const a1 = doc({ id: 'a', total: '250', date: '2026-08-18' });
  const m = matchesByDoc([l1, l2, l3], [grab, a1, doc({ id: 'none', total: '999' })]);
  check('a document with one line: one match, firm', m.get('a').map((x) => [x.line.date, x.confidence]), [['2026-08-20', 'firm']]);
  check('a document two lines could pay: both listed, the nearer firm, the other left for a person', m.get('g').map((x) => [x.line.date, x.confidence]), [['2026-08-19', 'firm'], ['2026-08-26', 'possible']]);
  check('a document nothing pays is absent', m.has('none'), false);
}

// --- the entity's own name, and saying why --------------------------------------
{
  // Excellence's own statement: the narrative names the PAYER, which is us.
  const ivpt = line({ date: '2026-09-02', amount: -3000, description: 'IVPT Excellence AS Pte Ltd' });
  const proof = doc({ id: 'p', supplier: 'EXCELLENCE A.S PTE. LTD.', date: '2026-09-02', total: '3000' });
  const own = { ownNames: ['EXCELLENCE A.S PTE. LTD.'] };
  check('the word that tied them is returned', nameMatchIn('EXCELLENCE A.S PTE. LTD.', ivpt), 'EXCELLENCE');
  check('…but the entity\'s own name names nobody', nameMatchIn('EXCELLENCE A.S PTE. LTD.', ivpt, own), '');
  check('a real supplier on the same statement still matches', nameMatchIn('EIVA HR Solutions', line({ description: 'IVPT EIVA HR SOLUTIONS' }), own), 'EIVA');
  const c = candidatesFor(ivpt, [proof], own);
  check('without the own-name word it is not "named"', c[0].reasons.includes('name'), false);

  const named = candidatesFor(line({ description: 'FAST A1 CONSULTANCY' }), [doc()])[0];
  check('a name match says which word', matchReason(named, named.doc), 'Bank text names the supplier (CONSULTANCY)');
  const numbered = candidatesFor(line({ description: 'INV 20260818' }), [doc({ invoiceNumber: 'INV-20260818' })])[0];
  check('a number match says the number', matchReason(numbered, numbered.doc), 'Bank text has invoice number INV-20260818');
  const only = candidatesFor(line({ description: 'CARD 4821' }), [doc()])[0];
  check('the lone document at that figure says so', matchReason(only, only.doc), 'Only document at this amount within a week');
  check('a bare money match says only that', matchReason({ reasons: ['amount'] }, doc()), 'Same amount, close date');
}

// --- a card fee the bank adds on top ------------------------------------------------
{
  // UOB takes 1% on some debit-card spends in the same line: a Canva receipt of
  // SGD 17.99 clears as 18.17.
  const uob = line({ date: '2026-08-26', amount: -18.17, description: 'Canva* 04983-44591559 Sydney MISC DR - DEBIT CARD', bank_account_name: 'UOB SGD' });
  const canva = doc({ id: 'c', supplier: 'Canva Pty Ltd', total: '17.99', date: '2026-08-24', invoiceNumber: '04983-44591559-1' });
  const rules = [{ bankAccount: 'UOB SGD', percent: '1', accountCode: '404 - Bank Fees' }];
  check('the rule for the line’s bank account', cardFeeRuleFor(uob, rules), { percent: 1, accountCode: '404', bankAccount: 'UOB SGD' });
  check('17.99 plus 1% is 18.17: a fee of 0.18', feeFor(canva, uob, rules), { percent: 1, fee: 0.18, accountCode: '404', bankAccount: 'UOB SGD' });
  check('no rule, no fee — nothing is guessed', feeFor(canva, uob, []), null);
  check('another bank account’s rule does not apply', feeFor(canva, line({ ...uob, bank_account_name: 'DBS Current' }), rules), null);
  check('two cents off the fee is not the fee', feeFor(canva, line({ ...uob, amount: -18.19 }), rules), null);
  check('an exact match is not a fee', feeFor(canva, line({ ...uob, amount: -17.99 }), rules), null);
  // The fee goes on the bill as a line, so it has to be the bank's currency.
  check('a bill in another currency takes no fee line', feeFor({ ...canva, currency: 'USD', baseCurrency: 'SGD', baseTotal: 17.99 }, uob, rules), null);

  check('without the rule the line pays nothing', candidatesFor(uob, [canva], {}), []);
  const withFee = candidatesFor(uob, [canva], { feeRules: rules });
  check('with it, the receipt is a firm match by name', [withFee.length, withFee[0]?.confidence, withFee[0]?.reasons], [1, 'firm', ['amount', 'name', 'fee']]);
  check('and says the fee', matchReason(withFee[0], canva), 'Bank text names the supplier (CANVA) · incl. 1% card fee 0.18');
  const unnamed = candidatesFor(line({ ...uob, description: 'MISC DR - DEBIT CARD' }), [canva], { feeRules: rules });
  check('a fee match that names nobody is never promoted to firm', unnamed[0]?.confidence, 'possible');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall bank-match checks passed');
