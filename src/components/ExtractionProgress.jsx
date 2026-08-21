import { useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// The six fields the Processing bar counts, in the order the panel lists them.
// `present` mirrors the reader's own "didn't find it" values — an unread
// document arrives carrying "Unknown supplier" / "Uncategorised", which is an
// absence, not an answer.
export const COST_FIELDS = [
  { key: 'supplier', label: 'Supplier' },
  { key: 'date', label: 'Date' },
  { key: 'invoiceNumber', label: 'Document reference' },
  { key: 'category', label: 'Category' },
  { key: 'total', label: 'Total' },
  { key: 'currency', label: 'Currency' },
];

// Sales rows name the other party 'customer' and the reference 'ref'.
export const SALES_FIELDS = [
  { key: 'customer', label: 'Customer' },
  { key: 'date', label: 'Date' },
  { key: 'ref', label: 'Document reference' },
  { key: 'category', label: 'Category' },
  { key: 'total', label: 'Total' },
  { key: 'currency', label: 'Currency' },
];

const present = (v) =>
  v != null && v !== '' && v !== '—' && v !== 'Unknown supplier' && v !== 'Uncategorised' && v !== 0 && v !== '0';

export function extractedFields(doc, fields = COST_FIELDS) {
  return fields.map((f) => ({ ...f, done: present(doc?.[f.key]), value: doc?.[f.key] }));
}

export function extractedCount(doc, fields = COST_FIELDS) {
  return extractedFields(doc, fields).filter((f) => f.done).length;
}

// How long this document has been reading, in words.
function elapsedLabel(createdAt) {
  const started = new Date(createdAt || '').getTime();
  if (!started || Number.isNaN(started)) return '';
  const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (secs < 60) return `${secs}s so far`;
  const mins = Math.floor(secs / 60);
  return `${mins} min ${secs % 60}s so far`;
}

// The Processing tab's progress bar. Hovering says which fields have been read
// and which are still outstanding — otherwise "2 out of 6" tells you something
// is missing without telling you what.
export default function ExtractionProgress({ doc, fieldSet = COST_FIELDS }) {
  const fields = extractedFields(doc, fieldSet);
  const done = fields.filter((f) => f.done).length;
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  // Fixed positioning, measured on hover: the table scrolls horizontally, and an
  // absolutely-positioned card would be clipped by that container.
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = 260;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - width - 12);
    const above = r.top > window.innerHeight - r.bottom;
    setPos({ left, width, top: above ? undefined : r.bottom + 8, bottom: above ? window.innerHeight - r.top + 8 : undefined });
  };

  return (
    <div
      ref={ref}
      className="w-56"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      tabIndex={0}
    >
      <div className="mb-1 text-xs text-muted-foreground">{done} out of {fields.length} fields extracted</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${(done / fields.length) * 100}%` }} />
      </div>
      {pos && (
        <div
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          className="fixed z-50 rounded-lg border bg-background p-3 shadow-lg"
        >
          <p className="mb-2 text-xs font-medium text-foreground">
            Read {done} of {fields.length} fields
            {elapsedLabel(doc?.createdAt) ? ` · ${elapsedLabel(doc.createdAt)}` : ''}
          </p>
          <ul className="space-y-1">
            {fields.map((f) => (
              <li key={f.key} className={cn('flex items-center gap-2 text-xs', f.done ? 'text-foreground' : 'text-muted-foreground')}>
                {f.done ? (
                  <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.75} />
                )}
                <span className="shrink-0">{f.label}</span>
                {f.done && (
                  <span className="ml-auto truncate text-muted-foreground" title={String(f.value)}>{String(f.value)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t pt-2 text-[11px] leading-snug text-muted-foreground">
            Still reading. Anything it can’t find is left for you to fill in — the document moves to the
            inbox either way.
          </p>
        </div>
      )}
    </div>
  );
}
