// Which tab a cost document belongs in. Both answers are derived from the
// document itself: Ready when the reader finished it, To review when it could
// not — the account code it could not choose, the fields it could not read. To
// review used to be a STATUS that only a toolbar button could write, so a
// document needing attention appeared there only if somebody had already
// noticed it and pressed the button.
import {
  isComplete,
  missingFields,
  isReady,
  needsReview,
  isInInbox,
  isArchived,
  inCostsList,
  isUnpublished,
  READY_FIELDS,
} from '../src/lib/readiness.js';

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

// Inbox and Archive are one list, split by whether the document's figures have
// reached Xero rather than by which tab somebody filed it under. Publishing is
// what archives a document, so "unpublished" is NOT the old Inbox renamed.
{
  const inbox = doc({ status: 'new' });
  const archivedNeverPublished = doc({ status: 'archived' });
  const published = doc({ status: 'archived', xeroInvoiceId: 'inv-1' });
  const onClaim = doc({ status: 'expenseclaim' });
  const merged = doc({ status: 'merged' });
  const stillReading = doc({ status: 'processing' });

  check('an inbox document is in the list', inCostsList(inbox), true);
  check('so is an archived one', inCostsList(archivedNeverPublished), true);
  check('a document still being read is not', inCostsList(stillReading), false);
  check('archive statuses are archived, inbox ones are not',
    [isArchived(archivedNeverPublished), isArchived(onClaim), isArchived(merged), isArchived(inbox)],
    [true, true, true, false]);

  check('an inbox document is unpublished', isUnpublished(inbox), true);
  check('an archived document nobody ever published is TOO — the point of one list',
    isUnpublished(archivedNeverPublished), true);
  check('a published one is not', isUnpublished(published), false);
  check('nor is one riding on an expense claim, which reaches Xero as the claim',
    isUnpublished(onClaim), false);
  check('nor is one merged away into another document', isUnpublished(merged), false);
  check('a document still being read is in neither half',
    [isUnpublished(stillReading), inCostsList(stillReading)], [false, false]);

  // Unpublished is a subset of the whole list, never a document outside it.
  const all = [inbox, archivedNeverPublished, published, onClaim, merged, stillReading];
  check('every unpublished document is in the list',
    all.filter(isUnpublished).every(inCostsList), true);
  check('and the list is the wider of the two',
    [all.filter(inCostsList).length, all.filter(isUnpublished).length], [5, 2]);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
