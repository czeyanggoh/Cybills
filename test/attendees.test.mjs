// Who was at the table, and what a description says when nobody wrote it down.
//
// A meal or a meeting is only half recorded by its amount: the other half is
// who it was for, and it is the half nobody can reconstruct a year later. So on
// those categories the description has to say — the people where the paper or
// the covering message names them, and that nobody did where neither does.
// Never a guess: an invented guest list reads as evidence.
import { isAttendeeCategory, attendeeCategories, withAttendees, NO_ATTENDEES } from '../src/lib/attendees.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Which categories ask the question ---------------------------------------
// A Xero label carries its account code; the digits match nothing, so no code
// has to be stripped off before the words are read.
check('a Xero entertainment account', isAttendeeCategory('420 - Entertainment'), true);
check('and the meals one beside it', isAttendeeCategory('493 - Staff Meals & Refreshments'), true);
// A bridge entity has no chart at all — its categories are the plain names off
// its own claim form, and they ask the same question.
check('a claim-policy meal', isAttendeeCategory('Meal Weekday (after 9pm)'), true);
check('a client meeting', isAttendeeCategory('Client meetings'), true);
check('staff welfare', isAttendeeCategory('Staff Welfare'), true);

// And which do not. The words are matched whole, so a category is never dragged
// in by a fragment of one — "Retreat" is not "eat", and a repair is not a meal.
check('a taxi fare', isAttendeeCategory('Transport - Taxi'), false);
check('general expenses', isAttendeeCategory('429 - General Expenses'), false);
check('a company retreat venue', isAttendeeCategory('Retreat venue hire'), false);
check('repairs', isAttendeeCategory('Repairs & Maintenance'), false);
check('nothing at all', isAttendeeCategory(''), false);

// What the reader's prompt names: this entity's own labels, not a description of
// them — the chart has already made the judgement.
check(
  'the entity’s own people-categories',
  attendeeCategories(['429 - General Expenses', '420 - Entertainment', 'Transport - Taxi', 'Meal Weekend']),
  ['420 - Entertainment', 'Meal Weekend']
);
check('nothing to name', attendeeCategories(['429 - General Expenses']), []);
check('nothing at all to name', attendeeCategories(null), []);

// --- Joining the answer onto the description ---------------------------------
check(
  'the people are appended, not folded in',
  withAttendees('Lunch at Din Tai Fung', 'Kai Tan and two of the ARC3 team', '420 - Entertainment'),
  'Lunch at Din Tai Fung — attendees: Kai Tan and two of the ARC3 team'
);
// A head count is an answer. It is what most till receipts print, and it is
// still more than a blank.
check(
  'a head count counts',
  withAttendees('Dinner at Jumbo Seafood', '4 pax', 'Meal Weekday (after 9pm)'),
  'Dinner at Jumbo Seafood — attendees: 4 pax'
);
// Nobody wrote it down. Said out loud rather than left silent: a blank there is
// indistinguishable from a meal whose guests did not matter, and this is the
// sentence that sends a reviewer to fill them in.
check(
  'and the silence is said out loud',
  withAttendees('Lunch at Din Tai Fung', '', '420 - Entertainment'),
  `Lunch at Din Tai Fung — ${NO_ATTENDEES}`
);
// Everything else is left exactly as it was read. A taxi fare with three people
// in the car is still a taxi fare.
check('a taxi keeps its own description', withAttendees('Grab ride Jurong to Raffles', '', 'Transport - Taxi'), 'Grab ride Jurong to Raffles');
// Nothing to append to. A read that got nothing produces no description, and
// "attendees not stated" on its own describes nothing at all.
check('an empty description stays empty', withAttendees('', '', '420 - Entertainment'), '');

// --- Applied twice, because it is --------------------------------------------
// The server writes it at the read; the re-read applies it again once a supplier
// rule has had the last word on the category. Neither may say it twice.
const once = withAttendees('Team lunch', 'the finance team', '420 - Entertainment');
check('idempotent with names', withAttendees(once, 'the finance team', '420 - Entertainment'), once);
const bare = withAttendees('Team lunch', '', '420 - Entertainment');
check('idempotent without them', withAttendees(bare, '', '420 - Entertainment'), bare);
// And a name found on the second pass does not displace the marker written on
// the first — the description already answers the question, either way.
check('the first answer stands', withAttendees(bare, 'the finance team', '420 - Entertainment'), bare);

// A reader that worked the people into its own sentence keeps its wording:
// saying it twice is worse than the prompt being disobeyed.
check(
  'said already, said once',
  withAttendees('Lunch with Dean Chua and Priya', 'Dean Chua and Priya', '420 - Entertainment'),
  'Lunch with Dean Chua and Priya'
);

// A supplier rule can move a document OFF a meal category on the re-read. The
// marker was written for a meal and this is no longer one, so it comes back off
// — but a real guest list is a fact about the document and stays.
check(
  'the marker is taken back off',
  withAttendees(`Grab ride Jurong to Raffles — ${NO_ATTENDEES}`, '', 'Transport - Taxi'),
  'Grab ride Jurong to Raffles'
);
check(
  'the names are not',
  withAttendees('Team offsite — attendees: the finance team', '', 'Transport - Taxi'),
  'Team offsite — attendees: the finance team'
);

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
