// The star a read puts in front of its own description.
//
// Two hands write a cost's description — the reader's on the way in, a person's
// when they correct it — and in the ledger, in an export and in the Costs list
// those look identical. The star says which one wrote this, and a description
// somebody has rewritten stops saying it the moment they drop it.
import { starDescription } from '../src/lib/description.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

check('a read’s description wears the star', starDescription('Lunch at Din Tai Fung'), '* Lunch at Din Tai Fung');
// The same description is composed again on every re-read, and it is starred by
// the server and again by the browser, so the star must never stack up.
check('once, however many times it is asked', starDescription('* Lunch at Din Tai Fung'), '* Lunch at Din Tai Fung');
check('and again', starDescription(starDescription(starDescription('Grab ride'))), '* Grab ride');
// A lone star describes nothing. A read that came back with nothing leaves the
// field empty, which is what the inbox reads to say so.
check('a blank stays blank', starDescription(''), '');
check('and so does nothing at all', starDescription(null), '');
// Everything the read composed sits behind the star — the period, the people.
check(
  'the whole composed sentence',
  starDescription('Client dinner (August 2026) — attendees: 6 pax'),
  '* Client dinner (August 2026) — attendees: 6 pax'
);

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
