import { useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// A searchable single-select dropdown with a — None — reset. Options is an array
// of strings. Renders a compact trigger suited to table cells.
export default function SearchSelect({ value, options, placeholder = 'None', onChange, compact = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between rounded-md border bg-background text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          compact ? 'px-2.5 py-1.5 text-xs' : 'h-10 px-3 text-sm'
        )}
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>{value || placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 z-20 mt-1 max-h-72 w-full min-w-[220px] overflow-auto rounded-md border bg-background py-1 shadow-lg">
            <div className="relative px-2 pb-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search"
                className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); setQ(''); }}
              className="flex w-full items-center px-3 py-2 text-left text-sm italic text-muted-foreground transition-colors hover:bg-muted"
            >
              — None —
            </button>
            {filtered.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => { onChange(o); setOpen(false); setQ(''); }}
                className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                {o}
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>}
          </div>
        </>
      )}
    </div>
  );
}
