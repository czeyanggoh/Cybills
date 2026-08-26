// How a claim identifies itself outside CYBills.
//
// The number on the claim's own page ("Claim ID"), the one on the PDF, in the
// CSV, and the one the practice has always put in the Xero bill's Reference:
//
//   ST Eng Exp Claim 20-Aug-2026 21324972410
//   └ the claim's name  └ its date  └ its id
//
// Pure and dependency-free, because the SERVER builds that reference when it
// posts the bill (server/src/claimRef.ts loads this by path) and the browser
// prints the same number on the paperwork. Two implementations would mean the
// bill in Xero and the claim it came from disagreeing about their own name.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse an ISO (YYYY-MM-DD) or DD/MM/YYYY date; null when unrecognised.
export function dateParts(input) {
  const s = String(input || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
  return null;
}

// "20-Aug-2026" — the date style in the CSV and in a Xero reference.
export function csvDate(input) {
  const p = dateParts(input);
  if (!p) return String(input || '');
  return `${String(p.d).padStart(2, '0')}-${MONTHS[p.mo - 1]}-${p.y}`;
}

// A clean NUMERIC claim id, consistent with the item-id scheme: the claim's
// creation date-time in SGT as YYMMDDHHMMSS. Falls back to a stable numeric
// hash of the UUID for claims created before createdAt was recorded.
export function claimRef(claim) {
  const ms = Date.parse(String(claim?.createdAt || ''));
  if (Number.isFinite(ms) && ms > 0) {
    const d = new Date(ms + 8 * 60 * 60 * 1000); // SGT
    const p = (n) => String(n).padStart(2, '0');
    return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  }
  const s = String(claim?.id || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(21000000000 + (h % 1000000000));
}

const pad = (n) => String(n).padStart(2, '0');
const isoish = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '');

// The latest date among a claim's own items, as YYYY-MM-DD.
export function latestItemDate(claim) {
  let best = '';
  for (const t of claim?.transactions || []) {
    const p = dateParts(t?.date);
    if (!p) continue;
    const iso = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
    if (!best || iso > best) best = iso;
  }
  return best;
}

// The date a claim IS, whatever has been filled in.
//
// Its own date when it has one, then the period it covers, then the latest date
// among its items — every expense on it happened on or before that, so a bill
// dated there can never land before the money was spent. '' only when the claim
// has nothing dated at all; the caller falls back to today, which is what used
// to happen for every claim and quietly put August's expenses in September.
export function claimDateFor(claim) {
  return isoish(claim?.claimDate) || isoish(claim?.endDate) || latestItemDate(claim);
}

// The Reference a published bill carries. Name first because that is the part a
// person recognises and the part they choose ("ST Eng Exp Claim"); then the
// date and the id, so two months of claims are never the same reference.
export function claimReference(claim) {
  const name = String(claim?.name || '').trim() || 'Expense claim';
  const date = csvDate(claimDateFor(claim));
  return [name, date, claimRef(claim)].filter(Boolean).join(' ');
}
