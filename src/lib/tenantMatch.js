// Which client entity a document is actually made out to.
//
// A practice colleague works across many clients and uploads into whichever
// entity happens to be open — so a Red Alpha invoice lands in CY Business
// Management's book, and nothing notices. The document says who it belongs to
// on its face: "Bill To: Red Alpha Cybersecurity Pte. Ltd." is the whole
// answer, printed by the supplier, and the uploader can already open both
// entities. This module is the comparison, kept pure and in ONE place because
// both sides read it — the Costs listing decides it server-side (so an emailed
// or WhatsApp document is checked too), and the browser shows and acts on it.
//
// It answers or it says nothing. A wrong answer here moves somebody's paperwork
// into another client's book, so every uncertainty — a near-miss, two entities
// that both fit — resolves to "no answer" and the document stays exactly where
// it was put. An entity the caller cannot OPEN is a different thing from an
// uncertainty: the answer is known, it just can't be acted on, and saying so is
// worth more than silence (see `access` below).

// Legal forms, not names. "Red Alpha Cybersecurity Pte. Ltd." on an invoice and
// "Red Alpha Cybersecurity" in CYBills are one company, and the difference is
// never the thing that tells two clients apart. Longest first, so "private
// limited" is taken as one form rather than leaving a stray "private".
const LEGAL_FORMS = [
  'private limited',
  'pte limited',
  'sdn bhd',
  'pty ltd',
  'pte ltd',
  'pte',
  'llp',
  'llc',
  'plc',
  'ltd',
  'limited',
  'incorporated',
  'inc',
  'corporation',
  'corp',
  'company',
  'co',
  'gmbh',
  'bhd',
  'bv',
  'nv',
  'sa',
  'ag',
];

// A name reduced to the words that identify it: lower case, punctuation gone,
// "&" read as "and", and any trailing legal form stripped (repeatedly — plenty
// of documents print "XYZ Pte Ltd Co").
export function normaliseEntityName(value) {
  let s = String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return '';
  let trimming = true;
  while (trimming) {
    trimming = false;
    for (const form of LEGAL_FORMS) {
      if (s === form) return ''; // the whole name was a legal form — nothing left
      if (s.endsWith(` ${form}`)) {
        s = s.slice(0, -(form.length + 1)).trim();
        trimming = true;
        break;
      }
    }
  }
  return s;
}

// The names one entity answers to: what CYBills calls it, and what Xero calls
// the tenant behind it. They differ often enough to matter — an entity renamed
// here for the practice's own convenience still bills under its registered name.
export function entityAliases(org) {
  return [org?.name, org?.tenantName]
    .map(normaliseEntityName)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

// Is `needle` a run of whole words inside `haystack`? Word-boundary, never
// substring: "alpha" must not match inside "alphabet", and a client called
// "Cyber" must not claim every document billed to "Cybersecurity Pte Ltd".
function containsWords(haystack, needle) {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

const wordCount = (s) => (s ? s.split(' ').length : 0);

// The entity a document made out to `billedTo` belongs to, or null.
//
// Two tiers, strongest first, and they never mix: an exact match on any alias,
// then one name containing the other as a run of whole words. The second tier
// needs at least two words on the shorter side — a one-word entity ("Cybills")
// would otherwise claim every document whose bill-to line happens to say it,
// and one word is not enough evidence to move somebody's paperwork on.
//
// Whichever tier answers, it has to answer ONCE: two entities matching equally
// well is not a weak answer, it is no answer — "Red Alpha" alone cannot choose
// between "Red Alpha Cybersecurity" and "Red Alpha - ST Engineering", and
// guessing is exactly the failure this exists to prevent.
export function matchOrganisation(billedTo, organisations) {
  const target = normaliseEntityName(billedTo);
  if (!target) return null;
  const list = (Array.isArray(organisations) ? organisations : []).filter((o) => o && o.id);

  const exact = [];
  const partial = [];
  for (const org of list) {
    for (const alias of entityAliases(org)) {
      if (alias === target) {
        exact.push(org);
        break;
      }
      const shorter = wordCount(alias) <= wordCount(target) ? alias : target;
      const longer = shorter === alias ? target : alias;
      if (wordCount(shorter) >= 2 && containsWords(longer, shorter)) {
        partial.push(org);
        break;
      }
    }
  }

  const tier = exact.length ? exact : partial;
  const unique = tier.filter((o, i, a) => a.findIndex((x) => x.id === o.id) === i);
  if (unique.length !== 1) return null; // nothing, or nothing that can be told apart
  const org = unique[0];
  return { orgId: org.id, name: org.name || org.tenantName || '', exact: exact.length > 0 };
}

// Every id, when the caller didn't narrow it. Keeps "no list given" meaning
// "everything is open", which is what a session-less mock/dev context is.
const idsOf = (list) => list.map((o) => o.id);

// The entity this document should have been filed under, when that is not the
// one it IS filed under. Null in every other case, including the ordinary one.
//
// `organisations` is what the document is COMPARED against, and `accessibleIds`
// is the subset the caller may actually open. They are two different questions,
// and keeping them apart is what lets the answer be "this belongs somewhere,
// and it isn't somewhere you can reach" — which is a useful thing to be told,
// and impossible to say when the comparison list is the access list.
//
// Who is given which comparison list, and whether the entity may be NAMED to
// them, is not decided here: it is a question about people rather than about
// names, so it lives beside the roster (server/src/tenantMatch.ts).
//
// One candidate has nothing to be wrong about, and the current entity has to be
// among them — "it isn't this one" drawn from a list that never held it is not
// a conclusion, it is an artefact.
export function misfiledOrganisation({ billedTo, currentOrgId, organisations, accessibleIds = null }) {
  const list = (Array.isArray(organisations) ? organisations : []).filter((o) => o && o.id);
  if (list.length < 2) return null;
  if (!list.some((o) => o.id === currentOrgId)) return null;
  const match = matchOrganisation(billedTo, list);
  if (!match || match.orgId === currentOrgId) return null;
  const open = new Set(Array.isArray(accessibleIds) ? accessibleIds : idsOf(list));
  // `access` is what separates a badge that offers a button from one that
  // explains why there isn't one. A move the caller cannot make must never be
  // offered: the server would refuse it, and a button that refuses is worse
  // than no button.
  return { ...match, access: open.has(match.orgId) };
}

// What to SAY about a document that is in the wrong book, in one place because
// the row and the document page both say it and must not drift — the same
// arrangement src/lib/xeroPaidStatus.js uses for the Paid wording.
//
// Three answers, and the difference between them is whether the reader can do
// anything about it:
//   - they can open the entity → name it, and offer the move
//   - they cannot, but may be told which → name it, and say what to do instead
//   - they cannot, and may not be told → say that it belongs elsewhere, which
//     the bill-to line on their own document already told them
//
// Null when the document is where it belongs, which is nearly always.
export function misfiledNotice(doc) {
  const match = doc?.misfiledTo;
  if (!match) return null;
  const billed = String(doc?.billedTo || '').trim();
  const where = billed ? `Billed to ${billed}` : 'The bill-to line names another entity';
  if (match.access && match.orgId) {
    return {
      canMove: true,
      name: match.name,
      label: `Belongs to ${match.name}`,
      title: `${where}, which is ${match.name} — not the entity this document is in. Move it there.`,
    };
  }
  if (match.name) {
    return {
      canMove: false,
      name: match.name,
      label: `No access — ${match.name}`,
      title: `${where}, which is ${match.name} — not the entity this document is in. You don’t have client access to that entity, so it can’t be moved from here. Add it under Colleagues → Manage → Client access.`,
    };
  }
  return {
    canMove: false,
    name: '',
    label: 'Billed to another entity',
    title: `${where}, which is another client entity — not the one this document is in. You don’t have access to it, so it can’t be moved from here. Ask a practice admin for client access.`,
  };
}
