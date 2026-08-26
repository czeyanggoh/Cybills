// Shared formatting for claim exports so the CSV and PDF stay consistent with
// Dext's conventions: clean file names, "D MMM YYYY" dates, and a short claim
// reference instead of a raw UUID.

import { displayItemId } from '@/lib/bills';
// The claim's own number and date formatting live in a pure module: the server
// builds the Xero reference from the same code (see claimReference.js).
import { dateParts, csvDate, claimRef } from '@/lib/claimReference';

export { csvDate, claimRef };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// History text stores raw internal item keys (e.g. "bill_msfp2iz5_d2f91b0e").
// Swap them for the clean numeric display id shown everywhere else, so reports
// and the activity log never surface storage keys.
export function cleanHistoryText(text) {
  return String(text ?? '').replace(/\bbill_[A-Za-z0-9_]+/g, (m) => displayItemId(m));
}

// "25 Jun 2026" — the on-page date style in the PDF (matches Dext).
export function pdfDate(input) {
  const p = dateParts(input);
  if (!p) return String(input || '');
  return `${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
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
