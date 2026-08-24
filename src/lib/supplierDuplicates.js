// Find likely-duplicate supplier NAMES in a list — the "ACCOUNTING AND CORPORATE
// REGULATORY AUTHORITY" vs "Accouting And Corporate Regulatory Authority" case.
// Suppliers come from the org's Xero contacts, so this SURFACES duplicates to
// review; the contacts themselves are de-duplicated in Xero.

// Normalise a name for comparison: lowercase, strip punctuation, collapse
// whitespace, and drop the common company suffixes that don't distinguish two
// records of the same entity.
const SUFFIXES = /\b(pte|ptd|ltd|limited|llp|llc|inc|incorporated|co|company|corp|corporation|sdn|bhd|gmbh)\b/g;
export function normaliseSupplier(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein edit distance, capped early once it exceeds `max` (cheap when the
// two strings are obviously different).
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let best = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < best) best = curr[j];
    }
    if (best > max) return max + 1; // whole row already past the cap
    prev = curr;
  }
  return prev[b.length];
}

// The numbers in a name, in order: "OCBC Loan 2" → "2", "A1 Consultancy" → "1".
//
// A digit that differs is NOT a typo, it is an enumeration. "OCBC Loan 2" and
// "OCBC Loan 3" are two different loan accounts, and "A1 Consultancy" and "A2
// Consultancy" are two different firms — yet each pair is one edit apart, so
// distance alone called them the same supplier. Letters are where people slip
// ("Accouting" for "Accounting"); a number is chosen deliberately, and the whole
// reason it is in the name is to tell one from another.
const digitsOf = (s) => (String(s || '').match(/\d+/g) || []).join(' ');

// A stable identifier for one PAIR of names, order-independent — what a
// "not a duplicate" verdict is recorded against.
export function pairKey(a, b) {
  return [normaliseSupplier(a), normaliseSupplier(b)].sort().join(' | ');
}

// Every pair inside a suggested group, so rejecting the group rejects each
// pairing it was built from — and a later name can't quietly re-form it.
export function pairsInGroup(group = []) {
  const out = [];
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) out.push(pairKey(group[i], group[j]));
  }
  return out;
}

// Two names are "the same supplier" when their normalised forms are equal, or
// within a small edit distance (scaled to length) to catch typos like the
// missing "n" in "Accouting" — but never when their numbers disagree.
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (digitsOf(a) !== digitsOf(b)) return false;
  const max = a.length <= 8 ? 1 : a.length <= 16 ? 2 : 3;
  return editDistance(a, b, max) <= max;
}

// Group the names into clusters of suspected duplicates. Returns only the
// clusters with 2+ members, largest first. Pure — safe to call on every render.
//
// `dismissed` is the set of pair keys a reviewer has already said are NOT the
// same supplier; those pairings are never suggested again.
export function findDuplicateGroups(names, { dismissed = null } = {}) {
  const items = (names || [])
    .map((name) => ({ name, key: normaliseSupplier(name) }))
    .filter((x) => x.key);
  const rejected = dismissed instanceof Set ? dismissed : new Set(dismissed || []);
  const used = new Array(items.length).fill(false);
  const groups = [];
  for (let i = 0; i < items.length; i += 1) {
    if (used[i]) continue;
    const group = [items[i].name];
    used[i] = true;
    for (let j = i + 1; j < items.length; j += 1) {
      if (used[j]) continue;
      if (rejected.has(pairKey(items[i].name, items[j].name))) continue;
      if (similar(items[i].key, items[j].key)) {
        group.push(items[j].name);
        used[j] = true;
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}
