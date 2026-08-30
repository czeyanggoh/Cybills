// Which client entity a document is made out to — and, therefore, whether it
// was filed under the wrong one. Mirrors server/src/tenantMatch.ts, which loads
// this very module rather than re-implementing it: a second copy of the rule
// that decides whose book a receipt moves into is exactly the drift that must
// not happen.
import { normaliseEntityName, matchOrganisation, misfiledOrganisation, misfiledNotice } from '../src/lib/tenantMatch.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Reducing a name to what identifies it -----------------------------------
check('case and punctuation go', normaliseEntityName('Red Alpha Cybersecurity'), 'red alpha cybersecurity');
check('a legal form goes', normaliseEntityName('Red Alpha Cybersecurity Pte. Ltd.'), 'red alpha cybersecurity');
check('…however it is spelt', normaliseEntityName('RED ALPHA CYBERSECURITY PRIVATE LIMITED'), 'red alpha cybersecurity');
check('…and however many are stacked up', normaliseEntityName('Acme Trading Pte Ltd Co'), 'acme trading');
check('an ampersand reads as the word', normaliseEntityName('Tan & Sons'), 'tan and sons');
check('a name that is only a legal form is no name', normaliseEntityName('Pte Ltd'), '');
check('nothing in, nothing out', normaliseEntityName('   '), '');

const ORGS = [
  { id: 'org-cybm', name: 'CY Business Management', tenantName: 'CY Business Management Pte. Ltd.' },
  { id: 'org-red', name: 'Red Alpha Cybersecurity', tenantName: 'Red Alpha Cybersecurity Pte Ltd' },
  { id: 'org-ste', name: 'Red Alpha - ST Engineering', tenantName: '' },
];

// --- Matching ----------------------------------------------------------------
check(
  'the name as CYBills holds it',
  matchOrganisation('Red Alpha Cybersecurity', ORGS)?.orgId,
  'org-red'
);
check(
  'the registered name a supplier prints',
  matchOrganisation('RED ALPHA CYBERSECURITY PTE. LTD.', ORGS)?.orgId,
  'org-red'
);
check(
  'the name Xero holds, when the two differ',
  matchOrganisation('CY Business Management Pte Ltd', ORGS)?.orgId,
  'org-cybm'
);
// A longer bill-to line still names the entity: "Attn: Accounts, Red Alpha
// Cybersecurity" is the same company with a department in front of it.
check(
  'the entity named inside a longer line',
  matchOrganisation('Attn Accounts Payable, Red Alpha Cybersecurity Pte Ltd', ORGS)?.orgId,
  'org-red'
);

// The refusals. Each of these would move somebody's paperwork into another
// client's book on evidence that cannot carry it.
check('a shared prefix chooses nobody', matchOrganisation('Red Alpha', ORGS), null);
check('a supplier that is not a client', matchOrganisation('Grab Singapore Pte Ltd', ORGS), null);
check('a blank bill-to line', matchOrganisation('', ORGS), null);
check('a single word is never enough on its own', matchOrganisation('Cybersecurity', ORGS), null);
// Word boundaries, not substrings: an entity called "Cyber" must not claim a
// document billed to "Cybersecurity Holdings".
check(
  'a word inside a word is not a match',
  matchOrganisation('Cybersecurity Holdings Pte Ltd', [{ id: 'org-x', name: 'Cyber Holdings' }]),
  null
);

// --- Was it filed in the right place? ----------------------------------------
const misfiled = (billedTo, currentOrgId, organisations = ORGS) =>
  misfiledOrganisation({ billedTo, currentOrgId, organisations });

check(
  'a Red Alpha invoice uploaded into CYBM',
  misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-cybm'),
  { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: true }
);
check('…and the same invoice in its own book says nothing', misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-red'), null);
check('a document billed to nobody we hold says nothing', misfiled('Some Other Company Pte Ltd', 'org-cybm'), null);

// One entity has nothing to be wrong about. An entity that is not among the
// candidates at all cannot be matched, named, or moved to — which is how a
// client's own employee never learns another client's name.
check(
  'a single candidate entity is never wrong',
  misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-cybm', [ORGS[0]]),
  null
);
check(
  'an entity outside the candidates is not an answer',
  misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-cybm', [ORGS[0], ORGS[2]]),
  null
);

// --- Compared against, but not open to you -----------------------------------
// A practice colleague is compared against every entity the firm holds, so the
// answer can be "it belongs somewhere, and it isn't somewhere you can reach" —
// which is the case they most need telling, and the one silence hides.
check(
  'an entity they may not open still answers, and says so',
  misfiledOrganisation({
    billedTo: 'Red Alpha Cybersecurity Pte Ltd',
    currentOrgId: 'org-cybm',
    organisations: ORGS,
    accessibleIds: ['org-cybm'],
  }),
  { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: false }
);
check(
  'no access list means everything is open (mock/dev)',
  misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-cybm').access,
  true
);

// --- What gets said ----------------------------------------------------------
const notice = (billedTo, misfiledTo) => misfiledNotice({ billedTo, misfiledTo });
check('a document where it belongs says nothing', notice('Whoever', null), null);
check(
  'a move you can make is offered',
  notice('RED ALPHA CYBERSECURITY PTE. LTD.', { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: true }).canMove,
  true
);
check(
  '…and names where it goes',
  notice('RED ALPHA CYBERSECURITY PTE. LTD.', { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: true }).label,
  'Belongs to Red Alpha Cybersecurity'
);
// Named, but not a button: the entity is known to them and the remedy is named.
check(
  'a move you cannot make is never offered as one',
  notice('RED ALPHA CYBERSECURITY PTE. LTD.', { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: false }).canMove,
  false
);
check(
  '…and says which entity, when they may be told',
  notice('RED ALPHA CYBERSECURITY PTE. LTD.', { orgId: 'org-red', name: 'Red Alpha Cybersecurity', exact: true, access: false }).label,
  'No access — Red Alpha Cybersecurity'
);
// Redacted: the fact survives without the name, and the name they see is the
// one printed on their own document.
check(
  '…and only that it is elsewhere, when they may not',
  notice('RED ALPHA CYBERSECURITY PTE. LTD.', { orgId: '', name: '', exact: true, access: false }).label,
  'Billed to another entity'
);
// "It isn't this one" drawn from a list that never held this one is an artefact,
// not a conclusion.
check(
  'the current entity has to be among the candidates',
  misfiled('Red Alpha Cybersecurity Pte Ltd', 'org-gone', ORGS),
  null
);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
