// How a period is named on the Clients page.
//
// The dates come back from the server already resolved, so all this side has to
// do is say them — but a date range said badly is worse than no date at all,
// and 'YYYY-MM-DD' handed to Date is UTC midnight, which prints as the day
// before anywhere west of Greenwich. So the keys are read as three numbers and
// never as a Date. The resolution itself is tested server-side
// (server/test/usage-range.test.mts), which also asserts that every key listed
// here is one the server knows.
import assert from 'node:assert/strict';
import {
  USAGE_RANGES,
  DEFAULT_USAGE_RANGE,
  rangeLabel,
  formatDayRange,
  windowLabel,
} from '../src/lib/usageRange.js';

// The parts both ends share are printed once, at the end, the way somebody
// writes a date range by hand.
assert.equal(formatDayRange('2026-08-03', '2026-08-03'), '3 Aug 2026');
assert.equal(formatDayRange('2026-08-01', '2026-08-31'), '1–31 Aug 2026');
assert.equal(formatDayRange('2026-07-28', '2026-08-03'), '28 Jul – 3 Aug 2026');
assert.equal(formatDayRange('2025-12-28', '2026-01-03'), '28 Dec 2025 – 3 Jan 2026');

// A day is never off by one, whatever timezone the browser is in: the keys are
// read as numbers rather than parsed as instants.
assert.equal(formatDayRange('2026-01-01', '2026-01-01'), '1 Jan 2026');
assert.equal(formatDayRange('2026-12-31', '2026-12-31'), '31 Dec 2026');

// Nothing to say is said as nothing — the label is dropped, not printed as
// "Invalid Date".
assert.equal(formatDayRange('', ''), '');
assert.equal(formatDayRange('2026-08-01', 'soon'), '');
assert.equal(formatDayRange('2026-13-01', '2026-13-02'), '');

// A preset is named by its own words; a range somebody picked by hand is named
// by its dates, since "Custom range" tells the reader nothing about what they
// are looking at.
assert.equal(windowLabel('last-month', '2026-07-01', '2026-07-31'), 'Last month');
assert.equal(windowLabel('custom', '2026-07-01', '2026-07-15'), '1–15 Jul 2026');
assert.equal(windowLabel('custom', '', ''), 'Custom range');

// An unknown key gets the words for what the server actually falls back to, so
// the page never labels itself with a period it isn't showing.
assert.equal(rangeLabel('fortnight'), 'This month');
assert.equal(rangeLabel(DEFAULT_USAGE_RANGE), 'This month');

const keys = USAGE_RANGES.map((r) => r.key);
assert.equal(new Set(keys).size, keys.length, 'a key is offered twice');
assert.ok(keys.includes(DEFAULT_USAGE_RANGE), 'the default is not on the list');
assert.ok(keys.includes('custom'), 'there is no way to pick dates by hand');
assert.ok(
  USAGE_RANGES.every((r) => typeof r.label === 'string' && r.label.trim()),
  'a period is offered with nothing to call it'
);

console.log('usage-range: all good');
