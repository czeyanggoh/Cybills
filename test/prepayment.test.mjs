// A quotation / pro-forma paid in advance, and the invoice that uses it up: the
// rules the document page and server/src/prepayment.ts both read.
import {
  isAdvanceDocument,
  advancePatch,
  prepaymentRemainingCents,
  prepaymentCandidates,
  firmPrepayment,
  sameSupplier,
  invoiceQuotes,
} from '../src/lib/prepayment.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- what counts ----------------------------------------------------------------
check('Quotation', isAdvanceDocument('Quotation'), true);
check('Pro-forma invoice', isAdvanceDocument('Pro-forma invoice'), true);
check('proforma, however spelt', isAdvanceDocument(' PROFORMA invoice'), true);
check('an invoice is not one', isAdvanceDocument('Invoice'), false);

// --- No Tax -----------------------------------------------------------------------
check('coded No Tax with its reason', Object.keys(advancePatch({ type: 'Quotation', taxRate: 'Standard-Rated Purchases' })).sort(), ['baseTax', 'tax', 'taxRate', 'taxRateReason']);
check('a code picked by hand is kept', advancePatch({ type: 'Quotation', taxRateEdited: true }), {});
check('any other type: nothing', advancePatch({ type: 'Invoice' }), {});

// --- suppliers and references -----------------------------------------------------
check('legal forms ignored', sameSupplier('Windee Private Limited', 'WINDEE PTE. LTD.'), true);
check('a longer trading name', sameSupplier('Windee', 'Windee Singapore Pte Ltd'), true);
check('different suppliers', sameSupplier('Windee', 'Windsor Glass'), false);
check('quoted anywhere, however punctuated', invoiceQuotes({ invoiceNumber: 'INV-88', description: 'As per quotation QUO 2609239' }, 'QUO-2609239'), true);
check('its own number is not a quotation', invoiceQuotes({ invoiceNumber: 'QUO-2609239' }, 'QUO-2609239'), false);

// --- what is left ----------------------------------------------------------------
const quote = {
  id: 'q1',
  type: 'Quotation',
  supplier: 'Windee Private Limited',
  invoiceNumber: 'QUO-2609239',
  prepayment: { overpaymentId: 'op1', amount: 999, currency: 'SGD', date: '2026-09-19', reference: 'QUO-2609239', allocations: [] },
};
check('nothing used yet', prepaymentRemainingCents(quote), 99900);
check('less what was applied', prepaymentRemainingCents({ prepayment: { ...quote.prepayment, allocations: [{ amount: 400 }] } }), 59900);
check('not recorded: nothing', prepaymentRemainingCents({ type: 'Quotation' }), 0);

// --- which invoice uses which ------------------------------------------------------
const invoice = { id: 'i1', type: 'Invoice', supplier: 'Windee Pte Ltd', total: '1200.00', currency: 'SGD', date: '2026-10-05', invoiceNumber: 'INV-1' };
const firm = firmPrepayment(invoice, [quote, invoice]);
check('the supplier’s only prepayment is firm', firm && firm.doc.id, 'q1');
check('capped at what is left', firm && firm.amountCents, 99900);
check('a smaller invoice takes only its own total', firmPrepayment({ ...invoice, total: '500' }, [quote]).amountCents, 50000);
check('an invoice dated BEFORE the payment is not firm by supplier alone', firmPrepayment({ ...invoice, date: '2026-09-01' }, [quote]), null);
check('…but quoting the number is', firmPrepayment({ ...invoice, date: '2026-09-01', description: 'Ref QUO-2609239' }, [quote]).doc.id, 'q1');

const quote2 = { ...quote, id: 'q2', invoiceNumber: 'QUO-2609300', prepayment: { ...quote.prepayment, overpaymentId: 'op2', reference: 'QUO-2609300' } };
check('two from one supplier: neither firm', firmPrepayment(invoice, [quote, quote2]), null);
check('…both offered', prepaymentCandidates(invoice, [quote, quote2]).map((c) => c.doc.id), ['q1', 'q2']);
check('…until the invoice quotes one', firmPrepayment({ ...invoice, note: 'balance of QUO-2609300' }, [quote, quote2]).doc.id, 'q2');

check('another supplier: nothing', prepaymentCandidates({ ...invoice, supplier: 'Acme' }, [quote]), []);
check('another currency: nothing', prepaymentCandidates({ ...invoice, currency: 'USD' }, [quote]), []);
check('used up: nothing', prepaymentCandidates(invoice, [{ ...quote, prepayment: { ...quote.prepayment, allocations: [{ amount: 999 }] } }]), []);
check('a quotation never draws on one', prepaymentCandidates({ ...invoice, type: 'Quotation' }, [quote]), []);
check('nor a credit note', prepaymentCandidates({ ...invoice, type: 'Credit note/refund' }, [quote]), []);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll prepayment tests passed.');
