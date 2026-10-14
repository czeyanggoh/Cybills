import { formatDate } from '@/lib/date';
import { effectiveDate, dateFromSubmission } from '@/lib/readiness';

// A document's date as a list shows it. A document with no printed date goes by
// the day it was submitted, and publishes with it — so that is what is shown,
// in italics with a `*`, rather than a blank beside a Ready badge.
export default function DocDate({ doc }) {
  if (!dateFromSubmission(doc)) return formatDate(doc?.date);
  return (
    <span className="italic" title="No date printed — the day it was submitted is used">
      {formatDate(effectiveDate(doc))}*
    </span>
  );
}
