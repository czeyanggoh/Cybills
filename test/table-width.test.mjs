// The table's own floor: what its shown columns asked for. Below it an
// auto-layout table sizes each column from its longest WORD instead, which is
// what collapsed Status to one word per line — see src/lib/tableWidth.js.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const { columnWidth, tableMinWidth } = await import('../src/lib/tableWidth.js');

// A width class is read as the pixels it asks for.
assert.equal(columnWidth('w-[150px]'), 150);
// `w-` is the preference and `min-w-` the floor under it, so the WIDEST of the
// two is what the column asked for — not their sum, and not whichever came
// first in the string.
assert.equal(columnWidth('w-[220px] min-w-[200px]'), 220);
assert.equal(columnWidth('min-w-[136px] w-[150px]'), 150);
// A floor ABOVE the preference is what the column needs.
assert.equal(columnWidth('w-[100px] min-w-[180px]'), 180);
// Nothing declared falls back rather than counting as nothing, or a table of
// undeclared columns would be given no floor at all.
assert.equal(columnWidth(undefined), 120);
assert.equal(columnWidth('whitespace-nowrap px-3'), 120);
assert.equal(columnWidth(undefined, 90), 90);
// And not fooled by a longer class ending in one: `max-w-[260px]` caps the
// content of a cell, it does not ask for a column.
assert.equal(columnWidth('max-w-[260px]'), 120);

// The sum, plus the fixed cells outside the column list.
assert.equal(tableMinWidth([{ width: 'w-[100px]' }, { width: 'w-[50px]' }]), 150);
assert.equal(tableMinWidth([{ width: 'w-[100px]' }], 36), 136);
assert.equal(tableMinWidth([]), 0);
assert.equal(tableMinWidth(undefined, 40), 40);

// The Costs columns themselves. tablePrefs.js carries a React hook, so its
// declarations are read as text rather than imported — what is being checked is
// that every column really does declare a width, since one that doesn't is
// silently counted as the fallback and the floor comes out wrong.
const prefs = readFileSync(new URL('../src/lib/tablePrefs.js', import.meta.url), 'utf8');
const costBlock = prefs.slice(prefs.indexOf('export const COST_COLUMNS'), prefs.indexOf('export const CLAIM_COLUMNS'));
const costColumns = [...costBlock.matchAll(/\{ key: '(\w+)',[^}]*\}/g)].map((m) => ({
  key: m[1],
  width: (m[0].match(/width: '([^']+)'/) || [])[1],
  primary: m[0].includes('primary: true'),
  fixed: m[0].includes('fixed: true'),
}));
assert.ok(costColumns.length > 20, `only found ${costColumns.length} Costs columns`);
for (const c of costColumns) {
  assert.ok(columnWidth(c.width, 0) > 0, `column ${c.key} declares no width`);
}

// And the default set really is wider than a laptop window — which is the whole
// reason the floor is computed from the columns rather than guessed at 1000px.
const shown = costColumns.filter((c) => c.fixed || c.primary);
assert.ok(tableMinWidth(shown, 96 + 40) > 1400, 'the default columns fit a narrow window after all');

console.log('table-width ok');
