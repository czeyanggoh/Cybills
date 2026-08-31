// The dates on a claim: the ones somebody TYPED and the ones the system
// STAMPED. They arrive in different shapes and only one of them is an instant.
import { formatClaimDate, formatClaimStamp, toIsoClaimDate, parseDateParts } from '../src/lib/claimDate.js';

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
}

// A typed date is a calendar date, whatever shape it was typed in.
check('ISO', formatClaimDate('2026-07-31'), '31 Jul 2026');
check('DD/MM/YYYY', formatClaimDate('31/07/2026'), '31 Jul 2026');
check('DDMMYYYY', formatClaimDate('31072026'), '31 Jul 2026');
check('DD Mon YYYY is left as it reads', formatClaimDate('31 Jul 2026'), '31 Jul 2026');
check('a single-digit day is padded', formatClaimDate('2026-07-01'), '01 Jul 2026');
check('blank is a dash', formatClaimDate(''), '—');
check('and nothing recognisable is shown as it is', formatClaimDate('sometime in July'), 'sometime in July');

// A STAMPED moment — an approval, a rejection, the day Xero settled a bill —
// is written by the server as an ISO timestamp. It matched none of the shapes
// above, so the whole thing was printed raw in a column of "27 Aug 2026" dates:
// "2026-08-27T02:50:29.683Z" under a heading that says Approved.
//
// An instant is rendered as the READER's own calendar day, so what it should
// say is worked out here the same way rather than written down: an approval
// given at 1:30am in Singapore is stamped 17:30Z the day before, and a claim
// approved this morning must not read as yesterday. Asserting a literal would
// only be asserting the timezone the test happens to run in.
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayOf = (t) => {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')} ${MON[d.getMonth()]} ${d.getFullYear()}`;
};
check('an approval stamp reads as a date',
  formatClaimDate('2026-08-27T02:50:29.683Z'), dayOf('2026-08-27T02:50:29.683Z'));
check('…which is a date, not a timestamp',
  /^\d{2} [A-Z][a-z]{2} \d{4}$/.test(formatClaimDate('2026-08-27T02:50:29.683Z')), true);
check('with no milliseconds',
  formatClaimDate('2026-08-26T09:04:24Z'), dayOf('2026-08-26T09:04:24Z'));
check('with an explicit offset',
  formatClaimDate('2026-08-26T17:30:00+08:00'), dayOf('2026-08-26T17:30:00+08:00'));
check('a stamp that crosses midnight where it is read is the day it is there',
  formatClaimDate('2026-08-26T17:30:00Z'), dayOf('2026-08-26T17:30:00Z'));
// No zone at all is what Date already treats as local time, so these two are
// the same moment and the same day wherever they are read.
check('a stamp with no zone is read as local time', formatClaimDate('2026-08-26T09:04:24'), '26 Aug 2026');
check('a space instead of a T is the same stamp', formatClaimDate('2026-08-26 09:04:24'), '26 Aug 2026');
check('and a broken one is still shown rather than guessed at',
  formatClaimDate('2026-13-45T99:99:99Z'), '2026-13-45T99:99:99Z');

// A bare ISO date is NOT read as an instant: Date reads it as UTC midnight,
// which renders as the day before anywhere west of Greenwich. Splitting it by
// hand is what keeps an end date the end date wherever it is read.
check('a bare ISO date is a calendar date, not midnight UTC',
  parseDateParts('2026-08-27'), { y: 2026, mo: 8, d: 27 });

// Storage stays a calendar date, so an end date picked from a timestamp is the
// day of it rather than the timestamp.
check('ISO storage of a typed date', toIsoClaimDate('31/07/2026'), '2026-07-31');
check('ISO storage of a stamp is its day', toIsoClaimDate('2026-08-27T02:50:29.683Z'), '2026-08-27');
check('nothing unparseable is stored', toIsoClaimDate('sometime'), '');

// The activity feed is a trail of events, so it keeps the hour — a date alone
// would say three things happened on Wednesday and not which came first.
{
  const t = '2026-08-27T02:50:29.683Z';
  const d = new Date(t);
  check('an event stamp keeps its time',
    formatClaimStamp(t),
    `${dayOf(t)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  check('a date with no time in it stays a date', formatClaimStamp('2026-07-31'), '31 Jul 2026');
  check('nothing is nothing', formatClaimStamp(''), '');
  check('and a broken stamp is shown as it is', formatClaimStamp('whenever'), 'whenever');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
