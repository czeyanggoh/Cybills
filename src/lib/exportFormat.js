// Shared formatting for claim exports so the CSV and PDF stay consistent with
// Dext's conventions: clean file names, "D MMM YYYY" dates, and a short claim
// reference instead of a raw UUID.

import { displayItemId } from '@/lib/bills';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// History text stores raw internal item keys (e.g. "bill_msfp2iz5_d2f91b0e").
// Swap them for the clean numeric display id shown everywhere else, so reports
// and the activity log never surface storage keys.
export function cleanHistoryText(text) {
  return String(text ?? '').replace(/\bbill_[A-Za-z0-9_]+/g, (m) => displayItemId(m));
}

// Parse an ISO (YYYY-MM-DD) or DD/MM/YYYY date; null when unrecognised.
function dateParts(input) {
  const s = String(input || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
  return null;
}

// "25 Jun 2026" — the on-page date style in the PDF (matches Dext).
export function pdfDate(input) {
  const p = dateParts(input);
  if (!p) return String(input || '');
  return `${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
}

// "25-Jun-2026" — the date style in the CSV (matches Dext's export).
export function csvDate(input) {
  const p = dateParts(input);
  if (!p) return String(input || '');
  return `${String(p.d).padStart(2, '0')}-${MONTHS[p.mo - 1]}-${p.y}`;
}

// Short, human-friendly claim reference. Dext shows a compact id, not the raw
// UUID — take the first block of the id, uppercased.
// A clean NUMERIC claim id, consistent with the item-id scheme (displayItemId):
// the claim's creation date-time in SGT as YYMMDDHHMMSS. Falls back to a stable
// numeric hash of the UUID for claims created before createdAt was recorded.
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

function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'expense-claim'
  );
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Dext names exports "<entity>-<export-date>.<ext>". Mirror that with the
// claimant's name so files are identifiable instead of a bare UUID.
export function claimExportName(claim, ext) {
  return `${slug(claim?.claimFor || claim?.name)}-${today()}.${ext}`;
}
