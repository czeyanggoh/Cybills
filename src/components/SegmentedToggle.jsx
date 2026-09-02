import { cn } from '@/lib/utils';

// The segmented control every list page says "how much of this to show" with:
// Unpublished / All costs, Unpublished / All claims, My items / All items.
//
// One component rather than a shape each page draws for itself. They were
// copies, and copies drift — the two pages already disagreed about the margin
// under it, and about nothing else, which is exactly how a control stops
// looking like the same control.
//
// It is sized to the toolbar it sits above: h-8 OUTSIDE, the height of every
// toolbar button on these pages, so a row of controls lines up rather than
// stepping. The segments take the height that leaves them (h-full inside the
// border and the half-unit of padding), which is why nothing here names a
// second height that would have to be kept in step with the first.
//
// A count is part of the promise the control makes — "All costs 20" says what
// pressing it produces — so each option carries one, either in `counts` (keyed
// by option) or on the option itself.
export default function SegmentedToggle({ options, value, onChange, counts = {}, label }) {
  return (
    <div className="inline-flex h-8 items-center rounded-md border p-0.5" role="group" aria-label={label}>
      {options.map((o) => {
        const active = value === o.key;
        const count = counts[o.key] ?? o.count ?? 0;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={cn(
              'inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded px-3 text-sm transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
            <span
              className={cn(
                'rounded-full px-1.5 text-xs',
                active ? 'bg-background/20 text-background' : 'bg-muted text-muted-foreground'
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
