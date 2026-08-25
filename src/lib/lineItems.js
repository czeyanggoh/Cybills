// One line of a document's itemised table, kept internally consistent.
//
// Net, Tax and Total are three views of the SAME row. Editing one and leaving
// the others where they were makes the row contradict itself — and the row total
// is what the publish path adds up to decide whether the breakdown may be posted
// to Xero at all, so a row that disagrees with itself is not a display problem.
//
//   net or tax → total = net + tax
//   total      → net   = total − tax
//
// Total gives way to net rather than to tax because the tax is the figure the
// document states; the net is the one derived from it.
//
// Pure and tested (test/line-items.test.mjs) rather than only exercised through
// the grid, because the arithmetic is the part that has to be right.

// A cell's number, or null when it holds nothing usable. Null matters: it is how
// "the person cleared this cell" and "the person is midway through typing" stay
// distinguishable from a real zero, so neither cascades a 0.00 into the
// neighbouring cells under their cursor.
export function cellNumber(value) {
  const text = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Apply `patch` to `row`, then restore the row's own arithmetic. Anything that
// isn't one of the three money cells passes straight through.
export function balanceLine(row, patch) {
  const next = { ...row, ...patch };
  const touched = ['net', 'tax', 'total'].find((f) => f in patch);
  if (!touched || cellNumber(patch[touched]) === null) return next;
  if (touched === 'total') {
    next.net = ((cellNumber(next.total) ?? 0) - (cellNumber(next.tax) ?? 0)).toFixed(2);
  } else {
    next.total = ((cellNumber(next.net) ?? 0) + (cellNumber(next.tax) ?? 0)).toFixed(2);
  }
  return next;
}
