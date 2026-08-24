// What a supplier merge touches. One supplier under several spellings becomes
// one name, and the documents follow — except the ones already published to
// Xero, whose figures are in the ledger and must not be renamed underneath it.
import { planSupplierMerge, namesMergedAway } from '../src/lib/supplierMerge.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const doc = (over) => ({ id: 'b1', supplier: 'ACRA', total: '100', persisted: true, ...over });

// --- The ordinary merge -----------------------------------------------------
const docs = [
  doc({ id: 'a', supplier: 'ACRA' }),
  doc({ id: 'b', supplier: 'Accouting And Corporate Regulatory Authority' }),
  doc({ id: 'c', supplier: 'Grab' }),
];
const plan = planSupplierMerge({
  docs,
  keep: 'ACCOUNTING AND CORPORATE REGULATORY AUTHORITY',
  mergedAway: ['ACRA', 'Accouting And Corporate Regulatory Authority'],
});
check('both spellings move', plan.moves.map((m) => m.id), ['a', 'b']);
check('an unrelated supplier is untouched', plan.unchanged, 1);
check('the kept name is written', plan.moves[0].patch.supplier, 'ACCOUNTING AND CORPORATE REGULATORY AUTHORITY');

// --- Case and spacing -------------------------------------------------------
check(
  'matched without regard to case or spacing',
  planSupplierMerge({ docs: [doc({ id: 'x', supplier: '  aCrA ' })], keep: 'ACRA Ltd', mergedAway: ['acra'] }).moves.map((m) => m.id),
  ['x']
);

// --- Published documents are left alone -------------------------------------
const withPublished = planSupplierMerge({
  docs: [doc({ id: 'p', supplier: 'ACRA', xeroInvoiceId: 'INV-1' }), doc({ id: 'q', supplier: 'ACRA' })],
  keep: 'ACRA Ltd',
  mergedAway: ['ACRA'],
});
check('a published document does not move', withPublished.moves.map((m) => m.id), ['q']);
check('…and is reported as skipped', withPublished.skipped.map((d) => d.id), ['p']);

// --- The kept supplier's rules ride along ------------------------------------
const withRule = planSupplierMerge({
  docs: [doc({ id: 'r', supplier: 'ACRA', total: '109' })],
  keep: 'ACRA Ltd',
  mergedAway: ['ACRA'],
  rulePatch: { category: '485 - Subscriptions', taxRate: 'Standard-Rated Purchases' },
  taxFor: (rate, total) => (rate && Number(total) ? (Number(total) * 9 / 109).toFixed(2) : '0.00'),
});
check('the kept rule is applied', withRule.moves[0].patch.category, '485 - Subscriptions');
check('tax is computed from the document’s own total', withRule.moves[0].patch.tax, '9.00');

// --- Nothing silly ----------------------------------------------------------
check(
  'merging a name into itself moves nothing',
  planSupplierMerge({ docs, keep: 'ACRA', mergedAway: ['ACRA'] }).moves.length,
  0
);
check('no keep name, no moves', planSupplierMerge({ docs, keep: '', mergedAway: ['ACRA'] }).moves.length, 0);
check(
  'a document still being read has no row to patch',
  planSupplierMerge({ docs: [doc({ id: 'u', supplier: 'ACRA', persisted: false })], keep: 'ACRA Ltd', mergedAway: ['ACRA'] }).moves.length,
  0
);

// --- Which names leave the list ---------------------------------------------
check('the kept name is never dropped', namesMergedAway('ACRA', ['ACRA', 'acra', 'ACRA Pte']), ['ACRA Pte']);
check('duplicates collapse', namesMergedAway('Keep', ['A', 'a', 'B']), ['A', 'B']);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
