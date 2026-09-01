// An inbound address is two facts joined: the person's handle, and the short
// form their entity chose. Mirrors server/src/users.ts, which is the authority
// — this is what makes the address a page PREVIEWS the one that gets saved.
import {
  cleanHandle,
  cleanSuffix,
  localPart,
  inboundAddress,
  entityAddress,
  addressTail,
  suffixForUser,
} from '../src/lib/inboundAddress.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The handle --------------------------------------------------------------
check('a name becomes a local part', cleanHandle('Martin Lim'), 'martinlim');
check('a whole address pasted back in keeps its local part', cleanHandle('martin@cybills.sg'), 'martin');
check('nothing usable leaves nothing', cleanHandle('@@@'), '');

// --- The short form ----------------------------------------------------------
check('a short form is lowercased', cleanSuffix('RedAlpha'), 'redalpha');
check('hyphens survive', cleanSuffix('red-alpha'), 'red-alpha');
// A dot is what separates the person from the entity, so a suffix carrying one
// would leave the address reading as three parts with no way to say where the
// split was meant to be.
check('a dot does not', cleanSuffix('red.alpha'), 'redalpha');
check('and neither does an @', cleanSuffix('redalpha@cybills.sg'), 'redalpha');

// --- Joined ------------------------------------------------------------------
check('person then entity', localPart('martin', 'redalpha'), 'martin.redalpha');
check('no short form leaves the bare handle', localPart('martin', ''), 'martin');
check('no handle is no address at all', inboundAddress('', 'redalpha'), '');
check('the whole address', inboundAddress('martin', 'redalpha'), 'martin.redalpha@cybills.sg');

// The short form standing alone is the ENTITY's address rather than anybody's,
// and what arrives there files under the General account. An entity that has set
// no short form simply has none — printing one made from its name would put an
// address on the page that reaches nobody.
check("an entity's own address is its short form alone", entityAddress('redalpha'), 'redalpha@cybills.sg');
check('…and no short form is no address', entityAddress(''), '');
check('…cleaned the same way the field cleans it', entityAddress('Red Alpha'), 'redalpha@cybills.sg');

// The tail is the fixed half printed beside the editable handle, so it has to
// carry the short form too — otherwise the field shows one address and the
// server stores another.
check('the tail carries the short form', addressTail('redalpha'), '.redalpha@cybills.sg');
check('…and is just the domain without one', addressTail(''), '@cybills.sg');

// --- Whose short form --------------------------------------------------------
const orgs = [
  { id: 'org_cybm', name: 'CY Business Management', isPrimary: true, emailSuffix: '' },
  { id: 'org_red', name: 'Red Alpha', emailSuffix: 'redalpha' },
];
check("a client's employee carries their own entity's", suffixForUser({ organisationId: 'org_red' }, orgs), 'redalpha');
// A colleague belongs to no single client, so their address follows the same
// rule an emailed document of theirs does: the practice's primary entity.
check('a colleague on no entity falls back to the primary one', suffixForUser({ organisationId: '' }, orgs), '');
// An entity the caller cannot open has no short form to read here, so the bare
// handle is shown rather than the primary entity's, which would be an address
// belonging to nobody.
check('an entity nobody can see is not borrowed from', suffixForUser({ organisationId: 'org_gone' }, orgs), '');
check('a colleague filed under the practice carries its short form', suffixForUser({ organisationId: '' }, [{ id: 'p', isPrimary: true, emailSuffix: 'cybm' }]), 'cybm');

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
