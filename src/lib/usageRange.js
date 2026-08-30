// The windows the Clients page can price AI API spend over.
//
// A key is resolved into actual dates by the SERVER (`resolveRange` in
// server/src/usage.ts), never here: "this week" means this week in the
// PRACTICE's own timezone — days roll over in Singapore — and the browser
// asking may not be in it. So this module owns the vocabulary and the words
// for it, the server owns the arithmetic, and a server test walks this list to
// assert every key it offers actually resolves, so the two can't drift.

export const USAGE_RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' },
];

export const DEFAULT_USAGE_RANGE = 'month';

export function rangeLabel(key) {
  return USAGE_RANGES.find((r) => r.key === key)?.label ?? 'This month';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day key is read as three numbers rather than as a Date: 'YYYY-MM-DD' parsed
// by Date is UTC midnight, which prints as the day before anywhere west of it.
function parts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  if (month < 1 || month > 12) return null;
  return { y: Number(y), m: month, d: Number(d) };
}

// "3 Aug 2026" · "1–31 Aug 2026" · "28 Jul – 3 Aug 2026" · "28 Dec 2025 – 3 Jan 2026".
// The parts both ends share are printed once, at the end, the way a date range
// is written by hand.
export function formatDayRange(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return '';
  const full = (p) => `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
  if (a.y === b.y && a.m === b.m && a.d === b.d) return full(a);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${full(b)}`;
  return `${full(a)} – ${full(b)}`;
}

// What the range is called on a stat card or a column header: the preset's own
// words, or the dates themselves when somebody picked them.
export function windowLabel(key, from, to) {
  if (key === 'custom') return formatDayRange(from, to) || 'Custom range';
  return rangeLabel(key);
}
