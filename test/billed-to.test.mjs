// Is this document in the right client's book?
//
// Until now nothing read the paper: which entity a document lands in is decided
// by who uploaded it and where they were standing, so a United Engineers invoice
// made out to Dart Consulting, filed under Red Alpha, looked exactly like a
// correct one — and would publish into Red Alpha's ledger claiming Red Alpha's
// input tax on a supply made to somebody else.
import {
  billedToVerdict,
  normaliseCompanyName,
  normaliseRegNo,
  sameCompany,
} from '../src/lib/billedTo.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The two normalisations -------------------------------------------------

// A legal form is not part of the name. The same company writes it four ways
// across four documents and they all have to be one company.
check('Pte Ltd is dropped', normaliseCompanyName('Dart Consulting And Training Pte Ltd'), 'dart consulting and training');
check('…and Private Limited', normaliseCompanyName('DART CONSULTING AND TRAINING PRIVATE LIMITED'), 'dart consulting and training');
check('…and the ampersand is spelled out', normaliseCompanyName('Tan & Sons Pte. Ltd.'), 'tan and sons');
// Only from the END, or a company whose name STARTS with one loses it.
check('a form word inside the name survives', normaliseCompanyName('Limited Brands Inc'), 'limited brands');
check('a name made only of form words is not emptied', normaliseCompanyName('Ltd'), 'ltd');

// A registration number is the same number however it is punctuated or spaced.
check('a GST number normalises', normaliseRegNo('M2-0000542-2'), 'M200005422');
check('…and a UEN with spaces', normaliseRegNo('2016 14382 R'), '201614382R');

// --- Name comparison --------------------------------------------------------

check('the same company two ways', sameCompany('Red Alpha Cybersecurity Pte. Ltd.', 'RED ALPHA CYBERSECURITY'), true);
check('a longer trading name still contains it', sameCompany('Red Alpha', 'Red Alpha Cybersecurity Pte Ltd'), true);
check('two different companies', sameCompany('Dart Consulting and Training', 'Red Alpha Cybersecurity'), false);
// Word boundary, not substring: "Dart" must not be found inside "Dartmouth".
check('a substring is not a match', sameCompany('Dart', 'Dartmouth Holdings'), false);
// One shared word settles that a document is FINE (which costs nothing if it is
// wrong — that is today's behaviour) but never that it belongs to another
// client, which is a button that moves a client's paperwork.
check('one word can say a document is ours', sameCompany('Alpha', 'Alpha Trading'), true);
check('…but not with two words demanded', sameCompany('Alpha', 'Alpha Trading', { minWords: 2 }), false);

// The names two systems hold for one company differ in the MIDDLE as often as at
// the end, and a client list carries labels the paper never does. This entity is
// listed as "DART Consulting (SGD)" — one of its two ledgers — and pays an
// invoice made out to "DART CONSULTING AND TRAINING PTE LTD".
check(
  'a ledger label and two extra words are still one company',
  sameCompany('DART CONSULTING AND TRAINING PTE LTD', 'DART Consulting (SGD)', { minWords: 2 }),
  true
);
// …but every naming word has to be shared, not merely one. These four pairs are
// all real neighbours in one client list, and every one of them is two companies.
check('sharing the last word is not enough', sameCompany('ARC3 Nobel Pte. Ltd.', 'ARCHER NOBEL PTE. LTD.', { minWords: 2 }), false);
check('nor sharing the first', sameCompany('CY-Biz Pte. Ltd.', 'CY Business Management Pte. Ltd.'), false);
check('nor a word as common as Consulting', sameCompany('Sunstream Consulting Services Pte Ltd', 'DART Consulting (SGD)'), false);
check('nor Singapore', sameCompany('TYA Singapore Pte Ltd', 'TiffinLabs Singapore Pte. Ltd.'), false);

// --- The verdict ------------------------------------------------------------

const red = {
  id: 'org-red',
  name: 'Red Alpha Cybersecurity Pte. Ltd.',
  tenantName: 'Red Alpha',
  profile: { businessName: 'Red Alpha Cybersecurity Pte. Ltd.', taxNumber: '201614382R', crn: '201614382R' },
};
const dart = {
  id: 'org-dart',
  name: 'Dart Consulting and Training Pte Ltd',
  tenantName: 'Dart Consulting',
  profile: { businessName: 'Dart Consulting and Training Pte Ltd', taxNumber: '199912345K', crn: '199912345K' },
};

// The case this exists for: United Engineers invoices Dart, and it is sitting in
// Red Alpha's book.
let v = billedToVerdict({ billedTo: 'DART CONSULTING AND TRAINING PTE LTD' }, red, [dart]);
check('a document billed to another company is a mismatch', v.status, 'mismatch');
check('…and the reason names both', v.reason.includes('DART CONSULTING') && v.reason.includes('Red Alpha'), true);
check('…and CYBills holds the book it belongs in', v.candidates, [{ id: 'org-dart', name: 'Dart Consulting and Training Pte Ltd' }]);

// The same document in the book it belongs to.
check('billed to us is fine', billedToVerdict({ billedTo: 'Dart Consulting and Training Pte Ltd' }, dart, [red]).status, 'ok');

// Most receipts name nobody. Silence is the only honest answer.
check('a till receipt says nothing either way', billedToVerdict({ billedTo: '' }, red, [dart]).status, 'unknown');

// A registration number beats a name, in both directions: it is the one
// identifier that cannot be a trading name, an abbreviation or a misread.
v = billedToVerdict({ billedTo: 'Red Alpha', billedToRegNo: '1999-12345-K' }, red, [dart]);
check('a buyer number that is not ours is a mismatch whatever the name says', v.status, 'mismatch');
check('…on the number, not the name', v.evidence, 'regNo');
check('…and it finds whose number it is', v.candidates[0].id, 'org-dart');
check(
  'our own number settles it',
  billedToVerdict({ billedTo: 'Some Trading Name', billedToRegNo: '201614382R' }, red, [dart]).status,
  'ok'
);

// The case as it actually appears: the entity is listed under a ledger label.
const dartSgd = { id: 'org-dart', name: 'DART Consulting (SGD)', tenantName: 'DART Consulting (SGD)', profile: {} };
v = billedToVerdict({ billedTo: 'DART CONSULTING AND TRAINING PTE LTD' }, red, [dartSgd]);
check('the entity list label does not hide the destination', v.candidates, [
  { id: 'org-dart', name: 'DART Consulting (SGD)' },
]);
check('…and in its own book it is fine', billedToVerdict({ billedTo: 'DART CONSULTING AND TRAINING PTE LTD' }, dartSgd, []).status, 'ok');

// A near-miss must produce no destination rather than a plausible wrong one:
// this answer becomes a button that moves a client's paperwork into another
// client's book.
v = billedToVerdict({ billedTo: 'Alpha Logistics Pte Ltd' }, dart, [red]);
check('a stranger is still a mismatch', v.status, 'mismatch');
check('…but with nowhere to move it to', v.candidates, []);

// A sales invoice is billed to the customer — that is what it IS — so checking
// them would badge the entire Sales book as misfiled.
check(
  'a sales invoice is not checked',
  billedToVerdict({ kind: 'sales', billedTo: 'Dart Consulting and Training Pte Ltd' }, red, [dart]).status,
  'unknown'
);

// A bridge entity holds other people's paperwork by design — ST Engineering
// staff claim against Red Alpha's ledger, and their receipts name themselves,
// their employer, or nobody. Checking it would flag everything it holds.
const bridge = { id: 'org-ste', name: 'Red Alpha - ST Engineering', standalone: true, profile: {} };
check(
  'a bridge entity is not checked',
  billedToVerdict({ billedTo: 'ST Engineering Land Systems Ltd' }, bridge, [red, dart]).status,
  'unknown'
);
// …and it is never offered as somewhere to move a document TO, for the same
// reason: it is not the company on anybody's invoice.
check(
  'nor offered as a destination',
  billedToVerdict({ billedTo: 'Red Alpha - ST Engineering' }, dart, [bridge]).candidates,
  []
);

// An entity with no Business profile filled in has no number to compare, so the
// name has to answer — never a mismatch for want of data we simply don't hold.
const bare = { id: 'org-bare', name: 'Red Alpha Cybersecurity', profile: {} };
check(
  'no profile falls back to the name',
  billedToVerdict({ billedTo: 'Red Alpha Cybersecurity Pte Ltd', billedToRegNo: '201614382R' }, bare, []).status,
  'ok'
);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
