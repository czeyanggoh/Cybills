// How wide a document table actually needs to be.
//
// Its columns declare their widths as Tailwind classes (see COST_COLUMNS in
// tablePrefs.js), and those widths are only ever honoured while the table has
// room for all of them. Once the shown columns add up to more than the window,
// an auto-layout table stops reading the preference and hands the space out by
// min-content instead — which, for every cell that WRAPS, is its longest single
// word. That is how the Status column came to print "Billed to / Goh / Cze /
// Yang" one word per line, five lines tall, next to a Tax rate column clipped
// off the right-hand edge: the widths were right, and there was nowhere to put
// them.
//
// So the table is given a min-width of what its own columns asked for, and the
// container it sits in scrolls sideways — which it already did. The widths stay
// preferences rather than a fixed layout: a column whose content genuinely
// needs more still takes it, out of the slack, not out of its neighbours'
// declared width.

// A column with no width of its own. Nothing in COST_COLUMNS is without one;
// this is the floor for a table that hasn't declared them.
const FALLBACK = 120;

// The pixels a `width` class string asks for: `w-[220px] min-w-[200px]` is a
// request for 220. The WIDEST of the two, because `w-` is the preference and
// `min-w-` is only the floor under it.
export function columnWidth(width, fallback = FALLBACK) {
  if (typeof width !== 'string') return fallback;
  let widest = 0;
  for (const m of width.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+(?:\.\d+)?)px\]/g)) {
    widest = Math.max(widest, Number(m[1]));
  }
  return widest || fallback;
}

// The whole table's floor: every shown column's own width, plus whatever fixed
// cells sit outside the column list (the sticky checkbox cell and the delete
// button, in the Costs table's case).
export function tableMinWidth(columns, extra = 0) {
  return (columns || []).reduce((n, c) => n + columnWidth(c && c.width), 0) + extra;
}
