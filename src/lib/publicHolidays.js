// Singapore's public holidays, as the Ministry of Manpower gazettes them
// (mom.gov.sg/employment-practices/public-holidays). The practice works to the
// Singapore calendar — PRACTICE_TIMEZONE is Asia/Singapore — so a day the
// office is shut is one of these, whichever country the client is in.
//
// A LIST rather than a rule, because most of them cannot be computed: Chinese
// New Year, Hari Raya, Vesak and Deepavali follow lunar calendars and are
// fixed by the government a year or so ahead, and a Polling Day is declared at
// a few weeks' notice. So this is the gazetted list, kept by hand: add the next
// year when MOM publishes it, and a Polling Day when one is called.
// `HOLIDAYS_KNOWN_THROUGH` is the last year it covers, which is what lets the
// screens say when the list has run out instead of quietly skipping nothing.
//
// When a holiday falls on a SUNDAY the Monday after is a public holiday too,
// and both are listed: a digest set to go out every day should skip the
// Sunday, and one set to weekdays should skip the Monday. A Saturday holiday
// has no public day in lieu, so it stands alone.
//
// Pure, so `npm test` holds it; the digest (src/lib/digest.js) reads it on both
// sides.

export const SG_PUBLIC_HOLIDAYS = {
  '2026-01-01': "New Year's Day",
  '2026-02-17': 'Chinese New Year',
  '2026-02-18': 'Chinese New Year',
  '2026-03-21': 'Hari Raya Puasa',
  '2026-04-03': 'Good Friday',
  '2026-05-01': 'Labour Day',
  '2026-05-27': 'Hari Raya Haji',
  '2026-05-31': 'Vesak Day',
  '2026-06-01': 'Vesak Day (observed)',
  '2026-08-09': 'National Day',
  '2026-08-10': 'National Day (observed)',
  '2026-11-08': 'Deepavali',
  '2026-11-09': 'Deepavali (observed)',
  '2026-12-25': 'Christmas Day',

  '2027-01-01': "New Year's Day",
  '2027-02-06': 'Chinese New Year',
  '2027-02-07': 'Chinese New Year',
  '2027-02-08': 'Chinese New Year (observed)',
  '2027-03-10': 'Hari Raya Puasa',
  '2027-03-26': 'Good Friday',
  '2027-05-01': 'Labour Day',
  '2027-05-17': 'Hari Raya Haji',
  '2027-05-20': 'Vesak Day',
  '2027-08-09': 'National Day',
  '2027-10-28': 'Deepavali',
  '2027-12-25': 'Christmas Day',
};

export const HOLIDAYS_KNOWN_THROUGH = 2027;

const dayKeyOf = (value) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return m ? m[1] : '';
};

// The holiday's name on a YYYY-MM-DD day, or '' when it is an ordinary day.
export function publicHolidayOn(dayKey) {
  return SG_PUBLIC_HOLIDAYS[dayKeyOf(dayKey)] || '';
}

// The first holiday on or after a day, or null once the list has run out.
export function nextPublicHoliday(dayKey) {
  const from = dayKeyOf(dayKey);
  if (!from) return null;
  const day = Object.keys(SG_PUBLIC_HOLIDAYS).sort().find((d) => d >= from);
  return day ? { day, name: SG_PUBLIC_HOLIDAYS[day] } : null;
}

// Whether the list says anything about a day's year. Past its last year it
// knows of no holidays at all, which must read as "not known yet" rather than
// as "none".
export function holidaysKnownFor(dayKey) {
  const year = Number(dayKeyOf(dayKey).slice(0, 4));
  return year > 0 && year <= HOLIDAYS_KNOWN_THROUGH;
}
