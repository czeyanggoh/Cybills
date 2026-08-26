// Which supplier names are the SAME supplier spelled two ways, and which are
// simply different suppliers. The distinction that matters most here is the
// number: "OCBC Loan 2" and "OCBC Loan 3" are one edit apart and are not the
// same account at all.
import { findDuplicateGroups, normaliseSupplier, pairKey, pairsInGroup } from '../src/lib/supplierDuplicates.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- A number is not a typo -------------------------------------------------
check('numbered accounts are separate suppliers', findDuplicateGroups(['OCBC Loan 2', 'OCBC Loan 3', 'OCBC Loan 4']), []);
check('numbered firms are separate suppliers', findDuplicateGroups(['A1 Consultancy', 'A2 Consultancy']), []);
check('a number against none is still separate', findDuplicateGroups(['ACRA', 'ACRA 2']), []);

// --- A letter still is ------------------------------------------------------
check(
  'a real typo is still caught',
  findDuplicateGroups(['ACCOUNTING AND CORPORATE REGULATORY AUTHORITY', 'Accouting And Corporate Regulatory Authority']),
  [['ACCOUNTING AND CORPORATE REGULATORY AUTHORITY', 'Accouting And Corporate Regulatory Authority']]
);
check(
  'a company suffix does not distinguish',
  findDuplicateGroups(['Grab Singapore Pte Ltd', 'Grab Singapore']),
  [['Grab Singapore Pte Ltd', 'Grab Singapore']]
);
check(
  'a number shared by both is no obstacle',
  findDuplicateGroups(['3M Singapore Pte Ltd', '3M Singapore']),
  [['3M Singapore Pte Ltd', '3M Singapore']]
);

// --- Rejecting a suggestion -------------------------------------------------
const typos = ['Accrual', 'Accruals'];
check('suggested before it is rejected', findDuplicateGroups(typos).length, 1);
check(
  'and never again once rejected',
  findDuplicateGroups(typos, { dismissed: new Set([pairKey('Accrual', 'Accruals')]) }),
  []
);
check('a rejection is order-independent', pairKey('Accruals', 'Accrual'), pairKey('Accrual', 'Accruals'));
check('every pairing in a group is recorded', pairsInGroup(['a', 'b', 'c']).length, 3);

// A third spelling must not quietly re-form a group the reviewer rejected.
check(
  'rejected pairs stay rejected when a third name arrives',
  findDuplicateGroups(['Accrual', 'Accruals', 'Accural'], { dismissed: new Set(pairsInGroup(['Accrual', 'Accruals', 'Accural'])) }),
  []
);

// --- Normalisation ----------------------------------------------------------
check('punctuation and case are ignored', normaliseSupplier('A-Roy Thai Restaurant'), 'a roy thai restaurant');
check('digits are kept', normaliseSupplier('OCBC Loan 2'), 'ocbc loan 2');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
