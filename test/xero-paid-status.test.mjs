// The wording of a published bill's Xero status, and the line it holds between
// the ledger's answer and the reviewer's own Paid toggle.
import { xeroPaidStatus, isPaidInXero } from '../src/lib/xeroPaidStatus.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

check('a paid bill says so', xeroPaidStatus({ xeroStatus: 'PAID' }), { label: 'Paid', tone: 'paid' });
check('an approved bill is awaiting payment', xeroPaidStatus({ xeroStatus: 'AUTHORISED' }), { label: 'Awaiting payment', tone: 'awaiting' });
check('a submitted bill is awaiting approval', xeroPaidStatus({ xeroStatus: 'SUBMITTED' }), { label: 'Awaiting approval', tone: 'awaiting' });
check('a voided bill is not just "unpaid"', xeroPaidStatus({ xeroStatus: 'VOIDED' }), { label: 'Voided in Xero', tone: 'void' });

// Nothing to say is said as nothing — never as a guessed status.
check('an unpublished document has no Xero status', xeroPaidStatus({}), null);
check('a published document nobody has touched in Xero has none either', xeroPaidStatus({ xeroInvoiceId: 'inv-1' }), null);
check('a blank status is not a status', xeroPaidStatus({ xeroStatus: '   ' }), null);

// The reviewer's toggle and the ledger's answer are independent, in both
// directions. A receipt captured as already paid, published, and not yet
// reconciled reads Awaiting payment; a bill captured unpaid and since settled
// in Xero reads Paid. Neither is the other's business.
check('the Paid toggle does not colour the Xero status', xeroPaidStatus({ paid: true, xeroStatus: 'AUTHORISED' }), { label: 'Awaiting payment', tone: 'awaiting' });
check('...nor the other way round', xeroPaidStatus({ paid: false, xeroStatus: 'PAID' }), { label: 'Paid', tone: 'paid' });
check('the toggle alone is not a Xero status', xeroPaidStatus({ paid: true }), null);

// An unrecognised status is shown rather than swallowed — Xero adding one
// should read oddly, not vanish.
check('an unknown status is still reported', xeroPaidStatus({ xeroStatus: 'SOMETHINGNEW' }), { label: 'Somethingnew', tone: 'awaiting' });

check('isPaidInXero is only ever PAID', [isPaidInXero({ xeroStatus: 'PAID' }), isPaidInXero({ xeroStatus: 'AUTHORISED' }), isPaidInXero({ paid: true })], [true, false, false]);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
