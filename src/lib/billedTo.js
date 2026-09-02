// Who a document was billed TO, checked against the entity it was filed under.
//
// Which entity a document belongs to is decided entirely by PROVENANCE — who
// uploaded it and which entity they had open, which inbound address it was
// emailed to, which WhatsApp group it arrived through. Nothing has ever read
// the paper itself, so an invoice addressed to one client, filed under another,
// looks exactly like a correct one: it publishes into the wrong ledger, coded
// to the wrong chart, claiming the wrong company's input tax.
//
// The reader now reads the bill-to party (`billedTo` + `billedToRegNo`, see
// extract.ts) and this is what it means. Pure, and tested by `npm test` at the
// repo root — it is loaded server-side too (server/src/entityCheck.ts), the same
// arrangement taxRateRules.js and categoryList.js have, so the badge on a row
// and the verdict behind the Move button can never disagree.
//
// A WARNING, never a refusal. A document can legitimately name somebody else:
// an intercompany recharge, a trading name, a group company that pays for its
// subsidiaries, a landlord billing the tenant a client sublets from. So the
// worst this does is ask, and "This is right" settles it for good.

// Words that identify a company's legal FORM rather than the company. Dropped
// from both sides before comparing, so "Dart Consulting And Training Pte Ltd"
// and "DART CONSULTING AND TRAINING PRIVATE LIMITED" are one name.
const FORM_WORDS = new Set([
  'pte', 'ptd', 'ltd', 'limited', 'private', 'llp', 'llc', 'lp', 'inc',
  'incorporated', 'plc', 'corp', 'corporation', 'co', 'company', 'sdn', 'bhd',
  'gmbh', 'ag', 'bv', 'nv', 'sa', 'srl', 'sarl', 'pty',
]);

// Bookkeeping labels an ENTITY's name carries that the paper never does. A
// client with two ledgers is listed as "DART Consulting (SGD)"; the invoice it
// pays says "DART CONSULTING AND TRAINING PTE LTD". The parenthesis is ours.
const NOISE_WORDS = new Set(['sgd', 'usd', 'myr', 'gbp', 'eur', 'aud', 'sg', 'old', 'new']);

// A company name reduced to the part that identifies it: lower case, no
// punctuation, no trailing legal form. "&" is spelled out so "Tan & Sons" and
// "Tan and Sons" agree, and a parenthesised tail is dropped whole — it is a
// label somebody put on a ledger, not part of anybody's registered name.
export function normaliseCompanyName(value) {
  const words = String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // Only from the END: "Pte Ltd Holdings" is not a thing, but "Limited Brands"
  // is a name whose first word must survive.
  while (words.length > 1 && FORM_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

// The words that actually name the company: no legal form anywhere, no ledger
// label. This is what two spellings of one company are compared on, because they
// differ in the MIDDLE as often as at the end — "Dart Consulting" against "Dart
// Consulting and Training" is the same company with two words inserted, and no
// amount of containment will find it.
export function significantWords(value) {
  const words = normaliseCompanyName(value).split(' ').filter(Boolean);
  const kept = words.filter((w) => !FORM_WORDS.has(w) && !NOISE_WORDS.has(w) && w !== 'and');
  // A name made of nothing else keeps what it has rather than becoming nobody.
  return kept.length ? kept : words;
}

// A registration number reduced to what it is: "M2-0000542-2" and "M20000542 2"
// are the same number written two ways, and OCR spaces a UEN as it pleases.
export function normaliseRegNo(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Are these two the same company by name?
//
// `minWords` is how much of a name has to be there. Deciding a document is FINE
// costs nothing if it is wrong — that is today's behaviour — so one naming word
// is allowed to settle it. Proposing to move a document into another client's
// book on the same evidence is not: "Alpha" and "Alpha Trading" are not one
// company, so the caller that offers a MOVE asks for two.
export function sameCompany(a, b, { minWords = 1 } = {}) {
  const x = normaliseCompanyName(a);
  const y = normaliseCompanyName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Containment on a WORD boundary, for the names that are one inside the other.
  // Substring alone would read "Dart" out of "Dartmouth" and move a document to
  // the wrong client on it.
  if (
    short.split(' ').length >= minWords &&
    (long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `))
  ) {
    return true;
  }
  // Otherwise: is the shorter name entirely inside the longer one, word for
  // word, in the words that actually NAME the company?
  //
  // Every word, not merely some — a list of clients is full of "Consulting",
  // "Services" and "Singapore", and one word in common is nothing. "CY Business
  // Management" and "CY-Biz" share only "cy", so they stay two companies, which
  // is what makes a CY-Biz invoice sitting in CYBM's book something to ask
  // about. And anchored on the FIRST word, which is where two near-misses in one
  // client list differ: "ARC3 Nobel" and "ARCHER NOBEL" share "nobel".
  const xs = significantWords(a);
  const ys = significantWords(b);
  if (!xs.length || !ys.length || xs[0] !== ys[0]) return false;
  const [few, many] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
  if (!few.every((w) => many.includes(w))) return false;
  return few.length >= Math.max(1, minWords);
}

// The names and numbers one entity answers to. Its CYBills name, the Xero
// organisation it is linked to, and the registered name/CRN/GST number off its
// Business profile — all four are the same company said by different systems,
// and a document may print any of them.
export function entityIdentity(entity) {
  const profile = entity?.profile || {};
  return {
    id: entity?.id || '',
    name: entity?.name || profile.businessName || '',
    standalone: Boolean(entity?.standalone),
    names: [entity?.name, entity?.tenantName, profile.businessName].filter(Boolean),
    regNos: [profile.taxNumber, profile.crn].map(normaliseRegNo).filter(Boolean),
  };
}

const nameHit = (billedTo, identity, minWords) =>
  identity.names.some((n) => sameCompany(billedTo, n, { minWords }));

// Which of `others` this document looks addressed to. Strict: a registration
// number, or a name agreeing in at least two words. This answer becomes a button
// offering to move a client's paperwork into another client's book, so a
// near-miss must produce nothing rather than a plausible wrong destination.
function candidatesFor(billedTo, regNo, others) {
  return others
    .map(entityIdentity)
    .filter((o) => !o.standalone)
    .filter((o) => (regNo && o.regNos.includes(regNo)) || nameHit(billedTo, o, 2))
    .map((o) => ({ id: o.id, name: o.name }));
}

// Does this document's bill-to party agree with the entity it is filed under?
//
//   'ok'       — it names this entity (by registration number, or by name)
//   'mismatch' — it names somebody else
//   'unknown'  — there is nothing to check: no addressee on the paper (most
//                receipts print none), or a bridge entity, whose documents are
//                addressed to the people who submit them
//
// `candidates` is the other entities the CALLER can already open that the
// document does name — the offer to put it where it belongs. Empty is common
// and means only that CYBills holds no book for whoever it is addressed to.
export function billedToVerdict(doc, entity, others = []) {
  const billedTo = String(doc?.billedTo ?? '').trim();
  const regNo = normaliseRegNo(doc?.billedToRegNo);
  const me = entityIdentity(entity);
  const blank = { status: 'unknown', evidence: '', billedTo, candidates: [] };

  // A SALES invoice is billed to the customer — that is what a sales invoice is
  // — so every one of them names somebody who isn't this entity. Checking them
  // would put a wrong-entity badge on the whole Sales book.
  if (String(doc?.kind || 'cost') === 'sales') {
    return { ...blank, reason: 'A sales invoice is made out to the customer, which is who it is supposed to name.' };
  }
  // A bridge entity is not the company on anybody's invoice — ST Engineering
  // staff claim against Red Alpha's ledger, and their receipts name themselves,
  // their employer, or nobody. Checking it would flag every document it holds.
  if (me.standalone) {
    return { ...blank, reason: 'A bridge entity holds other people’s paperwork, so who a document is addressed to says nothing about whether it belongs here.' };
  }
  if (!billedTo && !regNo) {
    return { ...blank, reason: 'This document names no bill-to party — most receipts don’t.' };
  }

  // The registration number first: it is the only identifier that cannot be a
  // trading name, an abbreviation or a misread.
  if (regNo && me.regNos.length) {
    if (me.regNos.includes(regNo)) {
      return { status: 'ok', evidence: 'regNo', billedTo, candidates: [], reason: `Billed to ${billedTo || 'this entity'} — the registration number on it is ${me.name}’s.` };
    }
    return {
      status: 'mismatch',
      evidence: 'regNo',
      billedTo,
      candidates: candidatesFor(billedTo, regNo, others),
      reason: `This document is billed to ${billedTo || 'another party'} (registration ${doc.billedToRegNo}), which is not ${me.name}.`,
    };
  }
  if (!billedTo) return { ...blank, reason: 'This document names a bill-to registration number but no party.' };
  if (nameHit(billedTo, me, 1)) {
    return { status: 'ok', evidence: 'name', billedTo, candidates: [], reason: `Billed to ${billedTo}.` };
  }
  return {
    status: 'mismatch',
    evidence: 'name',
    billedTo,
    candidates: candidatesFor(billedTo, regNo, others),
    reason: `This document is billed to ${billedTo}, not to ${me.name}.`,
  };
}
