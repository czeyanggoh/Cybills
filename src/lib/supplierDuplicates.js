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

// Two names are "the same supplier" when their normalised forms are equal, or
// within a small edit distance (scaled to length) to catch typos like the
// missing "n" in "Accouting".
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const max = a.length <= 8 ? 1 : a.length <= 16 ? 2 : 3;
  return editDistance(a, b, max) <= max;
}

// Group the names into clusters of suspected duplicates. Returns only the
// clusters with 2+ members, largest first. Pure — safe to call on every render.
export function findDuplicateGroups(names) {
  const items = (names || [])
    .map((name) => ({ name, key: normaliseSupplier(name) }))
    .filter((x) => x.key);
  const used = new Array(items.length).fill(false);
  const groups = [];
  for (let i = 0; i < items.length; i += 1) {
    if (used[i]) continue;
    const group = [items[i].name];
    used[i] = true;
    for (let j = i + 1; j < items.length; j += 1) {
      if (used[j]) continue;
      if (similar(items[i].key, items[j].key)) {
        group.push(items[j].name);
        used[j] = true;
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}
