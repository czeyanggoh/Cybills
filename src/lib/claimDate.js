// How a claim's dates are read and written. Pure, so `npm test` can hold the
// rules to account and nothing that shows a date can drift from them.
//
// Claim end dates were stored in whatever shape they were entered — ISO, DD/MM/
// YYYY, DDMMYYYY, "DD Mon YYYY" — which is why the list looked inconsistent.
// Parse the common shapes to parts, then render/store them one canonical way.

export const CLAIM_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A date somebody TYPED is a calendar date and nothing else: "2026-08-27" is
// the 27th wherever it is read, so it is split by hand rather than through
// Date, which reads a bare ISO date as UTC midnight and renders it as the 26th
// anywhere west of Greenwich.
function parseTypedDate(s) {
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return { y: +m[1], mo: +m[2], d: +m[3] };
  if ((m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s))) return { y: +m[3], mo: +m[2], d: +m[1] };
  if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) return { y: +m[3], mo: +m[2], d: +m[1] };
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(s))) {
    const mo = CLAIM_MON.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()) + 1;
    if (mo) return { y: +m[3], mo, d: +m[1] };
  }
  return null;
}

// A MOMENT, not a typed date: an approval, a rejection, the day Xero settled a
// bill. The server stamps those with `new Date().toISOString()`, so they arrive
// as "2026-08-27T02:50:29.683Z" — which none of the shapes above matches, so
// the whole timestamp was printed raw in a column of "27 Aug 2026" dates.
//
// Read as an INSTANT and rendered as the reader's own calendar day: an approval
// given at 1:30am in Singapore is stamped 17:30Z the day before, and a claim
// approved this morning must not say yesterday. A stamp with no zone at all is
// what Date already treats as local time.
function parseInstant(s) {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const t = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(t.getTime())) return null;
  return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate() };
}

export function parseDateParts(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return parseTypedDate(s) ?? parseInstant(s);
}

// Consistent display: "31 Jul 2026". Blank → "—"; unparseable → shown as-is.
export function formatClaimDate(v) {
  const p = parseDateParts(v);
  if (!p) return v ? String(v) : '—';
  if (p.mo < 1 || p.mo > 12) return String(v);
  return `${String(p.d).padStart(2, '0')} ${CLAIM_MON[p.mo - 1]} ${p.y}`;
}

// Canonical ISO YYYY-MM-DD for storage + the native date picker value.
export function toIsoClaimDate(v) {
  const p = parseDateParts(v);
  if (!p || p.mo < 1 || p.mo > 12) return '';
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// A moment where the TIME is half of what happened. The activity feed is a
// trail of events — "3 item(s) added", "submitted for approval" — and the hour
// is part of reading it, so this keeps it: "27 Aug 2026, 10:50". A column of
// dates wants formatClaimDate; a trail of events wants this. Both were printing
// the server's raw `2026-08-27T02:50:29.683Z`.
export function formatClaimStamp(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const day = formatClaimDate(s);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return day;
  const t = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(t.getTime())) return day;
  return `${day}, ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
