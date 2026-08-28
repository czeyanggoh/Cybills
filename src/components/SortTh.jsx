import { cn } from '@/lib/utils';

// A sortable table header: click to sort, click again to reverse, with an arrow
// saying which way it currently runs.
//
// Shared rather than copied. It began as a local helper in the Costs inbox and
// is now the claim's items table as well, and two copies of "click a header to
// sort" would drift in the small ways that matter — which arrow means which
// direction, whether a second click reverses or resets.
export default function SortTh({ label, sortKey, sort, setSort, align = 'left', className = '' }) {
  const active = sort.key === sortKey;
  // ↕ when this column is not the one being sorted on, so it reads as "you can
  // sort by this" rather than as a direction it is not in.
  const arrow = !active ? '↕' : sort.dir === 'asc' ? '↑' : '↓';
  return (
    <th className={cn('px-3 py-2.5 font-medium', align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() =>
          setSort((s) => (s.key === sortKey ? { key: sortKey, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: sortKey, dir: 'asc' }))
        }
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
        <span className={cn('text-[11px]', active ? 'text-foreground' : 'text-muted-foreground/50')}>{arrow}</span>
      </button>
    </th>
  );
}

// Order rows by the chosen column. Money and dates are compared as numbers and
// instants; everything else as text, which is what a person means by A–Z.
//
// `fields` maps a column key to the field it actually sorts on, for the columns
// whose key isn't the field name. Returns a NEW array — the caller's order is
// somebody else's state.
export function sortRows(rows, sort, { fields = {}, numeric = [], dates = [] } = {}) {
  if (!sort?.key) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const field = fields[sort.key] || sort.key;
  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const time = (v) => {
    const t = new Date(String(v ?? '')).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return [...rows].sort((a, b) => {
    if (numeric.includes(sort.key)) return (num(a[field]) - num(b[field])) * dir;
    if (dates.includes(sort.key)) return (time(a[field]) - time(b[field])) * dir;
    return String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * dir;
  });
}
