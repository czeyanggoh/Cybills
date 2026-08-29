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
// that both fit, an entity the caller can't open — resolves to "no answer" and
// the document stays exactly where it was put.

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

// The entity this document should have been filed under, when that is not the
// one it IS filed under. Null in every other case, including the ordinary one.
//
// `organisations` is the list the CALLER may open, which is what makes this
// safe to show: an entity somebody can't work in is not in the list, so it can
// never be matched, named on screen, or transferred to. A single accessible
// entity has nothing to be wrong about, and the current one has to be among
// them — "it isn't this one" drawn from a list that never held it is not a
// conclusion, it is an artefact.
export function misfiledOrganisation({ billedTo, currentOrgId, organisations }) {
  const list = (Array.isArray(organisations) ? organisations : []).filter((o) => o && o.id);
  if (list.length < 2) return null;
  if (!list.some((o) => o.id === currentOrgId)) return null;
  const match = matchOrganisation(billedTo, list);
  if (!match || match.orgId === currentOrgId) return null;
  return match;
}
