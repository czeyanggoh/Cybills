// When a portal login retrieves by itself (Costs -> Retrieve).
//
// Pure, so the login dialog, the card and the server's clock read one rule —
// loaded server-side by path (server/src/retrieve.ts) the way digest.ts loads
// digest.js. Days are the PRACTICE's calendar days as YYYY-MM-DD keys and the
// hour is the practice's local hour; the server works both out against
// PRACTICE_TIMEZONE, so nothing here needs to know which timezone that is.
//
// Measured by DAY, like the daily digest: a login runs at most once per
// practice day, whatever the clock or a restart does, and a run that was missed
// because the server was down is made up when it comes back — the latest slot
// that has passed and was never run is due, so a monthly retrieval due on the
// 5th, with the server down from the 4th to the 7th, runs on the 7th. A slot
// before the schedule was set is not a missed one: a schedule saved on the 10th
// for "the 5th of each month" first runs on the 5th of next month.

export const SCHEDULE_FREQUENCIES = ['off', 'daily', 'monthly'];
export const SCHEDULE_HOURS = Array.from({ length: 24 }, (_, i) => i);
export const SCHEDULE_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
export const DEFAULT_SCHEDULE = { frequency: 'off', day: 1, hour: 7 };

const int = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

/** A schedule as stored: unknown or missing parts take the defaults. */
export function normaliseSchedule(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    frequency: SCHEDULE_FREQUENCIES.includes(v.frequency) ? v.frequency : DEFAULT_SCHEDULE.frequency,
    day: int(v.day, 1, 31, DEFAULT_SCHEDULE.day),
    hour: int(v.hour, 0, 23, DEFAULT_SCHEDULE.hour),
  };
}

/** Whether a schedule sent by a caller is one this module can keep, as sent. */
export function validSchedule(value) {
  if (!value || typeof value !== 'object') return false;
  if (!SCHEDULE_FREQUENCIES.includes(value.frequency)) return false;
  if (value.hour !== undefined && int(value.hour, 0, 23, null) === null) return false;
  if (value.day !== undefined && int(value.day, 1, 31, null) === null) return false;
  return true;
}

const pad = (n) => String(n).padStart(2, '0');
const parts = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};
const keyOf = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The day key `n` days after `key`. */
export function addDays(key, n) {
  const p = parts(key);
  return p ? keyOf(p.y, p.m, p.d + n) : '';
}

// The run day in the month `offset` months from `key`'s. A day the month does
// not have is its last day: "the 31st" is 30 Sep and 28 Feb.
function monthlyDay(key, day, offset) {
  const p = parts(key);
  if (!p) return '';
  const first = new Date(Date.UTC(p.y, p.m - 1 + offset, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  return keyOf(y, m, Math.min(day, daysIn(y, m)));
}

// The latest slot that has come by `today` at `hourNow` — the one a run is owed
// for if nothing has run since.
function latestSlot(s, today, hourNow) {
  if (s.frequency === 'daily') return hourNow >= s.hour ? today : addDays(today, -1);
  const here = monthlyDay(today, s.day, 0);
  if (here < today || (here === today && hourNow >= s.hour)) return here;
  return monthlyDay(today, s.day, -1);
}

/**
 * Whether a login's schedule is due now.
 * @param schedule  the login's schedule (normalised here)
 * @param state     { lastDay, from }: the practice day it last ran by schedule,
 *                  and the day the schedule was set
 * @param today     YYYY-MM-DD, the practice's day
 * @param hourNow   0-23, the practice's hour
 */
export function scheduleDue(schedule, state, today, hourNow) {
  const s = normaliseSchedule(schedule);
  if (s.frequency === 'off' || !parts(today)) return false;
  const slot = latestSlot(s, today, hourNow);
  const lastDay = state?.lastDay || '';
  const from = state?.from || '';
  // lastDay is the day it RAN, not the slot it ran for — so a slot caught up
  // at 00:30 and today's 07:00 one are one run, never two in a practice day.
  if (lastDay && lastDay >= slot) return false;
  if (from && slot < from) return false;
  return true;
}

/** The practice day the next scheduled run falls on ('' when off). */
export function nextScheduledDay(schedule, state, today, hourNow) {
  const s = normaliseSchedule(schedule);
  if (s.frequency === 'off' || !parts(today)) return '';
  if (scheduleDue(s, state, today, hourNow)) return today;
  const ranToday = (state?.lastDay || '') === today;
  if (s.frequency === 'daily') return !ranToday && hourNow < s.hour ? today : addDays(today, 1);
  const here = monthlyDay(today, s.day, 0);
  if (here > today || (here === today && !ranToday && hourNow < s.hour)) return here;
  return monthlyDay(today, s.day, 1);
}

export const hourLabel = (h) => `${pad(h)}:00`;

export function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** "Daily at 07:00", "Monthly on the 5th at 07:00", "Off". */
export function scheduleLabel(schedule) {
  const s = normaliseSchedule(schedule);
  if (s.frequency === 'daily') return `Daily at ${hourLabel(s.hour)}`;
  if (s.frequency === 'monthly') {
    const tail = s.day > 28 ? ' (or the month’s last day)' : '';
    return `Monthly on the ${ordinal(s.day)}${tail} at ${hourLabel(s.hour)}`;
  }
  return 'Off';
}

/** "Fri 5 Nov 2026" for a day key, without a Date's timezone getting a say. */
export function dayKeyLabel(key) {
  const p = parts(key);
  if (!p) return '';
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return d.toLocaleDateString('en-SG', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
