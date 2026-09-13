// A supplier rule's invoice date, for a supplier that invoices after the period
// it bills for. The mistakes that matter are quiet ones — a date a month out, or
// a date that walks back a month every time the rule is applied — so they are
// pinned here.
import { endOfPreviousMonth, isMonthEnd, ruleInvoiceDate } from '../src/lib/ruleDate.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

check('an invoice of 2 September belongs to August', endOfPreviousMonth('2026-09-02'), '2026-08-31');
check('a 30-day month', endOfPreviousMonth('2026-10-15'), '2026-09-30');
check('January goes back to December of the year before', endOfPreviousMonth('2026-01-05'), '2025-12-31');
check('March goes back to a leap-year February', endOfPreviousMonth('2028-03-01'), '2028-02-29');
check('…and an ordinary February', endOfPreviousMonth('2026-03-01'), '2026-02-28');
check('nothing readable is nothing', endOfPreviousMonth('02/09/2026'), '');

check('31 August is a month end', isMonthEnd('2026-08-31'), true);
check('2 September is not', isMonthEnd('2026-09-02'), false);

check('no rule moves nothing', ruleInvoiceDate('', '2026-09-02'), '');
check('the rule moves a read date', ruleInvoiceDate('endOfPreviousMonth', '2026-09-02'), '2026-08-31');
// A read always starts from the printed date, so a month-end invoice is still
// moved: a supplier that bills after the period billed September on 30 September
// for August.
check('a read moves a month-end date too', ruleInvoiceDate('endOfPreviousMonth', '2026-09-30'), '2026-08-31');
// Applied to a document already on screen, the date may be the one this rule
// just set — pressing Apply again must not walk it back a month.
check('applied again on screen, 31/08 stays 31/08', ruleInvoiceDate('endOfPreviousMonth', '2026-08-31', { keepMonthEnd: true }), '2026-08-31');
check('…while a printed date on screen is still moved', ruleInvoiceDate('endOfPreviousMonth', '2026-09-02', { keepMonthEnd: true }), '2026-08-31');
check('no date, no answer', ruleInvoiceDate('endOfPreviousMonth', ''), '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
