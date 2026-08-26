// Which documents a supplier merge actually touches, decided in one pure place.
//
// One supplier arrives under several spellings — "ACCOUNTING AND CORPORATE
// REGULATORY AUTHORITY", "Accouting And Corporate Regulatory Authority", "ACRA"
// — and merging re-points every document at the one name the org keeps. Getting
// that wrong renames the wrong documents, so the decision is separated from the
// page that renders it and tested directly (test/supplier-merge.test.mjs).
//
// Two rules run through it:
//   - Names are matched WITHOUT regard to case or surrounding space. The whole
//     reason a merge is needed is that the spellings differ, and a reader's
//     spelling is rarely byte-identical to the Xero contact's.
//   - A document already published to Xero is never touched. Its figures are in
//     the ledger; renaming the copy here would only make the two disagree. It is
//     reported as skipped rather than silently left behind.

const norm = (s) => String(s ?? '').trim().toLowerCase();

// What a merge would do, without doing any of it.
//
//   docs        — the cost documents in this book
//   keep        — the name to keep
//   mergedAway  — the names being merged into it
//   rulePatch   — the kept supplier's standing rule, as a field patch
//   taxFor      — (rateName, total) => tax string, when the rule sets a tax rate
//
// Returns { moves, skipped, unchanged }: `moves` is [{ id, patch }] ready to
// send, `skipped` the published documents that must be left alone.
export function planSupplierMerge({ docs = [], keep = '', mergedAway = [], rulePatch = {}, taxFor = null } = {}) {
  const keptName = String(keep ?? '').trim();
  const gone = new Set(mergedAway.map(norm).filter(Boolean));
  // Merging a name into itself is not a move; it would also delete the rule of
  // the supplier being kept.
  gone.delete(norm(keptName));

  const moves = [];
  const skipped = [];
  if (!keptName || !gone.size) return { moves, skipped, unchanged: docs.length };

  for (const d of docs) {
    if (!gone.has(norm(d?.supplier))) continue;
    if (d?.xeroInvoiceId) {
      skipped.push(d);
      continue;
    }
    // Only stored documents can be patched; one still being read has no row yet.
    if (d?.persisted === false) continue;
    const patch = { supplier: keptName, ...rulePatch };
    if (patch.taxRate && typeof taxFor === 'function') patch.tax = taxFor(patch.taxRate, d?.total);
    moves.push({ id: d.id, patch });
  }
  return { moves, skipped, unchanged: docs.length - moves.length - skipped.length };
}

// The names a merge should drop from the Suppliers list: everything merged away,
// never the name being kept.
export function namesMergedAway(keep, mergedAway = []) {
  const k = norm(keep);
  const seen = new Set();
  return mergedAway
    .map((n) => String(n ?? '').trim())
    .filter((n) => n && norm(n) !== k && !seen.has(norm(n)) && seen.add(norm(n)));
}
