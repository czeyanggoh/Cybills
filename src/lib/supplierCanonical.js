// Which supplier a freshly read name IS, among the suppliers this entity
// already has. Pure: the server loads it by path (supplierName.ts) and applies
// it to every read, the upload's and the background one alike.
//
// The reader copies the name as each invoice prints it, so one vendor arrives
// as "Xero (NZ) Limited" this month and "Xero (NZ) Ltd" the next, and every
// spelling then becomes a supplier of its own: in the picker, in the supplier
// rules (matched by name), and, once published, as a new Xero contact, since
// Xero matches a contact by its exact name and creates one for a new name.
//
// What it does, in order:
//   1. a spelling somebody MERGED AWAY on the Suppliers page goes to the name it
//      was merged into (`merged`, keyed lower-case), following a chain;
//   2. a name that is already a live supplier, case aside, stays itself;
//   3. a name that differs from merged-away spellings only the way
//      normaliseSupplier ignores (case, punctuation, "&", Pte Ltd / Limited)
//      goes where those went, if they all went to one place;
//   4. likewise against the live suppliers: one match is taken; several are
//      ranked (has a supplier rule, then most documents, then a Xero contact)
//      and the top one is taken only if it strictly wins. A tie leaves the
//      read as it was, because guessing between two real names is worse than
//      one more spelling somebody can merge.
// Never a near-miss: "OCBC Loan 2" and "OCBC Loan 3" normalise apart and stay
// apart. Nothing here invents a name: the answer is always one already in use.

import { normaliseSupplier } from './supplierDuplicates.js';

const lower = (v) => String(v ?? '').trim().toLowerCase();
const PLACEHOLDER = /^unknown (supplier|customer)$/i;

function follow(name, merged) {
  let cur = String(name).trim();
  const seen = new Set();
  while (merged[lower(cur)] && !seen.has(lower(cur))) {
    seen.add(lower(cur));
    cur = String(merged[lower(cur)]).trim();
  }
  return cur;
}

// candidates: [{ name, rule?: boolean, docs?: number, xero?: boolean }]
// removed:    names removed from the Suppliers list (merged-away ones included)
// merged:     { "lower-cased spelling": "kept name" }
// Returns { name, from } — from is 'merge', 'spelling' or '' (left as read).
export function canonicalSupplierName(read, { candidates = [], removed = [], merged = {} } = {}) {
  const asRead = { name: read, from: '' };
  const r = String(read ?? '').trim();
  if (!r || PLACEHOLDER.test(r)) return asRead;
  const key = normaliseSupplier(r);
  if (!key) return asRead;
  const map = merged && typeof merged === 'object' ? merged : {};

  // 1. Exactly a merged-away spelling.
  if (map[lower(r)]) {
    const to = follow(r, map);
    if (to && lower(to) !== lower(r)) return { name: to, from: 'merge' };
  }

  const removedSet = new Set([...removed.map(lower), ...Object.keys(map).map(lower)]);
  // One entry per live name, its evidence summed (the same name can come from
  // Xero, a rule and the documents at once).
  const live = new Map();
  for (const c of candidates) {
    const name = String(c?.name ?? '').trim();
    if (!name || PLACEHOLDER.test(name) || removedSet.has(lower(name))) continue;
    const cur = live.get(lower(name)) || { name, rule: false, docs: 0, xero: false };
    cur.rule = cur.rule || Boolean(c.rule);
    cur.docs += Number(c.docs) || 0;
    cur.xero = cur.xero || Boolean(c.xero);
    live.set(lower(name), cur);
  }

  // 2. Already a live supplier.
  const exact = live.get(lower(r));
  if (exact) return exact.name === r ? asRead : { name: exact.name, from: 'spelling' };

  // 3. The same name as spellings merged away, all into one place.
  const targets = new Set();
  let target = '';
  for (const from of Object.keys(map)) {
    if (normaliseSupplier(from) !== key) continue;
    target = follow(from, map);
    targets.add(lower(target));
  }
  if (targets.size === 1 && target) return { name: target, from: 'merge' };

  // 4. The same name as a live supplier.
  const matches = [...live.values()].filter((c) => normaliseSupplier(c.name) === key);
  if (!matches.length) return asRead;
  if (matches.length === 1) return { name: matches[0].name, from: 'spelling' };
  const score = (c) => [c.rule ? 1 : 0, c.docs, c.xero ? 1 : 0];
  const cmp = (a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  };
  matches.sort(cmp);
  if (cmp(matches[0], matches[1]) === 0) return asRead;
  return { name: matches[0].name, from: 'spelling' };
}
