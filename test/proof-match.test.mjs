// Which invoices a payment proof pays — one for the whole amount, or several of
// the payee's that add up. The rule the document page and the server share.
import { proofMatches, suggestionFor, sumsExactly, payableByProof, namesPayee, quotesNumber } from '../src/lib/proofMatch.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const inv = (id, over = {}) => ({ id, kind: 'cost', status: 'ready', type: 'Invoice', supplier: 'Nuphar Design Pte Ltd', currency: 'SGD', date: '2026-08-01', total: '0', paid: false, invoiceNumber: '', ...over });
const proof = (over = {}) => ({ id: 'p', kind: 'cost', status: 'archived', type: 'Payment proof', supplier: 'NUPHAR DESIGN', currency: 'SGD', date: '2026-08-20', total: '109.00', invoiceNumber: 'FT2608201234', description: 'PayNow transfer', ...over });
const ids = (ms) => ms.map((m) => [m.ids.join('+'), m.confidence]);

// --- what a proof may pay --------------------------------------------------------
check('an unpaid invoice of the payee', payableByProof(inv('a', { total: '109' }), proof()), true);
check('never another payment proof', payableByProof(inv('a', { total: '109', type: 'Payment proof' }), proof()), false);
check('never a credit note', payableByProof(inv('a', { total: '109', type: 'Credit note/refund' }), proof()), false);
check('never one already marked paid — a receipt settled at the till', payableByProof(inv('a', { total: '109', paid: true }), proof()), false);
check('unless it is THIS proof that paid it', payableByProof(inv('a', { total: '109', paid: true, paidByProof: { proofId: 'p' } }), proof()), true);
check('never one another proof paid', payableByProof(inv('a', { total: '109', paidByProof: { proofId: 'other' } }), proof()), false);
check('never one Xero calls PAID', payableByProof(inv('a', { total: '109', xeroStatus: 'PAID' }), proof()), false);
check('a published bill still awaiting payment is payable', payableByProof(inv('a', { total: '109', xeroInvoiceId: 'x', xeroStatus: 'AUTHORISED' }), proof()), true);
check('an invoice dated long before the window is not', payableByProof(inv('a', { total: '109', date: '2025-12-01' }), proof()), false);
check('nor one dated weeks after the payment', payableByProof(inv('a', { total: '109', date: '2026-09-15' }), proof()), false);
check('but a person picking by hand is not held to the window', payableByProof(inv('a', { total: '109', date: '2025-12-01' }), proof(), { anyDate: true }), true);
check('a USD invoice pays at the SGD figure it restated itself in', payableByProof(inv('a', { currency: 'USD', total: '80', baseCurrency: 'SGD', baseTotal: '109' }), proof()), true);
check('and without one it cannot be compared', payableByProof(inv('a', { currency: 'USD', total: '80' }), proof()), false);

// --- the ties ----------------------------------------------------------------------
check('a truncated payee still names the supplier', namesPayee(inv('a'), proof({ supplier: 'NUPHAR DESIG' })), true);
check('a stranger does not', namesPayee(inv('a', { supplier: 'Singtel' }), proof()), false);
check('the proof quoting an invoice number', quotesNumber(inv('a', { invoiceNumber: 'ND-2026-011' }), proof({ description: 'Payment for ND2026011' })), true);

// --- one invoice ---------------------------------------------------------------------
let m = proofMatches(proof(), [inv('a', { total: '109' }), inv('b', { total: '60' })]);
check('one of the payee\'s invoices at the amount is firm', ids(m), [['a', 'firm']]);
check('and is what the proof applies by itself', suggestionFor(m)?.ids, ['a']);

m = proofMatches(proof(), [inv('a', { total: '109', supplier: 'Somebody Else' })]);
check('an unnamed invoice at the amount is only possible', ids(m), [['a', 'possible']]);
check('and is never applied by itself', suggestionFor(m), null);

m = proofMatches(proof(), [inv('a', { total: '109' }), inv('b', { total: '109', date: '2026-08-05' })]);
check('two of the payee\'s invoices at the amount are a choice', ids(m).map((x) => x[1]), ['possible', 'possible']);
check('so neither is applied', suggestionFor(m), null);

// --- several invoices ------------------------------------------------------------------
m = proofMatches(proof(), [inv('a', { total: '60' }), inv('b', { total: '49', date: '2026-08-10' }), inv('c', { total: '49', supplier: 'Singtel' })]);
check('two of the payee\'s invoices that add up are one firm combination', ids(m), [['a+b', 'firm']]);
check('another supplier\'s invoice at the right figure is not pulled in', suggestionFor(m)?.ids, ['a', 'b']);

m = proofMatches(proof(), [inv('a', { total: '60' }), inv('b', { total: '49' }), inv('c', { total: '49', date: '2026-08-02' })]);
check('two combinations that both add up are a choice', ids(m).map((x) => x[1]), ['possible', 'possible']);
check('so nothing is applied', suggestionFor(m), null);

m = proofMatches(
  proof({ description: 'Nuphar ND-011 ND-013' }),
  [inv('a', { total: '60', invoiceNumber: 'ND-011' }), inv('b', { total: '49', invoiceNumber: 'ND-012' }), inv('c', { total: '49', invoiceNumber: 'ND-013' })]
);
check('the invoices the proof quotes by number win over the other combination', suggestionFor(m)?.ids, ['a', 'c']);

m = proofMatches(proof({ total: '150' }), [inv('a', { total: '60' }), inv('b', { total: '49' })]);
check('nothing that adds up is nothing at all', m, []);

check('a proof that is not one pays nothing', proofMatches({ ...proof(), type: 'Receipt' }, [inv('a', { total: '109' })]), []);

// --- Apply's own check -------------------------------------------------------------------
check('a set that adds up to the cent', sumsExactly(proof(), [inv('a', { total: '60' }), inv('b', { total: '49' })]), true);
check('a set a cent out', sumsExactly(proof(), [inv('a', { total: '60' }), inv('b', { total: '48.99' })]), false);
check('the same invoice twice is not two', sumsExactly(proof({ total: '120' }), [inv('a', { total: '60' }), inv('a', { total: '60' })]), false);
check('a set holding a paid receipt', sumsExactly(proof(), [inv('a', { total: '60' }), inv('b', { total: '49', paid: true })]), false);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall proof-match checks passed');
