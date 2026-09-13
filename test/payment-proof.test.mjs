// A payment proof is paid, and carries no tax: the rule the document page, the
// upload drawer and the server's writes all apply — one module, loaded by both.
import { isPaymentProof, paymentProofPatch, PAYMENT_PROOF_TAX_REASON } from '../src/lib/paymentProof.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- what counts ----------------------------------------------------------------
check('the type, as the dropdown spells it', isPaymentProof('Payment proof'), true);
check('however cased or spaced', isPaymentProof('  payment_proof '), true);
check('a receipt is not one', isPaymentProof('Receipt'), false);
check('nor nothing', isPaymentProof(''), false);
check('nor "Statement/remittance advice", which is the supplier telling us what is owed', isPaymentProof('Statement/remittance advice'), false);

// --- the patch --------------------------------------------------------------------
check('any other type: nothing to write', paymentProofPatch({ type: 'Invoice', taxRate: 'INPUTY24' }), {});
check(
  'a fresh payment proof: paid, no tax, No Tax with its reason',
  paymentProofPatch({ documentType: 'Payment proof', taxRate: '', tax: 3.2 }),
  { paid: true, tax: 0, baseTax: 0, taxRate: 'No Tax', taxRateReason: PAYMENT_PROOF_TAX_REASON }
);
check(
  'under the entity’s own name for No Tax',
  paymentProofPatch({ type: 'Payment proof' }, 'No GST').taxRate,
  'No GST'
);
check(
  'already at No Tax: the code is not rewritten, the money and the reason still are',
  paymentProofPatch({ type: 'Payment proof', taxRate: 'No Tax', tax: 1 }),
  { paid: true, tax: 0, baseTax: 0, taxRateReason: PAYMENT_PROOF_TAX_REASON }
);
check(
  'a code somebody picked by hand is theirs — only Paid is written',
  paymentProofPatch({ type: 'Payment proof', taxRate: 'INPUTY24', taxRateEdited: true, tax: 3.2 }),
  { paid: true }
);
check(
  'a blank somebody chose is theirs too',
  paymentProofPatch({ type: 'Payment proof', taxRate: '', taxRateCleared: true }),
  { paid: true }
);
check('reads `type` (the page) and `documentType` (the store) alike', [
  paymentProofPatch({ type: 'Payment proof' }).paid,
  paymentProofPatch({ documentType: 'Payment proof' }).paid,
], [true, true]);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall payment-proof checks passed');
