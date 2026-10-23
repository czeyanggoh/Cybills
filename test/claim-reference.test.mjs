// The reference a claim's Xero bill carries: name, date, id — and the date only
// once. An auto claim is named for its period, and adding the date again put
// "Auto claim — 30 Sep 2026 30-Sep-2026 261013115120" on a bill in Xero.
import { claimReference, nameStatesDate } from '../src/lib/claimReference.js';

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
}

const createdAt = '2026-10-13T03:51:20.000Z'; // 261013115120 in SGT

check('an auto claim says its date once',
  claimReference({ name: 'Expense Claim 30 Sep 2026', claimDate: '2026-09-30', createdAt }),
  'Expense Claim 30 Sep 2026 261013115120');
check('a numbered one too',
  claimReference({ name: 'Expense Claim 30 Sep 2026 (2)', claimDate: '2026-09-30', createdAt }),
  'Expense Claim 30 Sep 2026 (2) 261013115120');
check('a name without the date still gets it',
  claimReference({ name: 'ST Eng Exp Claim', claimDate: '2026-08-20', createdAt }),
  'ST Eng Exp Claim 20-Aug-2026 261013115120');
check('a name naming ANOTHER date still gets its own',
  claimReference({ name: 'Trip 30 Sep 2026', claimDate: '2026-10-31', createdAt }),
  'Trip 30 Sep 2026 31-Oct-2026 261013115120');

check('dashed form', nameStatesDate('Claim 30-Sep-2026', '2026-09-30'), true);
check('ISO form', nameStatesDate('Claim 2026-09-30', '2026-09-30'), true);
check('slashed form', nameStatesDate('Claim 30/09/2026', '2026-09-30'), true);
check('unpadded day', nameStatesDate('Claim 1 Oct 2026', '2026-10-01'), true);
check('padded day', nameStatesDate('Claim 01 Oct 2026', '2026-10-01'), true);
check('a month alone is not the date', nameStatesDate('Claim Sep 2026', '2026-09-30'), false);
check('no date at all', nameStatesDate('Claim', ''), false);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
