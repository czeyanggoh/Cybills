// The period the Clients page prices AI API spend over.
//
// The vocabulary lives in the browser (src/lib/usageRange.js) and the
// arithmetic lives here, because "this week" means this week in the practice's
// own timezone — days roll over in Singapore — and the browser asking may not
// be in it. That split is only safe while the two agree on the words, so the
// last check below walks the browser's own list and asserts every key it offers
// resolves to something other than the fallback.
import { resolveRange } from '../src/usage.ts';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
// 30 Aug 2026 is a Sunday, which is the day a Monday-started week is most
// easily got wrong.
const TODAY = '2026-08-30';
const at = (range: string, extra: Record<string, string> = {}) => {
  const { from, to } = resolveRange({ range, ...extra }, TODAY);
  return `${from}..${to}`;
};

check('today', at('today'), '2026-08-30..2026-08-30');
check('yesterday', at('yesterday'), '2026-08-29..2026-08-29');
check('the week so far runs from Monday', at('week'), '2026-08-24..2026-08-30');
check('last week is a whole Monday-to-Sunday', at('last-week'), '2026-08-17..2026-08-23');
check('the month so far', at('month'), '2026-08-01..2026-08-30');
check('last month, whole', at('last-month'), '2026-07-01..2026-07-31');
check('last 30 days includes today', at('last-30'), '2026-08-01..2026-08-30');
check('the quarter so far', at('quarter'), '2026-07-01..2026-08-30');
check('the year so far', at('year'), '2026-01-01..2026-08-30');

// Month ends are read off the calendar rather than assumed: the day before the
// first of the next month is right in February and in a leap year alike.
check('last month across the new year', resolveRange({ range: 'last-month' }, '2026-01-04').from + '..' + resolveRange({ range: 'last-month' }, '2026-01-04').to, '2025-12-01..2025-12-31');
check('last month is February, in a leap year', resolveRange({ range: 'last-month' }, '2024-03-15').to, '2024-02-29');
check('last week across the new year', resolveRange({ range: 'last-week' }, '2026-01-04').from, '2025-12-22');

// A custom range takes what it is given, and fills in what it is not: a start
// with no end means "since then". Dates the wrong way round are read as the
// range they describe rather than refused — nobody types two dates meaning an
// empty window.
check('custom, both ends', at('custom', { from: '2026-05-04', to: '2026-06-10' }), '2026-05-04..2026-06-10');
check('custom, no end', at('custom', { from: '2026-05-04' }), '2026-05-04..2026-08-30');
check('custom, no start', at('custom', { to: '2026-08-10' }), '2026-08-01..2026-08-10');
check('custom, back to front', at('custom', { from: '2026-06-10', to: '2026-05-04' }), '2026-05-04..2026-06-10');
check('custom, nonsense dates', at('custom', { from: 'last tuesday', to: '' }), '2026-08-01..2026-08-30');

// A key nobody recognises — a stale bookmark, a typo — shows this month rather
// than nothing at all, and says so, so the page can name the period it is
// actually showing instead of the one it was asked for.
check('an unknown key falls back to this month', resolveRange({ range: 'fortnight' }, TODAY), {
  key: 'month',
  from: '2026-08-01',
  to: '2026-08-30',
});
check('no range at all is this month', resolveRange({}, TODAY).key, 'month');

// The contract with the browser: every preset it offers must resolve to itself.
const { USAGE_RANGES } = (await import(
  new URL('../../src/lib/usageRange.js', import.meta.url).href
)) as { USAGE_RANGES: Array<{ key: string; label: string }> };
const unresolved = USAGE_RANGES.map((r) => r.key).filter(
  (key) => resolveRange({ range: key, from: '2026-05-04', to: '2026-06-10' }, TODAY).key !== key
);
check('every preset the page offers resolves', unresolved, []);

console.log(failures ? `\n${failures} failing` : '\nAll good');
process.exit(failures ? 1 : 0);
