// Which tab a cost document belongs in. Both answers are derived from the
// document itself: Ready when the reader finished it, To review when it could
// not — the account code it could not choose, the fields it could not read. To
// review used to be a STATUS that only a toolbar button could write, so a
// document needing attention appeared there only if somebody had already
// noticed it and pressed the button.
import { isComplete, missingFields, isReady, needsReview, isInInbox, READY_FIELDS } from '../src/lib/readiness.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const doc = (over) => ({
  status: 'new',
  supplier: 'Grab',
  date: '2026-08-22',
  category: '429 - General Expenses',
  total: '100',
  ...over,
});

// A finished document is Ready and nobody's problem.
const done = doc({ status: 'ready' });
check('a complete document is complete', isComplete(done), true);
check('…and needs nobody', needsReview(done), false);
check('…and lists nothing missing', missingFields(done), []);

// The case this exists for: the reader could not pick an account code.
const uncoded = doc({ category: 'Uncategorised' });
check('no account code is not complete', isComplete(uncoded), false);
check('…so a person is needed', needsReview(uncoded), true);
check('…and the row says which field', missingFields(uncoded), ['Category']);
check('an empty category counts the same', missingFields(doc({ category: '' })), ['Category']);

// The other placeholders the reader leaves behind.
check('unknown supplier', missingFields(doc({ supplier: 'Unknown supplier' })), ['Supplier']);
check('an em dash is not a date', missingFields(doc({ date: '—' })), ['Date']);
check('zero is not a total', missingFields(doc({ total: '0' })), ['Total']);
check('a blank read names all four',
  missingFields(doc({ supplier: 'Unknown supplier', date: '', category: '', total: '0' })),
  READY_FIELDS);

// Settled documents are nobody's problem either, however incomplete.
for (const status of ['archived', 'expenseclaim', 'merged', 'deleted', 'processing']) {
  check(`${status} is out of the inbox`, isInInbox(doc({ status })), false);
  check(`…and never asks for review`, needsReview(doc({ status, category: 'Uncategorised' })), false);
}

// Inbox is exactly Ready + To review, with nothing falling between them.
{
  const inbox = [
    doc({ status: 'ready' }),
    doc({ status: 'new', category: 'Uncategorised' }),
    doc({ status: 'viewed', total: '0' }),
    doc({ status: 'review' }), // written while To review was a status, since completed
  ];
  const ready = inbox.filter(isReady);
  const review = inbox.filter(needsReview);
  check('every inbox document is in one tab or the other', ready.length + review.length, inbox.length);
  check('and never in both', ready.some((d) => review.includes(d)), false);
  check('a legacy "review" row that is now complete is not still asking for review',
    needsReview(doc({ status: 'review' })), false);
  check('…it is simply Ready', isReady(doc({ status: 'review' })), true);
  check('a row stamped ready that lost a field is back under review',
    [isReady(doc({ status: 'ready', category: '' })), needsReview(doc({ status: 'ready', category: '' }))],
    [false, true]);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
